"""Адаптер KudaGo public API v1.4."""

import logging
import re
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from pydantic import ValidationError

from ..cities import city_by_kudago, get_city
from ..models import Event, Image, Price, Session, Venue
from ..text import capitalize_first, clean_text
from .base import REFUSAL_STATUSES, SourceAccessError, SourceAdapter, SourceConfigError, response_detail

log = logging.getLogger(__name__)

API_BASE = "https://kudago.com/public-api/v1.4"
PAGE_SIZE = 100

FIELDS = ",".join([
    "id", "title", "short_title", "slug", "tagline", "description", "body_text",
    "dates", "place", "location", "categories", "tags", "age_restriction",
    "price", "is_free", "images", "site_url",
])

# «Бессрочно» и «дата неизвестна» KudaGo кодирует экстремальными timestamp
# (далёкое прошлое или год ~9999). Всё вне этого окна — отсутствующая дата.
_MIN_TS = int(datetime(2000, 1, 1, tzinfo=UTC).timestamp())
_MAX_TS = int(datetime(2100, 1, 1, tzinfo=UTC).timestamp())

DEFAULT_DAYS = 30

# Нумерация дней недели в schedules[].days_of_week.
# 0 — если у KudaGo 0 = понедельник (как date.weekday() в Python), 1 — если 0 = воскресенье.
WEEKDAY_OFFSET = 0

_NUMBER_RE = re.compile(r"\d{1,3}(?:[ \u00a0]\d{3})+|\d+")

# «Вход свободный», «бесплатный вход», «вход бесплатный»
_FREE_ENTRY_RE = re.compile(r"(бесплатн\w*\s+вход|вход\w*\s+(?:свободн|бесплатн)\w*|свободн\w*\s+вход)", re.IGNORECASE)

# KudaGo дописывает в конец текста «KudaGo: <адрес>», если у события нет площадки
_KUDAGO_TAIL_RE = re.compile(r"\s*KudaGo:(?!.*KudaGo:).*$", re.DOTALL)


def city_timezone(city: str) -> ZoneInfo:
    """Таймстемпы KudaGo абсолютные; пояс нужен только чтобы в JSON было местное время."""
    found = get_city(city) or city_by_kudago(city)
    if found is None:
        log.warning("Города %r нет в справочнике cities.py, время будет в UTC", city)
        return ZoneInfo("UTC")
    return found.zone


def kudago_code(city: str) -> str:
    """Наш slug → код города у KudaGo. Неизвестный slug передаём как есть (вдруг это код KudaGo)."""
    found = get_city(city)
    if found is None:
        return city
    if not found.kudago:
        raise SourceConfigError(f"У KudaGo нет города {found.name} ({city}), он собирается из других источников")
    return found.kudago


def _to_datetime(value: Any, tz: ZoneInfo) -> datetime | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not _MIN_TS <= value <= _MAX_TS:
        return None
    return datetime.fromtimestamp(value, tz)


def _parse_date(value: Any) -> date | None:
    try:
        return date.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        return None


def _parse_time(value: Any) -> time | None:
    try:
        return time.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        return None


def expand_schedules(item: dict, *, tz: ZoneInfo, now: datetime, until: datetime) -> list[Session]:
    """Регулярное событие («по вторникам в 20:00 до 19 октября») → конкретные сеансы в окне [now, until]."""
    schedules = [s for s in item.get("schedules") or [] if isinstance(s, dict)]
    today = now.astimezone(tz).date()
    last_allowed = until.astimezone(tz).date()

    first_day = None if item.get("is_startless") else _parse_date(item.get("start_date"))
    last_day = None if item.get("is_endless") else _parse_date(item.get("end_date"))
    day = max(first_day or today, today)
    stop = min(last_day or last_allowed, last_allowed)

    result: list[Session] = []
    while day <= stop:
        kudago_weekday = (day.weekday() + WEEKDAY_OFFSET) % 7
        for schedule in schedules:
            if kudago_weekday not in (schedule.get("days_of_week") or []):
                continue
            start_time = _parse_time(schedule.get("start_time"))
            if start_time is None:
                continue
            starts = datetime.combine(day, start_time, tzinfo=tz)
            if not now <= starts <= until:
                continue
            ends = None
            end_time = _parse_time(schedule.get("end_time"))
            if end_time is not None:
                ends = datetime.combine(day, end_time, tzinfo=tz)
                if ends <= starts:
                    ends += timedelta(days=1)  # заканчивается после полуночи
            result.append(Session(starts_at=starts, ends_at=ends))
        day += timedelta(days=1)
    return result


