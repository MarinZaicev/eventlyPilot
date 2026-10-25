"""Шаг цикла службы: кино KudaGo (фильмы и сеансы) раз в AFISHA_CINEMA_INTERVAL_HOURS.

Идёт в задаче источника KudaGo тем же HTTP-клиентом — общий лимит запросов в час.
Между обновлениями файл для приложения всё равно пересобирается из последнего дампа
без прошедших сеансов, чтобы в приложении не висели сеансы «на вчера».
"""

import logging
from datetime import datetime, timedelta
from types import SimpleNamespace
from typing import Any

import httpx

from . import pipeline
from .cinema import (
    as_event_batch, event_source, export_movie_links,
    CinemaBatch, CinemaMovie, cinema_due, compute_movie_hash, drop_past_showings, export_app_cinema, export_cinema,
    load_cinema,
)
from .cities import get_city
from .config import Settings
from .enrichers.kinopoisk import BudgetExhausted, KinopoiskClient
from .exporters.evently import export_evently
from .enrichers.tmdb_catalog import CatalogMovie
from .enrichers.tmdb_trailers import TmdbClient, find_best_match, normalize_title, pick_trailer
from .http_client import HttpClient
from .images import download_images
from .pauses import active_pause, refusal_status, set_pause
from .sources.base import SourceConfigError
from .sources.cinema_kudago import KudaGoCinema
from .trailers import download_trailers

log = logging.getLogger(__name__)

# Названия фильмов из афиши — точные, но «Мастер и Маргарита» бывает и 1994, и 2024: год сверяем
MIN_SCORE = 0.85


def _error(exc: BaseException) -> str:
    text = str(exc).strip().splitlines()
    return f"{type(exc).__name__}: {text[0] if text else ''}".strip(": ")


def cinema_cities(settings: Settings) -> list[str]:
    return [c for c in settings.city_slugs() if (found := get_city(c)) is not None and found.kudago]


def _catalog_match(movie: CinemaMovie, catalog: list[CatalogMovie]) -> CatalogMovie | None:
    keys = {normalize_title(movie.title), normalize_title(movie.original_title or movie.title)}
    found = [m for m in catalog if keys & {normalize_title(m.title), normalize_title(m.original_title or "")}]
    if movie.year:
        found = [m for m in found if not m.release_date or abs(int(m.release_date[:4]) - movie.year) <= 1]
    return found[0] if len(found) == 1 else None


async def enrich_trailers(movies: list[CinemaMovie], tmdb: TmdbClient | None,
                          catalog: list[CatalogMovie] | None, kinopoisk: KinopoiskClient | None) -> None:
    """Ролик к каждому фильму: свой у KudaGo → прокат TMDb → поиск TMDb → Кинопоиск."""
    for movie in movies:
        if movie.trailer is not None and movie.tmdb_id is not None:
            continue
        if catalog and (hit := _catalog_match(movie, catalog)):
            movie.tmdb_id = hit.tmdb_id
            if movie.trailer is None and hit.trailer is not None:
                movie.trailer, movie.trailer_source = hit.trailer.model_copy(), "tmdb"
            continue
        if tmdb is not None and movie.trailer is None:
            try:
                candidates = await tmdb.search("movie", movie.title, movie.year)
                found = find_best_match(candidates, movie.title, movie.year, min_score=MIN_SCORE)
                if found is not None:
                    movie.tmdb_id = found[0]["id"]
                    trailer = pick_trailer(await tmdb.videos("movie", found[0]["id"]), prefer_language="ru")
                    if trailer is not None:
                        movie.trailer, movie.trailer_source = trailer, "tmdb"
            except httpx.HTTPError as exc:
                log.warning("TMDb: %s: %s", movie.title, exc)
        if kinopoisk is not None and movie.trailer is None:
            try:
                trailer = await kinopoisk.trailer(movie.title, movie.year, alt_titles=(movie.original_title or "",))
            except BudgetExhausted as exc:
                log.info("Кинопоиск: %s", exc)
                kinopoisk = None
                continue
            except httpx.HTTPError as exc:
                log.warning("Кинопоиск: %s: %s", movie.title, exc)
                continue
            if trailer is not None:
                movie.trailer, movie.trailer_source = trailer, "kinopoisk"


