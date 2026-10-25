"""Запасной источник трейлеров — ПоискКино API (бывший kinopoisk.dev), данные Кинопоиска.

Зачем: у TMDb плохо с российскими фильмами и с роликами к ним. Кинопоиск знает почти всё, что
идёт в наших кинотеатрах. Используется, только если задан AFISHA_KINOPOISK_TOKEN (бесплатный
токен на 200 запросов в сутки — у бота @poiskkinodev_bot, см. poiskkino.dev).

Когда спрашиваем:
  * TMDb нашёл фильм, но роликов у него нет;
  * TMDb фильм не нашёл вовсе (часто у российских фильмов) — тогда ищем по названию
    с тем же строгим порогом сходства, что и в TMDb.

Бесплатный лимит маленький, поэтому:
  * ответы кешируются в output/cache/kinopoisk.json (найдено — на 30 дней, не найдено — на 7);
  * в сутки тратим не больше AFISHA_KINOPOISK_REQUESTS_PER_DAY запросов, остальное — завтра.
"""

import hashlib
import json
import logging
import re
from datetime import UTC, date, datetime, timedelta
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

import httpx

from ..export import write_json_atomic
from ..http_client import HttpClient
from .tmdb_trailers import Trailer, normalize_title

log = logging.getLogger(__name__)

DEFAULT_BASE = "https://api.poiskkino.dev"
CACHE_NAME = "kinopoisk.json"
FOUND_TTL_DAYS = 30
MISS_TTL_DAYS = 7
MIN_SCORE = 0.9
# Столько запросов в сутки не тратим на поиск роликов — они нужны списку проката
LOOKUP_RESERVE = 6
MAX_YEAR_DIFF = 1

_YT_RE = re.compile(r"(?:youtube(?:-nocookie)?\.com/(?:embed/|watch\?v=|v/|shorts/)|youtu\.be/)([\w-]{11})")


class BudgetExhausted(RuntimeError):
    pass


def youtube_key(url: str) -> str | None:
    match = _YT_RE.search(url or "")
    return match.group(1) if match else None


def trailer_from_url(url: str, name: str | None = None) -> Trailer | None:
    if not isinstance(url, str) or not url.startswith(("http://", "https://", "//")):
        return None
    url = "https:" + url if url.startswith("//") else url
    if key := youtube_key(url):
        return Trailer(site="YouTube", key=key, name=name, url=f"https://www.youtube.com/watch?v={key}",
                       embed_url=f"https://www.youtube-nocookie.com/embed/{key}")
    key = "kp-" + hashlib.sha1(url.encode()).hexdigest()[:12]
    return Trailer(site="Kinopoisk", key=key, name=name, url=url, embed_url=url)


def pick_kinopoisk_trailer(movie: dict) -> Trailer | None:
    """YouTube — первым (его можно встроить и скачать), трейлер — раньше тизера."""
    videos = (movie.get("videos") or {}).get("trailers") or []
    items = [v for v in videos if isinstance(v, dict) and isinstance(v.get("url"), str)]
    items.sort(key=lambda v: (youtube_key(v["url"]) is not None,
                              "трейлер" in (v.get("name") or "").lower() or v.get("type") == "TRAILER"),
               reverse=True)
    for item in items:
        if trailer := trailer_from_url(item["url"], item.get("name")):
            return trailer
    return None


def _names(doc: dict) -> list[str]:
    return [n for n in (doc.get("name"), doc.get("alternativeName"), doc.get("enName")) if isinstance(n, str) and n]


def best_doc(docs: list[dict], title: str, year: int | None) -> dict | None:
    """Только уверенное совпадение: название почти точно, год (если известен) ±1."""
    scored = []
    for doc in docs[:5]:
        names = _names(doc)
        if not names:
            continue
        # «Чебурашка» и «Чебурашка 2» похожи на 0.9, но это разные фильмы: числа в названии должны совпасть
        digits = set(re.findall(r"\d+", title))
        names = [n for n in names if set(re.findall(r"\d+", n)) == digits]
        if not names:
            continue
        score = max(SequenceMatcher(None, normalize_title(title), normalize_title(n)).ratio() for n in names)
        doc_year = doc.get("year") if isinstance(doc.get("year"), int) else None
        if score < MIN_SCORE:
            continue
        if year is not None and doc_year is not None and abs(doc_year - year) > MAX_YEAR_DIFF:
            continue
        scored.append((score, doc))
    if not scored:
        return None
    scored.sort(key=lambda pair: pair[0], reverse=True)
    if len(scored) > 1 and scored[1][0] >= scored[0][0] - 0.01 and year is None:
        return None  # два одинаково похожих фильма, год не подсказывает — не угадываем
    return scored[0][1]


