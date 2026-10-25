"""Запасные трейлеры с Кинопоиска (ПоискКино API)."""

from datetime import UTC, date, datetime

import httpx

from afisha_parser.config import Settings
from afisha_parser.enrichers.kinopoisk import (
    BudgetExhausted, KinopoiskClient, best_doc, pick_kinopoisk_trailer, trailer_from_url, youtube_key,
)
from afisha_parser.enrichers.tmdb_trailers import enrich_batch
from afisha_parser.http_client import HttpClient
from afisha_parser.models import Event, EventBatch

import pytest


def test_youtube_links():
    assert youtube_key("https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0") == "dQw4w9WgXcQ"
    assert youtube_key("https://youtu.be/dQw4w9WgXcQ") == "dQw4w9WgXcQ"
    assert youtube_key("https://widgets.kinopoisk.ru/discovery/trailer/1") is None
    yt = trailer_from_url("//www.youtube.com/embed/dQw4w9WgXcQ")
    assert yt.site == "YouTube" and yt.url == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    kp = trailer_from_url("https://widgets.kinopoisk.ru/discovery/trailer/1")
    assert kp.site == "Kinopoisk" and kp.key.startswith("kp-") and kp.embed_url == kp.url


def test_pick_prefers_youtube_trailer():
    movie = {"videos": {"trailers": [
        {"url": "https://widgets.kinopoisk.ru/discovery/trailer/1", "name": "Трейлер"},
        {"url": "https://www.youtube.com/embed/aaaaaaaaaaa", "name": "Тизер"},
        {"url": "https://www.youtube.com/embed/bbbbbbbbbbb", "name": "Трейлер (русский язык)"},
    ]}}
    assert pick_kinopoisk_trailer(movie).key == "bbbbbbbbbbb"
    assert pick_kinopoisk_trailer({}) is None


def test_best_doc_is_strict():
    docs = [{"id": 1, "name": "Чебурашка", "year": 2022}, {"id": 2, "name": "Чебурашка", "year": 1971}]
    assert best_doc(docs, "Чебурашка", 2023)["id"] == 1
    assert best_doc(docs, "Чебурашка", None) is None  # два одинаковых — без года не угадываем
    assert best_doc([{"id": 3, "name": "Чебурашка 2", "year": 2026}], "Чебурашка", None) is None


def kp_handler(calls: list):
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        assert request.headers["x-api-key"] == "kp-token"
        if request.url.path == "/v1.4/movie/search":
            if request.url.params["query"] == "Летучий корабль":
                return httpx.Response(200, json={"docs": [{"id": 77, "name": "Летучий корабль", "year": 2024}]})
            return httpx.Response(200, json={"docs": []})
        if request.url.path == "/v1.4/movie/77":
            return httpx.Response(200, json={"id": 77, "name": "Летучий корабль", "year": 2024,
                                             "description": "Сказка", "genres": [{"name": "мюзикл"}],
                                             "videos": {"trailers": [{"url": "https://www.youtube.com/embed/ccccccccccc",
                                                                      "name": "Трейлер"}]}})
        raise AssertionError(request.url)
    return handler


async def test_lookup_caches_and_counts_budget(tmp_path):
    calls: list = []
    settings = Settings(output_dir=tmp_path)
    async with HttpClient(settings, transport=httpx.MockTransport(kp_handler(calls))) as http:
        kp = KinopoiskClient(http, "kp-token", tmp_path, requests_per_day=9)
        trailer = await kp.trailer("Летучий корабль", 2024)
        assert trailer.key == "ccccccccccc" and len(calls) == 2
        assert await kp.trailer("Летучий корабль", 2024) == trailer and len(calls) == 2  # из кеша
        assert await kp.trailer("Неизвестный фильм") is None and len(calls) == 3
        with pytest.raises(BudgetExhausted):
            await kp.trailer("Ещё один")
        kp.save()
    again = KinopoiskClient(None, "kp-token", tmp_path, requests_per_day=9)  # type: ignore[arg-type]
    assert again.used_today == 3 and again.cached("Летучий корабль", 2024)[0]


async def test_tmdb_miss_falls_back_to_kinopoisk(tmp_path):
    calls: list = []
    kp_inner = kp_handler(calls)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.themoviedb.org":
            if "genre" in request.url.path:
                return httpx.Response(200, json={"genres": []})
            return httpx.Response(200, json={"results": []})
        return kp_inner(request)

    settings = Settings(output_dir=tmp_path, tmdb_api_key="k", request_delay=0)
    event = Event(source="kudago", source_id="9", source_url="https://kudago.com/", city="msk",
                  title="Показ фильма «Летучий корабль»", categories=["cinema"])
    batch = EventBatch(source="kudago", city="msk", fetched_at=datetime.now(UTC), count=1, events=[event])
    async with HttpClient(settings, transport=httpx.MockTransport(handler)) as http:
        kp = KinopoiskClient(http, "kp-token", tmp_path)
        result = await enrich_batch(batch, settings, http=http, kinopoisk=kp)
    movie = result.movies[0]
    assert movie.tmdb_id is None and movie.kinopoisk_id == 77 and movie.matched_by == "kinopoisk"
    assert movie.trailer.key == "ccccccccccc" and movie.trailer_source == "kinopoisk"
    assert movie.genres == ["мюзикл"] and movie.release_year == 2024


def test_budget_resets_next_day(tmp_path):
    kp = KinopoiskClient(None, "t", tmp_path, requests_per_day=1)  # type: ignore[arg-type]
    kp._data["budget"] = {"day": "2000-01-01", "used": 99}
    assert kp.used_today == 0
    kp._data["budget"] = {"day": date.today().isoformat(), "used": 1}
    assert kp.used_today == 1



async def test_backfill_daily_quota_and_cache(tmp_path):
    from afisha_parser.cinema import CinemaMovie
    from afisha_parser.cinema_cycle import backfill_trailers
    calls: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        kp_id = int(request.url.path.rsplit("/", 1)[-1])
        videos = {"trailers": [{"url": f"https://youtu.be/{kp_id:011d}"}]} if kp_id % 2 else {}
        return httpx.Response(200, json={"id": kp_id, "videos": videos})

    movies = [CinemaMovie(source="kinopoisk", source_id=str(i), city="ru", title=f"Ф{i}", kinopoisk_id=i,
                          status="upcoming" if i == 1 else "now_playing") for i in range(1, 6)]
    settings = Settings(output_dir=tmp_path)
    async with HttpClient(settings, transport=httpx.MockTransport(handler)) as http:
        kp = KinopoiskClient(http, "t", tmp_path)
        added = await backfill_trailers(movies, kp, per_day=3)
        # сначала то, что уже в прокате (2, 3, 4), премьера 1 — в следующий раз
        assert calls == ["/v1.4/movie/2", "/v1.4/movie/3", "/v1.4/movie/4"] and added == 1
        assert movies[2].trailer.key == "00000000003" and movies[0].trailer is None
        calls.clear()
        assert await backfill_trailers(movies, kp, per_day=3) == 0 and calls == []  # норма на сегодня выбрана
        kp._data["backfill"] = {"day": "2000-01-01", "used": 3}  # наступил новый день
        await backfill_trailers(movies, kp, per_day=3)
        assert calls == ["/v1.4/movie/5", "/v1.4/movie/1"]  # 2 и 4 уже проверены — из кеша, без запросов
