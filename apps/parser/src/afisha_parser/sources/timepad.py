"""Адаптер Timepad API v1 (https://dev.timepad.ru/api/get-v1-events/).

Timepad есть во всех городах справочника, в том числе там, где нет KudaGo (Челябинск, Омск,
Пермь и т. д.). Город ищется по русскому названию, поэтому код города не нужен.

Особенности:
  * токен (AFISHA_TIMEPAD_TOKEN) передаётся как Authorization: Bearer. Документация говорит,
    что публичные события доступны и без него, но с ограничением частоты запросов;
  * у площадки нет названия — только адрес, поэтому venue.name = адрес;
  * страница события на Timepad — это и есть страница регистрации/покупки, она же ticket_url;
  * берём только события, прошедшие модерацию (featured, shown), без спама;
  * длинные события (выставка на месяц) начались раньше сегодняшнего дня, поэтому ищем
    с запасом в прошлое, а прошедшее отбрасывает общий фильтр.
"""

import logging
import re
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from pydantic import ValidationError

from ..cities import City, distance_km, get_city
from ..models import Event, Image, Price, Session, Venue
from ..text import capitalize_first, clean_text
from .base import REFUSAL_STATUSES, SourceAccessError, SourceAdapter, SourceConfigError, response_detail
from .kudago import parse_age

log = logging.getLogger(__name__)

API_BASE = "https://api.timepad.ru/v1"
PAGE_SIZE = 100
# Насколько далеко в прошлое искать начало ещё идущих событий (выставки, курсы).
# События идут от поздних к ранним, так что лимит страниц срезает самые старые — их и не жалко
LOOKBACK_DAYS = 30
# Сколько страниц «уже идущих» событий (выставки, курсы) смотреть сверх ближайших
ONGOING_PAGES = 3
MODERATION = "featured,shown"
FIELDS = ",".join([
    "location", "ticket_types", "registration_data", "description_short", "description_html",
    "age_limit", "categories", "poster_image",
])
# Координаты дальше этого от центра города считаем ошибкой
MAX_DISTANCE_KM = 150


class TimepadAccessError(SourceAccessError):
    pass


def _parse_dt(value: Any, tz: ZoneInfo) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=tz)
    return moment.astimezone(tz)


def parse_coordinates(value: Any, city: City) -> tuple[float | None, float | None]:
    """Timepad отдаёт [a, b] без явного порядка — выбираем порядок, при котором точка ближе к городу."""
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None, None
    try:
        a, b = float(value[0]), float(value[1])
    except (TypeError, ValueError):
        return None, None
    options = [(lat, lon) for lat, lon in ((a, b), (b, a)) if -90 <= lat <= 90 and -180 <= lon <= 180]
    if not options:
        return None, None
    lat, lon = min(options, key=lambda p: distance_km(p[0], p[1], city.lat, city.lon))
    if distance_km(lat, lon, city.lat, city.lon) > MAX_DISTANCE_KM:
        return None, None
    return lat, lon


_IMAGE_EXT_RE = re.compile(r"\.(?:jpe?g|png|webp|gif)", re.IGNORECASE)


