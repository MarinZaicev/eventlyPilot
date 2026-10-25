"""Трейлеры и постеры для событий категории cinema через TMDb.

У KudaGo своих трейлеров для этой категории нет: `cinema` там — разовые показы и
ретроспективы (см. README), а не афиша кинотеатров. Поэтому для каждого такого события
угадываем название фильма по его заголовку и ищем совпадение в TMDb.

Совпадение — не гарантия. Часть заголовков вообще не про кино (концертный спецпоказ,
театральная трансляция), часть — редкие документалки, которых в TMDb может не быть.
Правило: не уверены — трейлер не проставляем, лучше пропустить событие, чем прицепить
чужой ролик. Результат — отдельный файл, не часть контракта событий: у друга под кино
ещё нет таблиц в БД, поэтому не подстраиваемся заранее под несуществующую схему.
"""

import logging
import re
from contextlib import AsyncExitStack
from datetime import UTC, datetime
from difflib import SequenceMatcher
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

import httpx
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from ..config import Settings
from ..export import write_json_atomic
from ..http_client import HttpClient
from ..models import Event, EventBatch, filename_stamp
from .title_guess import Guess, extract_guesses, extract_title_guess, extract_year

if TYPE_CHECKING:
    from .kinopoisk import KinopoiskClient
    from .tmdb_catalog import CatalogMovie

log = logging.getLogger(__name__)

# extract_title_guess и extract_year переехали в title_guess.py, импорт оставлен для совместимости
__all__ = ["MovieBatch", "MovieMatch", "TmdbClient", "Trailer", "enrich_batch", "export_movies",
           "extract_title_guess", "extract_year", "find_best_match", "pick_trailer", "pick_trailer_url"]

TMDB_API_BASE = "https://api.themoviedb.org/3"
TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500"

# Событие достаётся для обогащения, если в его категориях источника есть один из этих slug'ов.
# Сейчас только кино; при желании расширить на семейные мюзиклы — достаточно дописать сюда "kids".
SOURCE_CATEGORIES = {"kudago": {"cinema"}, "timepad": {"кино"}}

# Ниже этого сходства названий совпадение не принимаем, событие остаётся без трейлера.
# Для надёжно извлечённого названия («Показ фильма «…»») хватает 0.72,
# для угаданного из менее надёжного места заголовка — только почти точное совпадение.
MIN_TITLE_SCORE = 0.72
MIN_SCORE_MEDIUM = 0.9
# Если у TMDb есть год выхода, а у события — год из заголовка, расхождение больше этого — отказ.
MAX_YEAR_DIFF = 1

_NORM_RE = re.compile(r"[«»\"„“”'.,:;!?…—–\-()\[\]]+")


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Trailer(_Model):
    """Ролик с YouTube. В приложении показывать через embed_url (официальный плеер YouTube);
    local_path заполняется, только если включено скачивание файлов (AFISHA_TRAILERS_DOWNLOAD)."""

    site: str = Field("YouTube", description="YouTube или Kinopoisk (виджет Кинопоиска — только embed_url)")
    key: str = Field(description="id ролика на YouTube (у других сайтов — наш id kp-...)")
    name: str | None = None
    language: str | None = Field(None, description="Язык ролика по TMDb: ru, en, ...")
    official: bool = False
    url: str
    embed_url: str
    local_path: str | None = Field(None, description="Скачанный файл относительно output/")


class MovieMatch(_Model):
    event_source: str = Field(description="Источник события, из которого угадано название")
    event_source_id: str
    event_title: str
    query_title: str = Field(description="Название, извлечённое из заголовка события")
    query_year: int | None = None
    tmdb_id: int | None = Field(None, description="null — фильм найден только на Кинопоиске")
    kinopoisk_id: int | None = None
    title: str
    original_title: str
    release_year: int | None = None
    overview: str | None = None
    genres: list[str] = Field(default_factory=list)
    vote_average: float | None = None
    poster_url: str | None = None
    trailer_url: str | None = Field(None, description="Ссылка на ролик YouTube (то же, что trailer.url)")
    trailer: Trailer | None = None
    match_score: float = Field(description="Схожесть названий 0..1, для отладки")
    media_type: Literal["movie", "tv"] = "movie"
    matched_by: Literal["search", "catalog", "kinopoisk"] = Field(
        "search", description="catalog — совпало с фильмом из текущего проката TMDb, kinopoisk — найден только там")
    trailer_source: Literal["tmdb", "kinopoisk"] | None = Field(None, description="Откуда взят ролик")
    guess_strength: Literal["strong", "medium"] = "strong"


