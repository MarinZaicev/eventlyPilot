"""Кино в прокате: фильмы города и их сеансы по кинотеатрам (KudaGo /movies/ и /movie-showings/).

Файлы:
  output/cinema/<источник>/<город>/latest.json  — универсальный дамп (snake_case)
  output/app/cinema/<город>/latest.json         — для бэкенда Evently (camelCase): фильмы с трейлерами
                                                  и сеансами, сгруппированными по кинотеатрам

Сеансы меняются каждый день, но не каждый час: обновляем раз в AFISHA_CINEMA_INTERVAL_HOURS
на AFISHA_CINEMA_DAYS дней вперёд. Трейлер — из KudaGo (поле trailer у фильма), если его нет —
TMDb, затем Кинопоиск; скачивание файлов — как у остальных трейлеров (AFISHA_TRAILERS_DOWNLOAD).
"""

import hashlib
import json
import logging
from datetime import UTC, datetime, timedelta
from pathlib import Path

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from .cities import CITIES
from .enrichers.tmdb_trailers import Trailer
from .export import write_json_atomic
from .models import Image, filename_stamp

log = logging.getLogger(__name__)

CINEMA_SCHEMA_VERSION = "1.0"


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Showing(_Model):
    source_id: str
    starts_at: AwareDatetime
    cinema_id: str | None = None
    cinema_name: str | None = None
    address: str | None = None
    lat: float | None = None
    lon: float | None = None
    subway: str | None = None
    cinema_url: str | None = None
    three_d: bool = False
    imax: bool = False
    four_dx: bool = False
    original_language: bool = False
    price: str | None = None


class CinemaMovie(_Model):
    source: str
    source_id: str
    source_url: str | None = None
    city: str
    title: str
    original_title: str | None = None
    year: int | None = None
    country: str | None = None
    genres: list[str] = Field(default_factory=list)
    director: str | None = None
    stars: str | None = None
    running_time: int | None = Field(None, description="минуты")
    age_restriction: str | None = None
    description: str | None = None
    full_text: str | None = None
    imdb_rating: float | None = None
    poster: Image | None = None
    images: list[Image] = Field(default_factory=list)
    trailer: Trailer | None = None
    trailer_source: str | None = Field(None, description="kudago, tmdb или kinopoisk")
    tmdb_id: int | None = None
    kinopoisk_id: int | None = None
    rating_kp: float | None = None
    status: str | None = Field(None, description="now_playing — в прокате, upcoming — скоро премьера (Кинопоиск)")
    premiere: str | None = Field(None, description="Дата премьеры в России, YYYY-MM-DD")
    ticket_url: str | None = Field(None, description="Где смотреть сеансы и купить билет")
    showings: list[Showing] = Field(default_factory=list, description="Только будущие, по возрастанию")
    content_hash: str | None = None


class CinemaBatch(_Model):
    schema_version: str = CINEMA_SCHEMA_VERSION
    source: str
    city: str
    fetched_at: AwareDatetime
    days: int
    movies_count: int
    showings_count: int
    movies: list[CinemaMovie]


def compute_movie_hash(movie: CinemaMovie) -> str:
    payload = movie.model_dump(mode="json", exclude={
        "content_hash": True, "poster": {"local_path"}, "images": {"__all__": {"local_path"}},
        "trailer": {"local_path"},
    })
    blob = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def cinema_folder(output_dir: Path, source: str, city: str) -> Path:
    return output_dir / "cinema" / source / city


def export_cinema(batch: CinemaBatch, output_dir: Path) -> Path:
    folder = cinema_folder(output_dir, batch.source, batch.city)
    path = folder / f"{filename_stamp(batch.fetched_at)}.json"
    data = batch.model_dump(mode="json")
    write_json_atomic(path, data)
    write_json_atomic(folder / "latest.json", data)
    return path


def load_cinema(output_dir: Path, source: str, city: str) -> CinemaBatch | None:
    path = cinema_folder(output_dir, source, city) / "latest.json"
    try:
        return CinemaBatch.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        if path.exists():
            log.warning("Кино: %s не читается: %s", path, exc)
        return None


def cinema_due(output_dir: Path, source: str, city: str, interval_hours: float, now: datetime) -> bool:
    batch = load_cinema(output_dir, source, city)
    return batch is None or now - batch.fetched_at >= timedelta(hours=interval_hours)


