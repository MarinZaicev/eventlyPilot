"""Заведения из OpenStreetMap через Overpass API — для городов, где нет KudaGo.

Один запрос на город: все объекты amenity=restaurant/cafe/bar/... с названием в радиусе
AFISHA_OSM_RADIUS_KM от центра города (координаты центра — в cities.py).

Данные OSM открытые (лицензия ODbL), но в приложении обязательна подпись
«© участники OpenStreetMap». Фото и описаний в OSM нет.

Правила Overpass: не больше ~10 000 запросов в сутки и ~1 ГБ — у нас 16 запросов в неделю.
"""

import logging
from typing import Any

import httpx

from ..cities import City, get_city
from ..http_client import HttpClient
from ..places import Place, PlaceKind
from ..text import clean_text
from .base import REFUSAL_STATUSES, SourceAccessError, SourceConfigError

log = logging.getLogger(__name__)

DEFAULT_ENDPOINT = "https://overpass-api.de/api/interpreter"

AMENITY_KIND: dict[str, PlaceKind] = {
    "restaurant": "restaurant",
    "cafe": "cafe",
    "bar": "bar",
    "pub": "bar",
    "biergarten": "bar",
    "fast_food": "fast_food",
    "food_court": "fast_food",
}

# Перевод самых частых значений cuisine=* на русский, остальное оставляем как есть
CUISINE_RU = {
    "russian": "русская", "italian": "итальянская", "japanese": "японская", "sushi": "суши",
    "pizza": "пицца", "burger": "бургеры", "georgian": "грузинская", "chinese": "китайская",
    "asian": "азиатская", "european": "европейская", "coffee_shop": "кофе", "uzbek": "узбекская",
    "caucasian": "кавказская", "french": "французская", "american": "американская", "korean": "корейская",
    "vietnamese": "вьетнамская", "thai": "тайская", "indian": "индийская", "mexican": "мексиканская",
    "kebab": "шаурма и кебаб", "shawarma": "шаурма", "regional": "местная", "steak_house": "стейки",
    "seafood": "морепродукты", "vegetarian": "вегетарианская", "vegan": "веганская", "bakery": "выпечка",
    "pancake": "блины", "dumplings": "пельмени", "chicken": "курица", "grill": "гриль", "barbecue": "барбекю",
    "ice_cream": "мороженое", "cake": "десерты", "dessert": "десерты", "tea": "чай", "beer": "пиво",
    "wine": "вино", "breakfast": "завтраки", "sandwich": "сэндвичи", "soup": "супы", "noodle": "лапша",
    "ramen": "рамен", "turkish": "турецкая", "armenian": "армянская", "azerbaijani": "азербайджанская",
    "tatar": "татарская", "ukrainian": "украинская", "international": "интернациональная",
}


def build_query(city: City, radius_m: int, amenities: list[str]) -> str:
    pattern = "|".join(sorted(amenities))
    return (
        "[out:json][timeout:120];"
        f'nwr["amenity"~"^({pattern})$"]["name"](around:{radius_m},{city.lat},{city.lon});'
        "out center tags;"
    )


def _address(tags: dict) -> str | None:
    if full := clean_text(tags.get("addr:full")):
        return full
    street, house = clean_text(tags.get("addr:street")), clean_text(tags.get("addr:housenumber"))
    if street and house:
        return f"{street}, {house}"
    return street


def _first(tags: dict, *keys: str) -> str | None:
    for key in keys:
        if value := clean_text(tags.get(key)):
            return value.split(";")[0].strip()
    return None


def parse_element(element: dict, *, city: str) -> Place | None:
    tags = element.get("tags") or {}
    name = clean_text(tags.get("name:ru")) or clean_text(tags.get("name"))
    kind = AMENITY_KIND.get(tags.get("amenity", ""))
    if not name or kind is None or element.get("type") not in {"node", "way", "relation"}:
        return None
    if tags.get("disused") == "yes" or "disused:amenity" in tags:
        return None
    if element["type"] == "node":
        lat, lon = element.get("lat"), element.get("lon")
    else:
        center = element.get("center") or {}
        lat, lon = center.get("lat"), center.get("lon")
    cuisine_raw = [c.strip() for c in str(tags.get("cuisine") or "").split(";") if c.strip()]
    if kind == "cafe" and "coffee_shop" in cuisine_raw:
        kind = "coffee"
    osm_id = f"{element['type']}/{element['id']}"
    return Place(
        source="osm",
        source_id=osm_id,
        source_url=f"https://www.openstreetmap.org/{osm_id}",
        city=city,
        title=name,
        kind=kind,
        categories=[tags["amenity"]],
        cuisine=[CUISINE_RU.get(c, c.replace("_", " ")) for c in cuisine_raw],
        address=_address(tags),
        lat=lat if isinstance(lat, (int, float)) else None,
        lon=lon if isinstance(lon, (int, float)) else None,
        phone=_first(tags, "phone", "contact:phone"),
        website=_first(tags, "website", "contact:website", "url"),
        opening_hours=clean_text(tags.get("opening_hours")),
        description=clean_text(tags.get("description")),
    )


class OsmPlaces:
    name = "osm"

    def __init__(self, http: HttpClient, *, endpoint: str = DEFAULT_ENDPOINT, radius_km: float = 15,
                 amenities: list[str] | None = None) -> None:
        self.http = http
        self.endpoint = endpoint
        self.radius_m = int(radius_km * 1000)
        self.amenities = [a for a in (amenities or list(AMENITY_KIND)) if a in AMENITY_KIND]

    async def fetch_places(self, city: str) -> list[Place]:
        found = get_city(city)
        if found is None:
            raise SourceConfigError(f"Города {city!r} нет в справочнике cities.py")
        query = build_query(found, self.radius_m, self.amenities)
        try:
            response = await self.http.get(self.endpoint, params={"data": query})
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if status in REFUSAL_STATUSES:
                raise SourceAccessError(f"Overpass ответил {status}: лимит запросов, подождите", status) from exc
            raise
        data: Any = response.json()
        places: dict[str, Place] = {}
        for element in data.get("elements") or []:
            try:
                place = parse_element(element, city=city)
            except (KeyError, TypeError, ValueError) as exc:
                log.warning("OSM: пропускаю %s/%s: %s", element.get("type"), element.get("id"), exc)
                continue
            if place is not None:
                places[place.source_id] = place
        log.info("OSM заведения %s: %d (радиус %d км)", city, len(places), self.radius_m // 1000)
        return list(places.values())