class MovieBatch(_Model):
    source: str
    city: str
    fetched_at: AwareDatetime
    matched: int
    skipped: int
    movies: list[MovieMatch]


def normalize_title(text: str) -> str:
    text = text.casefold().replace("ё", "е")
    return re.sub(r"\s+", " ", _NORM_RE.sub(" ", text)).strip()


def _similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, normalize_title(a), normalize_title(b)).ratio()


# Кандидаты, чьё сходство отличается от лучшего меньше чем на это, считаются равными
TIE_EPSILON = 0.01
# Тег KudaGo, которым помечены показы классики
RETRO_TAG = "ретро"
RETRO_BEFORE_YEAR = 2000
# Среди одноимённых фильмов лидер по голосам должен опережать второго хотя бы во столько раз
DOMINANCE_RATIO = 2.0


def _release_year(candidate: dict) -> int | None:
    value = (candidate.get("release_date") or candidate.get("first_air_date") or "")[:4]
    return int(value) if value.isdigit() else None


def _votes(candidate: dict) -> int:
    value = candidate.get("vote_count")
    return value if isinstance(value, int) else 0


def find_best_match(
    candidates: list[dict], guess: str, year: int | None, *, retro: bool = False,
    min_score: float = MIN_TITLE_SCORE,
) -> tuple[dict, float] | None:
    """Лучший кандидат TMDb для угаданного названия, либо None, если выбрать уверенно нельзя.

    Одинаковые названия у разных фильмов — частый случай: «Вий» 1909, 1967 и 2014.
    Если год есть в заголовке события — он решает. Если нет:
      * показ помечен как ретро — рассматриваем только фильмы до 2000 года;
      * из оставшихся одноимённых берём самый известный (по числу голосов в TMDb),
        но только если он явно лидирует; иначе совпадение неоднозначно и пропускается.
    """
    scored: list[tuple[dict, float]] = []
    for candidate in candidates[:5]:  # TMDb уже сортирует по релевантности/популярности
        names = [n for n in (candidate.get("title"), candidate.get("original_title"),
                             candidate.get("name"), candidate.get("original_name")) if n]
        if names:
            scored.append((candidate, max(_similarity(guess, n) for n in names)))

    confident = [(c, score) for c, score in scored if score >= min_score]
    if not confident:
        return None

    if year is not None:
        fitting = [
            (c, score) for c, score in confident
            if (release := _release_year(c)) is None or abs(release - year) <= MAX_YEAR_DIFF
        ]
        return max(fitting, key=lambda pair: pair[1]) if fitting else None

    best_score = max(score for _, score in confident)
    tied = [(c, score) for c, score in confident if score >= best_score - TIE_EPSILON]
    if len(tied) == 1:
        return tied[0]

    if retro:
        old = [(c, score) for c, score in tied if (y := _release_year(c)) is not None and y < RETRO_BEFORE_YEAR]
        tied = old or tied
        if len(tied) == 1:
            return tied[0]

    tied.sort(key=lambda pair: _votes(pair[0]), reverse=True)
    leader, runner_up = _votes(tied[0][0]), _votes(tied[1][0])
    if leader < DOMINANCE_RATIO * max(runner_up, 1):
        return None  # несколько одинаково известных фильмов с таким названием — не угадываем
    return tied[0]


