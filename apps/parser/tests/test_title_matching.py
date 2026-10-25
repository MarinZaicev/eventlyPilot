"""Поиск фильмов по заголовкам: больше совпадений (Timepad, сериалы, прокат) без потери точности."""

from datetime import UTC, datetime

import httpx
import pytest

from afisha_parser.config import Settings
from afisha_parser.enrichers.tmdb_catalog import parse_movie
from afisha_parser.enrichers.tmdb_trailers import enrich_batch, find_best_match, normalize_title
from afisha_parser.enrichers.title_guess import extract_guesses
from afisha_parser.http_client import HttpClient
from afisha_parser.models import Event, EventBatch


def guesses(title: str) -> list[tuple[str, int | None, bool, bool]]:
    return [(g.query, g.year, g.strong, g.tv) for g in extract_guesses(title)]


@pytest.mark.parametrize(("title", "expected"), [
    ("Показ фильма «Территория»", [("Территория", None, True, False)]),
    ("Программа «Мой музей» | ДВОРЕЦ ГРЕЗ | 3 октября 19:00 | Киноцентр «ВАВИЛОН»",
     [("Дворец грез", None, False, False)]),
    ("Ретроспектива советских фильмов | Кинопоказ фильма «ИДИОТ» | 2 октября 14:30 | Культурный центр «Атриум Кино»",
     [("Идиот", None, True, False)]),
    ("Торжественная церемония открытия фестиваля «Порт_Арт» | Кинопоказ фильма «Волки» | 1 октября 16:00 | Киноцентр «Первомайский»",
     [("Волки", None, True, False)]),
    ("Сумерки: Сага (2008) (кинолекторий)", [("Сумерки: Сага", 2008, False, False)]),
    ("Фестивальный показ: жизнеутверждающий сериал «Пингвины моей мамы. 2 сезон»",
     [("Пингвины моей мамы", None, True, True)]),
    ("«Брат» на большом экране", [("Брат", None, False, False)]),
    ("Фильм «Золотой теленок», 1968 (к/т «Иллюзион», Большой зал)", [("Золотой теленок", 1968, True, False)]),
    ("Просмотр и обсуждение документального фильма «Медленные технологии | Low-Tech» (Франция, 2023)",
     [("Медленные технологии", 2023, True, False), ("Low-Tech", 2023, True, False)]),
    ("Киноклуб «Время героев»: фильм ««Человек Божий»", [("Человек Божий", None, True, False)]),
    ("Показ фильмов «Волонтёры Урала» и «Колибрик. Сила единства»",
     [("Волонтёры Урала", None, True, False), ("Колибрик. Сила единства", None, True, False)]),
    # Не фильмы: программы, площадки, фестивали, лекции
    ("Показ анимационных фильмов участников арт-резиденции «РЕАКТОР»", []),
    ("Встреча «Следуй за дождём»", []),
    ("Церемония открытия Международного фестиваля вдохновляющего кино «ЛАМПА»", []),
    ("Форум российских киношкол | Киношкола Александра Митты | 2 октября 18:00 | Библиотека имени Пушкина", []),
    ("Ламповая кинокухня «Рецепты вкусного кино»", []),
    ("Лекторий «Кино на все времена»", []),
    ("Без кавычек вообще", []),
])
def test_extract_guesses(title, expected):
    assert guesses(title) == expected


def test_normalize_ignores_punctuation_case_and_yo():
    assert normalize_title("МОЙ ДИКИЙ ДРУГ. Возвращение домой") == normalize_title("Мой дикий друг: возвращение домой")
    assert normalize_title("Ёлки") == normalize_title("елки")


def test_medium_guess_needs_near_exact_title():
    candidates = [{"id": 1, "title": "Амазонка", "original_title": "Amazonia", "release_date": "2013-01-01"}]
    assert find_best_match(candidates, "Амазонки", None) is not None          # надёжному хватает 0.72
    assert find_best_match(candidates, "Амазонки", None, min_score=0.9) is None  # угаданному — нет


def cinema(source_id: str, title: str, source: str = "timepad", categories=("кино",)) -> Event:
    return Event(source=source, source_id=source_id, source_url="https://afisha.timepad.ru/",
                 city="omsk", title=title, categories=list(categories))


