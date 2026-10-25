"""Заведения: KudaGo places, OpenStreetMap, склейка и файл для приложения."""

import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from afisha_parser import pipeline
from afisha_parser.cities import CITIES
from afisha_parser.config import Settings
from afisha_parser.cycle import format_status, run_cycle
from afisha_parser.http_client import HttpClient
from afisha_parser.places import Place, PlaceBatch, export_places, merge_places
from afisha_parser.sources.osm import build_query, parse_element
from afisha_parser.sources.places_kudago import food_categories, parse_place

CATEGORIES = [
    {"slug": "restaurants", "name": "Рестораны"}, {"slug": "bar", "name": "Бары и пабы"},
    {"slug": "anticafe", "name": "Антикафе"}, {"slug": "museums", "name": "Музеи"},
    {"slug": "coffee", "name": "Кофейни"},
]


def kudago_place(i: int, **extra) -> dict:
    item = {"id": i, "title": f"ресторан {i}", "slug": f"r{i}", "address": "ул. Ленина, 1",
            "coords": {"lat": 55.03, "lon": 82.92}, "categories": ["restaurants"], "timetable": "ежедневно 12:00–23:00",
            "phone": "+7 383 000-00-00", "foreign_url": "https://example.ru", "is_closed": False,
            "images": [{"image": f"https://kudago.com/media/p{i}.jpg", "source": {}},
                       {"image": f"https://kudago.com/media/p{i}b.jpg", "source": {}}],
            "description": "<p>Уютно</p>", "body_text": "Подробно"}
    item.update(extra)
    return item


def osm_node(i: int, lat=54.99, lon=73.37, **tags) -> dict:
    return {"type": "node", "id": i, "lat": lat, "lon": lon,
            "tags": {"amenity": "restaurant", "name": f"Кафе {i}", **tags}}


def test_food_categories_filter():
    assert food_categories(CATEGORIES) == {"restaurants": "Рестораны", "bar": "Бары и пабы", "coffee": "Кофейни"}


def test_parse_kudago_place():
    place = parse_place(kudago_place(7), city="nsk", category_names={"restaurants": "Рестораны"})
    assert place.kind == "restaurant" and place.title == "Ресторан 7"
    assert place.description == "Уютно" and place.website == "https://example.ru"
    assert len(place.images) == 1 and place.source_url == "https://kudago.com/nsk/place/r7/"
    assert parse_place(kudago_place(8, is_closed=True), city="nsk", category_names={}) is None


def test_parse_osm():
    node = parse_element(osm_node(1, cuisine="russian;coffee_shop", **{"addr:street": "ул. Ленина",
                                                                       "addr:housenumber": "5"}), city="omsk")
    assert node.source_id == "node/1" and node.address == "ул. Ленина, 5"
    assert node.cuisine == ["русская", "кофе"]
    way = parse_element({"type": "way", "id": 2, "center": {"lat": 1.0, "lon": 2.0},
                         "tags": {"amenity": "cafe", "name": "Зерно", "cuisine": "coffee_shop"}}, city="omsk")
    assert (way.lat, way.kind) == (1.0, "coffee")
    assert parse_element({"type": "node", "id": 3, "tags": {"amenity": "restaurant"}}, city="omsk") is None
    assert parse_element({"type": "node", "id": 4, "tags": {"amenity": "bank", "name": "Банк"}}, city="omsk") is None
    query = build_query(CITIES["omsk"], 15000, ["restaurant", "cafe"])
    assert "around:15000,54.9885,73.3242" in query and "^(cafe|restaurant)$" in query


def test_merge_drops_osm_duplicates():
    now = datetime.now(UTC)
    a = Place(source="kudago", source_id="1", city="nsk", title="Ресторан Тайга", kind="restaurant", lat=55.0, lon=82.9)
    b = Place(source="osm", source_id="node/1", city="nsk", title="Тайга", kind="restaurant", lat=55.0003, lon=82.9)
    b2 = b.model_copy(update={"title": "Ресторан Тайга", "source_id": "node/2"})
    c = Place(source="osm", source_id="node/3", city="nsk", title="Другое", kind="cafe", lat=55.0, lon=82.9)
    batches = [PlaceBatch(source="kudago", city="nsk", fetched_at=now, count=1, attribution="KudaGo", places=[a]),
               PlaceBatch(source="osm", city="nsk", fetched_at=now, count=3, attribution="OSM", places=[b, b2, c])]
    assert [p.source_id for p in merge_places(batches)] == ["1", "node/1", "node/3"]


