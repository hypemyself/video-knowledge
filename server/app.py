"""API and dashboard for local use or a token-protected cloud deployment."""

from __future__ import annotations

import hmac
import os
import threading
import time
import uuid
import math
import re
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, FiniteFloat, field_validator

from .ai import AIClient, AnalysisCancelled, ProviderError, check_cancelled, summarize_segments
from .bilibili import (
    HEADERS, Metadata, VideoError, VideoRef, fetch_metadata, fetch_subtitles,
    normalize_segments, parse_video_url,
)
from .media import MAX_DURATION_SECONDS, transcribe_video
from .storage import Storage


class SegmentInput(BaseModel):
    start: float
    end: float
    text: str


class AnalyzeRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)
    title: str | None = Field(default=None, max_length=300)
    segments: list[SegmentInput] | None = None
    force: bool = False
    allow_transcription: bool = False


class PointPatch(BaseModel):
    title: str | None = Field(default=None, max_length=100)
    explanation: str | None = Field(default=None, max_length=500)
    category: str | None = Field(default=None, max_length=40)
    review_status: Literal["unreviewed", "needs_review", "reviewed"] | None = None


class TranscriptionRequired(VideoError):
    def __init__(self, duration_seconds: float):
        super().__init__("这个视频没有可用字幕。音频转文字可能产生费用，请确认后再开始整理。")
        self.duration_seconds = duration_seconds


class SettingsInput(BaseModel):
    base_url: str | None = None
    model: str | None = None
    transcription_model: str | None = None
    api_key: str | None = None


class CancelRequest(BaseModel):
    lease_id: str = Field(min_length=32, max_length=32)


class CourseSummaryPointInput(BaseModel):
    title: str = Field(min_length=1, max_length=100)
    explanation: str = Field(min_length=1, max_length=500)
    category: str = Field(min_length=1, max_length=40)
    time_seconds: FiniteFloat = Field(ge=0)
    evidence: str | None = Field(default=None, max_length=600)

    @field_validator("time_seconds", mode="before")
    @classmethod
    def number_not_boolean(cls, value):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("时间点必须是秒数。")
        return value


class CourseSummaryImportRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)
    overview: str = Field(min_length=1, max_length=800)
    points: list[CourseSummaryPointInput] = Field(min_length=1, max_length=100)


EXTENSION_ORIGIN_PATTERN = re.compile(r"^(chrome-extension|moz-extension)://[A-Za-z0-9-]+$")
LOCAL_DASHBOARD_ORIGINS = {"http://127.0.0.1:8765", "http://localhost:8765"}


def _load_cloud_config() -> tuple[str | None, str | None, str | None]:
    public_url = os.environ.get("ZK_PUBLIC_URL", "").strip()
    access_token = os.environ.get("ZK_ACCESS_TOKEN", "")
    if not public_url and not access_token:
        if os.environ.get("ZK_REQUIRE_AUTH") == "1":
            raise RuntimeError("Cloud deployment requires ZK_PUBLIC_URL and ZK_ACCESS_TOKEN.")
        return None, None, None
    if not public_url or not access_token:
        raise RuntimeError("Cloud mode requires both ZK_PUBLIC_URL and ZK_ACCESS_TOKEN.")
    try:
        parsed = urlsplit(public_url)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError as exc:
        raise RuntimeError("ZK_PUBLIC_URL must be a single HTTPS origin.") from exc
    if (
        parsed.scheme != "https" or not hostname or port == 443 or
        parsed.username is not None or parsed.password is not None or
        parsed.path not in ("", "/") or parsed.query or parsed.fragment or
        public_url not in (f"https://{parsed.netloc}", f"https://{parsed.netloc}/") or
        not re.fullmatch(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*", hostname) or
        any(label.startswith("-") or label.endswith("-") for label in hostname.split("."))
    ):
        raise RuntimeError("ZK_PUBLIC_URL must be a single HTTPS origin.")
    if len(access_token) < 32 or not access_token.isascii() or any(
        char.isspace() or ord(char) < 33 or ord(char) > 126 for char in access_token
    ):
        raise RuntimeError("ZK_ACCESS_TOKEN must contain at least 32 visible ASCII characters.")
    origin = f"https://{hostname}" + (f":{port}" if port is not None else "")
    return origin, access_token, hostname


CLOUD_PUBLIC_URL, CLOUD_ACCESS_TOKEN, CLOUD_HOST = _load_cloud_config()
app = FastAPI(title="视频知识点整理", docs_url=None, redoc_url=None)


@app.middleware("http")
async def require_cloud_token(request: Request, call_next):
    path = request.url.path
    if CLOUD_ACCESS_TOKEN and (path == "/api" or path.startswith("/api/")) and request.method != "OPTIONS":
        scheme, separator, candidate = request.headers.get("authorization", "").partition(" ")
        if not separator or scheme.lower() != "bearer" or not hmac.compare_digest(
            candidate.encode("utf-8"), CLOUD_ACCESS_TOKEN.encode("utf-8")
        ):
            return JSONResponse(
                {"detail": "需要有效的访问令牌。"}, status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )
    return await call_next(request)


app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=["127.0.0.1", "localhost", *([CLOUD_HOST] if CLOUD_HOST else [])],
)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=EXTENSION_ORIGIN_PATTERN.pattern,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type", "Authorization"],
)


