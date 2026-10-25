import json
import os
from pathlib import Path
from typing import Any

from .models import EventBatch, filename_stamp


def write_json_atomic(path: Path, data: Any) -> None:
    """Пишем во временный файл и подменяем: читатель никогда не увидит полузаписанный JSON."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def export_batch(batch: EventBatch, output_dir: Path) -> Path:
    """output/events/<source>/<city>/<время>.json и копия latest.json рядом."""
    folder = output_dir / "events" / batch.source / batch.city
    path = folder / f"{filename_stamp(batch.fetched_at)}.json"
    data = batch.model_dump(mode="json")
    write_json_atomic(path, data)
    write_json_atomic(folder / "latest.json", data)
    return path


def load_batch(path: Path) -> EventBatch:
    return EventBatch.model_validate_json(path.read_text(encoding="utf-8"))