@pytest.fixture(autouse=True)
def no_backoff(monkeypatch):
    monkeypatch.setattr(HttpClient, "_backoff", staticmethod(lambda attempt, response: 0))


def handler_factory(kudago_count: int, seen: list):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        if "place-categories" in request.url.path:
            return httpx.Response(200, json=CATEGORIES)
        if request.url.path.endswith("/places/"):
            assert request.url.params["categories"] == "restaurants,bar,coffee"
            return httpx.Response(200, json={"count": kudago_count, "next": None,
                                             "results": [kudago_place(i) for i in range(kudago_count)]})
        if "interpreter" in request.url.path:
            return httpx.Response(200, json={"elements": [osm_node(1), osm_node(2)]})
        if request.url.path.endswith(".jpg"):
            return httpx.Response(200, content=b"img", headers={"content-type": "image/jpeg"})
        return httpx.Response(404)
    return handler


def settings_for(tmp_path, **extra) -> Settings:
    base = dict(output_dir=tmp_path, request_delay=0, max_retries=1, save_raw=False, movies=False,
                now_playing=False, tmdb_api_key=None, places=True, cities="nsk,omsk", sources="kudago",
                places_min_kudago=3)
    return Settings(**{**base, **extra})


async def test_cycle_collects_places_weekly(tmp_path, monkeypatch):
    seen: list[str] = []
    real = pipeline.HttpClient
    monkeypatch.setattr(pipeline, "HttpClient", lambda settings, **kw: real(
        settings, transport=httpx.MockTransport(handler_factory(5, seen)), **kw))
    settings = settings_for(tmp_path)

    status = await run_cycle(settings)

    by_key = {(p["source"], p["city"]): p for p in status["places"]}
    assert by_key[("kudago", "nsk")]["count"] == 5 and by_key[("kudago", "nsk")]["fresh"]
    assert by_key[("osm", "omsk")]["count"] == 2  # у KudaGo нет Омска
    assert ("osm", "nsk") not in by_key  # KudaGo отдал достаточно
    app = json.loads((tmp_path / "app" / "places" / "nsk" / "latest.json").read_text(encoding="utf-8"))
    assert app["count"] == 5 and app["cityName"] == "Новосибирск"
    first = app["places"][0]
    assert first["images"][0]["localPath"].startswith("images/") and first["kind"] == "restaurant"
    omsk = json.loads((tmp_path / "app" / "places" / "omsk" / "latest.json").read_text(encoding="utf-8"))
    assert omsk["attribution"] == ["© участники OpenStreetMap (ODbL)"]
    assert "заведения kudago/nsk: 5, обновлено" in format_status(settings, status)

    seen.clear()
    status = await run_cycle(settings)  # неделя не прошла — заведения не запрашиваем
    assert not [p for p in seen if "places" in p or "interpreter" in p]
    assert all(not p["fresh"] and p.get("next_due") for p in status["places"])


async def test_thin_kudago_city_gets_osm_too(tmp_path, monkeypatch):
    seen: list[str] = []
    real = pipeline.HttpClient
    monkeypatch.setattr(pipeline, "HttpClient", lambda settings, **kw: real(
        settings, transport=httpx.MockTransport(handler_factory(1, seen)), **kw))
    status = await run_cycle(settings_for(tmp_path, cities="nsk"))
    assert {(p["source"], p["city"]) for p in status["places"]} == {("kudago", "nsk"), ("osm", "nsk")}
    app = json.loads((tmp_path / "app" / "places" / "nsk" / "latest.json").read_text(encoding="utf-8"))
    assert app["count"] == 3 and set(app["sources"]) == {"kudago", "osm"}


async def test_places_due_after_interval(tmp_path):
    from afisha_parser.places import places_due
    old = datetime.now(UTC) - timedelta(days=8)
    export_places(PlaceBatch(source="osm", city="omsk", fetched_at=old, count=0, attribution="x", places=[]), tmp_path)
    assert places_due(tmp_path, "osm", "omsk", 168, datetime.now(UTC))
    assert not places_due(tmp_path, "osm", "omsk", 24 * 9, datetime.now(UTC))
