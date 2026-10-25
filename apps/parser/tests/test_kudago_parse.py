from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import pytest

from afisha_parser.sources.kudago import parse_age, parse_event, parse_price

# «Сейчас» для тестов разбора: 17 сентября 2026, 12:00 UTC
FIXED_NOW = datetime(2026, 9, 17, 12, 0, tzinfo=UTC)
MSK = ZoneInfo("Europe/Moscow")


def parse_all(page: dict) -> dict:
    return {
        item["id"]: parse_event(item, city="msk", tz=MSK, now=FIXED_NOW)
        for item in page["results"]
    }


def test_full_event(kudago_page):
    event = parse_all(kudago_page)[101]

    assert event.source == "kudago"
    assert event.source_id == "101"
    assert event.title == "Концерт группы «Пример»"
    assert event.description == "Акустический сет & новые песни"
    assert event.full_text == "Полное описание концерта."
    assert event.age_restriction == "16+"
    assert (event.price.min, event.price.max, event.price.is_free) == (1500, 3000, False)

    # прошедший сеанс выброшен, дубль схлопнут, порядок по возрастанию
    assert [s.starts_at.isoformat() for s in event.sessions] == [
        "2026-09-25T19:00:00+03:00",
        "2026-09-26T19:00:00+03:00",
    ]

    assert event.venue.name == "Дворец культуры «Пример»"
    assert event.venue.lat == 55.751
    assert [i.url for i in event.images] == [
        "https://media.example.org/events/1.jpg",
        "https://media.example.org/events/2.jpg",
    ]
    assert event.images[0].credit_name == "пресс-служба"


def test_endless_event_is_kept(kudago_page):
    event = parse_all(kudago_page)[102]

    assert len(event.sessions) == 1
    assert event.sessions[0].starts_at is None and event.sessions[0].ends_at is None
    assert event.price.is_free and event.price.min == 0
    assert event.venue is None  # place без названия
    assert event.age_restriction is None
    assert event.source_url == "https://kudago.com/msk/event/ekspoziciya/"


def test_past_and_untitled_events_are_skipped(kudago_page):
    parsed = parse_all(kudago_page)
    assert parsed[103] is None
    assert parsed[104] is None


@pytest.mark.parametrize(
    ("text", "is_free", "expected"),
    [
        ("от 1 500 до 3 000 рублей", False, (1500, 3000, False)),
        ("от 500 рублей", False, (500, None, False)),
        ("до 1000 рублей", False, (None, 1000, False)),
        ("700 рублей", False, (700, 700, False)),
        ("бесплатно", False, (0, 0, True)),
        ("", True, (0, 0, True)),
        (None, False, (None, None, False)),
    ],
)
def test_parse_price(text, is_free, expected):
    price = parse_price(text, is_free)
    assert (price.min, price.max, price.is_free) == expected


@pytest.mark.parametrize(("value", "expected"), [("18", "18+"), (12, "12+"), ("6+", "6+"), (0, None), (None, None)])
def test_parse_age(value, expected):
    assert parse_age(value) == expected
