"""Кино KudaGo: фильмы, сеансы по кинотеатрам, трейлеры, файл для приложения."""

import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from afisha_parser import pipeline
from afisha_parser.cinema import CinemaBatch, CinemaMovie, Showing, drop_past_showings
from afisha_parser.config import Settings
from afisha_parser.cycle import format_status, run_cycle
from afisha_parser.http_client import HttpClient
from afisha_parser.sources.cinema_kudago import parse_movie, parse_showing

NOW = datetime.now(UTC)


def movie_item(i: int, **extra) -> dict:
    item = {"id": i, "title": f"фильм {i}", "original_title": f"Film {i}", "year": 2026, "running_time": 110,
            "genres": [{"name": "драма"}], "age_restriction": "16", "poster": {"image": f"https://kudago.com/p{i}.jpg"},
            "trailer": f"https://www.youtube.com/watch?v=trailer{i:04d}", "site_url": f"https://kudago.com/msk/film/{i}/",
            "imdb_rating": 7.5, "description": "<p>Про жизнь</p>"}
    item.update(extra)
    return item


def showing_item(i: int, movie_id: int, hours: float, cinema: int = 1) -> dict:
    return {"id": i, "datetime": int((NOW + timedelta(hours=hours)).timestamp()), "three_d": i % 2 == 0,
            "movie": {"id": movie_id, "title": f"фильм {movie_id}"},
            "place": {"id": cinema, "title": f"Кинотеатр {cinema}", "address": "ул. Кино, 1",
                      "coords": {"lat": 55.75, "lon": 37.6}}}


def test_parse_movie_and_showing():
    movie = parse_movie(movie_item(1), city="msk")
    assert movie.title == "Фильм 1" and movie.age_restriction == "16+" and movie.genres == ["драма"]
    assert movie.trailer.key == "trailer0001" and movie.trailer_source == "kudago"
    assert movie.description == "Про жизнь" and movie.poster.url.endswith("p1.jpg")
    assert parse_movie(movie_item(2, trailer=""), city="msk").trailer is None
    stub, showing = parse_showing(showing_item(5, 1, 3), tz=UTC)
    assert stub["id"] == 1 and showing.cinema_name == "Кинотеатр 1" and showing.lat == 55.75
    assert parse_showing({"id": 6, "datetime": None}, tz=UTC) is None


def test_drop_past_showings():
    past = Showing(source_id="1", starts_at=NOW - timedelta(hours=1))
    future = Showing(source_id="2", starts_at=NOW + timedelta(hours=1))
    movies = [CinemaMovie(source="kudago", source_id="1", city="msk", title="А", showings=[past, future]),
              CinemaMovie(source="kudago", source_id="2", city="msk", title="Б", showings=[past]),
              CinemaMovie(source="kudago", source_id="3", city="msk", title="В")]
    batch = CinemaBatch(source="kudago", city="msk", fetched_at=NOW, days=3, movies_count=3, showings_count=3,
                        movies=movies)
    left = drop_past_showings(batch, NOW)
    assert [m.source_id for m in left.movies] == ["1", "3"] and left.showings_count == 1


@pytest.fixture(autouse=True)
def no_backoff(monkeypatch):
    monkeypatch.setattr(HttpClient, "_backoff", staticmethod(lambda attempt, response: 0))