def pick_trailer(videos: list[dict], prefer_language: str | None = None) -> Trailer | None:
    """Лучший ролик: YouTube → именно трейлер (не тизер/фрагмент) → нужный язык → официальный → свежий."""
    youtube = [v for v in videos if isinstance(v, dict) and v.get("site") == "YouTube" and v.get("key")]
    if not youtube:
        return None
    youtube.sort(key=lambda v: (
        v.get("type") == "Trailer",
        prefer_language is not None and v.get("iso_639_1") == prefer_language,
        v.get("official") is True,
        v.get("published_at") or "",
    ), reverse=True)
    best = youtube[0]
    key = best["key"]
    return Trailer(
        key=key,
        name=best.get("name") or None,
        language=best.get("iso_639_1") or None,
        official=best.get("official") is True,
        url=f"https://www.youtube.com/watch?v={key}",
        embed_url=f"https://www.youtube-nocookie.com/embed/{key}",
    )


def pick_trailer_url(videos: list[dict]) -> str | None:
    trailer = pick_trailer(videos)
    return trailer.url if trailer else None


class TmdbClient:
    """Запросы к TMDb с кешем на время одного цикла: один и тот же фильм часто идёт
    в нескольких городах и приходит и из KudaGo, и из Timepad."""

    def __init__(self, http: HttpClient, api_key: str) -> None:
        self.http = http
        self.api_key = api_key
        self._cache: dict[tuple, Any] = {}

    async def _get(self, path: str, **params: Any) -> dict:
        key = (path, tuple(sorted(params.items())))
        if key not in self._cache:
            response = await self.http.get(f"{TMDB_API_BASE}{path}", params={"api_key": self.api_key, **params})
            self._cache[key] = response.json()
        return self._cache[key]

    async def genres(self) -> dict[tuple[str, int], str]:
        result = {}
        for kind in ("movie", "tv"):
            data = await self._get(f"/genre/{kind}/list", language="ru-RU")
            result.update({(kind, g["id"]): g["name"] for g in data.get("genres") or []})
        return result

    async def search(self, kind: str, query: str, year: int | None) -> list[dict]:
        params: dict[str, Any] = {"language": "ru-RU", "query": query}
        if year is not None:
            params["year" if kind == "movie" else "first_air_date_year"] = year
        results = (await self._get(f"/search/{kind}", **params)).get("results") or []
        if not results and year is not None:
            # Год в заголовке бывает годом показа, а не выхода: ищем без него, find_best_match всё равно сверит
            results = (await self._get(f"/search/{kind}", language="ru-RU", query=query)).get("results") or []
        return results

    async def videos(self, kind: str, item_id: int) -> list[dict]:
        """Ролики на русском, английском и без языка — одним запросом. Трейлеры русских фильмов
        часто помечены как английские или вовсе без языка: без include_video_language их не видно."""
        videos = (await self._get(f"/{kind}/{item_id}/videos", language="ru-RU",
                                  include_video_language="ru,en,null")).get("results") or []
        if not videos:
            videos = (await self._get(f"/{kind}/{item_id}/videos")).get("results") or []
        return videos


def _match_catalog(guess: Guess, catalog: "list[CatalogMovie]") -> "CatalogMovie | None":
    """Точное совпадение названия с фильмом из текущего проката — самый надёжный вариант."""
    if guess.tv:
        return None
    key = normalize_title(guess.query)
    found = [m for m in catalog if key in {normalize_title(m.title), normalize_title(m.original_title or "")}]
    if guess.year is not None:
        found = [m for m in found if not m.release_date or abs(int(m.release_date[:4]) - guess.year) <= MAX_YEAR_DIFF]
    return found[0] if len(found) == 1 else None


def _from_catalog(event: Event, guess: Guess, movie: "CatalogMovie") -> MovieMatch:
    return MovieMatch(
        event_source=event.source, event_source_id=event.source_id, event_title=event.title,
        query_title=guess.query, query_year=guess.year, tmdb_id=movie.tmdb_id,
        title=movie.title, original_title=movie.original_title or movie.title,
        release_year=int(movie.release_date[:4]) if movie.release_date else None,
        overview=movie.overview, genres=movie.genres, vote_average=movie.vote_average,
        poster_url=movie.poster_url, trailer_url=movie.trailer.url if movie.trailer else None,
        trailer=movie.trailer.model_copy() if movie.trailer else None,
        match_score=1.0, matched_by="catalog", guess_strength="strong" if guess.strong else "medium",
        trailer_source="tmdb" if movie.trailer else None,
    )


