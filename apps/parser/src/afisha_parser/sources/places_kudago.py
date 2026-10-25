"""Заведения KudaGo: /place-categories/ и /places/ (public API v1.4).

Какие категории — «где поесть», решаем по названию категории (ресторан, кафе, бар, кофейня,
пекарня, ...), а не по зашитому списку slug'ов: так переживём переименования у KudaGo.
Список категорий — один запрос за цикл.
"""

import logging
import re
from typing import Any

import httpx

from ..cities import get_city
from ..http_client import HttpClient
from ..models import Image
from ..places import Place, guess_kind
from ..text import capitalize_first, clean_text
from .base import REFUSAL_STATUSES, SourceAccessError, SourceConfigError, response_detail
from .kudago import API_BASE, PAGE_SIZE, parse_images, strip_kudago_tail

log = logging.getLogger(__name__)

FOOD_CATEGORY_RE = re.compile(
    r"ресторан|кафе|бар|паб|пив|кофе|кофейн|пекар|кондитер|столов|фуд|гастро|еда|"
    r"restaurant|cafe|bar|pub|beer|coffee|bakery|food",
    re.IGNORECASE,
)
# «Антикафе», «караоке-бар», «кальянная» и т. п. — не про еду
NOT_FOOD_RE = re.compile(r"антикафе|anticafe|караоке|кальян|hookah|клуб", re.IGNORECASE)

FIELDS = ",".join([
    "id", "title", "short_title", "slug", "address", "timetable", "phone", "images", "description",
    "body_text", "site_url", "foreign_url", "coords", "subway", "categories", "is_closed", "location",
])


def food_categories(categories: list[dict]) -> dict[str, str]:
    """slug → название для категорий «где поесть»."""
    result = {}
    for item in categories:
        slug, name = item.get("slug"), item.get("name") or ""
        if not isinstance(slug, str):
            continue
        text = f"{slug} {name}"
        if FOOD_CATEGORY_RE.search(text) and not NOT_FOOD_RE.search(text):
            result[slug] = name
    return result


def _kind(slugs: list[str], names: list[str], title: str):
    """Сначала по категориям; по названию — только если категории ничего не сказали
    («Ресторан „Барашка“» — ресторан, а не бар)."""
    kind = guess_kind(*slugs, *names)
    return guess_kind(title) if kind == "other" else kind


def parse_place(item: dict, *, city: str, category_names: dict[str, str]) -> Place | None:
    title = clean_text(item.get("title"))
    if not title or item.get("id") is None or item.get("is_closed"):
        return None
    coords = item.get("coords") or {}
    slugs = [c for c in item.get("categories") or [] if isinstance(c, str)]
    names = [category_names.get(s, s) for s in slugs]
    slug = item.get("slug")
    images: list[Image] = parse_images(item.get("images"))[:1]  # одно фото на карточку: экономим запросы и диск
    return Place(
        source="kudago",
        source_id=str(item["id"]),
        source_url=item.get("site_url") or (f"https://kudago.com/{city}/place/{slug}/" if slug else None),
        city=city,
        title=capitalize_first(title),
        kind=_kind(slugs, names, title),
        categories=slugs,
        address=clean_text(item.get("address")),
        lat=coords.get("lat") if isinstance(coords.get("lat"), (int, float)) else None,
        lon=coords.get("lon") if isinstance(coords.get("lon"), (int, float)) else None,
        subway=clean_text(item.get("subway")),
        phone=clean_text(item.get("phone")),
        website=item.get("foreign_url") or None,
        opening_hours=clean_text(item.get("timetable")),
        description=strip_kudago_tail(clean_text(item.get("description"))),
        full_text=strip_kudago_tail(clean_text(item.get("body_text"))),
        images=images,
    )


class KudaGoPlaces:
    name = "kudago"

    def __init__(self, http: HttpClient, *, max_pages: int = 20) -> None:
        self.http = http
        self.max_pages = max(1, max_pages)
        self._categories: dict[str, str] | None = None

    async def _get(self, url: str, params: dict | None) -> Any:
        try:
            return (await self.http.get(url, params=params)).json()
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if status in REFUSAL_STATUSES:
                raise SourceAccessError(
                    f"KudaGo ответил {status}: {response_detail(exc.response) or 'доступ запрещён'}", status
                ) from exc
            raise

    async def categories(self) -> dict[str, str]:
        if self._categories is None:
            data = await self._get(f"{API_BASE}/place-categories/", {"lang": "ru"})
            self._categories = food_categories(data if isinstance(data, list) else [])
            log.info("KudaGo: категории заведений: %s", ", ".join(self._categories) or "не найдены")
        return self._categories

    async def fetch_places(self, city: str) -> list[Place]:
        found = get_city(city)
        if found is None or not found.kudago:
            raise SourceConfigError(f"У KudaGo нет города {city}")
        categories = await self.categories()
        if not categories:
            raise SourceConfigError("KudaGo не отдал ни одной категории заведений")
        url: str | None = f"{API_BASE}/places/"
        params: dict | None = {
            "lang": "ru", "location": found.kudago, "categories": ",".join(categories),
            "fields": FIELDS, "text_format": "text", "page_size": PAGE_SIZE, "order_by": "id",
        }
        places: dict[str, Place] = {}
        page = 1
        while url:
            if page > self.max_pages:
                log.warning("KudaGo заведения %s: предел %d страниц, остальное в следующий раз", city, self.max_pages)
                break
            data = await self._get(url, params)
            results = data.get("results") or []
            log.info("KudaGo заведения %s: страница %d, записей %d (всего %s)", city, page, len(results), data.get("count"))
            for item in results:
                try:
                    place = parse_place(item, city=city, category_names=categories)
                except (KeyError, TypeError, ValueError) as exc:
                    log.warning("KudaGo: пропускаю заведение id=%s: %s", item.get("id"), exc)
                    continue
                if place is not None:
                    places[place.source_id] = place
            url, params, page = data.get("next"), None, page + 1
        return list(places.values())
