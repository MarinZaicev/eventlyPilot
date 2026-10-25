"""Афиша проката TMDb, скачивание файлов трейлеров и отправка в бэкенд — без сети."""

import json

import httpx
import pytest

from afisha_parser.config import Settings
from afisha_parser.enrichers.tmdb_catalog import export_catalog, fetch_catalog, parse_movie
from afisha_parser.enrichers.tmdb_trailers import pick_trailer
from afisha_parser.http_client import HttpClient
from afisha_parser.publisher import PublishError, publish_evently
from afisha_parser.trailers import MAX_FAILURES, download_trailers

VIDEOS = [
    {"site": "YouTube", "key": "teaser", "type": "Teaser", "iso_639_1": "ru", "official": True},
    {"site": "YouTube", "key": "en-trailer", "type": "Trailer", "iso_639_1": "en", "official": True},
    {"site": "YouTube", "key": "ru-trailer", "type": "Trailer", "iso_639_1": "ru", "official": False},
    {"site": "Vimeo", "key": "vimeo", "type": "Trailer", "iso_639_1": "ru"},
]


def details(movie_id: int, title: str) -> dict:
    return {
        "id": movie_id, "title": title, "original_title": title + " (orig)", "overview": "Описание",
        "release_date": "2026-01-01", "runtime": 118, "genres": [{"id": 1, "name": "драма"}],
        "poster_path": "/p.jpg", "backdrop_path": "/b.jpg", "vote_average": 7.1,
        "videos": {"results": VIDEOS},
        "release_dates": {"results": [
            {"iso_3166_1": "US", "release_dates": [{"type": 3, "release_date": "2026-01-01T00:00:00.000Z", "certification": "R"}]},
            {"iso_3166_1": "RU", "release_dates": [{"type": 3, "release_date": "2026-09-25T00:00:00.000Z", "certification": "16"}]},
        ]},
    }


def test_pick_trailer_prefers_trailer_then_language():
    assert pick_trailer(VIDEOS, prefer_language="ru").key == "ru-trailer"
    trailer = pick_trailer(VIDEOS)
    assert trailer.key in {"en-trailer", "ru-trailer"}
    assert trailer.embed_url.startswith("https://www.youtube-nocookie.com/embed/")
    assert pick_trailer([{"site": "Vimeo", "key": "x", "type": "Trailer"}]) is None


def test_parse_movie_takes_regional_date_and_rating():
    movie = parse_movie(details(5, "Фильм"), "now_playing", "RU", "ru-RU")
    assert movie.release_date == "2026-09-25"
    assert movie.age_rating == "16+"
    assert movie.trailer.key == "ru-trailer"
    assert movie.poster_url.endswith("/p.jpg")


async def test_fetch_catalog_marks_status_and_dedupes(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/now_playing"):
            return httpx.Response(200, json={"total_pages": 1, "results": [{"id": 1}, {"id": 2}]})
        if path.endswith("/upcoming"):
            return httpx.Response(200, json={"total_pages": 1, "results": [{"id": 2}, {"id": 3}]})
        movie_id = int(path.rsplit("/", 1)[1])
        if movie_id == 3:
            return httpx.Response(404)
        return httpx.Response(200, json=details(movie_id, f"Фильм {movie_id}"))

    settings = Settings(output_dir=tmp_path, request_delay=0, max_retries=1, tmdb_api_key="k")
    async with HttpClient(settings, delay=0, transport=httpx.MockTransport(handler)) as http:
        catalog = await fetch_catalog(settings, http=http)

    assert [(m.tmdb_id, m.status) for m in catalog.movies] == [(1, "now_playing"), (2, "now_playing")]
    path = export_catalog(catalog, tmp_path)
    assert path.parent == tmp_path / "movies" / "tmdb" / "ru"


async def test_fetch_catalog_without_key(tmp_path):
    assert await fetch_catalog(Settings(output_dir=tmp_path, tmdb_api_key=None)) is None


async def test_download_trailers_budget_dedupe_and_failures(tmp_path):
    settings = Settings(output_dir=tmp_path, trailers_per_run=2)
    trailers = [pick_trailer([v]) for v in VIDEOS[:3]]
    duplicate = pick_trailer([VIDEOS[1]])
    calls: list[str] = []

    def fake(url, folder, key, s):
        calls.append(key)
        if key == "teaser":
            raise RuntimeError("ERROR: Video unavailable")
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{key}.mp4"
        path.write_bytes(b"mp4")
        return path

    assert await download_trailers(trailers + [duplicate], tmp_path, settings, downloader=fake) == 1
    assert calls == ["teaser", "en-trailer"]  # бюджет 2 за цикл, дубль не качается
    assert trailers[1].local_path == "trailers/en-trailer.mp4"
    assert duplicate.local_path == "trailers/en-trailer.mp4"

    calls.clear()
    await download_trailers(trailers, tmp_path, settings, downloader=fake)
    assert calls == ["teaser", "ru-trailer"]  # скачанное повторно не качается

    for _ in range(MAX_FAILURES):
        await download_trailers(trailers, tmp_path, settings, downloader=fake)
    calls.clear()
    await download_trailers(trailers, tmp_path, settings, downloader=fake)
    assert calls == []  # после MAX_FAILURES неудач ролик больше не пробуем


async def test_publish_in_chunks_with_token(tmp_path):
    path = tmp_path / "evently.json"
    path.write_text(json.dumps({"events": [{"externalId": str(i)} for i in range(5)]}), encoding="utf-8")
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.headers.get("authorization"), len(json.loads(request.content)["events"])))
        return httpx.Response(200, json={"ok": True})

    settings = Settings(evently_import_url="http://backend/internal/events/import/batch",
                        evently_import_token="secret", evently_import_chunk=2)
    assert await publish_evently(path, settings, transport=httpx.MockTransport(handler)) == 5
    assert seen == [("Bearer secret", 2), ("Bearer secret", 2), ("Bearer secret", 1)]


async def test_publish_rejected_raises(tmp_path):
    path = tmp_path / "evently.json"
    path.write_text('{"events": [{}]}', encoding="utf-8")
    settings = Settings(evently_import_url="http://backend/import")
    with pytest.raises(PublishError, match="422"):
        await publish_evently(path, settings, transport=httpx.MockTransport(lambda r: httpx.Response(422, text="bad")))


def test_trailers_page(tmp_path):
    from afisha_parser.preview import build_trailers_page
    settings = Settings(output_dir=tmp_path)
    catalog = parse_movie(details(5, "Фильм <тест>"), "now_playing", "RU", "ru-RU")
    from afisha_parser.enrichers.tmdb_catalog import CatalogBatch
    from datetime import UTC, datetime
    export_catalog(CatalogBatch(region="RU", fetched_at=datetime.now(UTC), count=1, with_trailer=1, movies=[catalog]),
                   settings.output_dir)
    page = build_trailers_page(tmp_path).read_text(encoding="utf-8")
    assert "youtube-nocookie.com/embed/ru-trailer" in page
    assert "Фильм &lt;тест&gt;" in page