async def enrich_event(
    tmdb: TmdbClient, event: Event, genre_map: dict[tuple[str, int], str],
    catalog: "list[CatalogMovie] | None" = None, kinopoisk: "KinopoiskClient | None" = None,
) -> MovieMatch | None:
    match = await _enrich_tmdb(tmdb, event, genre_map, catalog)
    if kinopoisk is None:
        return match
    from .kinopoisk import BudgetExhausted
    try:
        if match is not None and match.trailer is None and match.media_type == "movie":
            trailer = await kinopoisk.trailer(match.title, match.release_year,
                                              alt_titles=(match.original_title, match.query_title))
            if trailer is not None:
                match.trailer, match.trailer_url, match.trailer_source = trailer, trailer.url, "kinopoisk"
        elif match is None:
            match = await _match_kinopoisk(kinopoisk, event)
    except BudgetExhausted as exc:
        log.info("Кинопоиск пропущен: %s", exc)
    except httpx.HTTPError as exc:
        log.warning("Кинопоиск: ошибка для %r: %s", event.title, exc)
    return match


async def _match_kinopoisk(kinopoisk: "KinopoiskClient", event: Event) -> MovieMatch | None:
    """TMDb не нашёл — пробуем Кинопоиск, только по надёжно извлечённому названию фильма."""
    for guess in extract_guesses(event.title):
        if not guess.strong or guess.tv:
            continue
        movie = await kinopoisk.lookup(guess.query, guess.year)
        if not movie or movie.get("is_series"):
            continue
        trailer = Trailer.model_validate(movie["trailer"]) if movie.get("trailer") else None
        return MovieMatch(
            event_source=event.source, event_source_id=event.source_id, event_title=event.title,
            query_title=guess.query, query_year=guess.year, tmdb_id=None, kinopoisk_id=movie["kinopoisk_id"],
            title=movie.get("title") or guess.query,
            original_title=movie.get("original_title") or movie.get("title") or guess.query,
            release_year=movie.get("year") if isinstance(movie.get("year"), int) else None,
            overview=movie.get("overview"), genres=movie.get("genres") or [],
            vote_average=movie.get("rating") if isinstance(movie.get("rating"), (int, float)) else None,
            poster_url=movie.get("poster_url"), trailer_url=trailer.url if trailer else None, trailer=trailer,
            match_score=1.0, matched_by="kinopoisk", trailer_source="kinopoisk" if trailer else None,
            guess_strength="strong",
        )
    return None


async def _enrich_tmdb(
    tmdb: TmdbClient, event: Event, genre_map: dict[tuple[str, int], str],
    catalog: "list[CatalogMovie] | None" = None,
) -> MovieMatch | None:
    guesses = extract_guesses(event.title)
    if not guesses:
        log.info("TMDb: в заголовке не нашлось названия фильма, пропуск: %r", event.title)
        return None

    for guess in guesses:
        if catalog and (movie := _match_catalog(guess, catalog)):
            return _from_catalog(event, guess, movie)

        min_score = MIN_TITLE_SCORE if guess.strong else MIN_SCORE_MEDIUM
        kinds = ("tv", "movie") if guess.tv else ("movie",)
        for kind in kinds:
            try:
                candidates = await tmdb.search(kind, guess.query, guess.year)
            except httpx.HTTPStatusError as exc:
                log.warning("TMDb: ошибка поиска %r: %s", guess.query, exc)
                continue
            found = find_best_match(candidates, guess.query, guess.year,
                                    retro=RETRO_TAG in event.tags, min_score=min_score)
            if found is not None:
                return await _build_match(tmdb, event, guess, kind, *found, genre_map)

    log.info("TMDb: нет уверенного совпадения для %s (событие %r)",
             " / ".join(repr(g.query) for g in guesses), event.title)
    return None