async def update_city(settings: Settings, city: str, adapter: KudaGoCinema, http: HttpClient, now: datetime, *,
                      tmdb: TmdbClient | None = None, catalog: list[CatalogMovie] | None = None,
                      kinopoisk: KinopoiskClient | None = None, force: bool = False) -> dict[str, Any]:
    source = "kudago"
    report: dict[str, Any] = {"source": source, "city": city, "ok": False, "fresh": False, "errors": []}
    existing = load_cinema(settings.output_dir, source, city)
    if existing is not None:
        report.update(movies=existing.movies_count, showings=existing.showings_count,
                      data_from=existing.fetched_at.isoformat())

    def publish(batch: CinemaBatch) -> None:
        """Файл для приложения + фильмы как события Evently + трейлеры к ним (movies/)."""
        export_app_cinema(settings.output_dir, batch)
        if settings.evently:
            export_evently(as_event_batch(batch), settings.output_dir)
            export_movie_links(batch, settings.output_dir)

    def keep_old() -> None:
        if existing is not None:
            current = drop_past_showings(existing, now)
            publish(current)
            report.update(movies=current.movies_count, showings=current.showings_count)

    if not force and not cinema_due(settings.output_dir, source, city, settings.cinema_interval_hours, now):
        keep_old()
        report.update(ok=True, next_due=(existing.fetched_at + timedelta(hours=settings.cinema_interval_hours)).isoformat())
        return report
    if pause := active_pause(settings, source, now):
        report["errors"].append(f"{source} на паузе до {pause['until']}")
        keep_old()
        return report

    before = http.requests
    try:
        movies = await adapter.fetch(city, days=settings.cinema_days)
    except (httpx.HTTPError, SourceConfigError) as exc:
        log.error("Кино %s/%s: %s", source, city, _error(exc))
        report["errors"].append(_error(exc))
        if (code := refusal_status(exc)) is not None:
            report["paused_until"] = set_pause(settings, source, f"HTTP {code}", now)["until"]
        movies = None
    except Exception as exc:
        log.exception("Кино %s/%s", source, city)
        report["errors"].append(_error(exc))
        movies = None
    report["requests"] = http.requests - before
    if not movies:
        if movies is not None:
            report["errors"].append("KudaGo не отдал ни одного фильма")
        keep_old()
        return report

    await enrich_trailers(movies, tmdb, catalog, kinopoisk)
    if settings.download_images:
        posters = [SimpleNamespace(images=[m.poster]) for m in movies if m.poster]
        async with pipeline.HttpClient(settings, delay=1.0, accept="image/*") as image_http:
            await download_images(posters, image_http, settings.output_dir, 2,  # type: ignore[arg-type]
                                  max_new=settings.places_images_per_run)
    if settings.trailers_download:
        await download_trailers([m.trailer for m in movies if m.trailer], settings.output_dir, settings)
    for movie in movies:
        movie.content_hash = compute_movie_hash(movie)
    batch = CinemaBatch(source=source, city=city, fetched_at=now, days=settings.cinema_days,
                        movies_count=len(movies), showings_count=sum(len(m.showings) for m in movies), movies=movies)
    export_cinema(batch, settings.output_dir)
    publish(batch)
    report.update(ok=True, fresh=True, movies=batch.movies_count, showings=batch.showings_count,
                  with_trailer=sum(1 for m in movies if m.trailer), data_from=now.isoformat())
    return report


async def kudago_cinema(settings: Settings, http: HttpClient, now: datetime, *, tmdb: TmdbClient | None = None,
                        catalog: list[CatalogMovie] | None = None,
                        kinopoisk: KinopoiskClient | None = None) -> list[dict[str, Any]]:
    if not settings.cinema or "kudago" not in _cinema_sources(settings):
        return []
    adapter = KudaGoCinema(http, max_pages=settings.max_pages)
    reports = []
    for city in cinema_cities(settings):
        reports.append(await update_city(settings, city, adapter, http, now,
                                         tmdb=tmdb, catalog=catalog, kinopoisk=kinopoisk))
        if reports[-1].get("paused_until"):
            break
    return reports


