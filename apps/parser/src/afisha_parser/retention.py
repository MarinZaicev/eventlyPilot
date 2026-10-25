"""Уборка: при работе в фоне каждые несколько часов появляются новые файлы, диск не резиновый.

  * снимки прошлых запусков (events/evently/movies/*/<время>.json) старше AFISHA_KEEP_DAYS
    удаляются, но в каждой папке всегда остаются latest.json и KEEP_LAST последних снимков;
  * сырые ответы источников (raw/) старше AFISHA_RAW_KEEP_DAYS удаляются целиком;
  * картинки и трейлеры, на которые не ссылается ни один latest.json и которые
    старше AFISHA_KEEP_DAYS, удаляются. Если хоть один latest.json прочитать не удалось,
    картинки не трогаем — лучше лишний файл, чем битая ссылка у бэкенда.
"""

import json
import logging
import shutil
import time
from dataclasses import dataclass
from pathlib import Path

from .export import write_json_atomic

log = logging.getLogger(__name__)

KEEP_LAST = 3
SNAPSHOT_ROOTS = ("events", "evently", "movies", "places", "cinema")
DAY = 86400


@dataclass
class CleanupReport:
    snapshots: int = 0
    raw_dirs: int = 0
    images: int = 0
    trailers: int = 0

    def __str__(self) -> str:
        return (f"снимков {self.snapshots}, папок raw {self.raw_dirs}, "
                f"картинок {self.images}, трейлеров {self.trailers}")


def _old(path: Path, days: int, now: float) -> bool:
    return now - path.stat().st_mtime > days * DAY


def _prune_snapshots(output_dir: Path, keep_days: int, now: float) -> int:
    removed = 0
    for root in SNAPSHOT_ROOTS:
        base = output_dir / root
        if not base.is_dir():
            continue
        for folder in {p.parent for p in base.rglob("latest.json")}:
            snapshots = sorted(
                (p for p in folder.glob("*.json") if p.name != "latest.json"),
                key=lambda p: p.stat().st_mtime, reverse=True,
            )
            for path in snapshots[KEEP_LAST:]:
                if _old(path, keep_days, now):
                    path.unlink(missing_ok=True)
                    removed += 1
    return removed


def _prune_raw(output_dir: Path, raw_keep_days: int, now: float) -> int:
    base = output_dir / "raw"
    if not base.is_dir():
        return 0
    removed = 0
    # raw/<source>/<city>/<время>/
    for run_dir in base.glob("*/*/*"):
        if run_dir.is_dir() and _old(run_dir, raw_keep_days, now):
            shutil.rmtree(run_dir, ignore_errors=True)
            removed += 1
    return removed


def _collect_references(output_dir: Path) -> tuple[set[str], bool]:
    """Все local_path из latest.json. Второе значение — удалось ли прочитать всё."""
    refs: set[str] = set()
    complete = True

    def walk(node) -> None:
        if isinstance(node, dict):
            value = node.get("local_path")
            if isinstance(value, str):
                refs.add(value)
            for child in node.values():
                walk(child)
        elif isinstance(node, list):
            for child in node:
                walk(child)

    for root in ("events", "movies", "places", "cinema"):
        base = output_dir / root
        if not base.is_dir():
            continue
        for latest in base.rglob("latest.json"):
            try:
                walk(json.loads(latest.read_text(encoding="utf-8")))
            except (OSError, ValueError) as exc:
                log.warning("Уборка: не прочитан %s (%s), картинки и трейлеры не трогаю", latest, exc)
                complete = False
    return refs, complete


def _prune_media(output_dir: Path, folder_name: str, refs: set[str], keep_days: int, now: float) -> int:
    base = output_dir / folder_name
    if not base.is_dir():
        return 0
    removed = 0
    for path in base.rglob("*"):
        if not path.is_file() or path.name == "index.json":
            continue
        if path.relative_to(output_dir).as_posix() in refs:
            continue
        if _old(path, keep_days, now):
            path.unlink(missing_ok=True)
            removed += 1
    return removed


def _prune_image_index(output_dir: Path) -> None:
    """images/index.json не должен указывать на удалённые файлы: бэкенд строит по нему ссылки /media/…"""
    path = output_dir / "images" / "index.json"
    try:
        index = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if not isinstance(index, dict):
        return
    alive = {url: rel for url, rel in index.items() if isinstance(rel, str) and (output_dir / rel).is_file()}
    if len(alive) != len(index):
        write_json_atomic(path, dict(sorted(alive.items())))
        log.info("Уборка: из images/index.json убрано ссылок на удалённые файлы: %d", len(index) - len(alive))


def cleanup(output_dir: Path, *, keep_days: int = 7, raw_keep_days: int = 2, now: float | None = None) -> CleanupReport:
    now = time.time() if now is None else now
    report = CleanupReport(
        snapshots=_prune_snapshots(output_dir, keep_days, now),
        raw_dirs=_prune_raw(output_dir, raw_keep_days, now),
    )
    refs, complete = _collect_references(output_dir)
    if complete:
        report.images = _prune_media(output_dir, "images", refs, keep_days, now)
        report.trailers = _prune_media(output_dir, "trailers", refs, keep_days, now)
    _prune_image_index(output_dir)
    log.info("Уборка: удалено %s", report)
    return report