async def _build_match(
    tmdb: TmdbClient, event: Event, guess: Guess, kind: str, match: dict, score: float,
    genre_map: dict[tuple[str, int], str],
) -> MovieMatch:
    try:
        videos = await tmdb.videos(kind, match["id"])
    except httpx.HTTPStatusError as exc:
        log.warning("TMDb: ошибка загрузки видео для id=%s: %s", match["id"], exc)
        videos = []
    poster_path = match.get("poster_path")
    trailer = pick_trailer(videos, prefer_language="ru")
    title = match.get("title") or match.get("name") or guess.query
    return MovieMatch(
        event_source=event.source,
        event_source_id=event.source_id,
        event_title=event.title,
        query_title=guess.query,
        query_year=guess.year,
        tmdb_id=match["id"],
        title=title,
        original_title=match.get("original_title") or match.get("original_name") or title,
        release_year=_release_year(match),
        overview=match.get("overview") or None,
        genres=[genre_map[(kind, gid)] for gid in match.get("genre_ids") or [] if (kind, gid) in genre_map],
        vote_average=match.get("vote_average"),
        poster_url=f"{TMDB_IMAGE_BASE}{poster_path}" if poster_path else None,
        trailer_url=trailer.url if trailer else None,
        trailer=trailer,
        trailer_source="tmdb" if trailer else None,
        match_score=round(score, 3),
        media_type="tv" if kind == "tv" else "movie",
        guess_strength="strong" if guess.strong else "medium",
    )


async def enrich_batch(
    batch: EventBatch,
    settings: Settings,
    *,
    http: HttpClient | None = None,
    tmdb: TmdbClient | None = None,
    catalog: "list[CatalogMovie] | None" = None,
    kinopoisk: "KinopoiskClient | None" = None,
) -> MovieBatch | None:
    """None — обогащение не выполнялось (нет ключа или нет событий категории cinema).

    tmdb — общий клиент с кешем (в цикле службы один на все города),
    catalog — фильмы текущего проката: точное совпадение с ними принимается без поиска.
    """
    api_key = settings.tmdb_api_key
    if not api_key:
        log.error(
            "AFISHA_TMDB_API_KEY не задан — обогащение трейлерами пропущено. "
            "Ключ (v3 auth) берётся на themoviedb.org → Settings → API."
        )
        return None

    wanted = SOURCE_CATEGORIES.get(batch.source, set())
    candidates = [e for e in batch.events if wanted & set(e.categories)]
    if not candidates:
        log.info("TMDb: в дампе нет событий категорий %s, обогащать нечего", sorted(wanted))
        return None

    async with AsyncExitStack() as stack:
        if tmdb is None:
            client = http or await stack.enter_async_context(HttpClient(settings, accept="application/json"))
            tmdb = TmdbClient(client, api_key)
        genre_map = await tmdb.genres()
        movies = []
        for event in candidates:
            match = await enrich_event(tmdb, event, genre_map, catalog, kinopoisk)
            if match is not None:
                movies.append(match)

    skipped = len(candidates) - len(movies)
    log.info("TMDb: %s/%s — кинопоказов %d, найдено %d (из проката %d), пропущено %d",
             batch.source, batch.city, len(candidates), len(movies),
             sum(1 for m in movies if m.matched_by == "catalog"), skipped)
    return MovieBatch(
        source=batch.source, city=batch.city, fetched_at=datetime.now(UTC).replace(microsecond=0),
        matched=len(movies), skipped=skipped, movies=movies,
    )


def export_movies(movie_batch: MovieBatch, output_dir: Path) -> Path:
    """output/movies/<source>/<city>/<время>.json и копия latest.json рядом."""
    folder = output_dir / "movies" / movie_batch.source / movie_batch.city
    path = folder / f"{filename_stamp(movie_batch.fetched_at)}.json"
    data = movie_batch.model_dump(mode="json")
    write_json_atomic(path, data)
    write_json_atomic(folder / "latest.json", data)
    return path
