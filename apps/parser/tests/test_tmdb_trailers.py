"""Обогащение трейлерами: извлечение названия, сопоставление, выбор ролика — без реальных запросов к TMDb."""

import httpx
import pytest

from afisha_parser.config import Settings
from afisha_parser.enrichers.tmdb_trailers import (
    enrich_batch,
    extract_title_guess,
    extract_year,
    find_best_match,
    pick_trailer_url,
)
from afisha_parser.http_client import HttpClient
from afisha_parser.models import Event, EventBatch
from datetime import UTC, datetime


@pytest.mark.parametrize(
    ("title", "expected"),
    [
        ("Показ фильма «Территория»", "Территория"),
        ("Кинопоказ «Тихое материнство» (2025)", "Тихое материнство"),
        ("Без кавычек вообще", None),
        ("Спецпоказ «Курентзис: „Замок“ и „Мистерия“»", "Курентзис: „Замок“ и „Мистерия“"),
    ],
)
def test_extract_title_guess(title, expected):
    assert extract_title_guess(title) == expected


@pytest.mark.parametrize(
    ("title", "expected"),
    [("Кинопоказ «Тихое материнство» (2025)", 2025), ("Показ фильма «Территория»", None)],
)
def test_extract_year(title, expected):
    assert extract_year(title) == expected


def test_find_best_match_prefers_closest_title():
    candidates = [
        {"id": 1, "title": "Территория лжи", "original_title": "Территория лжи", "release_date": "2010-01-01"},
        {"id": 2, "title": "Территория", "original_title": "Territory", "release_date": "1978-06-01"},
    ]
    found = find_best_match(candidates, "Территория", year=1978)
    assert found is not None
    match, score = found
    assert match["id"] == 2
    assert score > 0.9


def test_find_best_match_rejects_low_similarity():
    candidates = [{"id": 1, "title": "Совсем другой фильм", "original_title": "Different", "release_date": "2020"}]
    assert find_best_match(candidates, "Твигги", year=None) is None


def test_find_best_match_rejects_year_mismatch():
    candidates = [{"id": 1, "title": "Территория", "original_title": "Территория", "release_date": "2015-01-01"}]
    assert find_best_match(candidates, "Территория", year=1978) is None


VIY = [
    {"id": 2014, "title": "Вий", "original_title": "Вий", "release_date": "2014-01-30", "vote_count": 420},
    {"id": 1967, "title": "Вий", "original_title": "Вий", "release_date": "1967-11-27", "vote_count": 380},
    {"id": 1909, "title": "Вий", "original_title": "Вий", "release_date": "1909-01-01", "vote_count": 3},
]


def test_retro_show_picks_best_known_old_film():
    # 1909 старше, но почти неизвестен; 2014 отсекается тегом «ретро»
    match, _ = find_best_match(VIY, "Вий", year=None, retro=True)
    assert match["id"] == 1967


def test_ambiguous_title_without_year_is_skipped():
    # 2014 и 1967 одинаково известны — без года и без тега «ретро» не угадываем
    assert find_best_match(VIY, "Вий", year=None) is None


def test_clear_leader_by_votes_is_accepted():
    candidates = [
        {"id": 1, "title": "Осень", "original_title": "Осень", "release_date": "1974-01-01", "vote_count": 90},
        {"id": 2, "title": "Осень", "original_title": "Осень", "release_date": "2021-01-01", "vote_count": 4},
    ]
    match, _ = find_best_match(candidates, "Осень", year=None)
    assert match["id"] == 1


def test_year_in_title_beats_everything():
    match, _ = find_best_match(VIY, "Вий", year=2014, retro=True)
    assert match["id"] == 2014


def test_better_title_wins_over_weaker_match():
    candidates = [
        {"id": 1, "title": "Осень", "original_title": "Осень", "release_date": "1974-01-01"},
        {"id": 2, "title": "Осенний марафон", "original_title": "Осенний марафон", "release_date": "1979-01-01"},
    ]
    match, _ = find_best_match(candidates, "Осень", year=None)
    assert match["id"] == 1


def test_pick_trailer_prefers_official_trailer_over_teaser():
    videos = [
        {"site": "YouTube", "type": "Teaser", "official": True, "key": "teaser1"},
        {"site": "Vimeo", "type": "Trailer", "official": True, "key": "ignored"},
        {"site": "YouTube", "type": "Trailer", "official": False, "key": "unofficial"},
        {"site": "YouTube", "type": "Trailer", "official": True, "key": "official1"},
    ]
    assert pick_trailer_url(videos) == "https://www.youtube.com/watch?v=official1"


def test_pick_trailer_none_without_youtube():
    assert pick_trailer_url([{"site": "Vimeo", "type": "Trailer", "official": True, "key": "x"}]) is None
    assert pick_trailer_url([]) is None


def cinema_event(source_id: str, title: str) -> Event:
    return Event(
        source="kudago", source_id=source_id, source_url=f"https://kudago.com/msk/event/{source_id}/",
        city="msk", title=title, categories=["cinema"],
    )


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(output_dir=tmp_path, request_delay=0, tmdb_api_key="test-key")


async def test_enrich_batch_end_to_end(settings):
    batch = EventBatch(
        source="kudago", city="msk", fetched_at=datetime.now(UTC), count=2,
        events=[
            cinema_event("1", "Показ фильма «Территория»"),
            cinema_event("2", "Показ фильма «Никогда не существовавший фильм тчк»"),
        ],
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/3/genre/movie/list":
            return httpx.Response(200, json={"genres": [{"id": 18, "name": "драма"}]})
        if request.url.path == "/3/genre/tv/list":
            return httpx.Response(200, json={"genres": []})
        if request.url.path == "/3/search/movie":
            query = request.url.params["query"]
            if query == "Территория":
                return httpx.Response(200, json={"results": [
                    {"id": 42, "title": "Территория", "original_title": "Территория",
                     "release_date": "1978-01-01", "overview": "Чукотка.", "genre_ids": [18],
                     "vote_average": 7.1, "poster_path": "/poster.jpg"},
                ]})
            return httpx.Response(200, json={"results": []})
        if request.url.path == "/3/movie/42/videos":
            return httpx.Response(200, json={"results": [
                {"site": "YouTube", "type": "Trailer", "official": True, "key": "abc123"},
            ]})
        raise AssertionError(f"неожиданный запрос: {request.url}")

    async with HttpClient(settings, transport=httpx.MockTransport(handler)) as http:
        result = await enrich_batch(batch, settings, http=http)

    assert result is not None
    assert result.matched == 1 and result.skipped == 1
    movie = result.movies[0]
    assert movie.event_source_id == "1"
    assert movie.tmdb_id == 42
    assert movie.genres == ["драма"]
    assert movie.trailer_url == "https://www.youtube.com/watch?v=abc123"
    assert movie.poster_url == "https://image.tmdb.org/t/p/w500/poster.jpg"


async def test_enrich_batch_without_api_key_returns_none(tmp_path):
    settings = Settings(output_dir=tmp_path, tmdb_api_key=None)
    batch = EventBatch(source="kudago", city="msk", fetched_at=datetime.now(UTC), count=1,
                        events=[cinema_event("1", "Показ фильма «Территория»")])
    assert await enrich_batch(batch, settings) is None


async def test_enrich_batch_skips_when_no_cinema_events(settings):
    batch = EventBatch(source="kudago", city="msk", fetched_at=datetime.now(UTC), count=1,
                        events=[Event(source="kudago", source_id="1", source_url="https://kudago.com/",
                                       city="msk", title="Концерт", categories=["concert"])])
    assert await enrich_batch(batch, settings) is None