def _url(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    url = "https:" + value if value.startswith("//") else value
    # Timepad иногда склеивает два адреса постера: «…poster_org_1.jpg-/preview/…/poster_event_2.jpg».
    # Такой адрес отдаёт 400 — обрезаем после первого расширения картинки.
    match = _IMAGE_EXT_RE.search(url)
    if match and url[match.end():].startswith("-/"):
        url = url[: match.end()]
    return url


def is_organizer_fallback(poster: dict) -> bool:
    """Своего постера у события нет — Timepad подставил постер организатора.

    Такой адрес выглядит как «…/poster_org_<id>.jpg…» (иногда ещё и склеенный с
    «poster_event_<id>.jpg»). Картинка одна на все события организатора: в ленте это
    десятки одинаковых карточек подряд, поэтому считаем, что картинки у события нет.
    """
    urls = [u for u in (poster.get("default_url"), poster.get("uploadcare_url")) if isinstance(u, str)]
    return any("poster_org_" in u for u in urls)


def parse_price(item: dict) -> Price:
    reg = item.get("registration_data") or {}
    prices = [t.get("price") for t in item.get("ticket_types") or [] if isinstance(t, dict)]
    prices += [reg.get("price_min"), reg.get("price_max")]
    numbers = sorted({int(p) for p in prices if isinstance(p, (int, float)) and not isinstance(p, bool) and p >= 0})
    if not numbers:
        return Price()
    if numbers == [0]:
        return Price(text="бесплатно", min=0, max=0, is_free=True)
    paid = [n for n in numbers if n > 0]
    text = f"{paid[0]} ₽" if len(paid) == 1 else f"от {paid[0]} до {paid[-1]} ₽"
    return Price(text=text, min=paid[0], max=paid[-1], is_free=False)


def parse_event(item: dict, *, city: City) -> Event | None:
    title = clean_text(item.get("name"))
    url = item.get("url")
    if not title or not isinstance(url, str) or item.get("id") is None:
        return None

    tz = city.zone
    start = _parse_dt(item.get("starts_at"), tz)
    end = _parse_dt(item.get("ends_at"), tz)
    if end is not None and start is not None and end < start:
        end = None
    sessions = [Session(starts_at=start, ends_at=end)] if start or end else []

    location = item.get("location") or {}
    venue = None
    address = clean_text(location.get("address"))
    if address:
        lat, lon = parse_coordinates(location.get("coordinates"), city)
        venue = Venue(name=address, address=address, lat=lat, lon=lon)

    images = []
    poster = item.get("poster_image") or {}
    if not is_organizer_fallback(poster) and (
        image_url := _url(poster.get("uploadcare_url")) or _url(poster.get("default_url"))
    ):
        images.append(Image(url=image_url))

    categories = [
        name.strip().lower()
        for c in item.get("categories") or []
        if isinstance(c, dict) and isinstance(name := c.get("name"), str) and name.strip()
    ]
    organization = item.get("organization") or {}

    return Event(
        source=TimepadAdapter.name,
        source_id=str(item["id"]),
        source_url=url,
        ticket_url=url,
        city=city.slug,
        title=capitalize_first(title),
        tagline=clean_text(organization.get("name")) if isinstance(organization, dict) else None,
        description=clean_text(item.get("description_short")),
        full_text=clean_text(item.get("description_html")),
        categories=categories,
        age_restriction=parse_age(item.get("age_limit")),
        price=parse_price(item),
        venue=venue,
        sessions=sessions,
        images=images,
    )


class TimepadAdapter(SourceAdapter):
    name = "timepad"

    @property
    def token(self) -> str | None:
        return self.settings.timepad_token if self.settings else None

    async def fetch_events(
        self, city: str, *, days: int = 30, limit: int | None = None
    ) -> AsyncIterator[Event]:
        """Два прохода, чтобы лимит страниц резал дальнее будущее, а не ближайшие дни:

        1. ближайшие: события, которые начинаются с сегодняшнего дня, от ближних к дальним
           (sort=starts_at). В Москве их больше, чем влезает в AFISHA_MAX_PAGES, — обрезается конец месяца;
        2. уже идущие: начались за последние LOOKBACK_DAYS дней и ещё не закончились (выставки, курсы),
           от недавних к давним, не больше ONGOING_PAGES страниц.

        Раньше был один проход от дальних к ближним, и в Москве/Петербурге лимит срезал как раз
        ближайшую неделю — а бэкенд архивировал эти события как пропавшие.
        """
        found = get_city(city)
        if found is None or not found.timepad:
            raise SourceConfigError(f"Города {city!r} нет в справочнике cities.py")
        now = datetime.now(UTC).replace(microsecond=0)
        today = datetime.combine(now.astimezone(found.zone).date(), datetime.min.time(), tzinfo=found.zone)
        oldest, newest = now - timedelta(days=LOOKBACK_DAYS), now + timedelta(days=days)
        headers = {"Authorization": f"Bearer {self.token}"} if self.token else None
        common = {"cities": found.name, "fields": FIELDS, "moderation_statuses": MODERATION, "limit": PAGE_SIZE}
        yielded = 0
        page_no = 0

        async def pages(params: dict, max_pages: int, label: str):
            nonlocal page_no
            for page in range(1, max_pages + 1):
                page_no += 1
                data = await self._request({**params, "skip": (page - 1) * PAGE_SIZE}, headers, page, city)
                if data is None:
                    return
                self.save_raw(f"events-page-{page_no:03d}", data)
                values = [v for v in data.get("values") or [] if isinstance(v, dict)]
                log.info("Timepad %s (%s): страница %d, записей %d (всего: %s)",
                         city, label, page, len(values), data.get("total"))
                yield page, values
                total = data.get("total")
                if len(values) < PAGE_SIZE or (isinstance(total, int) and page * PAGE_SIZE >= total):
                    return
            if label == "ближайшие":
                log.warning("Timepad %s: достигнут предел %d страниц (AFISHA_MAX_PAGES), "
                            "самые дальние по дате события не взяты", city, max_pages)

        # 1. Ближайшие — от сегодняшнего дня вперёд
        upcoming = {**common, "starts_at_min": today.isoformat(), "starts_at_max": newest.isoformat(),
                    "sort": "starts_at"}
        async for page, values in pages(upcoming, self.max_pages, "ближайшие"):
            starts = [s for v in values if (s := _parse_dt(v.get("starts_at"), found.zone))]
            if page == 1 and starts and max(starts) < today - timedelta(days=2):
                # Timepad проигнорировал starts_at_min и отдал события из далёкого прошлого
                log.error("Timepad %s: фильтр по дате не сработал (первые события от %s) — останавливаюсь",
                          city, min(starts).date())
                return
            for item in values:
                start = _parse_dt(item.get("starts_at"), found.zone)
                if start is not None and (start > newest or start < today - timedelta(days=1)):
                    continue
                if (event := self._parse(item, found)) is not None:
                    yield event
                    yielded += 1
                    if limit is not None and yielded >= limit:
                        return

        # 2. Уже идущие — начались раньше сегодняшнего дня, но ещё не закончились
        ongoing = {**common, "starts_at_min": oldest.isoformat(), "starts_at_max": today.isoformat(),
                   "sort": "-starts_at"}
        async for _, values in pages(ongoing, min(ONGOING_PAGES, self.max_pages), "идут сейчас"):
            for item in values:
                end = _parse_dt(item.get("ends_at"), found.zone)
                if end is None or end <= now:
                    continue  # разовое событие в прошлом или уже закончилось
                if (event := self._parse(item, found)) is not None:
                    yield event
                    yielded += 1
                    if limit is not None and yielded >= limit:
                        return

    @staticmethod
    def _parse(item: dict, city: City) -> Event | None:
        try:
            return parse_event(item, city=city)
        except (KeyError, TypeError, ValueError, ValidationError) as exc:
            log.warning("Timepad: пропускаю событие id=%s: %s", item.get("id"), exc)
            return None

    async def _request(self, params: dict, headers: dict | None, page: int, city: str) -> dict | None:
        try:
            response = await self.http.get(f"{API_BASE}/events.json", params=params, headers=headers)
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if status in REFUSAL_STATUSES:
                detail = response_detail(exc.response)
                if status == 429:
                    text = f"Timepad ответил 429: слишком много запросов. {detail}".strip()
                elif not self.token:
                    text = (f"Timepad ответил {status}: нужен токен. Получите его на dev.timepad.ru/api/oauth/ "
                            f"и впишите в .env: AFISHA_TIMEPAD_TOKEN=...")
                else:
                    text = (f"Timepad ответил {status}: «{detail or 'доступ запрещён'}». "
                            f"Проверьте токен (introspect, см. README) и не заблокирован ли аккаунт")
                raise TimepadAccessError(text, status) from exc
            if page > 1 and status in (400, 422):
                log.warning("Timepad %s: дальше страницы %d не пускает (%d), беру что есть", city, page - 1, status)
                return None
            raise
        return response.json()

    async def list_cities(self) -> list[tuple[str, str]]:
        from ..cities import CITIES
        return [(c.slug, c.name) for c in CITIES.values() if c.timepad]