def handler(seen: list):
    def inner(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        path = request.url.path
        if path.endswith("/movie-showings/"):
            assert request.url.params["expand"] == "movie,place"
            return httpx.Response(200, json={"count": 3, "next": None, "results": [
                showing_item(10, 1, 30), showing_item(11, 1, 5, cinema=2), showing_item(12, 3, 2)]})
        if path.endswith("/movies/"):
            return httpx.Response(200, json={"count": 2, "next": None, "results": [
                movie_item(1), movie_item(2, trailer=None)]})
        if path.endswith(".jpg"):
            return httpx.Response(200, content=b"jpg", headers={"content-type": "image/jpeg"})
        if path.endswith("/events/"):
            return httpx.Response(200, json={"count": 0, "next": None, "results": []})
        return httpx.Response(404)
    return inner


async def test_cycle_builds_cinema_files(tmp_path, monkeypatch):
    seen: list[str] = []
    real = pipeline.HttpClient
    monkeypatch.setattr(pipeline, "HttpClient", lambda settings, **kw: real(
        settings, transport=httpx.MockTransport(handler(seen)), **kw))
    settings = Settings(output_dir=tmp_path, request_delay=0, max_retries=1, save_raw=False, movies=False,
                        now_playing=False, tmdb_api_key=None, cinema=True, cinema_sources="kudago", cities="msk,omsk",
                        sources="kudago")

    status = await run_cycle(settings)

    report = status["cinema"][0]
    assert (report["city"], report["movies"], report["showings"], report["with_trailer"]) == ("msk", 3, 3, 1)
    assert len(status["cinema"]) == 1  # у KudaGo нет Омска
    app = json.loads((tmp_path / "app" / "cinema" / "msk" / "latest.json").read_text(encoding="utf-8"))
    first = app["movies"][0]
    # фильм 3 есть только в сеансах — карточка собрана из раскрытого movie; ближайший сеанс первым
    assert first["externalId"] == "3"
    film1 = next(m for m in app["movies"] if m["externalId"] == "1")
    assert [c["name"] for c in film1["cinemas"]] == ["Кинотеатр 2", "Кинотеатр 1"]
    assert film1["trailer"]["embedUrl"].endswith("trailer0001") and film1["posterUrl"].startswith("/media/events/")
    film2 = next(m for m in app["movies"] if m["externalId"] == "2")
    assert film2["cinemas"] == [] and film2["trailer"] is None
    assert "кино kudago/msk: фильмов 3, сеансов 3" in format_status(settings, status)
    # фильмы с сеансами — ещё и события Evently (в общую ленту) + трейлеры к ним в movies/
    evently = json.loads((tmp_path / "evently" / "kudago-cinema" / "msk" / "latest.json").read_text(encoding="utf-8"))
    ids = {e["externalId"]: e for e in evently["events"]}
    assert set(ids) == {"msk-1", "msk-3"}  # у фильма 2 нет сеансов
    assert ids["msk-3"]["venue"]["name"] == "Кинотеатр 1" and len(ids["msk-1"]["occurrences"]) == 2
    links = json.loads((tmp_path / "movies" / "kudago-cinema" / "msk" / "latest.json").read_text(encoding="utf-8"))
    link = next(m for m in links["movies"] if m["event_source_id"] == "msk-1")
    assert link["event_source"] == "kudago-cinema" and link["trailer"]["key"] == "trailer0001"
    target = next(t for t in status["targets"] if t["source"] == "kudago-cinema")
    assert target["fresh"] and target["ok"]

    seen.clear()
    await run_cycle(settings)  # 12 часов не прошло — к KudaGo за кино не ходим
    assert not [p for p in seen if "movie" in p]


async def test_trailer_from_tmdb_catalog():
    from afisha_parser.cinema_cycle import enrich_trailers
    from afisha_parser.enrichers.tmdb_catalog import CatalogMovie
    from afisha_parser.enrichers.tmdb_trailers import Trailer
    trailer = Trailer(key="cat", url="https://www.youtube.com/watch?v=cat", embed_url="https://x/cat")
    catalog = [CatalogMovie(tmdb_id=5, status="now_playing", title="Фильм 2", release_date="2026-01-01",
                            tmdb_url="https://www.themoviedb.org/movie/5", trailer=trailer),
               CatalogMovie(tmdb_id=6, status="now_playing", title="Фильм 9", release_date="1990-01-01",
                            tmdb_url="https://www.themoviedb.org/movie/6", trailer=trailer)]
    movies = [parse_movie(movie_item(2, trailer=None), city="msk"),
              parse_movie(movie_item(9, trailer=None, year=2026), city="msk")]
    await enrich_trailers(movies, None, catalog, None)
    assert movies[0].tmdb_id == 5 and movies[0].trailer.key == "cat" and movies[0].trailer_source == "tmdb"
    assert movies[1].trailer is None  # год не тот — это другой фильм



def test_cli_cinema_and_places(tmp_path, monkeypatch, capsys):
    import afisha_parser.__main__ as cli
    from afisha_parser.config import get_settings

    def all_handler(request: httpx.Request) -> httpx.Response:
        if "place-categories" in request.url.path:
            return httpx.Response(200, json=[{"slug": "restaurants", "name": "Рестораны"}])
        if request.url.path.endswith("/places/"):
            return httpx.Response(200, json={"count": 0, "next": None, "results": []})
        if "interpreter" in request.url.path:
            return httpx.Response(200, json={"elements": [
                {"type": "node", "id": 1, "lat": 55.0, "lon": 82.9, "tags": {"amenity": "cafe", "name": "Ёлка"}}]})
        return handler([])(request)

    real = HttpClient
    patched = lambda settings, **kw: real(settings, transport=httpx.MockTransport(all_handler), **kw)  # noqa: E731
    monkeypatch.setattr(cli, "HttpClient", patched)
    monkeypatch.setattr(pipeline, "HttpClient", patched)
    for key, value in {"AFISHA_OUTPUT_DIR": str(tmp_path), "AFISHA_CITIES": "msk,omsk", "AFISHA_REQUEST_DELAY": "0",
                       "AFISHA_DOWNLOAD_IMAGES": "false"}.items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()
    try:
        assert cli.main(["cinema", "--city", "msk"]) == 0
        assert "msk: фильмов 3, сеансов 3" in capsys.readouterr().out
        assert cli.main(["places", "--city", "omsk"]) == 0
        assert "osm/omsk: 1 заведений, обновлено" in capsys.readouterr().out
    finally:
        get_settings.cache_clear()


def kp_doc(i: int, **extra) -> dict:
    doc = {"id": i, "name": f"Новый фильм {i}", "alternativeName": f"New Film {i}", "year": 2026, "movieLength": 100,
           "ageRating": 12, "genres": [{"name": "комедия"}], "countries": [{"name": "Россия"}],
           "poster": {"url": f"https://image.openmoviedb.com/p{i}.jpg"}, "rating": {"kp": 7.1, "imdb": 0},
           "shortDescription": "Коротко", "description": "Длинно",
           "videos": {"trailers": [{"url": f"https://www.youtube.com/embed/kp{i:09d}", "name": "Трейлер"}]},
           "premiere": {"russia": "2026-10-01T00:00:00.000Z"}}
    doc.update(extra)
    return doc


async def test_kinopoisk_releases_become_city_events(tmp_path, monkeypatch):
    from afisha_parser import cycle as cycle_module
    seen: list[httpx.Request] = []

    def kp_handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.host == "api.poiskkino.dev":
            assert request.headers["x-api-key"] == "kp"
            params = request.url.params
            if request.url.path == "/v1.4/movie/2":  # догрузка ролика по полной карточке
                return httpx.Response(200, json={"id": 2, "videos": {"trailers": [
                    {"url": "https://www.youtube.com/embed/backfill002", "name": "Трейлер"}]}})
            assert "videos" in params.get_list("selectFields") and params.get_list("type") == ["movie", "cartoon", "anime"]
            if params.get("ticketsOnSale") == "true":
                return httpx.Response(200, json={"docs": [kp_doc(1), kp_doc(2, videos={}), kp_doc(5, isSeries=True),
                                                          kp_doc(6, name="TheatreHD: Гамлет", videos={})]})
            assert "-" in params["premiere.russia"]
            return httpx.Response(200, json={"docs": [kp_doc(1), kp_doc(3, premiere={"russia": "2099-01-01T00:00:00Z"})]})
        if request.url.path.endswith(".jpg"):
            return httpx.Response(200, content=b"jpg", headers={"content-type": "image/jpeg"})
        return httpx.Response(404)

    real = HttpClient
    patched = lambda settings, **kw: real(settings, transport=httpx.MockTransport(kp_handler), **{**kw, "delay": 0})  # noqa: E731
    monkeypatch.setattr(pipeline, "HttpClient", patched)
    monkeypatch.setattr(cycle_module, "HttpClient", patched)
    settings = Settings(output_dir=tmp_path, request_delay=0, max_retries=1, save_raw=False, movies=False,
                        now_playing=False, tmdb_api_key=None, cinema=True, cinema_sources="kinopoisk",
                        cities="nsk,omsk", sources="timepad", kinopoisk_token="kp",
                        kinopoisk_city_ids="nsk:999")

    status = await run_cycle(settings)

    summary = next(c for c in status["cinema"] if c["city"] == "ru")
    # сериал и трансляция TheatreHD отброшены, ролик фильма 2 догружен из полной карточки
    assert summary["fresh"] and summary["movies"] == 3 and summary["with_trailer"] == 3
    assert summary["backfilled"] == 1
    evently = json.loads((tmp_path / "evently" / "kinopoisk-cinema" / "omsk" / "latest.json").read_text(encoding="utf-8"))
    by_id = {e["externalId"]: e for e in evently["events"]}
    assert set(by_id) == {"omsk-1", "omsk-2", "omsk-3"}  # сериал отброшен
    assert by_id["omsk-1"]["ticketUrl"] == "https://www.kinopoisk.ru/film/1/afisha/"
    nsk = json.loads((tmp_path / "evently" / "kinopoisk-cinema" / "nsk" / "latest.json").read_text(encoding="utf-8"))
    nsk_by_id = {e["externalId"]: e for e in nsk["events"]}
    # у Новосибирска задан номер города — ссылка ведёт на сеансы именно в нём
    assert nsk_by_id["nsk-1"]["ticketUrl"] == "https://www.kinopoisk.ru/film/1/afisha/city/999/"
    assert all(e["categories"] == ["cinema"] for e in evently["events"])  # в отдельную ленту кино
    assert by_id["omsk-3"]["occurrences"][0]["startsAt"].startswith("2099-01-01T10:00")
    assert by_id["omsk-1"]["occurrences"][0]["startsAt"].endswith("+06:00")  # время Омска
    links = json.loads((tmp_path / "movies" / "kinopoisk-cinema" / "nsk" / "latest.json").read_text(encoding="utf-8"))
    assert {m["event_source_id"] for m in links["movies"] if m["trailer"]} == {"nsk-1", "nsk-2", "nsk-3"}
    targets = {(t["source"], t["city"]) for t in status["targets"]}
    assert {("kinopoisk-cinema", "nsk"), ("kinopoisk-cinema", "omsk")} <= targets
    assert "кино kinopoisk/ru: фильмов 3" in format_status(settings, status)
    app = json.loads((tmp_path / "app" / "cinema" / "nsk" / "latest.json").read_text(encoding="utf-8"))
    assert app["count"] == 3 and app["movies"][0]["posterUrl"].startswith("/media/events/")
    assert app["movies"][0]["ticketUrl"].endswith("/afisha/city/999/")
    # общий список проката не испорчен городскими ссылками
    shared = json.loads((tmp_path / "cinema" / "kinopoisk" / "ru" / "latest.json").read_text(encoding="utf-8"))
    assert all(m["ticket_url"].endswith("/afisha/") for m in shared["movies"])

    used = len([r for r in seen if r.url.host == "api.poiskkino.dev"])
    await run_cycle(settings)  # интервал не прошёл — к Кинопоиску не ходим, события всё равно пересобраны
    assert len([r for r in seen if r.url.host == "api.poiskkino.dev"]) == used


def test_select_movies_caps_now_playing_and_premieres():
    from afisha_parser.cinema_cycle import select_movies
    now = datetime(2026, 10, 24, tzinfo=UTC)
    movies = ([CinemaMovie(source="kinopoisk", source_id=f"n{i}", city="ru", title=f"N{i}", year=2026,
                           status="now_playing") for i in range(50)]
              + [CinemaMovie(source="kinopoisk", source_id="old", city="ru", title="Питер FM", year=2006,
                             status="now_playing")]
              + [CinemaMovie(source="kinopoisk", source_id=f"u{i}", city="ru", title=f"U{i}", year=2026,
                             status="upcoming") for i in range(20)])
    batch = CinemaBatch(source="kinopoisk", city="ru", fetched_at=now, days=30, movies_count=len(movies),
                        showings_count=0, movies=movies)
    kept = select_movies(batch, Settings(cinema_max_films=40, cinema_max_premieres=15, cinema_max_age_years=2), now)
    ids = [m.source_id for m in kept.movies]
    assert ids[:40] == [f"n{i}" for i in range(40)]  # самые популярные (порядок API) — первые 40
    assert ids[40:] == [f"u{i}" for i in range(15)] and "old" not in ids and kept.movies_count == 55


def test_kinopoisk_city_ids():
    s = Settings(kinopoisk_city_ids="nsk:123; msk:77, bad:x")
    assert s.kinopoisk_city_id("nsk") == 123 and s.kinopoisk_city_id("msk") == 77  # .env важнее cities.py
    assert s.kinopoisk_city_id("spb") == 2 and s.kinopoisk_city_id("smr") == 11
    assert s.kinopoisk_city_id("bad") is None and s.kinopoisk_city_id("omsk") is None
    movie = CinemaMovie(source="kinopoisk", source_id="5", city="ru", title="Фильм", kinopoisk_id=5,
                        ticket_url="https://www.kinopoisk.ru/film/5/afisha/")
    from afisha_parser.cinema import kinopoisk_ticket_url
    assert kinopoisk_ticket_url(movie, 2) == "https://www.kinopoisk.ru/film/5/afisha/city/2/"
    assert kinopoisk_ticket_url(movie, None) == "https://www.kinopoisk.ru/film/5/afisha/"


def test_source_limits():
    s = Settings(requests_per_hour=30, source_limits="kudago:10, osm:60", request_delay=0)
    assert s.source_gap_seconds("kudago") == 360 and s.source_gap_seconds("osm") == 60
    assert s.source_gap_seconds("timepad") == 120 and s.source_gap_seconds() == 120
