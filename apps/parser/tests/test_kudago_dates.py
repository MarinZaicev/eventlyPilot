"""Разбор дат KudaGo по реальным форматам из API (expand=dates)."""

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from afisha_parser.sources.kudago import (
    mentions_free_entry,
    parse_event,
    parse_sessions,
    strip_kudago_tail,
)

# Четверг, 17 сентября 2026, 15:00 по Москве
NOW = datetime(2026, 9, 17, 12, 0, tzinfo=UTC)
WEEK = NOW + timedelta(days=7)
MSK = ZoneInfo("Europe/Moscow")

HISTORY = {  # запись из 2017 года — у KudaGo такой истории сотни записей
    "start_date": "2017-11-06", "start_time": "18:00:00", "start": 1509980400,
    "end_date": None, "end_time": None, "end": 1509980400,
    "is_continuous": False, "is_endless": False, "is_startless": False,
    "schedules": [], "use_place_schedule": False,
}
ENDLESS = {
    "start_date": None, "start_time": "00:00:00", "start": -62135433000,
    "end_date": None, "end_time": "00:00:00", "end": 253370754000,
    "is_continuous": False, "is_endless": True, "is_startless": True,
    "schedules": [], "use_place_schedule": True,
}


def recurring(end_date: str | None, schedules: list[dict]) -> dict:
    return {
        "start_date": None, "start_time": None, "start": -62135433000,
        "end_date": end_date, "end_time": None, "end": 1792443600,
        "is_continuous": False, "is_endless": end_date is None, "is_startless": True,
        "schedules": schedules, "use_place_schedule": False,
    }


def iso(sessions) -> list[tuple]:
    return [(s.starts_at.isoformat(), s.ends_at.isoformat() if s.ends_at else None) for s in sessions]


def test_schedule_expands_into_sessions_within_horizon():
    dates = [HISTORY, recurring("2026-10-19", [
        {"days_of_week": [3], "start_time": "19:00:00", "end_time": "21:00:00"},  # четверг
        {"days_of_week": [5], "start_time": "13:00:00", "end_time": None},        # суббота
    ])]

    assert iso(parse_sessions(dates, tz=MSK, now=NOW, until=WEEK)) == [
        ("2026-09-17T19:00:00+03:00", "2026-09-17T21:00:00+03:00"),
        ("2026-09-19T13:00:00+03:00", None),
        # четверг 24.09 в 19:00 уже за горизонтом (до 15:00)
    ]


def test_schedule_skips_todays_past_time_and_respects_end_date():
    dates = [recurring("2026-09-19", [
        {"days_of_week": [3], "start_time": "10:00:00"},  # сегодня, но уже прошло
        {"days_of_week": [4, 5, 6], "start_time": "20:00:00", "end_time": "01:00:00"},
    ])]

    assert iso(parse_sessions(dates, tz=MSK, now=NOW, until=WEEK)) == [
        ("2026-09-18T20:00:00+03:00", "2026-09-19T01:00:00+03:00"),  # через полночь
        ("2026-09-19T20:00:00+03:00", "2026-09-20T01:00:00+03:00"),
        # воскресенье 20.09 уже после end_date
    ]


def test_expired_schedule_and_history_give_no_sessions():
    dates = [HISTORY, recurring("2024-03-24", [{"days_of_week": [0, 1, 2], "start_time": "20:00:00"}])]
    assert parse_sessions(dates, tz=MSK, now=NOW, until=WEEK) == []


def test_endless_by_flags():
    sessions = parse_sessions([HISTORY, ENDLESS], tz=MSK, now=NOW, until=WEEK)
    assert len(sessions) == 1
    assert sessions[0].starts_at is None and sessions[0].ends_at is None


def test_explicit_session_beyond_horizon_is_dropped():
    start = int((NOW + timedelta(days=10)).timestamp())
    dates = [{"start": start, "end": start + 7200}]
    assert parse_sessions(dates, tz=MSK, now=NOW, until=WEEK) == []


def test_free_entry_and_kudago_tail():
    item = {
        "id": 578,
        "title": "Петербургский двор в Москве",
        "slug": "peterburgskij-dvor",
        "body_text": "Вход свободный. KudaGo: Улица Адмирала Лазарева, дом 50",
        "price": "",
        "is_free": False,
        "dates": [ENDLESS],
    }
    event = parse_event(item, city="msk", tz=MSK, now=NOW, until=WEEK)

    assert event.full_text == "Вход свободный."
    assert event.price.is_free and event.price.min == 0


def test_helpers():
    assert mentions_free_entry("Стендап-шоу с бесплатным входом")
    assert mentions_free_entry(None, "вход свободный")
    assert not mentions_free_entry("Бесплатный урок вокала", None)
    assert strip_kudago_tail("Текст KudaGo: адрес") == "Текст"
    assert strip_kudago_tail("Без хвоста") == "Без хвоста"
