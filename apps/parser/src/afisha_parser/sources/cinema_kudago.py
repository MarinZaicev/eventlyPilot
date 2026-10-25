"""Кино KudaGo: /movies/ (фильмы в прокате города) и /movie-showings/ (сеансы по кинотеатрам).

Сначала сеансы (в них же раскрыты фильм и кинотеатр), потом список фильмов — у него полнее
карточки и есть поле trailer. Фильм без сеансов остаётся в выдаче как «в прокате».
"""

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from ..cities import get_city
from ..cinema import CinemaMovie, Showing
from ..http_client import HttpClient
from ..models import Image
from ..text import capitalize_first, clean_text
from .base import REFUSAL_STATUSES, SourceAccessError, SourceConfigError, response_detail
from .kudago import API_BASE, PAGE_SIZE, parse_age, parse_images, strip_kudago_tail
from ..enrichers.kinopoisk import trailer_from_url

log = logging.getLogger(__name__)

MOVIE_FIELDS = ",".join([
    "id", "site_url", "slug", "title", "original_title", "description", "body_text", "genres", "country",
    "year", "running_time", "age_restriction", "stars", "director", "trailer", "images", "poster",
    "imdb_rating",
])


def _ts(value: Any, tz) -> datetime | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        return None
    return datetime.fromtimestamp(value, tz)


def parse_movie(item: dict, *, city: str) -> CinemaMovie | None:
    title = clean_text(item.get("title"))
    if not title or item.get("id") is None:
        return None
    poster = item.get("poster") or {}
    trailer = trailer_from_url(item["trailer"], "Трейлер") if isinstance(item.get("trailer"), str) else None
    running = item.get("running_time")
    rating = item.get("imdb_rating")
    year = item.get("year")
    return CinemaMovie(
        source="kudago",
        source_id=str(item["id"]),
        source_url=item.get("site_url") or None,
        city=city,
        title=capitalize_first(title),
        original_title=clean_text(item.get("original_title")),
        year=year if isinstance(year, int) and year > 1880 else None,
        country=clean_text(item.get("country")),
        genres=[g["name"] for g in item.get("genres") or [] if isinstance(g, dict) and g.get("name")],
        director=clean_text(item.get("director")),
        stars=clean_text(item.get("stars")),
        running_time=running if isinstance(running, int) and running > 0 else None,
        age_restriction=parse_age(item.get("age_restriction")),
        description=strip_kudago_tail(clean_text(item.get("description"))),
        full_text=strip_kudago_tail(clean_text(item.get("body_text"))),
        imdb_rating=float(rating) if isinstance(rating, (int, float)) and rating > 0 else None,
        poster=Image(url=poster["image"]) if isinstance(poster.get("image"), str) else None,
        images=parse_images(item.get("images"))[:3],
        trailer=trailer,
        trailer_source="kudago" if trailer else None,
    )


def parse_showing(item: dict, *, tz) -> tuple[dict | None, Showing] | None:
    starts = _ts(item.get("datetime"), tz)
    if starts is None or item.get("id") is None:
        return None
    place = item.get("place") if isinstance(item.get("place"), dict) else {}
    coords = place.get("coords") or {}
    movie = item.get("movie")
    return (movie if isinstance(movie, dict) else None), Showing(
        source_id=str(item["id"]),
        starts_at=starts,
        cinema_id=str(place["id"]) if place.get("id") is not None else None,
        cinema_name=clean_text(place.get("title")),
        address=clean_text(place.get("address")),
        lat=coords.get("lat") if isinstance(coords.get("lat"), (int, float)) else None,
        lon=coords.get("lon") if isinstance(coords.get("lon"), (int, float)) else None,
        subway=clean_text(place.get("subway")),
        cinema_url=place.get("site_url") or None,
        three_d=bool(item.get("three_d")),
        imax=bool(item.get("imax")),
        four_dx=bool(item.get("four_dx")),
        original_language=bool(item.get("original_language")),
        price=clean_text(item.get("price")),
    )


class KudaGoCinema:
    name = "kudago"

    def __init__(self, http: HttpClient, *, max_pages: int = 20) -> None:
        self.http = http
        self.max_pages = max(1, max_pages)

    async def _pages(self, url: str, params: dict, what: str, city: str):
        page, next_url, next_params = 1, url, params
        while next_url:
            if page > self.max_pages:
                log.warning("KudaGo %s %s: предел %d страниц, остальное не беру", what, city, self.max_pages)
                return
            try:
                data = (await self.http.get(next_url, params=next_params)).json()
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                if status in REFUSAL_STATUSES:
                    raise SourceAccessError(
                        f"KudaGo ответил {status}: {response_detail(exc.response) or 'доступ запрещён'}", status
                    ) from exc
                raise
            results = data.get("results") or []
            log.info("KudaGo %s %s: страница %d, записей %d (всего %s)", what, city, page, len(results), data.get("count"))
            for item in results:
                if isinstance(item, dict):
                    yield item
            next_url, next_params, page = data.get("next"), None, page + 1

    async def fetch(self, city: str, *, days: int = 3) -> list[CinemaMovie]:
        found = get_city(city)
        if found is None or not found.kudago:
            raise SourceConfigError(f"У KudaGo нет города {city}")
        tz = found.zone
        now = datetime.now(UTC)
        since, until = int(now.timestamp()), int((now + timedelta(days=days)).timestamp())

        showings: dict[str, list[Showing]] = {}
        stubs: dict[str, dict] = {}
        async for item in self._pages(f"{API_BASE}/movie-showings/", {
            "lang": "ru", "location": found.kudago, "actual_since": since, "actual_until": until,
            "expand": "movie,place", "order_by": "datetime", "page_size": PAGE_SIZE,
        }, "сеансы", city):
            parsed = parse_showing(item, tz=tz)
            if parsed is None:
                continue
            movie, showing = parsed
            movie_id = str(movie["id"]) if movie and movie.get("id") is not None else None
            if movie_id is None and isinstance(item.get("movie"), int):
                movie_id = str(item["movie"])
            if movie_id is None:
                continue
            showings.setdefault(movie_id, []).append(showing)
            if movie and movie.get("title"):
                stubs.setdefault(movie_id, movie)

        movies: dict[str, CinemaMovie] = {}
        async for item in self._pages(f"{API_BASE}/movies/", {
            "lang": "ru", "location": found.kudago, "actual_since": since, "actual_until": until,
            "fields": MOVIE_FIELDS, "text_format": "text", "page_size": PAGE_SIZE, "order_by": "id",
        }, "фильмы", city):
            if (movie := parse_movie(item, city=city)) is not None:
                movies[movie.source_id] = movie
        for movie_id, stub in stubs.items():  # фильм есть в сеансах, но не в списке
            if movie_id not in movies and (movie := parse_movie(stub, city=city)) is not None:
                movies[movie_id] = movie

        result = []
        for movie_id, movie in movies.items():
            own = sorted({s.source_id: s for s in showings.get(movie_id, [])}.values(), key=lambda s: s.starts_at)
            result.append(movie.model_copy(update={"showings": own}))
        # Сначала фильмы с ближайшими сеансами, потом «в прокате» без расписания
        far = datetime.max.replace(tzinfo=UTC)
        result.sort(key=lambda m: (m.showings[0].starts_at if m.showings else far, m.title))
        log.info("KudaGo кино %s: фильмов %d, с сеансами %d, сеансов %d", city, len(result),
                 sum(1 for m in result if m.showings), sum(len(m.showings) for m in result))
        return result