def drop_past_showings(batch: CinemaBatch, now: datetime) -> CinemaBatch:
    """Старый дамп (источник недоступен): убрать прошедшие сеансы и фильмы без сеансов."""
    movies = []
    for movie in batch.movies:
        showings = [s for s in movie.showings if s.starts_at > now]
        if showings or not movie.showings:
            movies.append(movie.model_copy(update={"showings": showings}))
    return batch.model_copy(update={"movies": movies, "movies_count": len(movies),
                                    "showings_count": sum(len(m.showings) for m in movies)})


def _media_url(local_path: str | None) -> str | None:
    """images/ab/x.jpg → /media/events/ab/x.jpg, trailers/x.mp4 → /media/trailers/x.mp4 (маршруты бэкенда)."""
    if not local_path:
        return None
    for prefix, route in (("images/", "/media/events/"), ("trailers/", "/media/trailers/")):
        if local_path.startswith(prefix):
            return route + local_path[len(prefix):]
    return None


def to_app_movie(movie: CinemaMovie) -> dict:
    cinemas: dict[str, dict] = {}
    for s in movie.showings:
        key = s.cinema_id or s.cinema_name or "?"
        cinema = cinemas.setdefault(key, {
            "externalId": s.cinema_id, "name": s.cinema_name, "address": s.address, "latitude": s.lat,
            "longitude": s.lon, "subway": s.subway, "url": s.cinema_url, "showings": [],
        })
        cinema["showings"].append({
            "externalId": s.source_id, "startsAt": s.starts_at.isoformat(), "threeD": s.three_d, "imax": s.imax,
            "fourDx": s.four_dx, "originalLanguage": s.original_language, "price": s.price,
        })
    trailer = movie.trailer
    poster = movie.poster
    return {
        "source": movie.source,
        "externalId": movie.source_id,
        "sourceUrl": movie.source_url,
        "title": movie.title,
        "originalTitle": movie.original_title,
        "year": movie.year,
        "country": movie.country,
        "genres": movie.genres,
        "director": movie.director,
        "stars": movie.stars,
        "runtime": movie.running_time,
        "ageRating": movie.age_restriction,
        "description": movie.description,
        "imdbRating": movie.imdb_rating,
        "posterUrl": (_media_url(poster.local_path) or poster.url) if poster else None,
        "tmdbId": movie.tmdb_id,
        "kinopoiskId": movie.kinopoisk_id,
        "ticketUrl": movie.ticket_url,
        "trailer": {
            "site": trailer.site, "key": trailer.key, "url": trailer.url, "embedUrl": trailer.embed_url,
            "file": _media_url(trailer.local_path), "source": movie.trailer_source,
        } if trailer else None,
        "nextShowingAt": movie.showings[0].starts_at.isoformat() if movie.showings else None,
        "cinemas": list(cinemas.values()),
        "contentHash": movie.content_hash,
    }


def export_app_cinema(output_dir: Path, batch: CinemaBatch) -> Path:
    known = CITIES.get(batch.city)
    data = {
        "schemaVersion": CINEMA_SCHEMA_VERSION,
        "kind": "cinema",
        "city": batch.city,
        "cityName": known.name if known else batch.city,
        "source": batch.source,
        "fetchedAt": batch.fetched_at.isoformat(),
        "generatedAt": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "days": batch.days,
        "count": batch.movies_count,
        "showingsCount": batch.showings_count,
        "movies": [to_app_movie(m) for m in batch.movies],
    }
    path = output_dir / "app" / "cinema" / batch.city / "latest.json"
    write_json_atomic(path, data)
    return path


# ---------- как события Evently: фильмы попадают в общую ленту без доработок бэкенда ----------

EVENT_SOURCE_SUFFIX = "-cinema"
MAX_EVENT_SESSIONS = 60


def event_source(batch_source: str) -> str:
    """kudago → kudago-cinema: отдельный источник событий, чтобы не путать с разовыми кинопоказами."""
    return batch_source + EVENT_SOURCE_SUFFIX


def event_id(movie: CinemaMovie) -> str:
    """Один фильм идёт в нескольких городах, а (source, externalId) у бэкенда уникальна — добавляем город."""
    return f"{movie.city}-{movie.source_id}"