def tmdb_handler(calls: list[str]):
    def handler(request: httpx.Request) -> httpx.Response:
        path, query = request.url.path, request.url.params.get("query")
        calls.append(f"{path}?{query or ''}")
        if path.startswith("/3/genre/"):
            return httpx.Response(200, json={"genres": []})
        if path == "/3/search/movie" and query == "Дворец грез":
            return httpx.Response(200, json={"results": [
                {"id": 7, "title": "Дворец грёз", "original_title": "Palácio dos Sonhos", "release_date": "2024-05-01"}]})
        if path == "/3/search/movie" and query == "Амазонки":
            return httpx.Response(200, json={"results": [
                {"id": 8, "title": "Амазонка", "original_title": "Amazonia", "release_date": "2013-01-01"}]})
        if path == "/3/search/tv" and query == "Пингвины моей мамы":
            return httpx.Response(200, json={"results": [
                {"id": 9, "name": "Пингвины моей мамы", "original_name": "Пингвины моей мамы", "first_air_date": "2021-03-01"}]})
        if path.endswith("/videos"):
            return httpx.Response(200, json={"results": [{"site": "YouTube", "type": "Trailer", "key": path.split("/")[3]}]})
        return httpx.Response(200, json={"results": []})
    return handler


async def test_timepad_titles_series_and_cache(tmp_path):
    settings = Settings(output_dir=tmp_path, request_delay=0, tmdb_api_key="k")
    batch = EventBatch(source="timepad", city="omsk", fetched_at=datetime.now(UTC), count=4, events=[
        cinema("1", "Программа «Мой музей» | ДВОРЕЦ ГРЕЗ | 3 октября 19:00 | Киноцентр «ВАВИЛОН»"),
        cinema("2", "Программа «Мой музей» | ДВОРЕЦ ГРЕЗ | 5 октября 19:00 | Киноцентр «ВАВИЛОН»"),
        cinema("3", "Фокус: Латинская Америка | АМАЗОНКИ | 1 октября 18:30 | Культурный центр «Атриум Кино»"),
        cinema("4", "Фестивальный показ: жизнеутверждающий сериал «Пингвины моей мамы. 2 сезон»"),
    ])
    calls: list[str] = []
    async with HttpClient(settings, transport=httpx.MockTransport(tmdb_handler(calls))) as http:
        result = await enrich_batch(batch, settings, http=http)

    found = {m.event_source_id: m for m in result.movies}
    assert found["1"].tmdb_id == 7 and found["1"].guess_strength == "medium"
    assert found["2"].tmdb_id == 7
    assert "3" not in found  # «Амазонки» ≠ «Амазонка»: для угаданного названия слишком неточно
    assert found["4"].media_type == "tv" and found["4"].trailer.key == "9"
    assert calls.count("/3/search/movie?Дворец грез") == 1  # второй показ взят из кеша


async def test_now_playing_catalog_is_matched_without_search(tmp_path):
    settings = Settings(output_dir=tmp_path, request_delay=0, tmdb_api_key="k")
    movie = parse_movie({
        "id": 55, "title": "Волки", "original_title": "Wolves", "release_date": "2026-09-01",
        "videos": {"results": [{"site": "YouTube", "type": "Trailer", "key": "wolf", "iso_639_1": "ru"}]},
    }, "now_playing", "RU", "ru-RU")
    batch = EventBatch(source="timepad", city="omsk", fetched_at=datetime.now(UTC), count=1, events=[
        cinema("1", "Открытие фестиваля «Порт_Арт» | Кинопоказ фильма «Волки» | 1 октября 16:00 | Киноцентр «Первомайский»"),
    ])
    calls: list[str] = []
    async with HttpClient(settings, transport=httpx.MockTransport(tmdb_handler(calls))) as http:
        result = await enrich_batch(batch, settings, http=http, catalog=[movie])

    match = result.movies[0]
    assert (match.tmdb_id, match.matched_by, match.trailer.key) == (55, "catalog", "wolf")
    assert not any("search" in c for c in calls)
