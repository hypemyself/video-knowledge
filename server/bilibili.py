"""Bilibili URL, metadata, and public subtitle access."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from urllib.parse import parse_qs, urljoin, urlsplit

import httpx


VIEW_API = "https://api.bilibili.com/x/web-interface/view"
PLAYER_API = "https://api.bilibili.com/x/player/v2"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36",
    "Referer": "https://www.bilibili.com/",
}
BVID_PATTERN = re.compile(r"BV[0-9A-Za-z]{10}")
SUBTITLE_HOSTS = frozenset({
    "aisubtitle.hdslb.com", "i0.hdslb.com", "i1.hdslb.com", "i2.hdslb.com",
})


class VideoError(ValueError):
    pass


@dataclass(frozen=True)
class VideoRef:
    bvid: str
    page: int

    @property
    def url(self) -> str:
        return f"https://www.bilibili.com/video/{self.bvid}/?p={self.page}"

    @property
    def id(self) -> str:
        return f"{self.bvid}-p{self.page}"


@dataclass(frozen=True)
class Metadata:
    title: str
    cid: int
    duration: float
    cover: str | None = None


def _allowed_host(host: str | None) -> bool:
    return bool(host and (host == "bilibili.com" or host.endswith(".bilibili.com") or host == "b23.tv"))


def _safe_url(url: str, hosts: frozenset[str] | None = None, *, allow_http: bool = False) -> bool:
    try:
        parsed = urlsplit(url)
        return (
            parsed.scheme in ({"http", "https"} if allow_http else {"https"})
            and (parsed.hostname in hosts if hosts is not None else _allowed_host(parsed.hostname))
            and parsed.username is None
            and parsed.password is None
            and parsed.port in (None, 80 if parsed.scheme == "http" else 443)
        )
    except ValueError:
        return False


def _resolve_short_url(url: str, client: httpx.Client) -> str:
    for _ in range(5):
        if not _safe_url(url):
            raise VideoError("只能分析哔哩哔哩视频链接。")
        parsed = urlsplit(url)
        if parsed.hostname != "b23.tv":
            return url
        response = client.get(url, follow_redirects=False)
        if not response.is_redirect:
            response.raise_for_status()
        location = response.headers.get("location")
        if not location:
            raise VideoError("B 站短链接没有返回视频地址。")
        url = urljoin(url, location)
    raise VideoError("B 站短链接重定向次数过多。")


def parse_video_url(url: str, client: httpx.Client | None = None) -> VideoRef:
    raw = url.strip()
    if BVID_PATTERN.fullmatch(raw):
        return VideoRef(raw, 1)
    if not _safe_url(raw, allow_http=True):
        raise VideoError("请输入哔哩哔哩视频链接，例如 https://www.bilibili.com/video/BV... 。")
    parsed = urlsplit(raw)
    if parsed.hostname == "b23.tv":
        if client is None:
            raise VideoError("解析 B 站短链接需要网络连接。")
        raw = _resolve_short_url(raw, client)
        parsed = urlsplit(raw)
    match = re.search(r"/video/(BV[0-9A-Za-z]{10})(?:/|$)", parsed.path)
    if not match:
        raise VideoError("链接中没有找到 BV 号，请使用视频播放页地址。")
    page_text = parse_qs(parsed.query).get("p", ["1"])[0]
    try:
        page = int(page_text)
    except ValueError as exc:
        raise VideoError("分 P 参数必须是正整数。") from exc
    if page < 1 or page > 10000:
        raise VideoError("分 P 参数必须在 1 到 10000 之间。")
    return VideoRef(match.group(1), page)


def _api_data(client: httpx.Client, url: str, params: dict) -> dict:
    response = client.get(url, params=params)
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict) or payload.get("code") != 0:
        message = payload.get("message", "未知错误") if isinstance(payload, dict) else "响应格式错误"
        raise VideoError(f"B 站接口返回错误：{message}")
    data = payload.get("data")
    if not isinstance(data, dict):
        raise VideoError("B 站接口缺少视频信息。")
    return data


def fetch_metadata(client: httpx.Client, ref: VideoRef) -> Metadata:
    data = _api_data(client, VIEW_API, {"bvid": ref.bvid})
    pages = data.get("pages") or []
    if not isinstance(pages, list) or ref.page > len(pages):
        raise VideoError(f"这个视频没有第 {ref.page} P。")
    selected = pages[ref.page - 1]
    if not isinstance(selected, dict) or not selected.get("cid"):
        raise VideoError("B 站没有返回当前分 P 的编号。")
    base_title = str(data.get("title") or ref.bvid).strip()
    part_title = str(selected.get("part") or "").strip()
    title = f"{base_title} - P{ref.page} {part_title}" if len(pages) > 1 and part_title else base_title
    duration = float(selected.get("duration") or data.get("duration") or 0)
    cover = data.get("pic")
    if isinstance(cover, str) and cover.startswith("//"):
        cover = "https:" + cover
    elif isinstance(cover, str) and cover.startswith("http://"):
        cover = "https://" + cover.removeprefix("http://")
    return Metadata(
        title=title, cid=int(selected["cid"]), duration=duration,
        cover=cover if isinstance(cover, str) and cover.startswith("https://") else None,
    )


def fetch_subtitles(client: httpx.Client, ref: VideoRef, cid: int) -> list[dict]:
    try:
        data = _api_data(client, PLAYER_API, {"bvid": ref.bvid, "cid": cid})
        subtitles = (data.get("subtitle") or {}).get("subtitles") or []
    except (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError):
        return []
    if not isinstance(subtitles, list):
        return []
    subtitles = [item for item in subtitles if isinstance(item, dict)]
    subtitles.sort(key=lambda item: not str(item.get("lan", "")).startswith(("zh", "ai-zh")))
    for subtitle in subtitles:
        try:
            subtitle_url = subtitle.get("subtitle_url")
            if not isinstance(subtitle_url, str) or not subtitle_url:
                continue
            if subtitle_url.startswith("//"):
                subtitle_url = "https:" + subtitle_url
            for _ in range(5):
                if not _safe_url(subtitle_url, SUBTITLE_HOSTS):
                    raise VideoError("B 站字幕地址不可信。")
                response = client.get(subtitle_url, follow_redirects=False)
                if not response.is_redirect:
                    response.raise_for_status()
                    break
                location = response.headers.get("location")
                if not location:
                    raise VideoError("B 站字幕重定向缺少地址。")
                subtitle_url = urljoin(subtitle_url, location)
            else:
                raise VideoError("B 站字幕重定向次数过多。")
            body = response.json().get("body", [])
            segments = []
            for item in body:
                text = str(item.get("content") or "").strip()
                if text:
                    segments.append({"start": item.get("from"), "end": item.get("to"), "text": text})
            normalized = normalize_segments(segments)
            if normalized:
                return normalized
        except (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError):
            continue
    return []


def normalize_segments(segments: list[dict]) -> list[dict]:
    if len(segments) > 10000:
        raise VideoError("字幕片段过多，请换一个较短的视频。")
    result = []
    total_characters = 0
    for item in segments:
        if not isinstance(item, dict):
            raise VideoError("字幕片段格式错误。")
        text = item.get("text")
        if not isinstance(text, str):
            raise VideoError("字幕片段缺少文本。")
        text = text.strip()
        if not text:
            continue
        if len(text) > 4000:
            raise VideoError("单条字幕过长。")
        total_characters += len(text)
        if total_characters > 500000:
            raise VideoError("字幕总长度超过 50 万字，请分析更短的视频。")
        try:
            start = float(item["start"])
            end = float(item["end"])
        except (KeyError, TypeError, ValueError) as exc:
            raise VideoError("字幕片段需要数字类型的开始和结束时间。") from exc
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end < start:
            raise VideoError("字幕时间戳无效。")
        result.append({
            "start": start, "end": end, "text": text,
            "timestamp_approximate": bool(item.get("timestamp_approximate", False)),
        })
    result.sort(key=lambda item: (item["start"], item["end"]))
    for index, item in enumerate(result, start=1):
        item["id"] = f"S{index:05d}"
    return result
