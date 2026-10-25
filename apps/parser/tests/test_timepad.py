"""Timepad и справочник городов. Ответ собран по документации dev.timepad.ru (реальный пример — прислать с сервера)."""

import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from afisha_parser.cities import CITIES
from afisha_parser.config import Settings
from afisha_parser.exporters.evently import map_categories, to_evently_event
from afisha_parser.http_client import HttpClient
from afisha_parser.pipeline import fetch_and_save
from afisha_parser.sources.base import SourceConfigError
from afisha_parser.sources.kudago import kudago_code
from afisha_parser.sources.timepad import TimepadAccessError, parse_coordinates, parse_event, parse_price

OMSK = CITIES["omsk"]


def tp_event(event_id: int = 1, *, days: float = 3, **extra) -> dict:
    start = datetime.now(UTC) + timedelta(days=days)
    item = {
        "id": event_id,
        "name": "Концерт &laquo;Осень&raquo;",
        "url": f"https://afisha.timepad.ru/event/{event_id}/",
        "starts_at": start.strftime("%Y-%m-%dT%H:%M:%S+0000"),
        "ends_at": (start + timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%S+0000"),
        "description_short": "Коротко",
        "description_html": "<p>Полное <b>описание</b></p>",
        "age_limit": "16",
        "location": {"country": "Россия", "city": "Омск", "address": "ул. Ленина, 1", "coordinates": [73.3242, 54.9885]},
        "poster_image": {"default_url": "//ucare.timepad.ru/abc/poster.jpg"},
        "categories": [{"id": 1, "name": "Концерты"}],
        "ticket_types": [{"price": 500}, {"price": 1500}],
        "registration_data": {"price_min": 500, "price_max": 1500},
        "organization": {"id": 9, "name": "Филармония"},
    }
    item.update(extra)
    return item


def test_parse_event():
    event = parse_event(tp_event(), city=OMSK)
    assert event.source == "timepad" and event.city == "omsk"
    assert event.title == "Концерт «Осень»"
    assert event.ticket_url == event.source_url
    assert event.full_text == "Полное описание"
    assert event.age_restriction == "16+"
    assert event.categories == ["концерты"]
    assert (event.price.min, event.price.max, event.price.is_free) == (500, 1500, False)
    assert event.images[0].url == "https://ucare.timepad.ru/abc/poster.jpg"
    assert event.venue.name == "ул. Ленина, 1"
    assert event.sessions[0].starts_at.utcoffset() == timedelta(hours=6)  # местное время Омска


def test_coordinates_order_is_detected():
    assert parse_coordinates([73.3242, 54.9885], OMSK) == (54.9885, 73.3242)
    assert parse_coordinates([54.9885, 73.3242], OMSK) == (54.9885, 73.3242)
    assert parse_coordinates([55.75, 37.61], OMSK) == (None, None)  # точка в Москве — ошибка данных
    assert parse_coordinates(None, OMSK) == (None, None)


def test_free_price():
    assert parse_price({"ticket_types": [{"price": 0}]}).is_free
    assert parse_price({}).min is None


def test_timepad_categories_map_to_evently():
    assert map_categories("timepad", ["концерты"]) == ["concert"]
    assert map_categories("timepad", ["экскурсии и путешествия"]) == ["tour"]
    assert map_categories("timepad", ["спорт"]) == ["sport"]
    assert map_categories("timepad", ["еда"]) == ["food"]
    assert map_categories("timepad", ["для детей"]) == ["family"]
    assert map_categories("timepad", ["интеллектуальные игры"]) == ["games"]


def test_evently_gets_ticket_url_and_city_name():
    evently = to_evently_event(parse_event(tp_event(), city=OMSK))
    assert evently.ticket_url == "https://afisha.timepad.ru/event/1/"
    assert evently.venue.city == "Омск"


def test_cities_setting_expands_to_available_sources():
    settings = Settings(cities="msk, omsk", sources="kudago,timepad")
    assert settings.target_pairs() == [("kudago", "msk"), ("timepad", "msk"), ("timepad", "omsk")]
    assert Settings(cities="omsk", sources="kudago").target_pairs() == []
    with pytest.raises(ValueError, match="неизвестные"):
        Settings(cities="atlantis").target_pairs()
    assert Settings(cities="", targets="kudago:msk").target_pairs() == [("kudago", "msk")]


def test_kudago_refuses_city_it_does_not_have():
    assert kudago_code("msk") == "msk"
    with pytest.raises(SourceConfigError, match="нет города"):
        kudago_code("omsk")


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(output_dir=tmp_path, request_delay=0, max_retries=1, timepad_token="tok")


async def test_fetch_pages_with_token(settings, tmp_path):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.params["sort"] == "-starts_at":  # второй проход — уже идущие
            return httpx.Response(200, json={"total": 0, "values": []})
        skip = int(request.url.params["skip"])
        values = [tp_event(i) for i in range(skip + 1, skip + 101)] if skip == 0 else [tp_event(101), tp_event(102, days=-90)]
        return httpx.Response(200, json={"total": 102, "values": values})

    async with HttpClient(settings, transport=httpx.MockTransport(handler)) as http:
        result = await fetch_and_save(settings, "timepad", "omsk", save_raw=False, http=http)

    assert len(seen) == 3
    assert seen[0].url.params["cities"] == "Омск" and seen[0].url.params["sort"] == "starts_at"
    assert seen[0].headers["authorization"] == "Bearer tok"
    assert result.batch.count == 101  # событие 90 дней назад отброшено
    data = json.loads(result.path.read_text(encoding="utf-8"))
    assert data["events"][0]["ticket_url"]
    assert result.path.parent == tmp_path / "events" / "timepad" / "omsk"


async def test_missing_token_gives_clear_error(tmp_path):
    settings = Settings(output_dir=tmp_path, request_delay=0, max_retries=1, timepad_token=None)
    transport = httpx.MockTransport(lambda r: httpx.Response(403))
    async with HttpClient(settings, transport=transport) as http:
        with pytest.raises(TimepadAccessError, match="AFISHA_TIMEPAD_TOKEN"):
            await fetch_and_save(settings, "timepad", "omsk", save_raw=False, http=http)


def test_glued_url_is_cut_after_first_image():
    from afisha_parser.sources.timepad import _url
    glued = "//ucare.timepad.ru/c03/-/format/jpeg/a.jpg-/preview/308x600/-/format/jpeg/b.jpg"
    assert _url(glued) == "https://ucare.timepad.ru/c03/-/format/jpeg/a.jpg"


async def test_page_limit_cuts_far_future_not_nearest_days(tmp_path):
    """Москва: событий больше, чем влезает в лимит, — должны остаться ближайшие дни, а не конец месяца."""
    settings = Settings(output_dir=tmp_path, request_delay=0, max_retries=1, timepad_token="tok", max_pages=1)
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(dict(request.url.params))
        if request.url.params["sort"] == "starts_at":
            # Timepad отдаёт по возрастанию начала: первые 100 — ближайшие
            values = [tp_event(i, days=0.5 + i / 100) for i in range(1, 101)]
            return httpx.Response(200, json={"total": 5000, "values": values})
        values = [tp_event(900, days=-10, ends_at=(datetime.now(UTC) + timedelta(days=5)).strftime("%Y-%m-%dT%H:%M:%S+0000")),
                  tp_event(901, days=-3)]  # выставка идёт; разовое событие уже прошло
        return httpx.Response(200, json={"total": 2, "values": values})

    async with HttpClient(settings, transport=httpx.MockTransport(handler)) as http:
        result = await fetch_and_save(settings, "timepad", "omsk", days=30, save_raw=False, http=http)

    assert [r["sort"] for r in requests] == ["starts_at", "-starts_at"]  # лимит 1 страница на каждый проход
    ids = {e.source_id for e in result.batch.events}
    assert "1" in ids and "100" in ids  # ближайшие дни на месте
    assert "900" in ids and "901" not in ids  # идущая выставка есть, прошедшее — нет


async def test_ignored_date_filter_is_detected(settings):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"total": 1, "values": [tp_event(1, days=-400)]})

    async with HttpClient(settings, transport=httpx.MockTransport(handler)) as http:
        result = await fetch_and_save(settings, "timepad", "omsk", save_raw=False, http=http)
    assert result is None  # ничего не сохранили и прошлый latest.json не затёрли


def test_organizer_poster_is_not_used_as_event_image():
    org = parse_event(tp_event(poster_image={
        "default_url": "//ucare.timepad.ru/c03/-/preview/308x600/-/format/jpeg/poster_org_323586.jpg"
                       "-/preview/308x600/-/format/jpeg/poster_event_4218839.jpg",
        "uploadcare_url": "//ucare.timepad.ru/c03/"}), city=OMSK)
    own = parse_event(tp_event(poster_image={
        "default_url": "//ucare.timepad.ru/d04/-/preview/308x600/-/format/jpeg/poster_event_4218840.jpg",
        "uploadcare_url": "//ucare.timepad.ru/d04/"}), city=OMSK)
    assert org.images == []
    assert own.images[0].url == "https://ucare.timepad.ru/d04/"
