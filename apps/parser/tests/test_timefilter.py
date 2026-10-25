from datetime import UTC, datetime, timedelta

from afisha_parser.models import Event, EventBatch, Session
from afisha_parser.timefilter import drop_finished, event_is_current, filter_batch, session_is_current

NOW = datetime(2026, 9, 29, 12, 0, tzinfo=UTC)
H = timedelta(hours=1)


def event(event_id: str, *sessions: Session) -> Event:
    return Event(
        source="kudago", source_id=event_id, source_url="https://kudago.com/", city="msk",
        title=f"Событие {event_id}", sessions=list(sessions),
    )


def test_session_rules():
    assert session_is_current(Session(starts_at=NOW + H, ends_at=NOW + 3 * H), NOW)  # впереди
    assert session_is_current(Session(starts_at=NOW - 30 * 24 * H, ends_at=NOW + 24 * H), NOW)  # выставка идёт
    assert not session_is_current(Session(starts_at=NOW - 3 * H, ends_at=NOW - H), NOW)  # закончилось
    assert not session_is_current(Session(starts_at=NOW - H), NOW)  # точечное, уже началось
    assert session_is_current(Session(starts_at=NOW - H), NOW, grace=2 * H)  # но в пределах запаса
    assert not session_is_current(Session(starts_at=NOW - H, ends_at=NOW - H), NOW)  # начало = конец
    assert session_is_current(Session(starts_at=None, ends_at=None), NOW)  # бессрочно
    assert session_is_current(Session(starts_at=None, ends_at=NOW + H), NOW)  # «до …»
    assert not session_is_current(Session(starts_at=None, ends_at=NOW - H), NOW)


def test_event_without_sessions_is_kept():
    assert event_is_current(event("1"), NOW)


def test_drop_finished_trims_sessions_and_drops_empty_events():
    past = Session(starts_at=NOW - 48 * H, ends_at=NOW - 46 * H)
    future = Session(starts_at=NOW + 24 * H, ends_at=NOW + 26 * H)
    result = drop_finished([
        event("mixed", past, future),
        event("gone", past),
        event("undated"),
    ], NOW)

    assert [e.source_id for e in result.events] == ["mixed", "undated"]
    assert result.events[0].sessions == [future]
    assert result.dropped_events == 1
    assert result.dropped_sessions == 2


def test_filter_batch_updates_count():
    batch = EventBatch(
        source="kudago", city="msk", fetched_at=NOW - 24 * H, count=2,
        events=[event("old", Session(starts_at=NOW - 2 * H)), event("new", Session(starts_at=NOW + 2 * H))],
    )
    filtered, result = filter_batch(batch, NOW)
    assert filtered.count == 1
    assert [e.source_id for e in filtered.events] == ["new"]
    assert batch.count == 2  # исходный батч не меняется
