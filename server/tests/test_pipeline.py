import importlib
import json
import os
import tempfile
import threading
import time
import unittest
from concurrent.futures import Future
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from server.ai import AIClient, AnalysisCancelled, ground_candidates, summarize_segments
from server.bilibili import Metadata, VideoError, VideoRef, fetch_metadata, fetch_subtitles, normalize_segments, parse_video_url
from server.media import parse_transcription, transcribe_video
from server.storage import Storage


class ParsingTests(unittest.TestCase):
    def test_page_and_host_validation(self):
        ref = parse_video_url("https://www.bilibili.com/video/BV1xx411c7mD/?p=2&t=34")
        self.assertEqual((ref.bvid, ref.page), ("BV1xx411c7mD", 2))
        self.assertEqual(ref.id, "BV1xx411c7mD-p2")
        with self.assertRaises(VideoError):
            parse_video_url("https://example.com/video/BV1xx411c7mD")
        with self.assertRaises(VideoError):
            parse_video_url("https://www.bilibili.com/video/BV1xx411c7mD?p=0")

    def test_b23_redirect_keeps_page(self):
        def handler(request):
            self.assertEqual(request.url.host, "b23.tv")
            return httpx.Response(
                302, headers={"Location": "https://www.bilibili.com/video/BV1xx411c7mD/?p=3"}
            )

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            ref = parse_video_url("https://b23.tv/example", client)
        self.assertEqual((ref.bvid, ref.page), ("BV1xx411c7mD", 3))

    def test_b23_rejects_untrusted_redirects_without_requesting_them(self):
        for location in (
            "http://127.0.0.1/private",
            "https://user:pass@b23.tv/next",
            "https://b23.tv:8443/next",
            "https://www.bilibili.com:8443/video/BV1xx411c7mD",
        ):
            with self.subTest(location=location):
                requested = []

                def handler(request):
                    requested.append(str(request.url))
                    return httpx.Response(302, headers={"Location": location})

                with httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True) as client:
                    with self.assertRaises(VideoError):
                        parse_video_url("https://b23.tv/example", client)
                self.assertEqual(requested, ["https://b23.tv/example"])

        with httpx.Client(transport=httpx.MockTransport(lambda request: self.fail("Unexpected request"))) as client:
            for url in ("https://user@b23.tv/example", "https://b23.tv:8443/example", "http://b23.tv/example"):
                with self.subTest(url=url), self.assertRaises(VideoError):
                    parse_video_url(url, client)

    def test_subtitle_api(self):
        def handler(request):
            if request.url.path.endswith("/x/player/v2"):
                return httpx.Response(200, json={"code": 0, "data": {"subtitle": {"subtitles": [
                    {"lan": "zh-CN", "subtitle_url": "https://aisubtitle.hdslb.com/test.json"}
                ]}}})
            return httpx.Response(200, json={"body": [
                {"from": 2.5, "to": 4.0, "content": "第一个知识点"},
                {"from": 4.0, "to": 6.0, "content": "第二个知识点"},
            ]})

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            segments = fetch_subtitles(client, VideoRef("BV1xx411c7mD", 1), 42)
        self.assertEqual(segments[0]["id"], "S00001")
        self.assertEqual(segments[0]["start"], 2.5)
        self.assertEqual(segments[1]["text"], "第二个知识点")

    def test_subtitle_url_must_be_trusted_https(self):
        candidates = (
            "http://aisubtitle.hdslb.com/test.json",
            "https://127.0.0.1/private",
            "https://aisubtitle.hdslb.com.evil.test/test.json",
            "https://user:pass@aisubtitle.hdslb.com/test.json",
            "https://aisubtitle.hdslb.com:8443/test.json",
            "//i0.hdslb.com/test.json",
        )
        requested = []

        def handler(request):
            requested.append(str(request.url))
            if request.url.path.endswith("/x/player/v2"):
                return httpx.Response(200, json={"code": 0, "data": {"subtitle": {"subtitles": [
                    {"lan": "zh-CN", "subtitle_url": url} for url in candidates
                ]}}})
            return httpx.Response(200, json={"body": [{"from": 1, "to": 2, "content": "可信字幕"}]})

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            segments = fetch_subtitles(client, VideoRef("BV1xx411c7mD", 1), 42)
        self.assertEqual(segments[0]["text"], "可信字幕")
        self.assertEqual(requested[1:], ["https://i0.hdslb.com/test.json"])

    def test_subtitle_redirects_are_checked_at_each_hop(self):
        requested = []

        def handler(request):
            requested.append(str(request.url))
            if request.url.path.endswith("/x/player/v2"):
                return httpx.Response(200, json={"code": 0, "data": {"subtitle": {"subtitles": [
                    {"lan": "zh-CN", "subtitle_url": "https://aisubtitle.hdslb.com/first.json"},
                    {"lan": "zh-CN", "subtitle_url": "https://i1.hdslb.com/second.json"},
                ]}}})
            if request.url.path == "/first.json":
                return httpx.Response(302, headers={"Location": "http://127.0.0.1/private"})
            if request.url.path == "/second.json":
                return httpx.Response(302, headers={"Location": "https://i2.hdslb.com/final.json"})
            return httpx.Response(200, json={"body": [{"from": 3, "to": 4, "content": "安全跳转"}]})

        with httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True) as client:
            segments = fetch_subtitles(client, VideoRef("BV1xx411c7mD", 1), 42)
        self.assertEqual(segments[0]["text"], "安全跳转")
        self.assertEqual(requested[1:], [
            "https://aisubtitle.hdslb.com/first.json",
            "https://i1.hdslb.com/second.json",
            "https://i2.hdslb.com/final.json",
        ])

    def test_metadata_uses_selected_page_duration(self):
        def handler(request):
            return httpx.Response(200, json={"code": 0, "data": {
                "title": "课程", "pic": "http://i0.hdslb.com/cover.jpg",
                "pages": [
                    {"cid": 11, "duration": 40, "part": "导论"},
                    {"cid": 22, "duration": 120, "part": "变量"},
                ],
            }})

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            metadata = fetch_metadata(client, VideoRef("BV1xx411c7mD", 2))
            self.assertEqual((metadata.cid, metadata.duration), (22, 120))
            self.assertEqual(metadata.title, "课程 - P2 变量")
            self.assertEqual(metadata.cover, "https://i0.hdslb.com/cover.jpg")
            with self.assertRaises(VideoError):
                fetch_metadata(client, VideoRef("BV1xx411c7mD", 3))

    def test_grounding_rejects_invented_timestamp(self):
        segments = normalize_segments([{"start": 12, "end": 15, "text": "牛顿第一定律描述惯性"}])
        payload = {"points": [
            {"category": "物理", "title": "惯性", "explanation": "物体保持原有状态。", "segment_ids": ["S00001"], "time_seconds": 999},
            {"category": "物理", "title": "无根据", "explanation": "测试", "segment_ids": ["S99999"]},
        ]}
        points = ground_candidates(payload, segments)
        self.assertEqual(len(points), 1)
        self.assertEqual(points[0]["time_seconds"], 12)
        self.assertEqual(points[0]["evidence"], "牛顿第一定律描述惯性")

    def test_transcription_without_timestamps_marks_approximate(self):
        segments = parse_transcription({"text": "先学变量。再学循环。"}, 600, 120)
        self.assertEqual(segments[0]["start"], 600)
        self.assertEqual(segments[-1]["end"], 720)
        self.assertTrue(all(item["timestamp_approximate"] for item in segments))

    def test_summary_checks_cancellation_before_next_provider_call(self):
        event = threading.Event()
        segments = normalize_segments([
            {"start": 0, "end": 10, "text": "甲" * 4000},
            {"start": 10, "end": 20, "text": "乙" * 4000},
        ])

        class FakeAI:
            calls = 0

            def chat_json(self, _system, _prompt):
                self.calls += 1
                event.set()
                return {"overview": "第一段", "points": [{
                    "category": "课程", "title": "第一点", "explanation": "来自第一段。",
                    "segment_ids": ["S00001"],
                }]}

        fake = FakeAI()
        with self.assertRaises(AnalysisCancelled):
            summarize_segments(segments, fake, cancelled=event.is_set)
        self.assertEqual(fake.calls, 1)

    def test_partial_summary_only_exposes_points_with_known_citations(self):
        segments = normalize_segments([
            {"start": 0, "end": 10, "text": "甲" * 4000},
            {"start": 10, "end": 20, "text": "乙" * 4000},
        ])

        class FakeAI:
            calls = 0

            def chat_json(self, _system, _prompt):
                self.calls += 1
                if self.calls == 3:
                    return {"overview": "全片概述", "point_ids": ["C001", "C001", "C002"]}
                citation = f"S{self.calls:05d}"
                return {"overview": f"第{self.calls}段", "points": [
                    {"category": "课程", "title": f"第{self.calls}点", "explanation": "解释", "segment_ids": [citation]},
                    {"category": "课程", "title": "无效", "explanation": "解释", "segment_ids": ["S99999"]},
                ]}

        previews = []
        overview, points = summarize_segments(
            segments, FakeAI(), partial=lambda text, items: previews.append((text, items)),
        )
        self.assertEqual([len(items) for _, items in previews], [1, 2])
        self.assertEqual(previews[0][1][0]["time_seconds"], 0)
        self.assertEqual(previews[1][1][1]["time_seconds"], 10)
        self.assertTrue(all(point["review_status"] == "unreviewed" for point in points))
        self.assertEqual([point["title"] for point in points], ["第1点", "第2点"])
        self.assertEqual(overview, "全片概述")


