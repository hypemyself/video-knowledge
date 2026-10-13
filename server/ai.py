"""OpenAI-compatible calls and transcript-grounded knowledge extraction."""

from __future__ import annotations

import json
import re
from collections.abc import Callable

import httpx


class ProviderError(RuntimeError):
    pass


class AnalysisCancelled(RuntimeError):
    pass


def check_cancelled(cancelled: Callable[[], bool] | None) -> None:
    if cancelled and cancelled():
        raise AnalysisCancelled("已取消整理。")


def _endpoint(base_url: str, suffix: str) -> str:
    return base_url.rstrip("/") + suffix


def _provider_error(response: httpx.Response) -> ProviderError:
    try:
        data = response.json()
        detail = data.get("error", {}).get("message") or data.get("message")
    except (ValueError, AttributeError, TypeError):
        detail = None
    return ProviderError(f"AI 服务返回 HTTP {response.status_code}：{str(detail or response.text)[:300]}")


def _json_content(content: str) -> dict:
    content = content.strip()
    if content.startswith("```"):
        content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content, flags=re.IGNORECASE).strip()
    try:
        result = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ProviderError("AI 服务没有返回可解析的 JSON，请重试或更换模型。") from exc
    if not isinstance(result, dict):
        raise ProviderError("AI 服务返回的 JSON 格式不正确。")
    return result


class AIClient:
    def __init__(self, settings: dict, client: httpx.Client | None = None):
        self.settings = settings
        self._owns_client = client is None
        self.client = client or httpx.Client(timeout=120)

    def close(self) -> None:
        if self._owns_client:
            self.client.close()

    @property
    def headers(self) -> dict:
        return {"Authorization": f"Bearer {self.settings['api_key']}"}

    def chat_json(self, system: str, prompt: str) -> dict:
        try:
            response = self.client.post(
                _endpoint(self.settings["base_url"], "/chat/completions"),
                headers=self.headers,
                json={
                    "model": self.settings["model"],
                    "temperature": 0.2,
                    "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
                },
            )
        except httpx.HTTPError as exc:
            raise ProviderError(f"无法连接 AI 服务：{exc}") from exc
        if response.is_error:
            raise _provider_error(response)
        try:
            content = response.json()["choices"][0]["message"]["content"]
            if isinstance(content, list):
                content = "".join(str(part.get("text", "")) for part in content if isinstance(part, dict))
            if not isinstance(content, str):
                raise TypeError("message.content")
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise ProviderError("AI 服务响应缺少回答内容。") from exc
        return _json_content(content)

    def transcribe(self, audio_file, filename: str) -> dict:
        url = _endpoint(self.settings["base_url"], "/audio/transcriptions")
        common = {"model": self.settings["transcription_model"]}
        attempts = [
            {"response_format": "verbose_json", "timestamp_granularities[]": "segment"},
            {"response_format": "verbose_json"},
            {"response_format": "json"},
        ]
        for index, format_options in enumerate(attempts):
            audio_file.seek(0)
            data = {**common, **format_options}
            try:
                response = self.client.post(
                    url, headers=self.headers, data=data,
                    files={"file": (filename, audio_file, "audio/mpeg")},
                    timeout=180,
                )
            except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
                raise ProviderError(
                    "无法连接音频转文字服务。请检查本机网络或代理，并确认设置中的 AI 接口地址可访问。"
                ) from exc
            except httpx.HTTPError as exc:
                raise ProviderError(f"音频转文字服务请求失败：{exc}") from exc
            if response.status_code in {400, 422} and index < len(attempts) - 1:
                continue
            if response.is_error:
                raise _provider_error(response)
            try:
                payload = response.json()
            except ValueError as exc:
                raise ProviderError("音频转文字服务没有返回 JSON。") from exc
            if not isinstance(payload, dict):
                raise ProviderError("音频转文字服务返回格式错误。")
            return payload
        raise ProviderError("音频转文字服务不支持当前请求格式。")


def chunk_segments(segments: list[dict], max_chars: int = 8000, max_segments: int = 90) -> list[list[dict]]:
    chunks: list[list[dict]] = []
    current: list[dict] = []
    length = 0
    for segment in segments:
        size = len(segment["text"]) + 35
        if current and (length + size > max_chars or len(current) >= max_segments):
            chunks.append(current)
            current = []
            length = 0
        current.append(segment)
        length += size
    if current:
        chunks.append(current)
    return chunks


def ground_candidates(payload: dict, segments: list[dict]) -> list[dict]:
    """Reject points with missing or invented citations; take evidence and time from transcript."""
    by_id = {segment["id"]: segment for segment in segments}
    raw_points = payload.get("points", [])
    if not isinstance(raw_points, list):
        return []
    candidates = []
    for point in raw_points:
        if not isinstance(point, dict):
            continue
        title = point.get("title")
        explanation = point.get("explanation")
        category = point.get("category")
        citations = point.get("segment_ids")
        if not all(isinstance(value, str) and value.strip() for value in (title, explanation, category)):
            continue
        if not isinstance(citations, list) or not citations or any(
            not isinstance(cid, str) or cid not in by_id for cid in citations
        ):
            continue
        cited = sorted((by_id[cid] for cid in dict.fromkeys(citations)), key=lambda segment: segment["start"])
        evidence = " / ".join(segment["text"] for segment in cited)[:600]
        candidates.append({
            "category": category.strip()[:40],
            "title": title.strip()[:100],
            "explanation": explanation.strip()[:500],
            "time_seconds": round(cited[0]["start"], 2),
            "evidence": evidence,
            "segment_ids": [segment["id"] for segment in cited],
            "timestamp_approximate": any(segment.get("timestamp_approximate", False) for segment in cited),
        })
    return candidates


