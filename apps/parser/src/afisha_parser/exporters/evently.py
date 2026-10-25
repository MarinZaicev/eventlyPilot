"""Универсальный дамп → формат импорта Evently (POST /internal/events/import).

Парсер по-прежнему пишет свой универсальный JSON, а этот модуль — отдельный слой
поверх него. Формат БД не зашит в сборщик: поменялся контракт Evently — правим только здесь.
"""

import logging
import re
from collections import Counter
from pathlib import Path
from typing import Literal, get_args

from pydantic import AwareDatetime, BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from ..cities import CITIES
from ..export import write_json_atomic
from ..models import Event, EventBatch, filename_stamp

log = logging.getLogger(__name__)

EventlyCategory = Literal[
    "concert", "theatre", "cinema", "sport", "exhibition",
    "party", "standup", "food", "family", "education",
    "tour", "games",
]
EVENTLY_CATEGORIES: frozenset[str] = frozenset(get_args(EventlyCategory))

# Категории источника → категории Evently. Чего нет в таблице — отбрасывается
# и попадает в лог «без маппинга», по нему дополняем таблицу.
# Составлено по реальной выборке KudaGo (Москва, сентябрь 2026).
CATEGORY_MAPS: dict[str, dict[str, str]] = {
    # Фильмы проката (cinema.py): каждое событие — фильм с сеансами во всех кинотеатрах города
    "kudago-cinema": {"cinema": "cinema"},
    "kinopoisk-cinema": {"cinema": "cinema"},
    "kudago": {
        "exhibition": "exhibition",
        "permanent_exhibitions": "exhibition",
        "photo": "exhibition",
        "concert": "concert",
        "theater": "theatre",
        "education": "education",
        "business-events": "education",
        "kids": "family",
        "party": "party",
        "cinema": "cinema",
        "tour": "tour",
        "quest": "games",
        "quiz": "games",
        # Слишком общие, поэтому не маппим: entertainment, recreation, other,
        # holiday, fashion, festival, yarmarki-razvlecheniya-yarmarki.
    },
}

# Источники, где категории — свободные русские названия (Timepad): сопоставляем по словам.
# Первое совпадение — категория. Чего не нашли — в лог «без маппинга».
CATEGORY_KEYWORDS: dict[str, list[tuple[re.Pattern, str]]] = {
    "timepad": [(re.compile(pattern, re.IGNORECASE), category) for pattern, category in [
        (r"стенд-?ап|юмор|комеди", "standup"),
        (r"концерт|музык", "concert"),
        (r"театр|спектакл", "theatre"),
        (r"\bкино|фильм", "cinema"),
        (r"спорт|фитнес|йога|бег\b|забег", "sport"),
        (r"выставк|искусств|фотограф", "exhibition"),
        (r"вечеринк|клуб", "party"),
        (r"еда|гастро|кулинар|вино|кофе", "food"),
        (r"дет|семь", "family"),
        (r"экскурс|путешеств|прогулк", "tour"),
        (r"игр|квест|квиз|настольн", "games"),
        (r"образован|бизнес|наук|лекци|ит\b|интернет|язык|психолог|мастер-класс|хобби|карьер|маркетинг", "education"),
    ]],
}

# Не тема, а пометка. Событие, у которого нет других категорий, в Evently не отдаём.
IGNORED_CATEGORIES: dict[str, frozenset[str]] = {
    "kudago": frozenset({"stock"}),  # акция/скидка
}

# Слишком общий slug; для него смотрим название и теги
_BROAD_CATEGORIES = frozenset({"entertainment"})

# У KudaGo нет категории для стендапа: он приходит как concert или entertainment.
_STANDUP_RE = re.compile(r"стенд-?ап|stand[ -]?up", re.IGNORECASE)

# Квизы, квесты и викторины приходят без своей категории — узнаём по названию и тегам
_GAMES_RE = re.compile(r"квиз|квест|викторин|интеллектуальн\w*\s+игр", re.IGNORECASE)

CITY_NAMES = {c.slug: c.name for c in CITIES.values()}


class _Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class EventlyVenue(_Camel):
    source: str
    external_id: str | None
    name: str
    address: str | None
    city: str
    latitude: float | None
    longitude: float | None


class EventlyOccurrence(_Camel):
    starts_at: AwareDatetime
    ends_at: AwareDatetime | None
    ticket_url: str | None = None


class EventlyImage(_Camel):
    url: str


class EventlyEvent(_Camel):
    source: str
    external_id: str
    title: str
    short_description: str | None
    description: str | None
    source_url: str
    ticket_url: str | None = None
    price_min: int | None
    price_max: int | None
    currency: str
    is_free: bool
    age_rating: int | None
    categories: list[EventlyCategory]
    venue: EventlyVenue | None
    occurrences: list[EventlyOccurrence]
    images: list[EventlyImage]


