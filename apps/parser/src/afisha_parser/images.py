"""Скачивание картинок. Файл называется SHA-256 содержимого — одинаковые постеры не дублируются.

images/index.json помнит, какая ссылка в какой файл уже скачана: в фоновом режиме
при каждом цикле качаются только новые картинки, а не все полторы тысячи заново.
"""

import asyncio
import hashlib
import json
import logging
from pathlib import Path

import httpx

from .export import write_json_atomic
from .http_client import HttpClient
from .models import Event

log = logging.getLogger(__name__)

EXT_BY_CONTENT_TYPE = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}

INDEX_NAME = "index.json"


def load_index(images_dir: Path) -> dict[str, str]:
    path = images_dir / INDEX_NAME
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)} if isinstance(data, dict) else {}


def save_index(images_dir: Path, index: dict[str, str]) -> None:
    write_json_atomic(images_dir / INDEX_NAME, dict(sorted(index.items())))


async def download_images(
    events: list[Event], http: HttpClient, output_dir: Path, concurrency: int, *, max_new: int | None = None,
) -> None:
    """events — всё, у чего есть .images (события, заведения). max_new — не больше стольких новых
    картинок за раз (остальные докачаются в следующих циклах)."""
    urls = {image.url for event in events for image in event.images}
    if not urls:
        return
    images_dir = output_dir / "images"
    index = load_index(images_dir)
    known = {url: rel for url, rel in index.items() if url in urls and (output_dir / rel).is_file()}
    missing = urls - known.keys()
    if max_new is not None and len(missing) > max_new:
        log.info("Картинки: новых %d, за этот раз качаю %d, остальные — в следующих циклах", len(missing), max_new)
        missing = set(sorted(missing)[:max(0, max_new)])
    semaphore = asyncio.Semaphore(max(1, concurrency))

    async def fetch(url: str) -> tuple[str, str | None]:
        async with semaphore:
            try:
                response = await http.get(url)
            except httpx.HTTPError as exc:
                log.warning("Не удалось скачать картинку %s: %s", url, exc)
                return url, None
        content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
        ext = EXT_BY_CONTENT_TYPE.get(content_type)
        if ext is None:
            log.warning("Неожиданный тип %r у %s, пропускаю", content_type, url)
            return url, None
        digest = hashlib.sha256(response.content).hexdigest()
        path = images_dir / digest[:2] / f"{digest}{ext}"
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_bytes(response.content)
            tmp.replace(path)
        return url, path.relative_to(output_dir).as_posix()

    log.info("Картинки: всего %d, уже скачано %d, качаю %d", len(urls), len(known), len(missing))
    fresh = dict(await asyncio.gather(*(fetch(url) for url in sorted(missing))))
    local_paths = {**known, **fresh}
    for event in events:
        for image in event.images:
            image.local_path = local_paths.get(image.url)

    # Перечитываем индекс прямо перед записью: пока мы качали, его мог пополнить другой источник
    index = load_index(images_dir)
    index.update({url: rel for url, rel in fresh.items() if rel})
    # Ссылки, чьи файлы удалила уборка, из индекса убираем
    index = {url: rel for url, rel in index.items() if (output_dir / rel).is_file()}
    save_index(images_dir, index)