@app.middleware("http")
async def prevent_cloud_api_caching(request: Request, call_next):
    response = await call_next(request)
    if CLOUD_ACCESS_TOKEN and (request.url.path == "/api" or request.url.path.startswith("/api/")):
        response.headers["Cache-Control"] = "no-store"
    return response


storage = Storage()
executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="video-knowledge")
jobs: dict[str, dict] = {}
active_jobs: dict[str, str] = {}
job_refs: dict[str, str] = {}
job_events: dict[str, threading.Event] = {}
job_futures: dict[str, Future] = {}
job_leases: dict[str, set[str]] = {}
job_video_ids: dict[str, str] = {}
job_finished_at: dict[str, float] = {}
deleted_jobs: set[str] = set()
jobs_lock = threading.Lock()
MAX_ACTIVE_JOBS = 4
JOB_TTL_SECONDS = 15 * 60
MAX_TERMINAL_JOBS = 48
TERMINAL_STATUSES = {"done", "error", "cancelled"}
def _require_dashboard_origin(request: Request) -> None:
    allowed_origins = {CLOUD_PUBLIC_URL} if CLOUD_PUBLIC_URL else LOCAL_DASHBOARD_ORIGINS
    if request.headers.get("origin") not in allowed_origins:
        raise HTTPException(403, "此操作只能在知点网页中完成。")


def _require_import_origin(request: Request) -> None:
    origin = request.headers.get("origin", "")
    allowed_origins = {CLOUD_PUBLIC_URL} if CLOUD_PUBLIC_URL else LOCAL_DASHBOARD_ORIGINS
    if origin not in allowed_origins and not EXTENSION_ORIGIN_PATTERN.fullmatch(origin):
        raise HTTPException(403, "此操作只能在知点网页或已安装的扩展中完成。")


def _prune_jobs_locked() -> None:
    now = time.monotonic()
    expired = [job_id for job_id, finished in job_finished_at.items() if now - finished >= JOB_TTL_SECONDS]
    excess = max(0, len(job_finished_at) - len(expired) - MAX_TERMINAL_JOBS)
    if excess:
        expired.extend(sorted(
            (job_id for job_id in job_finished_at if job_id not in expired),
            key=job_finished_at.__getitem__,
        )[:excess])
    for job_id in expired:
        jobs.pop(job_id, None)
        job_video_ids.pop(job_id, None)
        job_finished_at.pop(job_id, None)


def _finish_job_locked(job_id: str, state: dict) -> None:
    jobs[job_id].update(state)
    job_finished_at[job_id] = time.monotonic()
    _prune_jobs_locked()


def _public_settings(settings: dict) -> dict:
    return {
        "base_url": settings["base_url"],
        "model": settings["model"],
        "transcription_model": settings["transcription_model"],
        "has_api_key": bool(settings["api_key"].strip()),
    }


def _validate_settings(changes: dict) -> dict:
    cleaned = {}
    if "base_url" in changes:
        url = changes["base_url"].strip().rstrip("/")
        parsed = urlsplit(url)
        local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        if (parsed.scheme != "https" and not (parsed.scheme == "http" and local)) or not parsed.netloc or parsed.query or parsed.fragment or parsed.username:
            raise HTTPException(400, "AI 接口地址须为 HTTPS；本机服务可使用 HTTP。")
        cleaned["base_url"] = url
    for field in ("model", "transcription_model"):
        if field in changes:
            value = changes[field].strip()
            if not value or len(value) > 200:
                raise HTTPException(400, f"{field} 不能为空或超过 200 字符。")
            cleaned[field] = value
    if "api_key" in changes:
        value = changes["api_key"].strip()
        if len(value) > 1000:
            raise HTTPException(400, "API 密钥过长。")
        cleaned["api_key"] = value
    return cleaned