class EventlyBatch(_Camel):
    events: list[EventlyEvent]


def map_categories(
    source: str,
    categories: list[str],
    unmapped: Counter | None = None,
    title: str = "",
    tags: list[str] | None = None,
) -> list[str]:
    # Любой «*-cinema» — фильмы проката: категория кино, даже если источник забыли внести в CATEGORY_MAPS
    table = CATEGORY_MAPS.get(source) or ({"cinema": "cinema"} if source.endswith("-cinema") else {})
    ignored = IGNORED_CATEGORIES.get(source, frozenset())
    result: list[str] = []

    is_standup = bool(_STANDUP_RE.search(title))
    if is_standup:
        result.append("standup")

    # Событие только с общей категорией: определяем игру по названию и тегам
    if _BROAD_CATEGORIES.intersection(categories):
        haystack = " ".join([title, *(tags or [])])
        if _GAMES_RE.search(haystack):
            result.append("games")

    keywords = CATEGORY_KEYWORDS.get(source, [])
    for slug in categories:
        if slug in ignored:
            continue  # решение принято заранее, в лог «без маппинга» не пишем
        mapped = table.get(slug) or next((cat for regex, cat in keywords if regex.search(slug)), None)
        if mapped is None:
            if unmapped is not None:
                unmapped[f"{source}:{slug}"] += 1
            continue
        if is_standup and mapped == "concert":
            continue  # «стендап-концерт» — это стендап, а не концерт
        if mapped not in result:
            result.append(mapped)
    return result


def is_promo_only(source: str, categories: list[str]) -> bool:
    """Событие, у которого есть только пометка «акция»: в Evently не отдаём."""
    ignored = IGNORED_CATEGORIES.get(source, frozenset())
    return bool(categories) and set(categories) <= ignored


def parse_age_rating(value: str | None) -> int | None:
    """'18+' → 18."""
    match = re.match(r"\s*(\d{1,2})", value or "")
    return int(match.group(1)) if match else None


def to_evently_event(event: Event, unmapped: Counter | None = None) -> EventlyEvent:
    venue = None
    if event.venue is not None:
        venue = EventlyVenue(
            source=event.source,
            external_id=event.venue.source_id,
            name=event.venue.name,
            address=event.venue.address,
            city=CITY_NAMES.get(event.city, event.city),
            latitude=event.venue.lat,
            longitude=event.venue.lon,
        )

    return EventlyEvent(
        source=event.source,
        external_id=event.source_id,
        title=event.title,
        short_description=event.description,
        description=event.full_text,
        source_url=event.source_url,
        ticket_url=event.ticket_url,
        price_min=event.price.min,
        price_max=event.price.max,
        currency=event.price.currency,
        is_free=event.price.is_free,
        age_rating=parse_age_rating(event.age_restriction),
        categories=map_categories(event.source, event.categories, unmapped, event.title, event.tags),
        venue=venue,
        # Сеансы без даты начала (постоянные выставки) Evently не принимает → occurrences: []
        occurrences=[
            EventlyOccurrence(starts_at=s.starts_at, ends_at=s.ends_at)
            for s in event.sessions
            if s.starts_at is not None
        ],
        images=[EventlyImage(url=image.url) for image in event.images],
    )


def to_evently_batch(batch: EventBatch) -> tuple[EventlyBatch, Counter]:
    unmapped: Counter = Counter()
    events = [
        to_evently_event(event, unmapped)
        for event in batch.events
        if not is_promo_only(event.source, event.categories)
    ]
    return EventlyBatch(events=events), unmapped


def export_evently(batch: EventBatch, output_dir: Path) -> Path:
    """output/evently/<source>/<city>/<время>.json и копия latest.json рядом."""
    evently, unmapped = to_evently_batch(batch)
    data = evently.model_dump(mode="json", by_alias=True)

    folder = output_dir / "evently" / batch.source / batch.city
    path = folder / f"{filename_stamp(batch.fetched_at)}.json"
    write_json_atomic(path, data)
    write_json_atomic(folder / "latest.json", data)

    no_date = sum(1 for e in evently.events if not e.occurrences)
    promo_only = sum(1 for e in batch.events if is_promo_only(e.source, e.categories))
    no_category = sum(1 for e in evently.events if not e.categories)
    log.info("Evently: событий %d, без дат %d, без категорий %d, отброшено акций %d → %s",
             len(evently.events), no_date, no_category, promo_only, path)
    if unmapped:
        top = ", ".join(f"{slug} ×{n}" for slug, n in unmapped.most_common())
        log.info("Категории без маппинга: %s", top)
    return path
