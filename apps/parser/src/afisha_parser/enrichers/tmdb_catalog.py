"""Афиша проката: фильмы, которые сейчас идут в кинотеатрах, и ближайшие премьеры (TMDb).

Это общероссийский список (без городов и сеансов) — им сверяются фильмы из кинопоказов и
кинотеатров (cinema.py: фильмы и сеансы KudaGo по городам). Список берём у TMDb: /movie/now_playing и /movie/upcoming для региона AFISHA_TMDB_REGION.
По каждому фильму одним запросом дотягиваем подробности, ролики и возрастной рейтинг региона.

Результат — output/movies/tmdb/<регион>/latest.json: каталог фильмов с трейлерами, без сеансов.
"""

import logging
from contextlib import AsyncExitStack
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

import httpx
from pydantic import AwareDatetime, Field

from ..config import Settings
from ..export import write_json_atomic
from ..http_client import HttpClient
from ..models import filename_stamp
from .tmdb_trailers import TMDB_API_BASE, TMDB_IMAGE_BASE, Trailer, _Model, pick_trailer

log = logging.getLogger(__name__)

TMDB_BACKDROP_BASE = "https://image.tmdb.org/t/p/w1280"
# Страниц по 20 фильмов. В прокате обычно 40–80 фильмов, премьер на месяц вперёд — 20–40
NOW_PLAYING_PAGES = 4
UPCOMING_PAGES = 2

MovieStatus = Literal["now_playing", "upcoming"]


class CatalogMovie(_Model):
    tmdb_id: int
    status: MovieStatus = Field(description="now_playing — идёт в прокате, upcoming — скоро премьера")
    title: str
    original_title: str | None = None
    overview: str | None = None
    release_date: str | None = Field(None, description="Дата выхода в регионе (или мировая), YYYY-MM-DD")
    runtime: int | None = Field(None, description="Длительность, минуты")
    genres: list[str] = Field(default_factory=list)
    age_rating: str | None = Field(None, description="Возрастной рейтинг региона, например 16+")
    vote_average: float | None = None
    poster_url: str | None = None
    backdrop_url: str | None = None
    tmdb_url: str
    trailer: Trailer | None = None


class CatalogBatch(_Model):
    region: str
    fetched_at: AwareDatetime
    count: int
    with_trailer: int
    movies: list[CatalogMovie]


def _regional_release(details: dict, region: str) -> tuple[str | None, str | None]:
    """(дата кинотеатрального релиза в регионе, возрастной рейтинг региона)."""
    for block in (details.get("release_dates") or {}).get("results") or []:
        if block.get("iso_3166_1") != region:
            continue
        dates = sorted(block.get("release_dates") or [], key=lambda d: (d.get("type") != 3, d.get("release_date") or ""))
        release = next((d.get("release_date", "")[:10] for d in dates if d.get("release_date")), None)
        rating = next((d["certification"].strip() for d in dates if (d.get("certification") or "").strip()), None)
        if rating and rating.isdigit():
            rating += "+"
        return release, rating
    return None, None


def parse_movie(details: dict, status: MovieStatus, region: str, language: str) -> CatalogMovie:
    release, rating = _regional_release(details, region)
    videos = (details.get("videos") or {}).get("results") or []
    poster, backdrop = details.get("poster_path"), details.get("backdrop_path")
    return CatalogMovie(
        tmdb_id=details["id"],
        status=status,
        title=details.get("title") or details.get("original_title") or str(details["id"]),
        original_title=details.get("original_title") or None,
        overview=details.get("overview") or None,
        release_date=release or details.get("release_date") or None,
        runtime=details.get("runtime") or None,
        genres=[g["name"] for g in details.get("genres") or [] if isinstance(g, dict) and g.get("name")],
        age_rating=rating,
        vote_average=details.get("vote_average"),
        poster_url=f"{TMDB_IMAGE_BASE}{poster}" if poster else None,
        backdrop_url=f"{TMDB_BACKDROP_BASE}{backdrop}" if backdrop else None,
        tmdb_url=f"https://www.themoviedb.org/movie/{details['id']}",
        trailer=pick_trailer(videos, prefer_language=language.split("-")[0]),
    )