def _set_job(job_id: str, **changes) -> None:
    with jobs_lock:
        if job_id not in deleted_jobs:
            jobs[job_id].update(changes)


def _run_analysis(job_id: str, ref: VideoRef, request: AnalyzeRequest) -> None:
    final_state: dict = {}
    ai: AIClient | None = None
    cancelled = job_events[job_id].is_set
    try:
        check_cancelled(cancelled)
        settings = storage.settings()
        ai = AIClient(settings)
        _set_job(job_id, status="fetching", progress=10)
        check_cancelled(cancelled)
        provided = [segment.model_dump() for segment in request.segments] if request.segments is not None else None
        with httpx.Client(timeout=30, headers=HEADERS, follow_redirects=True) as client:
            try:
                metadata = fetch_metadata(client, ref)
            except (VideoError, httpx.HTTPError, ValueError) as exc:
                if provided is None:
                    raise VideoError(f"无法读取视频信息：{exc}") from exc
                metadata = Metadata(title=request.title or ref.bvid, cid=0, duration=0)

            check_cancelled(cancelled)
            if provided is not None:
                segments = normalize_segments(provided)
                source = "provided"
            else:
                segments = fetch_subtitles(client, ref, metadata.cid)
                source = "subtitle"
        check_cancelled(cancelled)
        if not segments:
            if provided is not None:
                raise VideoError("提供的字幕没有可用内容。")
            if not request.allow_transcription:
                raise TranscriptionRequired(metadata.duration)
            if metadata.duration > MAX_DURATION_SECONDS:
                raise VideoError("视频超过 4 小时，请选择较短的视频或提供字幕。")
            _set_job(job_id, status="transcribing", progress=30)
            segments = transcribe_video(
                ref, metadata.duration, ai,
                progress=lambda value: _set_job(job_id, progress=value),
                cancelled=cancelled,
            )
            source = "transcription"
        check_cancelled(cancelled)
        if not segments:
            raise VideoError("视频没有可用字幕，音频转文字也没有识别出内容。")
        _set_job(job_id, status="summarizing", progress=75)
        overview, points = summarize_segments(
            segments, ai, progress=lambda value: _set_job(job_id, progress=value),
            cancelled=cancelled,
            partial=lambda partial_overview, partial_points: _set_job(
                job_id, partial_overview=partial_overview, partial_points=partial_points,
            ),
        )
        result = {
            "id": ref.id,
            "bvid": ref.bvid,
            "page": ref.page,
            "url": ref.url,
            "title": metadata.title,
            "cover": metadata.cover,
            "duration": metadata.duration,
            "source": source,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "overview": overview,
            "points": points,
            "point_count": len(points),
            "categories": list(dict.fromkeys(point["category"] for point in points)),
            "segments": segments,
        }
        with jobs_lock:
            check_cancelled(cancelled)
            storage.save_video(result)
            final_state = {"status": "done", "progress": 100, "result": result}
    except AnalysisCancelled as exc:
        final_state = {"status": "cancelled", "error": str(exc), "progress": 100}
    except TranscriptionRequired as exc:
        final_state = (
            {"status": "cancelled", "error": "已取消整理。", "progress": 100}
            if cancelled() else {
                "status": "error", "error": str(exc), "error_code": "transcription_required",
                "duration_seconds": exc.duration_seconds, "progress": 100,
            }
        )
    except (VideoError, ProviderError, httpx.HTTPError, OSError, ValueError) as exc:
        final_state = (
            {"status": "cancelled", "error": "已取消整理。", "progress": 100}
            if cancelled() else {"status": "error", "error": str(exc), "progress": 100}
        )
    except Exception as exc:
        final_state = (
            {"status": "cancelled", "error": "已取消整理。", "progress": 100}
            if cancelled() else {"status": "error", "error": f"分析失败：{exc}", "progress": 100}
        )
    finally:
        if ai is not None:
            ai.close()
        with jobs_lock:
            if job_id in deleted_jobs:
                final_state = {"status": "cancelled", "error": "视频笔记已删除。", "progress": 100}
                jobs[job_id].pop("partial_points", None)
                jobs[job_id].pop("partial_overview", None)
            deleted_jobs.discard(job_id)
            if active_jobs.get(ref.id) == job_id:
                active_jobs.pop(ref.id)
            job_refs.pop(job_id, None)
            job_events.pop(job_id, None)
            job_futures.pop(job_id, None)
            job_leases.pop(job_id, None)
            _finish_job_locked(job_id, final_state)