def parse_sessions(
    dates: list[dict], *, tz: ZoneInfo, now: datetime, until: datetime | None = None
) -> list[Session]:
    """Даты KudaGo → актуальные сеансы.

    У события хранится вся история проведения (бывает сотни записей с 2015 года),
    поэтому прошедшее отбрасываем, а расписания разворачиваем в сеансы до `until`.
    """
    until = until or now + timedelta(days=DEFAULT_DAYS)
    sessions: dict[tuple, Session] = {}

    for item in dates:
        if not isinstance(item, dict):
            continue
        raw_end = item.get("end")
        startless = bool(item.get("is_startless"))
        endless = bool(item.get("is_endless")) or (isinstance(raw_end, (int, float)) and raw_end > _MAX_TS)
        start = None if startless else _to_datetime(item.get("start"), tz)
        end = None if endless else _to_datetime(raw_end, tz)

        schedules = [s for s in item.get("schedules") or [] if isinstance(s, dict)]
        if any(_parse_time(s.get("start_time")) for s in schedules):
            for session in expand_schedules(item, tz=tz, now=now, until=until):
                sessions[(session.starts_at, session.ends_at)] = session
            continue

        if end is not None and end < now:
            continue  # уже закончилось
        if start is not None and start > until:
            continue  # за горизонтом сбора
        if end is None and not endless and (start is None or start < now):
            continue  # точечное событие в прошлом или дата неизвестна
        sessions[(start, end)] = Session(starts_at=start, ends_at=end)

    far_future = datetime.max.replace(tzinfo=UTC)
    return sorted(sessions.values(), key=lambda s: s.starts_at or s.ends_at or far_future)


def mentions_free_entry(*texts: str | None) -> bool:
    return any(_FREE_ENTRY_RE.search(text) for text in texts if text)


def strip_kudago_tail(text: str | None) -> str | None:
    if not text:
        return text
    return _KUDAGO_TAIL_RE.sub("", text).strip() or None


def parse_price(text: Any, is_free: Any) -> Price:
    clean = clean_text(text)
    lowered = (clean or "").lower()
    numbers = [int(re.sub(r"\D", "", n)) for n in _NUMBER_RE.findall(lowered)]
    numbers = [n for n in numbers if n > 0]

    minimum = maximum = None
    if len(numbers) >= 2:
        minimum, maximum = min(numbers), max(numbers)
    elif len(numbers) == 1:
        has_from = re.search(r"\bот\b", lowered) is not None
        has_to = re.search(r"\bдо\b", lowered) is not None
        if has_to and not has_from:
            maximum = numbers[0]
        elif has_from:
            minimum = numbers[0]
        else:
            minimum = maximum = numbers[0]

    free = bool(is_free) or "бесплатн" in lowered or mentions_free_entry(lowered)
    if free and not numbers:
        minimum = maximum = 0
    return Price(text=clean, min=minimum, max=maximum, is_free=free)


def parse_age(value: Any) -> str | None:
    text = clean_text(value)
    if not text or text in {"0", "0+"}:
        return None
    return f"{text}+" if text.isdigit() else text


def parse_venue(place: Any) -> Venue | None:
    if not isinstance(place, dict):
        return None
    name = clean_text(place.get("title"))
    if not name:
        return None  # place не раскрыт (пришёл только id) или пустой
    coords = place.get("coords") or {}
    return Venue(
        source_id=str(place["id"]) if place.get("id") is not None else None,
        name=capitalize_first(name),
        address=clean_text(place.get("address")),
        lat=coords.get("lat"),
        lon=coords.get("lon"),
        subway=clean_text(place.get("subway")),
        url=place.get("site_url") or None,
    )


def parse_images(images: Any) -> list[Image]:
    result: list[Image] = []
    seen: set[str] = set()
    for item in images or []:
        url = item.get("image") if isinstance(item, dict) else None
        if not isinstance(url, str) or not url or url in seen:
            continue
        seen.add(url)
        credit = item.get("source") or {}
        result.append(Image(
            url=url,
            credit_name=clean_text(credit.get("name")),
            credit_url=credit.get("link") or None,
        ))
    return result