# ---------- Кинопоиск: фильмы в прокате и премьеры для всех городов ----------

RELEASES_KEY = ("kinopoisk", "ru")  # cinema/kinopoisk/ru/latest.json — один список на страну


async def kinopoisk_cinema(settings: Settings, now: datetime, *, tmdb: TmdbClient | None = None,
                           catalog: list[CatalogMovie] | None = None,
                           kinopoisk: KinopoiskClient | None = None, force: bool = False) -> list[dict[str, Any]]:
    """Обновить список проката (раз в интервал) и разложить его событиями по всем городам."""
    from .cinema import release_event_batch, release_movie_links, with_city_tickets
    from .sources.cinema_kinopoisk import fetch_releases

    if not settings.cinema or "kinopoisk" not in _cinema_sources(settings):
        return []
    source, region = RELEASES_KEY
    report: dict[str, Any] = {"source": source, "city": region, "ok": False, "fresh": False, "errors": []}
    batch = load_cinema(settings.output_dir, source, region)
    due = force or cinema_due(settings.output_dir, source, region, settings.cinema_interval_hours, now)
    if due and kinopoisk is None:
        report["errors"].append("нет AFISHA_KINOPOISK_TOKEN — список проката не обновляется")
    elif due:
        try:
            movies = await fetch_releases(kinopoisk)
        except BudgetExhausted as exc:
            report["errors"].append(f"Кинопоиск: {exc}")
            movies = None
        except httpx.HTTPStatusError as exc:
            body = exc.response.text[:300].replace("\n", " ")
            log.error("Кинопоиск: прокат не получен: HTTP %s %s", exc.response.status_code, body)
            report["errors"].append(f"Кинопоиск HTTP {exc.response.status_code}: {body}")
            movies = None
        except httpx.HTTPError as exc:
            report["errors"].append(f"Кинопоиск: {_error(exc)}")
            movies = None
        if movies:
            await enrich_trailers(movies, tmdb, catalog, None)  # ролик есть не у всех — добираем из TMDb
            if settings.download_images:
                posters = [SimpleNamespace(images=[m.poster]) for m in movies if m.poster]
                async with pipeline.HttpClient(settings, delay=0.5, accept="image/*") as image_http:
                    await download_images(posters, image_http, settings.output_dir, 2,  # type: ignore[arg-type]
                                          max_new=settings.places_images_per_run)
            for movie in movies:
                movie.content_hash = compute_movie_hash(movie)
            batch = CinemaBatch(source=source, city=region, fetched_at=now, days=30, movies_count=len(movies),
                                showings_count=0, movies=movies)
            export_cinema(batch, settings.output_dir)
            report.update(fresh=True)
        elif movies is not None:
            report["errors"].append("Кинопоиск не вернул ни одного фильма в прокате")
    if batch is None:
        return [report]
    batch = exclude_movies(batch, settings.cinema_exclude)
    batch = select_movies(batch, settings, now)
    if kinopoisk is not None and settings.kinopoisk_backfill_per_day > 0:
        added = await backfill_trailers(batch.movies, kinopoisk, settings.kinopoisk_backfill_per_day)
        if added:
            report["backfilled"] = added
        export_cinema(batch, settings.output_dir)  # с догруженными роликами и без исключённого
    report.update(ok=not report["errors"], movies=batch.movies_count,
                  with_trailer=sum(1 for m in batch.movies if m.trailer), data_from=batch.fetched_at.isoformat())
    if not report["fresh"] and not report["errors"]:
        report["next_due"] = (batch.fetched_at + timedelta(hours=settings.cinema_interval_hours)).isoformat()

    reports = [report]
    for city in settings.city_slugs():
        # Фильмы, у которых в городе есть точные сеансы KudaGo, второй раз не добавляем
        kudago = load_cinema(settings.output_dir, "kudago", city)
        skip = {normalize_title(m.title) for m in kudago.movies if m.showings} if kudago else set()
        city_id = settings.kinopoisk_city_id(city)
        city_batch = with_city_tickets(batch, city, city_id)  # «билеты» — сеансы именно этого города
        events = release_event_batch(city_batch, city, now, skip)
        if settings.evently:
            export_evently(events, settings.output_dir)
            release_movie_links(city_batch, city, settings.output_dir, skip)
        if not (kudago and any(m.showings for m in kudago.movies)):
            export_app_cinema(settings.output_dir, city_batch)
        reports.append({"source": "kinopoisk", "city": city, "ok": True, "fresh": True, "movies": events.count,
                        "errors": [], "data_from": batch.fetched_at.isoformat(), "release_events": True,
                        "kinopoisk_city": city_id})
    return reports