@app.get("/api/status")
def status() -> dict:
    settings = storage.settings()
    result = {
        "configured": bool(settings["api_key"].strip()),
        "model": settings["model"],
        "base_url": settings["base_url"],
    }
    if not CLOUD_PUBLIC_URL:
        result["data_dir"] = str(storage.data_dir.resolve())
    return result


@app.get("/api/settings")
def get_settings() -> dict:
    return _public_settings(storage.settings())


@app.post("/api/settings")
def post_settings(input: SettingsInput, request: Request) -> dict:
    _require_dashboard_origin(request)
    changes = {key: value for key, value in input.model_dump().items() if value is not None}
    return _public_settings(storage.save_settings(_validate_settings(changes)))


@app.post("/api/analyze")
def analyze(request: AnalyzeRequest) -> dict:
    try:
        with httpx.Client(timeout=20, headers=HEADERS) as client:
            ref = parse_video_url(request.url, client=client)
        if request.segments is not None:
            normalize_segments([segment.model_dump() for segment in request.segments])
    except (VideoError, httpx.HTTPError) as exc:
        raise HTTPException(400, str(exc)) from exc

    with jobs_lock:
        _prune_jobs_locked()
        active = active_jobs.get(ref.id)
        if active:
            lease_id = uuid.uuid4().hex
            job_leases[active].add(lease_id)
            return {"job_id": active, "lease_id": lease_id}
        if not request.force:
            cached = storage.get_by_video(ref.bvid, ref.page)
            if cached:
                job_id = uuid.uuid4().hex
                jobs[job_id] = {"status": "done", "progress": 100, "result": cached}
                job_video_ids[job_id] = ref.id
                job_finished_at[job_id] = time.monotonic()
                _prune_jobs_locked()
                return {"job_id": job_id, "lease_id": None}
        if not storage.settings()["api_key"].strip():
            raise HTTPException(400, "请先在知点设置中配置 AI 服务 API 密钥。")
        if len(job_events) >= MAX_ACTIVE_JOBS:
            raise HTTPException(429, "已有 4 个视频正在排队或整理，请稍后再试。")
        job_id = uuid.uuid4().hex
        lease_id = uuid.uuid4().hex
        jobs[job_id] = {"status": "queued", "progress": 0}
        active_jobs[ref.id] = job_id
        job_refs[job_id] = ref.id
        job_video_ids[job_id] = ref.id
        job_events[job_id] = threading.Event()
        job_leases[job_id] = {lease_id}
        try:
            job_futures[job_id] = executor.submit(_run_analysis, job_id, ref, request)
        except RuntimeError as exc:
            active_jobs.pop(ref.id, None)
            job_refs.pop(job_id, None)
            job_video_ids.pop(job_id, None)
            job_events.pop(job_id, None)
            job_leases.pop(job_id, None)
            jobs.pop(job_id, None)
            raise HTTPException(503, "任务服务暂时不可用，请重启服务。") from exc
    return {"job_id": job_id, "lease_id": lease_id}


