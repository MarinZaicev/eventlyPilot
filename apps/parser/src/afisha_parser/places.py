"""Заведения: где поесть (рестораны, кафе, бары) — модель, сохранение и файл для приложения.

Источники:
  * KudaGo /places/ — богатые карточки (описание, фото, часы работы), только города KudaGo;
  * OpenStreetMap (Overpass API) — все города, но только название, адрес, кухня, часы, телефон.
    Лицензия ODbL: в приложении нужна подпись «© участники OpenStreetMap».

В городе KudaGo берём KudaGo; если KudaGo отдал мало (AFISHA_PLACES_MIN_KUDAGO), дополняем из OSM.
Заведения меняются редко, поэтому собираются раз в AFISHA_PLACES_INTERVAL_HOURS (неделя).

Файлы:
  output/places/<источник>/<город>/latest.json   — универсальный дамп (snake_case, как events/)
  output/app/places/<город>/latest.json          — для бэкенда Evently (camelCase), источники
                                                   склеены, повторы убраны. Не в evently/: та папка —
                                                   только события, бэкенд читает её как источники событий.
"""

import hashlib
import json
import logging
import re
from datetime import UTC, datetime, timedelta
from difflib import SequenceMatcher
from pathlib import Path
from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from .cities import CITIES, distance_km
from .export import write_json_atomic
from .models import Image, filename_stamp

log = logging.getLogger(__name__)

PLACES_SCHEMA_VERSION = "1.0"

PlaceKind = Literal["restaurant", "cafe", "coffee", "bar", "fast_food", "bakery", "canteen", "other"]

OSM_ATTRIBUTION = "© участники OpenStreetMap (ODbL)"
KUDAGO_ATTRIBUTION = "KudaGo"

# Одно и то же заведение из KudaGo и OSM: похожее название и не дальше стольких метров
DUPLICATE_DISTANCE_M = 150
DUPLICATE_NAME_SCORE = 0.8


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Place(_Model):
    source: str = Field(description="kudago или osm")
    source_id: str = Field(description="id у источника; у OSM вида node/123")
    source_url: str | None = Field(None, description="Страница заведения у источника")
    city: str
    title: str
    kind: PlaceKind = Field(description="Наш тип заведения")
    categories: list[str] = Field(default_factory=list, description="Категории в терминах источника")
    cuisine: list[str] = Field(default_factory=list, description="Кухня: русская, итальянская, ...")
    address: str | None = None
    lat: float | None = None
    lon: float | None = None
    subway: str | None = None
    phone: str | None = None
    website: str | None = Field(None, description="Собственный сайт заведения")
    opening_hours: str | None = Field(None, description="Часы работы как у источника (у OSM — формат opening_hours)")
    description: str | None = None
    full_text: str | None = None
    images: list[Image] = Field(default_factory=list)
    content_hash: str | None = None


class PlaceBatch(_Model):
    schema_version: str = PLACES_SCHEMA_VERSION
    source: str
    city: str
    fetched_at: AwareDatetime
    count: int
    attribution: str
    places: list[Place]


# ---------- тип заведения ----------

_KIND_RULES: list[tuple[str, PlaceKind]] = [
    (r"фастфуд|fast.?food|бургер|шаурм|пицц|food.?court|фудкорт", "fast_food"),
    (r"кофе|coffee", "coffee"),
    (r"пекар|bakery|кондитер|confectioner", "bakery"),
    (r"столов|canteen", "canteen"),
    (r"(?<![а-яё])бар(?!бек|ан|ашк)|\bbars?\b|паб|\bpubs?\b|пив|beer|brew|biergarten|винн|wine", "bar"),
    (r"кафе|cafe|чайн", "cafe"),
    (r"ресторан|restaurant|гастро", "restaurant"),
]


def guess_kind(*words: str | None) -> PlaceKind:
    text = " ".join(w for w in words if w).casefold()
    for pattern, kind in _KIND_RULES:
        if re.search(pattern, text):
            return kind
    return "other"