class ApiFlowTests(unittest.TestCase):
    def test_transcription_requires_confirmation_and_rejects_long_video_before_download(self):
        from server import app as module

        with tempfile.TemporaryDirectory() as temporary:
            storage = Storage(Path(temporary))
            storage.save_settings({"api_key": "test-key"})
            original_storage = module.storage
            module.storage = storage
            try:
                with patch.object(module, "fetch_metadata", return_value=Metadata("课程", 42, 75)), \
                     patch.object(module, "fetch_subtitles", return_value=[]), \
                     patch.object(module, "transcribe_video") as transcription:
                    client = TestClient(module.app, base_url="http://127.0.0.1")
                    url = "https://www.bilibili.com/video/BV1xx411c7mD"
                    submitted = client.post("/api/analyze", json={"url": url}).json()
                    job = self._wait(client, submitted["job_id"])
                    self.assertEqual(job["status"], "error")
                    self.assertEqual(job["error_code"], "transcription_required")
                    self.assertEqual(job["duration_seconds"], 75)
                    transcription.assert_not_called()
                with patch.object(module, "fetch_metadata", return_value=Metadata("课程", 42, 14401)), \
                     patch.object(module, "fetch_subtitles", return_value=[]), \
                     patch.object(module, "transcribe_video") as transcription:
                    submitted = client.post("/api/analyze", json={
                        "url": url, "allow_transcription": True,
                    }).json()
                    job = self._wait(client, submitted["job_id"])
                    self.assertEqual(job["status"], "error")
                    self.assertIn("4 小时", job["error"])
                    transcription.assert_not_called()
            finally:
                module.storage = original_storage

    def test_search_edit_and_delete_invalidate_cached_jobs(self):
        from server import app as module

        with tempfile.TemporaryDirectory() as temporary:
            storage = Storage(Path(temporary))
            storage.save_settings({"api_key": "test-key"})
            video_id = "BV1xx411c7mD-p1"
            storage.save_video({
                "id": video_id, "bvid": "BV1xx411c7mD", "page": 1,
                "url": "https://www.bilibili.com/video/BV1xx411c7mD/?p=1",
                "title": "Python 入门", "created_at": "2026-10-03T00:00:00Z",
                "overview": "讲解变量。", "points": [{
                    "id": "P001", "category": "基础语法", "title": "变量",
                    "explanation": "变量存放数据。", "evidence": "x = 1",
                    "time_seconds": 12, "segment_ids": ["S00001"],
                }],
            })
            original_storage = module.storage
            module.storage = storage
            try:
                client = TestClient(module.app, base_url="http://127.0.0.1")
                result = client.get("/api/search", params={"q": "变量"}).json()["results"]
                self.assertEqual(len(result), 1)
                self.assertEqual(client.get("/api/search", params={"q": "Python"}).json()["results"], [])
                self.assertEqual(result[0]["video_id"], video_id)
                self.assertEqual(result[0]["point"]["review_status"], "unreviewed")
                cached = client.post("/api/analyze", json={
                    "url": "https://www.bilibili.com/video/BV1xx411c7mD",
                }).json()["job_id"]
                dashboard_headers = {"Origin": "http://127.0.0.1:8765"}
                self.assertEqual(client.patch(f"/api/videos/{video_id}/points/P001", json={
                    "title": "不应保存",
                }, headers={"Origin": "chrome-extension://another-extension"}).status_code, 403)
                edited = client.patch(f"/api/videos/{video_id}/points/P001", json={
                    "title": "赋值与变量", "category": "变量与类型", "review_status": "reviewed",
                }, headers=dashboard_headers)
                self.assertEqual(edited.status_code, 200)
                self.assertEqual(edited.json()["point"]["review_status"], "reviewed")
                self.assertEqual(storage.get_video(video_id)["points"][0]["title"], "赋值与变量")
                self.assertEqual(storage.get_video(video_id)["categories"], ["变量与类型"])
                self.assertEqual(client.get(f"/api/jobs/{cached}").json()["result"]["points"][0]["title"], "赋值与变量")
                self.assertEqual(client.get(f"/api/jobs/{cached}").json()["result"]["categories"], ["变量与类型"])
                self.assertEqual(len(client.get("/api/search", params={"q": "赋值"}).json()["results"]), 1)
                self.assertEqual(client.patch(f"/api/videos/{video_id}/points/P001", json={
                    "review_status": "invalid",
                }, headers=dashboard_headers).status_code, 422)
                self.assertEqual(client.delete(f"/api/videos/{video_id}", headers={
                    "Origin": "chrome-extension://another-extension",
                }).status_code, 403)
                self.assertEqual(client.delete(f"/api/videos/{video_id}", headers=dashboard_headers).status_code, 200)
                self.assertEqual(client.get(f"/api/jobs/{cached}").status_code, 404)
                self.assertEqual(client.get("/api/search", params={"q": "赋值"}).json()["results"], [])
            finally:
                module.storage = original_storage

    def test_settings_write_requires_local_dashboard_origin(self):
        from server import app as module

        with tempfile.TemporaryDirectory() as temporary:
            storage = Storage(Path(temporary))
            original_storage = module.storage
            module.storage = storage
            try:
                client = TestClient(module.app, base_url="http://127.0.0.1")
                self.assertEqual(client.post("/api/settings", json={"model": "changed"}, headers={
                    "Origin": "chrome-extension://another-extension",
                }).status_code, 403)
                self.assertEqual(storage.settings()["model"], "gpt-4o-mini")
                self.assertEqual(client.post("/api/settings", json={"model": "changed"}, headers={
                    "Origin": "http://127.0.0.1:8765",
                }).status_code, 200)
                self.assertEqual(storage.settings()["model"], "changed")
            finally:
                module.storage = original_storage

    def test_terminal_jobs_are_pruned_by_age_and_count(self):
        from server import app as module

        now = time.monotonic()
        with patch.object(module, "jobs", {}), \
             patch.object(module, "job_video_ids", {}), \
             patch.object(module, "job_finished_at", {}), \
             patch.object(module, "MAX_TERMINAL_JOBS", 2):
            with module.jobs_lock:
                for job_id, age in (("expired", 901), ("old", 30), ("middle", 20), ("new", 10)):
                    module.jobs[job_id] = {"status": "done", "result": {"id": job_id}}
                    module.job_video_ids[job_id] = job_id
                    module.job_finished_at[job_id] = now - age
                module._prune_jobs_locked()
                self.assertEqual(set(module.jobs), {"middle", "new"})
                self.assertEqual(set(module.job_video_ids), {"middle", "new"})
                self.assertEqual(set(module.job_finished_at), {"middle", "new"})

    def test_subtitle_analysis_cache_and_force(self):
        from server import app as module

        with tempfile.TemporaryDirectory() as temporary:
            storage = Storage(Path(temporary))
            storage.save_settings({"api_key": "test-key"})
            segments = normalize_segments([
                {"start": 3, "end": 8, "text": "Python 变量用于存放数据。"},
                {"start": 9, "end": 14, "text": "使用等号给变量赋值。"},
            ])
            requests = []

            def handler(request):
                requests.append(request)
                self.assertEqual(request.url.path, "/v1/chat/completions")
                answer = {"overview": "讲解 Python 变量。", "points": [{
                    "category": "基础语法", "title": "变量", "explanation": "变量存放数据。",
                    "segment_ids": ["S00001", "S00002"],
                }]}
                return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(answer, ensure_ascii=False)}}]})

            fake_client = httpx.Client(transport=httpx.MockTransport(handler))
            original_storage = module.storage
            module.storage = storage
            try:
                with patch.object(module, "fetch_metadata", return_value=Metadata("Python 入门", 42, 30)), \
                     patch.object(module, "fetch_subtitles", return_value=segments), \
                     patch.object(module, "AIClient", side_effect=lambda settings: AIClient(settings, fake_client)):
                    client = TestClient(module.app, base_url="http://127.0.0.1")
                    self.assertNotIn("api_key", client.get("/api/settings").json())
                    body = {"url": "https://www.bilibili.com/video/BV1xx411c7mD"}
                    first = client.post("/api/analyze", json=body)
                    self.assertEqual(first.status_code, 200)
                    result = self._wait(client, first.json()["job_id"])
                    self.assertEqual(result["status"], "done")
                    self.assertEqual(result["result"]["source"], "subtitle")
                    self.assertEqual(result["result"]["points"][0]["time_seconds"], 3)
                    self.assertEqual(client.get("/api/videos").json()[0]["point_count"], 1)
                    second = client.post("/api/analyze", json=body).json()
                    self.assertIsNone(second["lease_id"])
                    self.assertEqual(client.get(f"/api/jobs/{second['job_id']}").json()["status"], "done")
                    self.assertEqual(len(requests), 1)
                    forced = client.post("/api/analyze", json={**body, "force": True}).json()
                    self.assertEqual(self._wait(client, forced["job_id"])["status"], "done")
                    self.assertEqual(len(requests), 2)
            finally:
                module.storage = original_storage
                fake_client.close()

    def test_missing_subtitles_uses_transcription(self):
        from server import app as module

        with tempfile.TemporaryDirectory() as temporary:
            storage = Storage(Path(temporary))
            storage.save_settings({"api_key": "test-key"})
            transcribed = normalize_segments([
                {"start": 20, "end": 25, "text": "光合作用利用光能。"},
            ])

            def handler(request):
                answer = {"overview": "讲解光合作用。", "points": [{
                    "category": "生物", "title": "光合作用", "explanation": "利用光能。",
                    "segment_ids": ["S00001"],
                }]}
                return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(answer, ensure_ascii=False)}}]})

            fake_client = httpx.Client(transport=httpx.MockTransport(handler))
            original_storage = module.storage
            module.storage = storage
            try:
                with patch.object(module, "fetch_metadata", return_value=Metadata("生物课", 42, 60)), \
                     patch.object(module, "fetch_subtitles", return_value=[]), \
                     patch.object(module, "transcribe_video", return_value=transcribed) as transcription, \
                     patch.object(module, "AIClient", side_effect=lambda settings: AIClient(settings, fake_client)):
                    client = TestClient(module.app, base_url="http://127.0.0.1")
                    submitted = client.post("/api/analyze", json={
                        "url": "https://www.bilibili.com/video/BV1xx411c7mD",
                        "allow_transcription": True,
                    }).json()
                    job = self._wait(client, submitted["job_id"])
                    self.assertEqual(job["status"], "done")
                    self.assertEqual(job["result"]["source"], "transcription")
                    self.assertEqual(job["result"]["points"][0]["time_seconds"], 20)
                    transcription.assert_called_once()
            finally:
                module.storage = original_storage
                fake_client.close()

    @staticmethod
    def _wait(client, job_id):
        for _ in range(100):
            job = client.get(f"/api/jobs/{job_id}").json()
            if job["status"] in {"done", "error", "cancelled"}:
                return job
            time.sleep(0.02)
        raise AssertionError("job did not finish")

    def test_nonlocal_host_rejected(self):
        from server import app as module

        client = TestClient(module.app, base_url="http://127.0.0.1")
        self.assertEqual(client.get("/api/status").status_code, 200)
        self.assertEqual(client.get("/api/status", headers={"Host": "attacker.example"}).status_code, 400)

    def test_queued_cancel_releases_capacity_and_queue_is_bounded(self):
        from server import app as module

        class QueuedExecutor:
            def submit(self, *_args):
                return Future()

        with tempfile.TemporaryDirectory() as temporary:
            storage = Storage(Path(temporary))
            storage.save_settings({"api_key": "test-key"})
            original_storage, original_executor = module.storage, module.executor
            module.storage, module.executor = storage, QueuedExecutor()
            try:
                client = TestClient(module.app, base_url="http://127.0.0.1")
                subscriptions = []
                for suffix in "ABCD":
                    response = client.post("/api/analyze", json={
                        "url": f"https://www.bilibili.com/video/BV1xx411c7m{suffix}",
                    })
                    self.assertEqual(response.status_code, 200)
                    subscriptions.append(response.json())
                fifth_url = "https://www.bilibili.com/video/BV1xx411c7mE"
                self.assertEqual(client.post("/api/analyze", json={"url": fifth_url}).status_code, 429)
                first = subscriptions[0]
                cancellation = client.post(
                    f"/api/jobs/{first['job_id']}/cancel", json={"lease_id": first["lease_id"]}
                ).json()
                self.assertEqual(cancellation, {"cancelled": True, "released": True, "remaining_subscribers": 0})
                self.assertEqual(client.get(f"/api/jobs/{first['job_id']}").json()["status"], "cancelled")
                replacement = client.post("/api/analyze", json={"url": fifth_url})
                self.assertEqual(replacement.status_code, 200)
                subscriptions.append(replacement.json())
                for subscription in subscriptions[1:]:
                    client.post(
                        f"/api/jobs/{subscription['job_id']}/cancel",
                        json={"lease_id": subscription["lease_id"]},
                    )
                self.assertEqual(client.get("/api/videos").json(), [])
            finally:
                module.storage, module.executor = original_storage, original_executor

    def test_two_subscribers_cancel_independently(self):
        from server import app as module

        with tempfile.TemporaryDirectory() as temporary:
            storage = Storage(Path(temporary))
            storage.save_settings({"api_key": "test-key"})
            original_storage = module.storage
            module.storage = storage
            try:
                with patch.object(module, "executor", SimpleNamespace(submit=lambda *_: Future())):
                    client = TestClient(module.app, base_url="http://127.0.0.1")
                    body = {"url": "https://www.bilibili.com/video/BV1xx411c7mT"}
                    first = client.post("/api/analyze", json=body).json()
                    second = client.post("/api/analyze", json=body).json()
                    self.assertEqual(first["job_id"], second["job_id"])
                    self.assertNotEqual(first["lease_id"], second["lease_id"])
                    first_cancel = client.post(
                        f"/api/jobs/{first['job_id']}/cancel", json={"lease_id": first["lease_id"]}
                    ).json()
                    self.assertEqual(first_cancel, {"cancelled": False, "released": True, "remaining_subscribers": 1})
                    self.assertEqual(client.get(f"/api/jobs/{first['job_id']}").json()["status"], "queued")
                    duplicate_cancel = client.post(
                        f"/api/jobs/{first['job_id']}/cancel", json={"lease_id": first["lease_id"]}
                    ).json()
                    self.assertFalse(duplicate_cancel["released"])
                    second_cancel = client.post(
                        f"/api/jobs/{first['job_id']}/cancel", json={"lease_id": second["lease_id"]}
                    ).json()
                    self.assertTrue(second_cancel["cancelled"])
                    self.assertEqual(client.get(f"/api/jobs/{first['job_id']}").json()["status"], "cancelled")
            finally:
                module.storage = original_storage

    def test_new_job_after_last_lease_release_survives_old_cleanup(self):
        from server import app as module

        first_entered = threading.Event()
        second_entered = threading.Event()
        release_first = threading.Event()
        release_second = threading.Event()
        counter_lock = threading.Lock()
        calls = 0

        def slow_metadata(_client, _ref):
            nonlocal calls
            with counter_lock:
                calls += 1
                current = calls
            if current == 1:
                first_entered.set()
                release_first.wait(3)
            else:
                second_entered.set()
                release_second.wait(3)
            return Metadata("课程", 42, 60)

        with tempfile.TemporaryDirectory() as temporary:
            storage = Storage(Path(temporary))
            storage.save_settings({"api_key": "test-key"})
            original_storage = module.storage
            module.storage = storage
            try:
                with patch.object(module, "fetch_metadata", side_effect=slow_metadata):
                    client = TestClient(module.app, base_url="http://127.0.0.1")
                    body = {"url": "https://www.bilibili.com/video/BV1xx411c7mR"}
                    first = client.post("/api/analyze", json=body).json()
                    self.assertTrue(first_entered.wait(2))
                    client.post(f"/api/jobs/{first['job_id']}/cancel", json={"lease_id": first["lease_id"]})
                    second = client.post("/api/analyze", json=body).json()
                    self.assertNotEqual(first["job_id"], second["job_id"])
                    self.assertTrue(second_entered.wait(2))
                    release_first.set()
                    self.assertEqual(self._wait(client, first["job_id"])["status"], "cancelled")
                    with module.jobs_lock:
                        self.assertEqual(module.active_jobs["BV1xx411c7mR-p1"], second["job_id"])
                    client.post(f"/api/jobs/{second['job_id']}/cancel", json={"lease_id": second["lease_id"]})
                    release_second.set()
                    self.assertEqual(self._wait(client, second["job_id"])["status"], "cancelled")
                    self.assertEqual(client.get("/api/videos").json(), [])
            finally:
                release_first.set()
                release_second.set()
                module.storage = original_storage

    def test_running_cancel_stops_before_subtitle_or_asr(self):
        from server import app as module

        entered = threading.Event()
        release = threading.Event()

        def slow_metadata(_client, _ref):
            entered.set()
            release.wait(3)
            return Metadata("课程", 42, 60)

        with tempfile.TemporaryDirectory() as temporary:
            storage = Storage(Path(temporary))
            storage.save_settings({"api_key": "test-key"})
            original_storage = module.storage
            module.storage = storage
            try:
                with patch.object(module, "fetch_metadata", side_effect=slow_metadata), \
                     patch.object(module, "fetch_subtitles") as subtitles, \
                     patch.object(module, "transcribe_video") as transcribe:
                    client = TestClient(module.app, base_url="http://127.0.0.1")
                    response = client.post("/api/analyze", json={
                        "url": "https://www.bilibili.com/video/BV1xx411c7mZ",
                    })
                    subscription = response.json()
                    job_id = subscription["job_id"]
                    self.assertTrue(entered.wait(2))
                    self.assertTrue(client.post(
                        f"/api/jobs/{job_id}/cancel", json={"lease_id": subscription["lease_id"]}
                    ).json()["cancelled"])
                    release.set()
                    self.assertEqual(self._wait(client, job_id)["status"], "cancelled")
                    subtitles.assert_not_called()
                    transcribe.assert_not_called()
                    self.assertEqual(client.get("/api/videos").json(), [])
            finally:
                release.set()
                module.storage = original_storage

    def test_cancel_takes_precedence_over_inflight_fetch_error(self):
        from server import app as module

        entered = threading.Event()
        release = threading.Event()

        def failing_metadata(_client, _ref):
            entered.set()
            release.wait(3)
            raise VideoError("网络失败")

        with tempfile.TemporaryDirectory() as temporary:
            storage = Storage(Path(temporary))
            storage.save_settings({"api_key": "test-key"})
            original_storage = module.storage
            module.storage = storage
            try:
                with patch.object(module, "fetch_metadata", side_effect=failing_metadata):
                    client = TestClient(module.app, base_url="http://127.0.0.1")
                    response = client.post("/api/analyze", json={
                        "url": "https://www.bilibili.com/video/BV1xx411c7mY",
                    })
                    subscription = response.json()
                    job_id = subscription["job_id"]
                    self.assertTrue(entered.wait(2))
                    self.assertTrue(client.post(
                        f"/api/jobs/{job_id}/cancel", json={"lease_id": subscription["lease_id"]}
                    ).json()["cancelled"])
                    release.set()
                    self.assertEqual(self._wait(client, job_id)["status"], "cancelled")
            finally:
                release.set()
                module.storage = original_storage