def parse_event(
    item: dict, *, city: str, tz: ZoneInfo, now: datetime, until: datetime | None = None
) -> Event | None:
    """Одна запись KudaGo → Event. None — если событие нам не подходит."""
    title = clean_text(item.get("title"))
    if not title:
        return None

    dates = item.get("dates") or []
    sessions = parse_sessions(dates, tz=tz, now=now, until=until)
    if dates and not sessions:
        return None  # всё в прошлом или за горизонтом

    description = strip_kudago_tail(clean_text(item.get("description")))
    full_text = strip_kudago_tail(clean_text(item.get("body_text")))
    price = parse_price(item.get("price"), item.get("is_free"))
    if not price.is_free and price.min is None and price.max is None and mentions_free_entry(
        title, description, full_text
    ):
        price = price.model_copy(update={"is_free": True, "min": 0, "max": 0})

    slug = item.get("slug")
    source_url = item.get("site_url") or (f"https://kudago.com/{city}/event/{slug}/" if slug else "")
    short_title = clean_text(item.get("short_title"))

    return Event(
        source=KudaGoAdapter.name,
        source_id=str(item["id"]),
        source_url=source_url,
        city=city,
        title=capitalize_first(title),
        short_title=capitalize_first(short_title) if short_title else None,
        tagline=clean_text(item.get("tagline")),
        description=description,
        full_text=full_text,
        categories=[c for c in item.get("categories") or [] if isinstance(c, str)],
        tags=[t for t in item.get("tags") or [] if isinstance(t, str)],
        age_restriction=parse_age(item.get("age_restriction")),
        price=price,
        venue=parse_venue(item.get("place")),
        sessions=sessions,
        images=parse_images(item.get("images")),
    )


class KudaGoAdapter(SourceAdapter):
    name = "kudago"

    async def fetch_events(
        self, city: str, *, days: int = 30, limit: int | None = None
    ) -> AsyncIterator[Event]:
        now = datetime.now(UTC)
        until = now + timedelta(days=days)
        tz = city_timezone(city)
        url: str | None = f"{API_BASE}/events/"
        params: dict | None = {
            "lang": "ru",
            "location": kudago_code(city),
            "actual_since": int(now.timestamp()),
            "actual_until": int(until.timestamp()),
            "fields": FIELDS,
            "expand": "place,dates",  # dates: флаги is_endless/is_startless и расписания schedules
            "text_format": "text",
            "order_by": "id",
            "page_size": PAGE_SIZE,
        }
        page = 1
        yielded = 0

        while url:
            if page > self.max_pages:
                log.warning("KudaGo %s: достигнут предел %d страниц (AFISHA_MAX_PAGES), остальное не беру",
                            city, self.max_pages)
                return
            try:
                response = await self.http.get(url, params=params)
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                if status in REFUSAL_STATUSES:
                    detail = response_detail(exc.response)
                    raise SourceAccessError(
                        f"KudaGo ответил {status}: {detail or 'доступ запрещён'}"
                        + (" (слишком много запросов)" if status == 429 else ""), status,
                    ) from exc
                raise
            data = response.json()
            self.save_raw(f"events-page-{page:03d}", data)
            results = data.get("results") or []
            log.info("KudaGo %s: страница %d, записей %d (всего у источника: %s)",
                     city, page, len(results), data.get("count"))

            for item in results:
                try:
                    event = parse_event(item, city=city, tz=tz, now=now, until=until)
                except (KeyError, TypeError, ValueError, ValidationError) as exc:
                    log.warning("KudaGo: пропускаю событие id=%s: %s", item.get("id"), exc)
                    continue
                if event is None:
                    continue
                yield event
                yielded += 1
                if limit is not None and yielded >= limit:
                    return

            url = data.get("next")
            params = None  # ссылка next уже содержит все параметры
            page += 1

    async def list_cities(self) -> list[tuple[str, str]]:
        response = await self.http.get(f"{API_BASE}/locations/", params={"lang": "ru", "fields": "slug,name"})
        return [(item["slug"], item.get("name", "")) for item in response.json()]