def compute_place_hash(place: Place) -> str:
    payload = place.model_dump(mode="json", exclude={"content_hash": True, "images": {"__all__": {"local_path"}}})
    blob = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


# ---------- файлы ----------

def places_folder(output_dir: Path, source: str, city: str) -> Path:
    return output_dir / "places" / source / city


def export_places(batch: PlaceBatch, output_dir: Path) -> Path:
    folder = places_folder(output_dir, batch.source, batch.city)
    path = folder / f"{filename_stamp(batch.fetched_at)}.json"
    data = batch.model_dump(mode="json")
    write_json_atomic(path, data)
    write_json_atomic(folder / "latest.json", data)
    return path


def load_places(output_dir: Path, source: str, city: str) -> PlaceBatch | None:
    path = places_folder(output_dir, source, city) / "latest.json"
    try:
        return PlaceBatch.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        if path.exists():
            log.warning("Заведения: %s не читается: %s", path, exc)
        return None


def places_due(output_dir: Path, source: str, city: str, interval_hours: float, now: datetime) -> bool:
    """Пора ли обновлять: файла нет или он старше интервала."""
    batch = load_places(output_dir, source, city)
    return batch is None or now - batch.fetched_at >= timedelta(hours=interval_hours)


# ---------- файл для приложения ----------

def _norm(text: str) -> str:
    return re.sub(r"[^\w]+", " ", text.casefold().replace("ё", "е")).strip()


def is_duplicate(a: Place, b: Place) -> bool:
    if None in (a.lat, a.lon, b.lat, b.lon):
        return False
    if distance_km(a.lat, a.lon, b.lat, b.lon) * 1000 > DUPLICATE_DISTANCE_M:
        return False
    return SequenceMatcher(None, _norm(a.title), _norm(b.title)).ratio() >= DUPLICATE_NAME_SCORE


def merge_places(batches: list[PlaceBatch]) -> list[Place]:
    """Склеить источники: первый (KudaGo) главный, из следующих — только то, чего ещё нет."""
    result: list[Place] = []
    for batch in batches:
        for place in batch.places:
            if any(is_duplicate(place, kept) for kept in result if kept.source != place.source):
                continue
            result.append(place)
    return result


def to_app_place(place: Place) -> dict:
    return {
        "source": place.source,
        "externalId": place.source_id,
        "sourceUrl": place.source_url,
        "name": place.title,
        "kind": place.kind,
        "categories": place.categories,
        "cuisine": place.cuisine,
        "address": place.address,
        "latitude": place.lat,
        "longitude": place.lon,
        "subway": place.subway,
        "phone": place.phone,
        "website": place.website,
        "openingHours": place.opening_hours,
        "description": place.description,
        "fullText": place.full_text,
        "images": [{"url": i.url, "localPath": i.local_path} for i in place.images],
        "attribution": OSM_ATTRIBUTION if place.source == "osm" else KUDAGO_ATTRIBUTION,
        "contentHash": place.content_hash,
    }


def export_app_places(output_dir: Path, city: str, batches: list[PlaceBatch]) -> Path | None:
    """output/app/places/<город>/latest.json из всех источников города."""
    batches = [b for b in batches if b is not None]
    if not batches:
        return None
    places = merge_places(batches)
    items = [to_app_place(p) for p in places]
    digest = hashlib.sha256(json.dumps(items, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    path = output_dir / "app" / "places" / city / "latest.json"
    try:
        if json.loads(path.read_text(encoding="utf-8")).get("contentHash") == digest:
            return path  # ничего не поменялось — не трогаем файл, бэкенду не нужно ничего перечитывать
    except (OSError, ValueError, AttributeError):
        pass
    known = CITIES.get(city)
    data = {
        "schemaVersion": PLACES_SCHEMA_VERSION,
        "kind": "places",
        "city": city,
        "cityName": known.name if known else city,
        "generatedAt": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "sources": {b.source: b.fetched_at.isoformat() for b in batches},
        "attribution": sorted({b.attribution for b in batches}),
        "count": len(places),
        "contentHash": digest,
        "places": items,
    }
    write_json_atomic(path, data)
    return path