class CourseSummaryImportTests(unittest.TestCase):
    URL = "https://www.bilibili.com/video/BV1xx411c7mD/?p=2"
    ORIGIN = {"Origin": "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}

    @classmethod
    def payload(cls):
        return {
            "url": cls.URL,
            "overview": "本节介绍变量和赋值。",
            "points": [{
                "title": "变量保存数据", "explanation": "变量可保存程序中的数据。",
                "category": "基础语法", "time_seconds": 12.5,
                "evidence": "课程总结：变量可存储值。",
            }],
        }

    def test_keyless_import_preserves_existing_edited_note(self):
        from server import app as module

        with tempfile.TemporaryDirectory() as temporary:
            storage = Storage(Path(temporary))
            original_storage = module.storage
            module.storage = storage
            try:
                with patch.object(module, "fetch_metadata", return_value=Metadata("官方课程 - P2", 42, 120, "https://i0.hdslb.com/cover.jpg")):
                    client = TestClient(module.app, base_url="http://127.0.0.1")
                    status = client.get("/api/status").json()
                    self.assertFalse(status["configured"])
                    self.assertEqual(status["data_dir"], str(storage.data_dir.resolve()))
                    first = client.post("/api/import-course-summary", json=self.payload(), headers=self.ORIGIN)
                    self.assertEqual(first.status_code, 200)
                    self.assertTrue(first.json()["imported"])
                    result = first.json()["result"]
                    self.assertEqual((result["bvid"], result["page"]), ("BV1xx411c7mD", 2))
                    self.assertEqual(result["title"], "官方课程 - P2")
                    self.assertEqual(result["duration"], 120)
                    self.assertEqual(result["source"], "bilibili_course_summary")
                    self.assertEqual(result["segments"], [])
                    self.assertEqual(result["points"][0]["id"], "P001")
                    self.assertEqual(result["points"][0]["review_status"], "unreviewed")
                    self.assertEqual(result["points"][0]["evidence"], "课程总结：变量可存储值。")
                    storage.update_point(result["id"], "P001", {"title": "我核对后的标题"})
                    changed = {**self.payload(), "overview": "不应覆盖原笔记"}
                    second = client.post("/api/import-course-summary", json=changed, headers=self.ORIGIN)
                    self.assertEqual(second.status_code, 200)
                    self.assertFalse(second.json()["imported"])
                    self.assertEqual(second.json()["result"]["overview"], "本节介绍变量和赋值。")
                    self.assertEqual(second.json()["result"]["points"][0]["title"], "我核对后的标题")
                    self.assertEqual(client.get("/api/videos").json()[0]["point_count"], 1)
            finally:
                module.storage = original_storage

    def test_keyless_import_can_be_reopened_without_starting_ai(self):
        from server import app as module

        with tempfile.TemporaryDirectory() as temporary:
            storage = Storage(Path(temporary))
            original_storage = module.storage
            module.storage = storage
            try:
                with patch.object(module, "fetch_metadata", return_value=Metadata("官方课程 - P2", 42, 120)):
                    client = TestClient(module.app, base_url="http://127.0.0.1")
                    imported = client.post(
                        "/api/import-course-summary", json=self.payload(), headers=self.ORIGIN,
                    ).json()["result"]
                    reopened = client.post("/api/analyze", json={"url": self.URL})
                    self.assertEqual(reopened.status_code, 200)
                    self.assertIsNone(reopened.json()["lease_id"])
                    job = client.get(f"/api/jobs/{reopened.json()['job_id']}").json()
                    self.assertEqual(job["status"], "done")
                    self.assertEqual(job["result"], imported)
                    self.assertEqual(client.post(
                        "/api/analyze", json={"url": self.URL, "force": True},
                    ).status_code, 400)
                    self.assertEqual(client.post("/api/analyze", json={
                        "url": "https://www.bilibili.com/video/BV1xx411c7mD/?p=1",
                    }).status_code, 400)
            finally:
                module.storage = original_storage

    def test_import_rejects_untrusted_origin_and_invalid_content(self):
        from server import app as module

        with tempfile.TemporaryDirectory() as temporary:
            storage = Storage(Path(temporary))
            original_storage = module.storage
            module.storage = storage
            try:
                with patch.object(module, "fetch_metadata", return_value=Metadata("官方课程", 42, 120)):
                    client = TestClient(module.app, base_url="http://127.0.0.1")
                    self.assertEqual(client.post("/api/import-course-summary", json=self.payload()).status_code, 403)
                    self.assertEqual(client.post("/api/import-course-summary", json=self.payload(), headers={
                        "Origin": "https://evil.example",
                    }).status_code, 403)
                    bad_cases = [
                        ({**self.payload(), "url": "https://evil.example/video/BV1xx411c7mD"}, 400),
                        ({**self.payload(), "overview": "   "}, 400),
                        ({**self.payload(), "points": []}, 422),
                        ({**self.payload(), "points": self.payload()["points"] * 101}, 422),
                        ({**self.payload(), "points": [{**self.payload()["points"][0], "title": "   "}]}, 400),
                        ({**self.payload(), "points": [{**self.payload()["points"][0], "time_seconds": 121}]}, 400),
                        ({**self.payload(), "points": [{**self.payload()["points"][0], "time_seconds": -1}]}, 422),
                        ({**self.payload(), "points": [{**self.payload()["points"][0], "time_seconds": True}]}, 422),
                        ({**self.payload(), "points": [{**self.payload()["points"][0], "time_seconds": "Infinity"}]}, 422),
                        ({**self.payload(), "points": [{**self.payload()["points"][0], "evidence": "证" * 601}]}, 422),
                    ]
                    for body, expected in bad_cases:
                        with self.subTest(body=body):
                            self.assertEqual(client.post(
                                "/api/import-course-summary", json=body, headers=self.ORIGIN,
                            ).status_code, expected)
                    self.assertEqual(client.get("/api/videos").json(), [])
                with patch.object(module, "fetch_metadata", return_value=Metadata("官方课程", 42, 0)):
                    self.assertEqual(client.post(
                        "/api/import-course-summary", json=self.payload(), headers=self.ORIGIN,
                    ).status_code, 502)
            finally:
                module.storage = original_storage

    def test_import_waits_for_active_analysis(self):
        from server import app as module

        with tempfile.TemporaryDirectory() as temporary:
            storage = Storage(Path(temporary))
            storage.save_settings({"api_key": "test-key"})
            original_storage = module.storage
            module.storage = storage
            try:
                with patch.object(module, "executor", SimpleNamespace(submit=lambda *_: Future())), \
                     patch.object(module, "fetch_metadata", return_value=Metadata("官方课程", 42, 120)):
                    client = TestClient(module.app, base_url="http://127.0.0.1")
                    subscription = client.post("/api/analyze", json={"url": self.URL}).json()
                    conflict = client.post("/api/import-course-summary", json=self.payload(), headers=self.ORIGIN)
                    self.assertEqual(conflict.status_code, 409)
                    self.assertEqual(client.get("/api/videos").json(), [])
                    client.post(
                        f"/api/jobs/{subscription['job_id']}/cancel",
                        json={"lease_id": subscription["lease_id"]},
                    )
                    imported = client.post("/api/import-course-summary", json=self.payload(), headers=self.ORIGIN)
                    self.assertEqual(imported.status_code, 200)
                    self.assertTrue(imported.json()["imported"])
            finally:
                module.storage = original_storage


class TranscriptionFlowTests(unittest.TestCase):
    def test_cancel_before_audio_download(self):
        with patch("server.media._download_audio") as download:
            with self.assertRaises(AnalysisCancelled):
                transcribe_video(VideoRef("BV1xx411c7mD", 1), 60, object(), cancelled=lambda: True)
            download.assert_not_called()

    def test_audio_fallback_calls_compatible_api_and_returns_timestamps(self):
        def handler(request):
            self.assertEqual(request.url.path, "/v1/audio/transcriptions")
            return httpx.Response(200, json={"segments": [
                {"start": 1, "end": 3, "text": "变量存放数据"},
            ]})

        settings = {"api_key": "test-key", "base_url": "https://fake.example/v1", "transcription_model": "whisper-1"}
        with tempfile.TemporaryDirectory() as temporary, \
             httpx.Client(transport=httpx.MockTransport(handler)) as client:
            source = Path(temporary) / "fake.m4a"
            source.write_bytes(b"audio")

            def fake_download(ref, directory):
                return source, 10

            def fake_ffmpeg(command, **kwargs):
                Path(command[-1]).write_bytes(b"mp3")
                return SimpleNamespace(returncode=0, stderr="")

            with patch("server.media._download_audio", side_effect=fake_download), \
                 patch("server.media.subprocess.run", side_effect=fake_ffmpeg), \
                 patch("imageio_ffmpeg.get_ffmpeg_exe", return_value="ffmpeg"):
                result = transcribe_video(VideoRef("BV1xx411c7mD", 1), 10, AIClient(settings, client))
        self.assertEqual(result[0]["text"], "变量存放数据")
        self.assertEqual(result[0]["start"], 1)
        self.assertFalse(result[0]["timestamp_approximate"])


class ZCloudModeTests(unittest.TestCase):
    TOKEN = "cloud-test-token-with-at-least-thirty-two-characters"
    URL = "https://notes.example.com"

    def test_cloud_config_rejects_incomplete_or_invalid_values(self):
        from server import app as module

        cases = [
            {"ZK_PUBLIC_URL": "", "ZK_ACCESS_TOKEN": "", "ZK_REQUIRE_AUTH": "1"},
            {"ZK_PUBLIC_URL": self.URL, "ZK_ACCESS_TOKEN": ""},
            {"ZK_PUBLIC_URL": "", "ZK_ACCESS_TOKEN": self.TOKEN},
            {"ZK_PUBLIC_URL": "http://notes.example.com", "ZK_ACCESS_TOKEN": self.TOKEN},
            {"ZK_PUBLIC_URL": "https://notes.example.com/path", "ZK_ACCESS_TOKEN": self.TOKEN},
            {"ZK_PUBLIC_URL": "https://notes.example.com:443", "ZK_ACCESS_TOKEN": self.TOKEN},
            {"ZK_PUBLIC_URL": "https://user@notes.example.com", "ZK_ACCESS_TOKEN": self.TOKEN},
            {"ZK_PUBLIC_URL": "https://notes.example.com?", "ZK_ACCESS_TOKEN": self.TOKEN},
            {"ZK_PUBLIC_URL": self.URL, "ZK_ACCESS_TOKEN": "too-short"},
            {"ZK_PUBLIC_URL": self.URL, "ZK_ACCESS_TOKEN": "a" * 31 + "\n"},
        ]
        for environment in cases:
            with self.subTest(public_url=environment["ZK_PUBLIC_URL"], token_length=len(environment["ZK_ACCESS_TOKEN"])):
                with patch.dict(os.environ, environment):
                    with self.assertRaises(RuntimeError):
                        module._load_cloud_config()

    def test_cloud_api_requires_token_and_limits_dashboard_origin(self):
        from server import app as module

        with tempfile.TemporaryDirectory() as temporary:
            try:
                with patch.dict(os.environ, {
                    "ZK_PUBLIC_URL": self.URL,
                    "ZK_ACCESS_TOKEN": self.TOKEN,
                    "VIDEO_KNOWLEDGE_DATA_DIR": temporary,
                }):
                    importlib.reload(module)
                    client = TestClient(module.app, base_url=self.URL)
                    bearer = {"Authorization": f"Bearer {self.TOKEN}"}
                    unauthorized = client.get("/api/status")
                    self.assertEqual(unauthorized.status_code, 401)
                    self.assertEqual(unauthorized.headers["cache-control"], "no-store")
                    self.assertEqual(client.get("/api/videos").status_code, 401)
                    self.assertEqual(client.get("/api/unknown").status_code, 401)
                    self.assertEqual(client.get("/api/status", headers={
                        "Authorization": "Bearer incorrect",
                    }).status_code, 401)
                    status = client.get("/api/status", headers=bearer)
                    self.assertEqual(status.status_code, 200)
                    self.assertEqual(status.headers["cache-control"], "no-store")
                    self.assertNotIn("data_dir", status.json())
                    self.assertEqual(client.get("/api/status", headers={
                        **bearer, "Host": "attacker.example",
                    }).status_code, 400)
                    self.assertEqual(client.post("/api/settings", json={
                        "model": "test-model",
                    }, headers={**bearer, "Origin": "http://127.0.0.1:8765"}).status_code, 403)
                    self.assertEqual(client.post("/api/settings", json={
                        "model": "test-model",
                    }, headers={**bearer, "Origin": self.URL}).status_code, 200)
                    self.assertEqual(client.get("/api/settings", headers=bearer).json()["model"], "test-model")
                    extension_origin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    preflight = client.options("/api/import-course-summary", headers={
                        "Origin": extension_origin,
                        "Access-Control-Request-Method": "POST",
                        "Access-Control-Request-Headers": "authorization,content-type",
                    })
                    self.assertEqual(preflight.status_code, 200)
                    self.assertEqual(preflight.headers["cache-control"], "no-store")
                    self.assertIn("authorization", preflight.headers["access-control-allow-headers"].lower())
                    self.assertEqual(preflight.headers["access-control-allow-origin"], extension_origin)
                    self.assertEqual(client.post("/api/import-course-summary", json={}, headers={
                        "Origin": extension_origin,
                    }).status_code, 401)
                    with patch.object(module, "fetch_metadata", return_value=Metadata("云端课程", 42, 120)):
                        imported = client.post(
                            "/api/import-course-summary",
                            json=CourseSummaryImportTests.payload(),
                            headers={**bearer, "Origin": extension_origin},
                        )
                    self.assertEqual(imported.status_code, 200)
                    self.assertTrue(imported.json()["imported"])
                    self.assertEqual(len(client.get("/api/videos", headers=bearer).json()), 1)
            finally:
                module.executor.shutdown(wait=True)
                importlib.reload(module)


if __name__ == "__main__":
    unittest.main()