async def _list_ids(http: HttpClient, api_key: str, endpoint: str, pages: int, region: str, language: str) -> list[int]:
    ids: list[int] = []
    for page in range(1, pages + 1):
        response = await http.get(
            f"{TMDB_API_BASE}/movie/{endpoint}",
            params={"api_key": api_key, "region": region, "language": language, "page": page},
        )
        data = response.json()
        ids += [m["id"] for m in data.get("results") or [] if isinstance(m, dict) and isinstance(m.get("id"), int)]
        if page >= (data.get("total_pages") or 1):
            break
    return list(dict.fromkeys(ids))


async def _details(http: HttpClient, api_key: str, movie_id: int, language: str) -> dict[str, Any]:
    lang = language.split("-")[0]
    response = await http.get(
        f"{TMDB_API_BASE}/movie/{movie_id}",
        params={
            "api_key": api_key,
            "language": language,
            "append_to_response": "videos,release_dates",
            "include_video_language": f"{lang},en,null",
        },
    )
    return response.json()


async def fetch_catalog(settings: Settings, *, http: HttpClient | None = None) -> CatalogBatch | None:
    """None — нет ключа TMDb или TMDb ничего не вернул (прошлый файл при этом не трогаем)."""
    api_key = settings.tmdb_api_key
    if not api_key:
        log.error("AFISHA_TMDB_API_KEY не задан — афиша проката пропущена")
        return None
    region, language = settings.tmdb_region.upper(), settings.tmdb_language

    async with AsyncExitStack() as stack:
        client = http or await stack.enter_async_context(HttpClient(settings, delay=0.25))
        now_ids = await _list_ids(client, api_key, "now_playing", NOW_PLAYING_PAGES, region, language)
        playing = set(now_ids)
        soon_ids = [i for i in await _list_ids(client, api_key, "upcoming", UPCOMING_PAGES, region, language)
                    if i not in playing]
        movies: list[CatalogMovie] = []
        for status, ids in (("now_playing", now_ids), ("upcoming", soon_ids)):
            for movie_id in ids:
                try:
                    movies.append(parse_movie(await _details(client, api_key, movie_id, language), status, region, language))
                except (httpx.HTTPStatusError, KeyError, TypeError, ValueError) as exc:
                    log.warning("TMDb: фильм id=%s пропущен: %s", movie_id, exc)

    if not movies:
        log.error("TMDb: для региона %s не найдено ни одного фильма в прокате", region)
        return None
    with_trailer = sum(1 for m in movies if m.trailer)
    log.info("TMDb прокат %s: в прокате %d, скоро %d, с трейлером %d",
             region, len(now_ids), len(soon_ids), with_trailer)
    return CatalogBatch(
        region=region, fetched_at=datetime.now(UTC).replace(microsecond=0),
        count=len(movies), with_trailer=with_trailer, movies=movies,
    )


def catalog_folder(output_dir: Path, region: str) -> Path:
    return output_dir / "movies" / "tmdb" / region.lower()


def export_catalog(batch: CatalogBatch, output_dir: Path) -> Path:
    """output/movies/tmdb/<регион>/<время>.json и копия latest.json рядом."""
    folder = catalog_folder(output_dir, batch.region)
    path = folder / f"{filename_stamp(batch.fetched_at)}.json"
    data = batch.model_dump(mode="json")
    write_json_atomic(path, data)
    write_json_atomic(folder / "latest.json", data)
    return path


def load_catalog(output_dir: Path, region: str) -> CatalogBatch | None:
    path = catalog_folder(output_dir, region) / "latest.json"
    try:
        return CatalogBatch.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