def as_event_batch(batch: CinemaBatch):
    """Фильм с сеансами → событие: сеансы — все показы города, площадка — если кинотеатр один."""
    from .models import Event, EventBatch, Price, Session, Venue, compute_content_hash

    events = []
    for movie in batch.movies:
        if not movie.showings:
            continue
        cinemas: dict[str, Showing] = {}
        for s in movie.showings:
            cinemas.setdefault(s.cinema_id or s.cinema_name or "?", s)
        venue = None
        if len(cinemas) == 1:
            s = next(iter(cinemas.values()))
            if s.cinema_name:
                venue = Venue(source_id=s.cinema_id, name=s.cinema_name, address=s.address, lat=s.lat, lon=s.lon,
                              subway=s.subway, url=s.cinema_url)
        names = [s.cinema_name for s in cinemas.values() if s.cinema_name]
        where = f"Где идёт: {', '.join(names[:15])}{' и др.' if len(names) > 15 else ''}." if names else None
        starts = sorted({s.starts_at for s in movie.showings})[:MAX_EVENT_SESSIONS]
        meta = ", ".join(x for x in [str(movie.year) if movie.year else None, movie.country,
                                       f"{movie.running_time} мин" if movie.running_time else None] if x)
        event = Event(
            source=event_source(batch.source),
            source_id=event_id(movie),
            source_url=movie.source_url or "",
            city=batch.city,
            title=movie.title,
            tagline=f"в {len(cinemas)} кинотеатр{'е' if len(cinemas) == 1 else 'ах'}" if cinemas else None,
            description=movie.description or meta or None,
            full_text="\n\n".join(x for x in [movie.full_text or movie.description, meta or None, where] if x) or None,
            categories=["cinema"],
            tags=movie.genres,
            age_restriction=movie.age_restriction,
            price=Price(),
            venue=venue,
            sessions=[Session(starts_at=t) for t in starts],
            images=[movie.poster] if movie.poster else [],
        )
        event.content_hash = compute_content_hash(event)
        events.append(event)
    return EventBatch(source=event_source(batch.source), city=batch.city, fetched_at=batch.fetched_at,
                      count=len(events), events=events)


def export_movie_links(batch: CinemaBatch, output_dir: Path) -> Path:
    """movies/<источник>-cinema/<город>/latest.json — трейлеры и карточки фильмов к этим событиям,
    в том же формате, что и у кинопоказов (бэкенд уже умеет его импортировать)."""
    movies = []
    for movie in batch.movies:
        if not movie.showings:
            continue
        trailer = movie.trailer
        movies.append({
            "event_source": event_source(batch.source),
            "event_source_id": event_id(movie),
            "event_title": movie.title,
            "tmdb_id": movie.tmdb_id,
            "kinopoisk_id": movie.kinopoisk_id,
            "media_type": "movie",
            "title": movie.title,
            "original_title": movie.original_title or movie.title,
            "release_year": movie.year,
            "overview": movie.full_text or movie.description,
            "genres": movie.genres,
            "vote_average": movie.imdb_rating,
            "runtime": movie.running_time,
            "age_rating": movie.age_restriction,
            "poster_url": movie.poster.url if movie.poster else None,
            "trailer_url": trailer.url if trailer else None,
            "trailer": trailer.model_dump(mode="json") if trailer else None,
            "trailer_source": movie.trailer_source,
            "matched_by": "cinema",
        })
    data = {"source": event_source(batch.source), "city": batch.city, "fetched_at": batch.fetched_at.isoformat(),
            "matched": len(movies), "skipped": 0, "movies": movies}
    folder = output_dir / "movies" / event_source(batch.source) / batch.city
    path = folder / f"{filename_stamp(batch.fetched_at)}.json"
    write_json_atomic(path, data)
    write_json_atomic(folder / "latest.json", data)
    return path



# ---------- фильмы проката без расписания (Кинопоиск): событие «идёт в кино» в каждом городе ----------

RELEASE_SOURCE = "kinopoisk-cinema"
NOW_PLAYING_DAYS = 7      # «в прокате» показываем как событие на ближайшую неделю, каждый день сдвигаем
PREMIERE_DAYS = 14


def kinopoisk_ticket_url(movie: CinemaMovie, city_id: int | None) -> str | None:
    """Страница сеансов фильма в конкретном городе на Кинопоиске; без номера города — общая афиша фильма."""
    if movie.kinopoisk_id and city_id:
        return f"https://www.kinopoisk.ru/film/{movie.kinopoisk_id}/afisha/city/{city_id}/"
    return movie.ticket_url


