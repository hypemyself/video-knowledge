"""Audio download and transcription fallback for videos without subtitles."""

from __future__ import annotations

import math
import re
import subprocess
import tempfile
from collections.abc import Callable
from pathlib import Path

from .ai import AIClient, ProviderError, check_cancelled
from .bilibili import VideoRef, normalize_segments


CHUNK_SECONDS = 600
MAX_DURATION_SECONDS = 4 * 60 * 60


def parse_transcription(payload: dict, offset: float, duration: float) -> list[dict]:
    raw_segments = payload.get("segments")
    if isinstance(raw_segments, list) and raw_segments:
        segments = []
        for item in raw_segments:
            if not isinstance(item, dict):
                continue
            text = str(item.get("text") or "").strip()
            try:
                start = float(item["start"])
                end = float(item["end"])
            except (KeyError, ValueError, TypeError):
                continue
            if text and math.isfinite(start) and math.isfinite(end) and 0 <= start <= end:
                bounded_start = min(start, duration)
                bounded_end = min(end, duration)
                if bounded_end > bounded_start:
                    segments.append({"start": offset + bounded_start, "end": offset + bounded_end, "text": text})
        if segments:
            return segments

    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ProviderError("音频转文字服务没有返回可用文字。")
    sentences = [part.strip() for part in re.split(r"(?<=[。！？.!?])\s*", text) if part.strip()]
    if not sentences:
        sentences = [text.strip()]
    total = sum(len(sentence) for sentence in sentences)
    segments = []
    cursor = offset
    for index, sentence in enumerate(sentences):
        end = offset + duration if index == len(sentences) - 1 else cursor + duration * len(sentence) / total
        segments.append({
            "start": cursor, "end": end, "text": sentence, "timestamp_approximate": True,
        })
        cursor = end
    return segments


def _download_audio(ref: VideoRef, directory: Path) -> tuple[Path, float]:
    try:
        import yt_dlp
    except ImportError as exc:
        raise ProviderError("缺少 yt-dlp，请运行启动脚本安装依赖。") from exc
    options = {
        "format": "bestaudio/best",
        "outtmpl": str(directory / "source.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "noprogress": True,
        "no_warnings": True,
        "cachedir": False,
    }
    try:
        with yt_dlp.YoutubeDL(options) as downloader:
            info = downloader.extract_info(ref.url, download=True)
    except Exception as exc:
        raise ProviderError(
            "无法下载视频音频。视频可能需要登录、受地区限制，或 B 站暂时拒绝下载。"
        ) from exc
    files = [path for path in directory.glob("source.*") if path.is_file()]
    if not files:
        raise ProviderError("音频下载完成后没有找到文件。")
    return files[0], float((info or {}).get("duration") or 0)


def transcribe_video(
    ref: VideoRef, duration_hint: float, ai: AIClient,
    progress: Callable[[int], None] | None = None,
    cancelled: Callable[[], bool] | None = None,
) -> list[dict]:
    check_cancelled(cancelled)
    try:
        from imageio_ffmpeg import get_ffmpeg_exe
    except ImportError as exc:
        raise ProviderError("缺少 FFmpeg，请运行启动脚本安装依赖。") from exc
    with tempfile.TemporaryDirectory(prefix="video-knowledge-") as temporary:
        directory = Path(temporary)
        source, downloaded_duration = _download_audio(ref, directory)
        check_cancelled(cancelled)
        duration = downloaded_duration or duration_hint
        if duration <= 0:
            raise ProviderError("无法确定视频时长，音频转文字未开始。")
        if duration > MAX_DURATION_SECONDS:
            raise ProviderError("视频超过 4 小时，请选择较短的视频或提供字幕。")
        ffmpeg = get_ffmpeg_exe()
        count = math.ceil(duration / CHUNK_SECONDS)
        transcript: list[dict] = []
        for index in range(count):
            check_cancelled(cancelled)
            start = index * CHUNK_SECONDS
            length = min(CHUNK_SECONDS, duration - start)
            chunk_file = directory / f"chunk-{index:03d}.mp3"
            command = [
                ffmpeg, "-nostdin", "-loglevel", "error", "-y", "-ss", str(start),
                "-t", str(length), "-i", str(source), "-vn", "-ac", "1", "-ar", "16000",
                "-c:a", "libmp3lame", "-b:a", "48k", str(chunk_file),
            ]
            try:
                completed = subprocess.run(command, capture_output=True, text=True, check=False)
            except OSError as exc:
                raise ProviderError("无法运行 FFmpeg 处理视频音频。") from exc
            if completed.returncode != 0 or not chunk_file.exists():
                raise ProviderError(f"FFmpeg 处理视频音频失败：{completed.stderr[-300:]}")
            check_cancelled(cancelled)
            with chunk_file.open("rb") as audio:
                payload = ai.transcribe(audio, chunk_file.name)
            transcript.extend(parse_transcription(payload, start, length))
            chunk_file.unlink(missing_ok=True)
            if progress:
                progress(30 + round((index + 1) / count * 40))
        return normalize_segments(transcript)