def _cinema_sources(settings: Settings) -> list[str]:
    return [s.strip() for s in settings.cinema_sources.split(",") if s.strip()]



def exclude_movies(batch: CinemaBatch, pattern: str):
    """Убрать то, что идёт в кино, но не кино: записи спектаклей, оперы, балета (AFISHA_CINEMA_EXCLUDE)."""
    import re

    if not pattern.strip():
        return batch
    regex = re.compile(pattern, re.IGNORECASE)
    kept = [m for m in batch.movies if not regex.search(m.title)]
    if len(kept) == len(batch.movies):
        return batch
    log.info("Кино: исключено трансляций и спектаклей: %d", len(batch.movies) - len(kept))
    return batch.model_copy(update={"movies": kept, "movies_count": len(kept),
                                    "showings_count": sum(len(m.showings) for m in kept)})


async def backfill_trailers(movies: list[CinemaMovie], kinopoisk: KinopoiskClient, per_day: int) -> int:
    """Фильмам без ролика — ролик из полной карточки Кинопоиска. Сначала то, что уже идёт в кино.
    Найденное кешируется, поэтому за несколько дней ролики появляются у всех, у кого они есть."""
    order = sorted((m for m in movies if m.trailer is None and m.kinopoisk_id),
                   key=lambda m: m.status != "now_playing")
    added = 0
    for movie in order:
        try:
            trailer = await kinopoisk.trailer_by_id(movie.kinopoisk_id, per_day=per_day)
        except BudgetExhausted as exc:
            log.info("Кинопоиск, догрузка роликов: %s", exc)
            break
        except httpx.HTTPError as exc:
            log.warning("Кинопоиск: карточка %s: %s", movie.kinopoisk_id, exc)
            continue
        if trailer is not None:
            movie.trailer, movie.trailer_source = trailer, "kinopoisk"
            movie.content_hash = compute_movie_hash(movie)
            added += 1
    if added:
        log.info("Кинопоиск: догружено роликов %d, без ролика осталось %d", added,
                 sum(1 for m in movies if m.trailer is None))
    return added



def select_movies(batch: CinemaBatch, settings: Settings, now: datetime):
    """Сколько фильмов Кинопоиска показывать: самые популярные в прокате + ближайшие премьеры.
    Без этого в каждом городе ~160 «фильмов» — они забивали ленту."""
    min_year = now.year - settings.cinema_max_age_years if settings.cinema_max_age_years > 0 else None
    fresh = [m for m in batch.movies if min_year is None or m.year is None or m.year >= min_year]
    now_playing = [m for m in fresh if m.status != "upcoming"][:max(0, settings.cinema_max_films)]
    premieres = [m for m in fresh if m.status == "upcoming"][:max(0, settings.cinema_max_premieres)]
    kept = now_playing + premieres
    if len(kept) != len(batch.movies):
        log.info("Кино: из %d фильмов Кинопоиска оставлено %d (в прокате %d, премьер %d)",
                 len(batch.movies), len(kept), len(now_playing), len(premieres))
    return batch.model_copy(update={"movies": kept, "movies_count": len(kept)})
