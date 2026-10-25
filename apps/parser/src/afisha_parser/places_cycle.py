"""Шаг цикла службы: обновить заведения, если пора (раз в AFISHA_PLACES_INTERVAL_HOURS).

KudaGo идёт тем же HTTP-клиентом, что и события KudaGo, — общий лимит запросов в час.
OpenStreetMap — после всех источников: к этому времени известно, где KudaGo отдал мало.
"""

import logging
from datetime import datetime, timedelta
from typing import Any

import httpx

from . import pipeline
from .cities import get_city
from .config import Settings
from .http_client import SOURCE_RETRY_STATUSES, HttpClient
from .images import download_images
from .pauses import active_pause, refusal_status, set_pause
from .places import (
    KUDAGO_ATTRIBUTION, OSM_ATTRIBUTION, PlaceBatch, compute_place_hash, export_app_places, export_places,
    load_places, places_due,
)
from .sources.base import SourceConfigError
from .sources.osm import OsmPlaces
from .sources.places_kudago import KudaGoPlaces

log = logging.getLogger(__name__)

ATTRIBUTION = {"kudago": KUDAGO_ATTRIBUTION, "osm": OSM_ATTRIBUTION}


def _sources(settings: Settings) -> list[str]:
    return [s.strip() for s in settings.places_sources.split(",") if s.strip()]


def _error(exc: BaseException) -> str:
    text = str(exc).strip().splitlines()
    return f"{type(exc).__name__}: {text[0] if text else ''}".strip(": ")


async def update_city(settings: Settings, source: str, city: str, adapter: Any, http: HttpClient,
                      now: datetime, *, force: bool = False) -> dict[str, Any]:
    report: dict[str, Any] = {"source": source, "city": city, "ok": False, "fresh": False, "errors": []}
    existing = load_places(settings.output_dir, source, city)
    if existing is not None:
        report.update(count=existing.count, data_from=existing.fetched_at.isoformat())
    if not force and not places_due(settings.output_dir, source, city, settings.places_interval_hours, now):
        due = existing.fetched_at + timedelta(hours=settings.places_interval_hours)
        report.update(ok=True, next_due=due.isoformat())
        return report
    if pause := active_pause(settings, source, now):
        report["errors"].append(f"{source} на паузе до {pause['until']}")
        return report

    before = http.requests
    try:
        places = await adapter.fetch_places(city)
    except (httpx.HTTPError, SourceConfigError) as exc:
        log.error("Заведения %s/%s: %s", source, city, _error(exc))
        report["errors"].append(_error(exc))
        if (code := refusal_status(exc)) is not None:
            entry = set_pause(settings, source, f"HTTP {code}", now)
            report["paused_until"] = entry["until"]
        places = None
    except Exception as exc:
        log.exception("Заведения %s/%s", source, city)
        report["errors"].append(_error(exc))
        places = None
    report["requests"] = http.requests - before
    if places is None:
        return report
    if not places:
        report["errors"].append("источник вернул 0 заведений, старый файл не трогаю")
        return report

    for place in places:
        place.content_hash = compute_place_hash(place)
    if settings.download_images and any(p.images for p in places):
        async with pipeline.HttpClient(settings, delay=1.0, accept="image/*") as image_http:
            await download_images(places, image_http, settings.output_dir, 2,  # type: ignore[arg-type]
                                  max_new=settings.places_images_per_run)
    batch = PlaceBatch(source=source, city=city, fetched_at=now, count=len(places),
                       attribution=ATTRIBUTION.get(source, source), places=places)
    export_places(batch, settings.output_dir)
    report.update(ok=True, fresh=True, count=len(places), data_from=now.isoformat())
    log.info("Заведения %s/%s: %d", source, city, len(places))
    return report


async def kudago_places(settings: Settings, http: HttpClient, now: datetime) -> list[dict[str, Any]]:
    """Вызывается из задачи источника KudaGo — тем же клиентом, что и события."""
    if not settings.places or "kudago" not in _sources(settings):
        return []
    adapter = KudaGoPlaces(http, max_pages=settings.max_pages)
    reports = []
    for city in settings.city_slugs():
        found = get_city(city)
        if found is None or not found.kudago:
            continue
        reports.append(await update_city(settings, "kudago", city, adapter, http, now))
        if reports[-1].get("paused_until"):
            break  # KudaGo отказал — остальные города не трогаем
    return reports


def needs_osm(settings: Settings, city: str) -> bool:
    found = get_city(city)
    if found is None:
        return False
    if not found.kudago or "kudago" not in _sources(settings):
        return True
    kudago = load_places(settings.output_dir, "kudago", city)
    # KudaGo по городу так и не собрался (он идёт раньше OSM в том же цикле — значит, недоступен
    # или на паузе) или отдал мало — берём OSM. Повторы из двух источников склеятся в файле приложения
    return kudago is None or kudago.count < settings.places_min_kudago


async def osm_places(settings: Settings, now: datetime) -> list[dict[str, Any]]:
    if not settings.places or "osm" not in _sources(settings):
        return []
    cities = [c for c in settings.city_slugs() if needs_osm(settings, c)]
    if not cities:
        return []
    reports = []
    async with pipeline.HttpClient(settings, delay=settings.source_gap_seconds("osm"),
                                   retry_statuses=SOURCE_RETRY_STATUSES, timeout=settings.osm_timeout, accept="application/json, text/plain, */*") as http:
        adapter = OsmPlaces(http, endpoint=settings.osm_endpoint, radius_km=settings.osm_radius_km,
                            amenities=[a.strip() for a in settings.osm_amenities.split(",") if a.strip()])
        for city in cities:
            reports.append(await update_city(settings, "osm", city, adapter, http, now))
            if reports[-1].get("paused_until"):
                break
    return reports


def export_app(settings: Settings) -> int:
    """Файлы app/places/<город>/latest.json по всем городам, где есть хоть один источник."""
    written = 0
    for city in settings.city_slugs():
        batches = [load_places(settings.output_dir, source, city) for source in ("kudago", "osm")]
        if export_app_places(settings.output_dir, city, [b for b in batches if b is not None]):
            written += 1
    return written
