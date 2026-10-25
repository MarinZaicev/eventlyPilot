"""Один запуск сбора: адаптер → фильтр прошедшего → хеши → (картинки) → JSON."""

import logging
from contextlib import AsyncExitStack
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from .config import Settings
from .export import export_batch
from .enrichers.tmdb_trailers import enrich_batch, export_movies
from .exporters.evently import export_evently
from .http_client import SOURCE_RETRY_STATUSES, HttpClient
from .images import download_images
from .models import Event, EventBatch, compute_content_hash, filename_stamp
from .sources import ADAPTERS
from .timefilter import drop_finished, grace_from_minutes

log = logging.getLogger(__name__)


def source_client(settings: Settings, source: str | None = None) -> HttpClient:
    """Клиент для API одного источника: не чаще AFISHA_REQUESTS_PER_HOUR, 429 не повторяет.

    В цикле на каждый источник — один клиент на все города, поэтому лимит общий для источника.
    """
    return HttpClient(settings, delay=settings.source_gap_seconds(source), retry_statuses=SOURCE_RETRY_STATUSES)


@dataclass
class FetchResult:
    batch: EventBatch
    path: Path
    dropped_events: int
    dropped_sessions: int


async def fetch_and_save(
    settings: Settings,
    source: str,
    city: str,
    *,
    days: int = 30,
    limit: int | None = None,
    with_images: bool = False,
    save_raw: bool = True,
    http: HttpClient | None = None,
    now: datetime | None = None,
) -> FetchResult | None:
    """Собрать, отфильтровать и сохранить универсальный дамп. None — источник ничего не отдал."""
    fetched_at = datetime.now(UTC).replace(microsecond=0)
    raw_dir = settings.output_dir / "raw" / source / city / filename_stamp(fetched_at) if save_raw else None

    events: dict[str, Event] = {}
    async with AsyncExitStack() as stack:
        client = http or await stack.enter_async_context(HttpClient(settings))
        adapter = ADAPTERS[source](client, raw_dir=raw_dir, settings=settings)
        async for event in adapter.fetch_events(city, days=days, limit=limit):
            events[event.source_id] = event  # при сдвиге страниц одно событие может прийти дважды

    if not events:
        # Не перезаписываем latest.json пустым файлом: сломанный источник не должен стирать данные
        log.error("%s вернул 0 событий для города %r. Проверьте slug: python -m afisha_parser cities %s",
                  source, city, source)
        return None

    # Адаптер уже отбрасывает прошедшее по-своему; общий фильтр — страховка для любых источников
    filtered = drop_finished(list(events.values()), now, grace_from_minutes(settings.past_grace_minutes))
    if filtered.dropped_events or filtered.dropped_sessions:
        log.info("Отброшено прошедших: событий %d, сеансов %d", filtered.dropped_events, filtered.dropped_sessions)
    event_list = filtered.events
    for event in event_list:
        event.content_hash = compute_content_hash(event)

    if with_images:
        async with HttpClient(settings, delay=0.1, accept="image/*") as image_http:
            await download_images(event_list, image_http, settings.output_dir, settings.image_concurrency)

    batch = EventBatch(source=source, city=city, fetched_at=fetched_at, count=len(event_list), events=event_list)
    path = export_batch(batch, settings.output_dir)
    log.info("Сохранено событий: %d → %s", len(event_list), path)
    return FetchResult(batch, path, filtered.dropped_events, filtered.dropped_sessions)


async def run_fetch(
    settings: Settings,
    source: str,
    city: str,
    *,
    days: int = 30,
    limit: int | None = None,
    with_images: bool = False,
    save_raw: bool = True,
    evently: bool = False,
    movies: bool = False,
    http: HttpClient | None = None,
) -> Path | None:
    """Ручной запуск (команда fetch). Возвращает путь к JSON или None, если источник ничего не отдал."""
    result = await fetch_and_save(
        settings, source, city, days=days, limit=limit, with_images=with_images, save_raw=save_raw, http=http,
    )
    if result is None:
        return None
    if evently:
        export_evently(result.batch, settings.output_dir)
    if movies:
        # Сбой TMDb не должен ронять основной сбор: события и Evently уже сохранены
        try:
            movie_batch = await enrich_batch(result.batch, settings)
        except Exception:
            log.exception("TMDb: обогащение трейлерами упало, события сохранены без него")
        else:
            if movie_batch is not None:
                export_movies(movie_batch, settings.output_dir)
    return result.path
