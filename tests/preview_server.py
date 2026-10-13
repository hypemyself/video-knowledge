"""Run the dashboard against disposable sample notes for UI checks."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from tempfile import TemporaryDirectory

import uvicorn


def sample(bvid: str, title: str, category: str, point_title: str, explanation: str) -> dict:
    video_id = f"{bvid}-p1"
    return {
        "id": video_id,
        "bvid": bvid,
        "page": 1,
        "url": f"https://www.bilibili.com/video/{bvid}/",
        "title": title,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "overview": f"{title}的主要内容。",
        "cover": None,
        "duration": 420,
        "source": "subtitle",
        "categories": [category],
        "points": [{
            "id": "P001",
            "category": category,
            "title": point_title,
            "explanation": explanation,
            "evidence": f"视频原话：{point_title}。",
            "time_seconds": 82,
            "timestamp_approximate": False,
            "review_status": "unreviewed",
            "segment_ids": ["S00001"],
        }],
    }


if __name__ == "__main__":
    with TemporaryDirectory(prefix="zhidian-ui-preview-") as directory:
        os.environ["VIDEO_KNOWLEDGE_DATA_DIR"] = directory
        from server.storage import Storage

        storage = Storage()
        storage.save_video(sample("BV1xx411c7mD", "Python 变量入门", "基础概念", "变量的赋值", "用等号把一个值交给变量名。"))
        storage.save_video(sample("BV1GJ411x7h7", "循环练习", "程序控制", "for 循环", "依次处理序列中的每个元素。"))
        uvicorn.run("server.app:app", host="127.0.0.1", port=8766, log_level="warning")
