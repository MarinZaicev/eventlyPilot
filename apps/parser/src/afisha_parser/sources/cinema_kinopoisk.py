"""Фильмы в прокате России по данным Кинопоиска (ПоискКино API) — без KudaGo.

Два запроса на обновление (раз в AFISHA_CINEMA_INTERVAL_HOURS):
  * сейчас в кино: /v1.4/movie?ticketsOnSale=true — фильмы, на которые продаются билеты;
  * скоро: /v1.4/movie?premiere.russia=<сегодня>-<+30 дней>.
Ролики приходят в том же ответе (selectFields=videos), отдельных запросов на фильм не нужно.

Сеансов по кинотеатрам Кинопоиск через API не отдаёт — для пользователя есть ссылка на афишу
фильма на Кинопоиске (ticket_url), где сеансы и билеты.
"""

import logging
from datetime import UTC, date, datetime, timedelta
from typing import Any

from ..cinema import CinemaMovie
from ..enrichers.kinopoisk import KinopoiskClient, pick_kinopoisk_trailer
from ..models import Image
from ..text import clean_text

log = logging.getLogger(__name__)

SELECT_FIELDS = [
    "id", "name", "alternativeName", "enName", "year", "description", "shortDescription", "genres", "countries",
    "movieLength", "ageRating", "poster", "rating", "videos", "premiere", "type", "isSeries",
]
TYPES = ["movie", "cartoon", "anime"]
NOW_LIMIT = 250
SOON_LIMIT = 100
SOON_DAYS = 30


def _premiere(doc: dict) -> str | None:
    value = (doc.get("premiere") or {}).get("russia") or (doc.get("premiere") or {}).get("world")
    if isinstance(value, str) and len(value) >= 10:
        return value[:10]
    return None


def parse_doc(doc: dict, *, status: str) -> CinemaMovie | None:
    title = clean_text(doc.get("name")) or clean_text(doc.get("alternativeName"))
    if not title or doc.get("id") is None or doc.get("isSeries"):
        return None
    kp_id = int(doc["id"])
    poster = doc.get("poster") or {}
    rating = doc.get("rating") or {}
    trailer = pick_kinopoisk_trailer(doc)
    age = doc.get("ageRating")
    length = doc.get("movieLength")
    year = doc.get("year")
    return CinemaMovie(
        source="kinopoisk",
        source_id=str(kp_id),
        source_url=f"https://www.kinopoisk.ru/film/{kp_id}/",
        ticket_url=f"https://www.kinopoisk.ru/film/{kp_id}/afisha/",
        city="ru",
        title=title,
        original_title=clean_text(doc.get("alternativeName")) or clean_text(doc.get("enName")),
        year=year if isinstance(year, int) else None,
        country=", ".join(c["name"] for c in doc.get("countries") or [] if isinstance(c, dict) and c.get("name"))
        or None,
        genres=[g["name"] for g in doc.get("genres") or [] if isinstance(g, dict) and g.get("name")],
        running_time=length if isinstance(length, int) and length > 0 else None,
        age_restriction=f"{age}+" if isinstance(age, int) else None,
        description=clean_text(doc.get("shortDescription")) or clean_text(doc.get("description")),
        full_text=clean_text(doc.get("description")),
        imdb_rating=rating.get("imdb") if isinstance(rating.get("imdb"), (int, float)) and rating["imdb"] else None,
        rating_kp=rating.get("kp") if isinstance(rating.get("kp"), (int, float)) and rating["kp"] else None,
        poster=Image(url=poster["url"]) if isinstance(poster.get("url"), str) and poster["url"] else None,
        trailer=trailer,
        trailer_source="kinopoisk" if trailer else None,
        kinopoisk_id=kp_id,
        status=status,
        premiere=_premiere(doc),
    )


async def fetch_releases(kinopoisk: KinopoiskClient, *, today: date | None = None) -> list[CinemaMovie]:
    """Сейчас в кино + премьеры на месяц вперёд. Бросает BudgetExhausted / httpx.HTTPError."""
    today = today or datetime.now(UTC).date()
    common: dict[str, Any] = {"page": 1, "selectFields": SELECT_FIELDS, "type": TYPES,
                              "sortField": "votes.kp", "sortType": "-1"}
    now_data = await kinopoisk._get("/v1.4/movie", {**common, "limit": NOW_LIMIT, "ticketsOnSale": "true"})
    soon_range = f"{today:%d.%m.%Y}-{today + timedelta(days=SOON_DAYS):%d.%m.%Y}"
    soon_data = await kinopoisk._get("/v1.4/movie", {**common, "limit": SOON_LIMIT, "premiere.russia": soon_range})

    movies: dict[str, CinemaMovie] = {}
    for doc in now_data.get("docs") or []:
        if isinstance(doc, dict) and (movie := parse_doc(doc, status="now_playing")):
            movies[movie.source_id] = movie
    for doc in soon_data.get("docs") or []:
        if isinstance(doc, dict) and (movie := parse_doc(doc, status="upcoming")) and movie.source_id not in movies:
            movies[movie.source_id] = movie
    # В прокате — в порядке популярности (так отдал API: sortField=votes.kp), премьеры — по дате
    now_list = [m for m in movies.values() if m.status == "now_playing"]
    soon_list = sorted((m for m in movies.values() if m.status == "upcoming"), key=lambda m: (m.premiere or "9999", m.title))
    result = now_list + soon_list
    log.info("Кинопоиск: в прокате %d, скоро %d, с роликом %d",
             sum(1 for m in result if m.status == "now_playing"), sum(1 for m in result if m.status == "upcoming"),
             sum(1 for m in result if m.trailer))
    return result