def with_city_tickets(batch: CinemaBatch, city: str, city_id: int | None) -> CinemaBatch:
    """Копия общероссийского списка для города: ссылки «билеты» ведут на сеансы этого города."""
    movies = [m.model_copy(update={"ticket_url": kinopoisk_ticket_url(m, city_id)}) for m in batch.movies]
    return batch.model_copy(update={"city": city, "movies": movies})


def release_event_batch(batch: CinemaBatch, city: str, now: datetime, skip_titles: set[str] | None = None):
    """Фильмы Кинопоиска → события города. Сеансов у Кинопоиска нет, поэтому одна «дата» на фильм:
    для проката — с сегодняшнего дня на неделю, для премьеры — с даты премьеры на две недели.
    Ссылка «билеты» — страница афиши фильма на Кинопоиске (там сеансы по городам)."""
    from .enrichers.tmdb_trailers import normalize_title
    from .models import Event, EventBatch, Price, Session, compute_content_hash

    known = CITIES.get(city)
    tz = known.zone if known else UTC
    today = now.astimezone(tz).date()
    events = []
    for movie in batch.movies:
        if skip_titles and normalize_title(movie.title) in skip_titles:
            continue  # этот фильм уже есть с точными сеансами из другого источника
        if movie.status == "upcoming" and movie.premiere:
            day = datetime.fromisoformat(movie.premiere).date()
            if day < today:
                day = today
            start = datetime.combine(day, datetime.min.time(), tzinfo=tz).replace(hour=10)
            end = start + timedelta(days=PREMIERE_DAYS)
            tagline = f"Премьера {day.strftime('%d.%m')}"
        else:
            start = datetime.combine(today, datetime.min.time(), tzinfo=tz).replace(hour=10)
            end = start + timedelta(days=NOW_PLAYING_DAYS)
            tagline = "Сейчас в кино"
        meta = ", ".join(x for x in [str(movie.year) if movie.year else None, movie.country,
                                       f"{movie.running_time} мин" if movie.running_time else None] if x)
        event = Event(
            source=RELEASE_SOURCE,
            source_id=f"{city}-{movie.source_id}",
            source_url=movie.source_url or "",
            ticket_url=movie.ticket_url,
            city=city,
            title=movie.title,
            tagline=tagline,
            description=movie.description or meta or None,
            full_text="\n\n".join(x for x in [movie.full_text or movie.description, meta or None] if x) or None,
            categories=["cinema"],
            tags=movie.genres,
            age_restriction=movie.age_restriction,
            price=Price(),
            sessions=[Session(starts_at=start, ends_at=end.replace(hour=23))],
            images=[movie.poster.model_copy()] if movie.poster else [],
        )
        event.content_hash = compute_content_hash(event)
        events.append(event)
    return EventBatch(source=RELEASE_SOURCE, city=city, fetched_at=batch.fetched_at, count=len(events), events=events)


def release_movie_links(batch: CinemaBatch, city: str, output_dir: Path, skip_titles: set[str] | None = None) -> Path:
    """movies/kinopoisk-cinema/<город>/latest.json — трейлеры и карточки к событиям выше."""
    from .enrichers.tmdb_trailers import normalize_title

    movies = []
    for movie in batch.movies:
        if skip_titles and normalize_title(movie.title) in skip_titles:
            continue
        trailer = movie.trailer
        movies.append({
            "event_source": RELEASE_SOURCE, "event_source_id": f"{city}-{movie.source_id}",
            "event_title": movie.title, "tmdb_id": movie.tmdb_id, "kinopoisk_id": movie.kinopoisk_id,
            "media_type": "movie", "title": movie.title, "original_title": movie.original_title or movie.title,
            "release_year": movie.year, "overview": movie.full_text or movie.description, "genres": movie.genres,
            "vote_average": movie.rating_kp or movie.imdb_rating, "runtime": movie.running_time,
            "age_rating": movie.age_restriction, "poster_url": movie.poster.url if movie.poster else None,
            "trailer_url": trailer.url if trailer else None,
            "trailer": trailer.model_dump(mode="json") if trailer else None,
            "trailer_source": movie.trailer_source, "matched_by": "cinema",
        })
    data = {"source": RELEASE_SOURCE, "city": city, "fetched_at": batch.fetched_at.isoformat(),
            "matched": len(movies), "skipped": 0, "movies": movies}
    folder = output_dir / "movies" / RELEASE_SOURCE / city
    write_json_atomic(folder / "latest.json", data)
    return folder / "latest.json"