class KinopoiskClient:
    def __init__(self, http: HttpClient, token: str, output_dir: Path, *,
                 base: str = DEFAULT_BASE, requests_per_day: int = 150) -> None:
        self.http = http
        self.token = token
        self.base = base.rstrip("/")
        self.path = output_dir / "cache" / CACHE_NAME
        self.requests_per_day = requests_per_day
        self._data = self._load()
        self.disabled_reason: str | None = None

    def _load(self) -> dict[str, Any]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        data.setdefault("entries", {})
        data.setdefault("budget", {})
        return data

    def save(self) -> None:
        write_json_atomic(self.path, self._data)

    @property
    def used_today(self) -> int:
        budget = self._data["budget"]
        return budget.get("used", 0) if budget.get("day") == date.today().isoformat() else 0

    async def _get(self, path: str, params: dict | None = None) -> dict:
        if self.disabled_reason:
            raise BudgetExhausted(self.disabled_reason)
        if self.used_today >= self.requests_per_day:
            raise BudgetExhausted(f"лимит {self.requests_per_day} запросов на сегодня исчерпан")
        self._data["budget"] = {"day": date.today().isoformat(), "used": self.used_today + 1}
        try:
            response = await self.http.get(f"{self.base}{path}", params=params, headers={"X-API-KEY": self.token})
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code in (401, 403, 429):
                detail = exc.response.text[:200].replace("\n", " ").strip()
                self.disabled_reason = (f"ПоискКино ответил {exc.response.status_code} на {path}: "
                                        f"{detail or 'без пояснения'}")
                log.error("%s — до конца цикла не спрашиваю", self.disabled_reason)
                raise BudgetExhausted(self.disabled_reason) from exc
            raise
        return response.json()

    @staticmethod
    def _key(title: str, year: int | None) -> str:
        return f"{normalize_title(title)}|{year or ''}"

    def cached(self, title: str, year: int | None) -> tuple[bool, dict | None]:
        entry = self._data["entries"].get(self._key(title, year))
        if not entry:
            return False, None
        ttl = FOUND_TTL_DAYS if entry.get("movie") else MISS_TTL_DAYS
        try:
            fresh = datetime.now(UTC) - datetime.fromisoformat(entry["checked_at"]) < timedelta(days=ttl)
        except (KeyError, ValueError):
            fresh = False
        return fresh, entry.get("movie")

    async def lookup(self, title: str, year: int | None = None, *, alt_titles: tuple[str, ...] = ()) -> dict | None:
        """Сводка фильма {kinopoisk_id, title, year, trailer, poster_url, ...} или None. Бросает BudgetExhausted."""
        hit, movie = self.cached(title, year)
        if hit:
            return movie
        if self.used_today >= self.requests_per_day - LOOKUP_RESERVE:
            # последние запросы суток бережём для списка проката (cinema_kinopoisk)
            raise BudgetExhausted("лимит запросов на поиск роликов на сегодня исчерпан")
        movie = None
        for query in dict.fromkeys([title, *[t for t in alt_titles if t]]):
            data = await self._get("/v1.4/movie/search", {"query": query, "page": 1, "limit": 5})
            doc = best_doc(data.get("docs") or [], query, year)
            if doc is None:
                continue
            full = await self._get(f"/v1.4/movie/{doc['id']}")
            trailer = pick_kinopoisk_trailer(full)
            movie = {
                "kinopoisk_id": doc["id"],
                "title": full.get("name") or doc.get("name"),
                "original_title": full.get("alternativeName") or full.get("enName"),
                "year": full.get("year") or doc.get("year"),
                "overview": full.get("description") or full.get("shortDescription"),
                "poster_url": (full.get("poster") or {}).get("url"),
                "genres": [g["name"] for g in full.get("genres") or [] if isinstance(g, dict) and g.get("name")],
                "rating": (full.get("rating") or {}).get("kp"),
                "is_series": bool(full.get("isSeries")),
                "trailer": trailer.model_dump(mode="json") if trailer else None,
            }
            break
        self._data["entries"][self._key(title, year)] = {
            "checked_at": datetime.now(UTC).replace(microsecond=0).isoformat(), "movie": movie}
        return movie

    async def trailer(self, title: str, year: int | None = None, *, alt_titles: tuple[str, ...] = ()) -> Trailer | None:
        movie = await self.lookup(title, year, alt_titles=alt_titles)
        if movie and movie.get("trailer"):
            return Trailer.model_validate(movie["trailer"])
        return None


    # ---------- догрузка роликов по полной карточке фильма ----------

    def backfill_used_today(self) -> int:
        info = self._data.get("backfill") or {}
        return info.get("used", 0) if info.get("day") == date.today().isoformat() else 0

    def cached_by_id(self, kp_id: int) -> tuple[bool, Trailer | None]:
        """(есть ли свежая запись, ролик). Найденный ролик помним 30 дней, «нет ролика» — 7."""
        entry = self._data["entries"].get(f"id:{kp_id}")
        if not entry:
            return False, None
        trailer = entry.get("trailer")
        ttl = FOUND_TTL_DAYS if trailer else MISS_TTL_DAYS
        try:
            fresh = datetime.now(UTC) - datetime.fromisoformat(entry["checked_at"]) < timedelta(days=ttl)
        except (KeyError, ValueError):
            fresh = False
        return fresh, Trailer.model_validate(trailer) if trailer else None

    async def trailer_by_id(self, kp_id: int, *, per_day: int) -> Trailer | None:
        """Ролик из полной карточки /v1.4/movie/{id}. Не больше per_day новых запросов в сутки.
        Бросает BudgetExhausted, когда дневная норма догрузки или общий лимит исчерпаны."""
        hit, trailer = self.cached_by_id(kp_id)
        if hit:
            return trailer
        if self.backfill_used_today() >= per_day:
            raise BudgetExhausted(f"норма догрузки роликов на сегодня ({per_day}) выбрана")
        if self.used_today >= self.requests_per_day - LOOKUP_RESERVE:
            raise BudgetExhausted("лимит запросов на сегодня исчерпан")
        self._data["backfill"] = {"day": date.today().isoformat(), "used": self.backfill_used_today() + 1}
        full = await self._get(f"/v1.4/movie/{kp_id}", {"selectFields": ["id", "videos"]})
        trailer = pick_kinopoisk_trailer(full)
        self._data["entries"][f"id:{kp_id}"] = {
            "checked_at": datetime.now(UTC).replace(microsecond=0).isoformat(),
            "trailer": trailer.model_dump(mode="json") if trailer else None,
        }
        return trailer
