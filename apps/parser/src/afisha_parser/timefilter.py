"""Фильтр прошедших событий.

Работает с универсальным дампом и не зависит от источника, поэтому применяется везде:
сразу после сбора, при конвертации в Evently, перед поиском трейлеров. Это важно для
автономной работы: даже если источник недоступен и свежих данных нет, при каждом цикле
файл для Evently пересобирается из последнего дампа и прошедшее из него пропадает.

Правила:
  * сеанс с временем окончания актуален, пока оно не наступило (выставка «до 30 ноября»);
  * сеанс только с началом (или начало = окончание) — пока не началось, плюс
    `grace` минут (AFISHA_PAST_GRACE_MINUTES);
  * сеанс без дат (бессрочно) актуален всегда;
  * событие выбрасывается, если сеансы у него были, но все прошли. Событие вообще
    без сеансов («дата уточняется», квизы по запросу) остаётся — решает бэкенд.
"""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from .models import Event, EventBatch, Session


def session_is_current(session: Session, now: datetime, grace: timedelta = timedelta(0)) -> bool:
    start, end = session.starts_at, session.ends_at
    if end is not None and (start is None or end > start):
        return end >= now
    if start is not None:
        return start + grace >= now
    return True


def current_sessions(event: Event, now: datetime, grace: timedelta = timedelta(0)) -> list[Session]:
    return [s for s in event.sessions if session_is_current(s, now, grace)]


def event_is_current(event: Event, now: datetime, grace: timedelta = timedelta(0)) -> bool:
    return not event.sessions or bool(current_sessions(event, now, grace))


@dataclass
class FilterResult:
    events: list[Event]
    dropped_events: int
    dropped_sessions: int


def drop_finished(events: list[Event], now: datetime | None = None, grace: timedelta = timedelta(0)) -> FilterResult:
    """Убирает прошедшие сеансы, а события, у которых сеансов не осталось, — целиком."""
    now = now or datetime.now(UTC)
    kept: list[Event] = []
    dropped_events = dropped_sessions = 0
    for event in events:
        if not event.sessions:
            kept.append(event)
            continue
        sessions = current_sessions(event, now, grace)
        dropped_sessions += len(event.sessions) - len(sessions)
        if not sessions:
            dropped_events += 1
            continue
        kept.append(event if len(sessions) == len(event.sessions) else event.model_copy(update={"sessions": sessions}))
    return FilterResult(kept, dropped_events, dropped_sessions)


def filter_batch(
    batch: EventBatch, now: datetime | None = None, grace: timedelta = timedelta(0)
) -> tuple[EventBatch, FilterResult]:
    result = drop_finished(batch.events, now, grace)
    return batch.model_copy(update={"events": result.events, "count": len(result.events)}), result


def grace_from_minutes(minutes: int) -> timedelta:
    return timedelta(minutes=max(0, minutes))