def _segment_prompt(chunk: list[dict]) -> str:
    lines = [f"[{s['id']} {s['start']:.1f}-{s['end']:.1f}秒] {s['text']}" for s in chunk]
    return (
        "请从以下视频字幕提炼值得记住的知识点。只根据字幕内容回答，不补充外部事实。"
        "请返回 JSON 对象：{\"overview\":\"本段概述\",\"points\":["
        "{\"category\":\"分类\",\"title\":\"知识点标题\","
        "\"explanation\":\"简洁解释\",\"segment_ids\":[\"S00001\"]}]}。"
        "每个知识点引用 1 到 3 个直接支持它的字幕 ID，不能编造 ID；内容空泛时可以少写。"
        "每段提取 3 到 7 个不同知识点。使用中文。\n\n"
        + "\n".join(lines)
    )


def _deduplicate(points: list[dict]) -> list[dict]:
    seen = set()
    result = []
    for point in points:
        key = re.sub(r"\W", "", point["title"]).casefold()
        if key in seen:
            continue
        seen.add(key)
        result.append(point)
    return result


def summarize_segments(
    segments: list[dict], ai: AIClient, progress: Callable[[int], None] | None = None,
    cancelled: Callable[[], bool] | None = None,
    partial: Callable[[str, list[dict]], None] | None = None,
) -> tuple[str, list[dict]]:
    check_cancelled(cancelled)
    if not segments:
        raise ProviderError("没有可用字幕，无法提炼知识点。")
    chunks = chunk_segments(segments)
    candidates: list[dict] = []
    overviews: list[str] = []
    for index, chunk in enumerate(chunks):
        check_cancelled(cancelled)
        payload = ai.chat_json(
            "你是一位严谨的课程笔记编辑。只输出合法 JSON，不使用 Markdown。",
            _segment_prompt(chunk),
        )
        overview = payload.get("overview")
        if isinstance(overview, str) and overview.strip():
            overviews.append(overview.strip()[:400])
        candidates.extend(ground_candidates(payload, chunk))
        if partial:
            preview = _deduplicate(candidates)
            if len(preview) > 40:
                preview = [preview[round(number * (len(preview) - 1) / 39)] for number in range(40)]
            partial(" ".join(overviews[-3:])[:800], [
                {"id": f"P{number:03d}", "review_status": "unreviewed", **point}
                for number, point in enumerate(preview, start=1)
            ])
        if progress:
            progress(75 + round((index + 1) / len(chunks) * 18))
    candidates = _deduplicate(candidates)
    if not candidates:
        raise ProviderError("AI 没有返回可核对字幕的知识点，请重试或更换模型。")

    if len(chunks) == 1:
        overview = overviews[0] if overviews else "本视频的重点见下方知识点。"
        selected = candidates
    else:
        check_cancelled(cancelled)
        # Preserve coverage across a long video when keeping the consolidation request bounded.
        if len(candidates) > 120:
            step = len(candidates) / 120
            candidates = [candidates[int(index * step)] for index in range(120)]
        brief = [
            {"id": f"C{index:03d}", "category": p["category"], "title": p["title"],
             "explanation": p["explanation"]}
            for index, p in enumerate(candidates, start=1)
        ]
        merged = ai.chat_json(
            "你是一位严谨的课程笔记编辑。只输出合法 JSON，不使用 Markdown。",
            "根据这些已经核对字幕的分段概述和候选知识点，写一个整段视频概述，"
            "并选取最重要、覆盖视频各部分的最多 20 个候选 ID。只能选提供的 ID。"
            "返回 JSON：{\"overview\":\"...\",\"point_ids\":[\"C001\"]}。\n"
            + json.dumps({"overviews": overviews, "candidates": brief}, ensure_ascii=False),
        )
        ids = merged.get("point_ids")
        by_id = {item["id"]: candidates[index] for index, item in enumerate(brief)}
        unique_ids = dict.fromkeys(point_id for point_id in ids if isinstance(point_id, str)) if isinstance(ids, list) else {}
        selected = [by_id[point_id] for point_id in unique_ids if point_id in by_id]
        if not selected:
            selected = candidates[:20]
        overview = merged.get("overview")
        if not isinstance(overview, str) or not overview.strip():
            overview = " ".join(overviews[:3])
    points = [
        {"id": f"P{index:03d}", "review_status": "unreviewed", **point}
        for index, point in enumerate(selected[:20], start=1)
    ]
    return overview.strip()[:800], points
