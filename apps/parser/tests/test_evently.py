from collections import Counter
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import pytest

from afisha_parser.export import export_batch, load_batch
from afisha_parser.exporters.evently import (
    CATEGORY_MAPS,
    EVENTLY_CATEGORIES,
    export_evently,
    is_promo_only,
    map_categories,
    parse_age_rating,
    to_evently_batch,
)
from afisha_parser.models import EventBatch
from afisha_parser.sources.kudago import parse_event

FIXED_NOW = datetime(2026, 9, 17, 12, 0, tzinfo=UTC)
MSK = ZoneInfo("Europe/Moscow")


def make_batch(page: dict) -> EventBatch:
    events = [
        event
        for item in page["results"]
        if (event := parse_event(item, city="msk", tz=MSK, now=FIXED_NOW)) is not None
    ]
    return EventBatch(source="kudago", city="msk", fetched_at=FIXED_NOW, count=len(events), events=events)


def dump(page: dict) -> list[dict]:
    evently, _ = to_evently_batch(make_batch(page))
    return evently.model_dump(mode="json", by_alias=True)["events"]


def test_full_event_matches_evently_contract(kudago_page):
    event = dump(kudago_page)[0]

    assert list(event) == [
        "source", "externalId", "title", "shortDescription", "description",
        "sourceUrl", "ticketUrl", "priceMin", "priceMax", "currency", "isFree",
        "ageRating", "categories", "venue", "occurrences", "images",
    ]
    assert event["externalId"] == "101"
    assert event["shortDescription"] == "Акустический сет & новые песни"
    assert event["description"] == "Полное описание концерта."
    assert event["ticketUrl"] is None
    assert (event["priceMin"], event["priceMax"], event["isFree"]) == (1500, 3000, False)
    assert event["ageRating"] == 16
    assert event["categories"] == ["concert"]
    assert event["venue"] == {
        "source": "kudago",
        "externalId": "555",
        "name": "Дворец культуры «Пример»",
        "address": "ул. Примерная, 1",
        "city": "Москва",
        "latitude": 55.751,
        "longitude": 37.618,
    }
    assert event["occurrences"][0] == {
        "startsAt": "2026-09-25T19:00:00+03:00",
        "endsAt": "2026-09-25T22:00:00+03:00",
        "ticketUrl": None,
    }
    assert event["images"] == [
        {"url": "https://media.example.org/events/1.jpg"},
        {"url": "https://media.example.org/events/2.jpg"},
    ]


def test_event_without_dates_gets_empty_occurrences(kudago_page):
    event = dump(kudago_page)[1]

    assert event["occurrences"] == []
    assert event["categories"] == ["exhibition"]
    assert event["venue"] is None
    assert event["ageRating"] is None


def test_map_categories_drops_unknown_and_duplicates():
    unmapped: Counter = Counter()
    result = map_categories("kudago", ["theater", "kids", "entertainment", "theater"], unmapped)

    assert result == ["theatre", "family"]
    assert unmapped == Counter({"kudago:entertainment": 1})


def test_category_table_uses_only_evently_categories():
    for table in CATEGORY_MAPS.values():
        assert set(table.values()) <= EVENTLY_CATEGORIES


@pytest.mark.parametrize(("value", "expected"), [("18+", 18), ("6+", 6), ("16", 16), (None, None), ("", None)])
def test_parse_age_rating(value, expected):
    assert parse_age_rating(value) == expected


def test_export_from_saved_dump(kudago_page, tmp_path):
    universal_path = export_batch(make_batch(kudago_page), tmp_path)
    evently_path = export_evently(load_batch(universal_path), tmp_path)

    assert evently_path.parent == tmp_path / "evently" / "kudago" / "msk"
    assert (evently_path.parent / "latest.json").exists()


def test_standup_detected_by_title_instead_of_concert():
    assert map_categories("kudago", ["concert"], title="Большой стендап-концерт") == ["standup"]
    assert map_categories("kudago", ["party", "concert"], title="Частный стендап") == ["standup", "party"]
    assert map_categories("kudago", ["entertainment"], title="Шоу «Стендап в темноте»") == ["standup"]
    assert map_categories("kudago", ["concert"], title="Концерт Дениса Мацуева") == ["concert"]


def test_real_kudago_slugs():
    unmapped: Counter = Counter()
    result = map_categories("kudago", ["cinema", "business-events", "tour", "festival"], unmapped)

    assert result == ["cinema", "education", "tour"]
    assert unmapped == Counter({"kudago:festival": 1})


def test_promo_mark_is_ignored_but_event_survives():
    unmapped: Counter = Counter()
    assert map_categories("kudago", ["concert", "stock"], unmapped) == ["concert"]
    assert unmapped == Counter()  # решение по stock принято заранее
    assert not is_promo_only("kudago", ["concert", "stock"])
    assert is_promo_only("kudago", ["stock"])


def test_promo_only_events_are_dropped_from_batch(kudago_page):
    batch = make_batch(kudago_page)
    batch.events[0].categories = ["stock"]

    evently, _ = to_evently_batch(batch)
    assert [e.external_id for e in evently.events] == ["102"]


def test_games_detected_for_quests_and_quizzes():
    assert map_categories("kudago", ["quest"]) == ["games"]
    assert map_categories("kudago", ["entertainment"], title="Квиз «60 секунд»") == ["games"]
    assert map_categories("kudago", ["entertainment"], title="Встреча «Играриум»", tags=["квест"]) == ["games"]
    assert map_categories("kudago", ["entertainment"], title="Светомузыкальное шоу") == []
    assert map_categories("kudago", ["kids"], title="Квиз для взрослых") == ["family"]