@app.post("/api/import-course-summary")
def import_course_summary(input: CourseSummaryImportRequest, request: Request) -> dict:
    _require_import_origin(request)
    try:
        with httpx.Client(timeout=20, headers=HEADERS) as client:
            ref = parse_video_url(input.url, client=client)
            metadata = fetch_metadata(client, ref)
    except VideoError as exc:
        raise HTTPException(400, str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"无法从 B 站核对视频信息：{exc}") from exc
    except (ValueError, TypeError) as exc:
        raise HTTPException(502, "B 站视频信息格式错误，无法核对课程总结。") from exc

    if not math.isfinite(metadata.duration) or metadata.duration <= 0:
        raise HTTPException(502, "B 站没有提供可核对的视频时长。")
    overview = input.overview.strip()
    if not overview:
        raise HTTPException(400, "课程总结不能为空。")
    points = []
    for index, point in enumerate(input.points, start=1):
        title = point.title.strip()
        explanation = point.explanation.strip()
        category = point.category.strip()
        if not title or not explanation or not category:
            raise HTTPException(400, f"第 {index} 个知识点的标题、解释和分类不能为空。")
        if point.time_seconds > metadata.duration:
            raise HTTPException(400, f"第 {index} 个知识点的时间超出视频时长。")
        points.append({
            "id": f"P{index:03d}",
            "title": title,
            "explanation": explanation,
            "category": category,
            "time_seconds": float(point.time_seconds),
            "evidence": (point.evidence or "").strip(),
            "timestamp_approximate": False,
            "review_status": "unreviewed",
        })

    result = {
        "id": ref.id,
        "bvid": ref.bvid,
        "page": ref.page,
        "url": ref.url,
        "title": metadata.title,
        "cover": metadata.cover,
        "duration": metadata.duration,
        "source": "bilibili_course_summary",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "overview": overview,
        "points": points,
        "point_count": len(points),
        "categories": list(dict.fromkeys(point["category"] for point in points)),
        "segments": [],
    }
    with jobs_lock:
        if any(video_id == ref.id and job_id in job_events for job_id, video_id in job_video_ids.items()):
            raise HTTPException(409, "这个视频正在整理，请等待当前任务结束后再保存课程总结。")
        existing = storage.get_by_video(ref.bvid, ref.page)
        if existing is not None:
            return {"result": existing, "imported": False}
        storage.save_video(result)
    return {"result": result, "imported": True}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    with jobs_lock:
        _prune_jobs_locked()
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(404, "任务不存在、已过期或服务已重新启动。")
        return dict(job)


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str, input: CancelRequest) -> dict:
    with jobs_lock:
        _prune_jobs_locked()
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(404, "任务不存在、已过期或服务已重新启动。")
        if job["status"] in TERMINAL_STATUSES:
            return {"cancelled": False, "released": False, "remaining_subscribers": 0}
        leases = job_leases[job_id]
        if input.lease_id not in leases:
            return {"cancelled": False, "released": False, "remaining_subscribers": len(leases)}
        leases.remove(input.lease_id)
        if leases:
            return {"cancelled": False, "released": True, "remaining_subscribers": len(leases)}
        event = job_events[job_id]
        event.set()
        video_id = job_refs[job_id]
        if active_jobs.get(video_id) == job_id:
            active_jobs.pop(video_id)
        future = job_futures[job_id]
        if future.cancel():
            job_refs.pop(job_id)
            job_events.pop(job_id, None)
            job_futures.pop(job_id, None)
            job_leases.pop(job_id, None)
            _finish_job_locked(job_id, {"status": "cancelled", "progress": 100, "error": "已取消整理。"})
        return {"cancelled": True, "released": True, "remaining_subscribers": 0}


@app.get("/api/videos")
def list_videos() -> list[dict]:
    return storage.list_videos()


@app.get("/api/search")
def search_points(q: str = Query(default="", max_length=200)) -> dict:
    return {"results": storage.search_points(q)}


@app.get("/api/videos/{video_id}")
def get_video(video_id: str) -> dict:
    result = storage.get_video(video_id)
    if result is None:
        raise HTTPException(404, "没有找到这份视频笔记。")
    return result


@app.patch("/api/videos/{video_id}/points/{point_id}")
def update_point(video_id: str, point_id: str, patch: PointPatch, request: Request) -> dict:
    _require_dashboard_origin(request)
    changes = patch.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(400, "请提供需要修改的知识点内容或核对状态。")
    for key, value in changes.items():
        if value is None or (isinstance(value, str) and not value.strip()):
            raise HTTPException(400, f"{key} 不能为空。")
        if key != "review_status":
            changes[key] = value.strip()
    with jobs_lock:
        point = storage.update_point(video_id, point_id, changes)
        if point is None:
            raise HTTPException(404, "没有找到这条知识点。")
        for job_id, job in jobs.items():
            if job_video_ids.get(job_id) != video_id or job.get("status") != "done":
                continue
            cached_result = job.get("result")
            if cached_result:
                for cached_point in cached_result.get("points", []):
                    if cached_point.get("id") == point_id:
                        cached_point.update(changes)
                cached_result["categories"] = list(dict.fromkeys(
                    item.get("category") or "未分类" for item in cached_result.get("points", [])
                ))
    return {"point": point}


@app.delete("/api/videos/{video_id}")
def delete_video(video_id: str, request: Request) -> dict:
    _require_dashboard_origin(request)
    with jobs_lock:
        if not storage.delete_video(video_id):
            raise HTTPException(404, "没有找到这份视频笔记。")
        active = active_jobs.get(video_id)
        if active:
            job_events[active].set()
            deleted_jobs.add(active)
            jobs[active].pop("partial_points", None)
            jobs[active].pop("partial_overview", None)
            active_jobs.pop(video_id, None)
        for job_id, related_video in list(job_video_ids.items()):
            if related_video == video_id and job_id in job_finished_at:
                jobs.pop(job_id, None)
                job_video_ids.pop(job_id, None)
                job_finished_at.pop(job_id, None)
    return {"deleted": True}


WEB_DIR = Path(__file__).resolve().parents[1] / "web"
app.mount("/", StaticFiles(directory=WEB_DIR, html=True, check_dir=False), name="web")
