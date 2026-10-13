"""Per-user settings and cached video summaries."""

from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from threading import RLock
from collections.abc import Iterator


DEFAULT_SETTINGS = {
    "base_url": "https://api.openai.com/v1",
    "model": "gpt-4o-mini",
    "transcription_model": "whisper-1",
    "api_key": "",
}


def default_data_dir() -> Path:
    override = os.environ.get("VIDEO_KNOWLEDGE_DATA_DIR")
    if override:
        return Path(override).expanduser()
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "VideoKnowledge"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "video-knowledge"


class Storage:
    def __init__(self, data_dir: Path | None = None):
        self.data_dir = data_dir or default_data_dir()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.config_path = self.data_dir / "config.json"
        self.db_path = self.data_dir / "videos.sqlite3"
        self._settings_lock = RLock()
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=30)
        connection.row_factory = sqlite3.Row
        return connection

    @contextmanager
    def _session(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _init_db(self) -> None:
        with self._session() as db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS videos (
                    id TEXT PRIMARY KEY,
                    bvid TEXT NOT NULL,
                    page INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    url TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    overview TEXT NOT NULL,
                    point_count INTEGER NOT NULL,
                    result_json TEXT NOT NULL,
                    UNIQUE (bvid, page)
                )
            """)

    def settings(self) -> dict:
        with self._settings_lock:
            if not self.config_path.exists():
                return DEFAULT_SETTINGS.copy()
            try:
                saved = json.loads(self.config_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError) as exc:
                raise RuntimeError("设置文件无法读取，请检查本地配置文件。") from exc
            return {**DEFAULT_SETTINGS, **saved}

    def save_settings(self, changes: dict) -> dict:
        with self._settings_lock:
            settings = self.settings()
            settings.update(changes)
            temporary = self.config_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")
            if os.name != "nt":
                temporary.chmod(0o600)
            temporary.replace(self.config_path)
            return settings

    def get_video(self, video_id: str) -> dict | None:
        with self._session() as db:
            row = db.execute("SELECT result_json FROM videos WHERE id = ?", (video_id,)).fetchone()
            return self._decode_result(row["result_json"]) if row else None

    def get_by_video(self, bvid: str, page: int) -> dict | None:
        with self._session() as db:
            row = db.execute(
                "SELECT result_json FROM videos WHERE bvid = ? AND page = ?", (bvid, page)
            ).fetchone()
            return self._decode_result(row["result_json"]) if row else None

    @staticmethod
    def _decode_result(raw: str) -> dict:
        result = json.loads(raw)
        for point in result.get("points", []):
            point.setdefault("review_status", "unreviewed")
        return result

    def list_videos(self) -> list[dict]:
        with self._session() as db:
            rows = db.execute(
                "SELECT id, bvid, page, title, url, created_at, overview, point_count, result_json "
                "FROM videos ORDER BY created_at DESC"
            ).fetchall()
            result = []
            for row in rows:
                item = dict(row)
                detail = self._decode_result(item.pop("result_json"))
                item["cover"] = detail.get("cover")
                item["duration"] = detail.get("duration")
                result.append(item)
            return result

    def search_points(self, query: str) -> list[dict]:
        needle = query.strip().casefold()
        if not needle:
            return []
        with self._session() as db:
            rows = db.execute(
                "SELECT id, title, url, result_json FROM videos ORDER BY created_at DESC"
            ).fetchall()
        matches = []
        for row in rows:
            result = self._decode_result(row["result_json"])
            for point in result.get("points", []):
                searchable = " ".join(str(point.get(field) or "") for field in (
                    "title", "explanation", "category", "evidence",
                ))
                if needle in searchable.casefold():
                    matches.append({
                        "video_id": row["id"],
                        "video_title": row["title"],
                        "video_url": row["url"],
                        "point": point,
                    })
        return matches

    def update_point(self, video_id: str, point_id: str, changes: dict) -> dict | None:
        with self._session() as db:
            row = db.execute("SELECT result_json FROM videos WHERE id = ?", (video_id,)).fetchone()
            if row is None:
                return None
            result = self._decode_result(row["result_json"])
            point = next((item for item in result.get("points", []) if item.get("id") == point_id), None)
            if point is None:
                return None
            point.update(changes)
            result["categories"] = list(dict.fromkeys(
                item.get("category") or "未分类" for item in result.get("points", [])
            ))
            db.execute(
                "UPDATE videos SET result_json = ? WHERE id = ?",
                (json.dumps(result, ensure_ascii=False), video_id),
            )
            return point.copy()

    def save_video(self, result: dict) -> None:
        with self._session() as db:
            db.execute(
                """INSERT INTO videos
                   (id, bvid, page, title, url, created_at, overview, point_count, result_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(bvid, page) DO UPDATE SET
                     title=excluded.title, url=excluded.url,
                     created_at=excluded.created_at, overview=excluded.overview,
                     point_count=excluded.point_count, result_json=excluded.result_json""",
                (
                    result["id"], result["bvid"], result["page"], result["title"],
                    result["url"], result["created_at"], result["overview"],
                    len(result["points"]), json.dumps(result, ensure_ascii=False),
                ),
            )

    def delete_video(self, video_id: str) -> bool:
        with self._session() as db:
            cursor = db.execute("DELETE FROM videos WHERE id = ?", (video_id,))
            return cursor.rowcount > 0
