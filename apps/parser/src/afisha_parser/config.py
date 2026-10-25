from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Все настройки читаются из переменных AFISHA_* или из файла .env в текущей папке."""

    model_config = SettingsConfigDict(env_prefix="AFISHA_", env_file=".env", extra="ignore")

    output_dir: Path = Path("output")
    user_agent: str = "afisha-parser/0.4"
    request_timeout: float = 20.0
    request_delay: float = 0.5
    max_retries: int = 4
    image_concurrency: int = 4

    # --- Бережный режим: сколько мы позволяем себе запрашивать у источников ---
    # Не больше стольких запросов в час к ОДНОМУ источнику (KudaGo, Timepad — у каждого свой счёт).
    # 30 — запрос раз в 2 минуты, 1 — раз в час. 0 — без ограничения (только AFISHA_REQUEST_DELAY).
    # Картинки и TMDb сюда не входят: это другие сайты.
    requests_per_hour: float = 30
    # Свой лимит для отдельных источников, «источник:запросов_в_час» через запятую.
    # KudaGo банит быстрее всех — по умолчанию ему 10 в час (запрос раз в 6 минут)
    source_limits: str = "kudago:10"
    # Не больше стольких страниц (по 100 событий) на один город у одного источника
    max_pages: int = 20
    # Источник ответил 401/403/429 — не трогаем его столько часов (по всем городам сразу).
    # Снять паузу вручную: python -m afisha_parser resume <источник>
    block_pause_hours: float = 24

    # --- Фильтр прошедших событий ---
    # Сеанс без времени окончания считается прошедшим через столько минут после начала.
    # 0 — как только начался (купить билет уже нельзя).
    past_grace_minutes: int = 0

    # --- Автономный режим (команды run и daemon) ---
    # Какие города собирать: наши slug'и через запятую (список: python -m afisha_parser cities).
    # Для каждого города берутся все источники из AFISHA_SOURCES, которые его знают.
    cities: str = ""
    sources: str = "kudago,timepad"
    # Точный список пар источник:город, например "kudago:msk,timepad:omsk".
    # Используется, только если AFISHA_CITIES пустой
    targets: str = "kudago:msk"
    days: int = 30
    interval_minutes: int = 180
    # Если цикл целиком упал (нет сети), следующая попытка раньше обычного
    retry_minutes: int = 20
    download_images: bool = True
    save_raw: bool = True
    evently: bool = True
    movies: bool = True          # трейлеры к кинопоказам источника (нужен ключ TMDb)
    now_playing: bool = True     # афиша проката TMDb с трейлерами (нужен ключ TMDb)
    # Сколько хранить снимки прошлых запусков (latest.json не удаляется никогда)
    keep_days: int = 7
    raw_keep_days: int = 2

    # --- Кино: фильмы и сеансы кинотеатров KudaGo (города KudaGo из AFISHA_CITIES) ---
    cinema: bool = True
    # kinopoisk — фильмы в прокате и премьеры (нужен AFISHA_KINOPOISK_TOKEN), во всех городах, без сеансов;
    # kudago — фильмы и сеансы по кинотеатрам (только города KudaGo, если KudaGo нас пускает)
    cinema_sources: str = "kinopoisk,kudago"
    # Кинопоиск: сколько фильмов брать. В прокате — самые популярные (по голосам Кинопоиска),
    # премьеры — ближайшие по дате. Перевыпуски старше cinema_max_age_years лет отсекаются (0 — не отсекать)
    cinema_max_films: int = 40
    cinema_max_premieres: int = 15
    cinema_max_age_years: int = 2
    # Что идёт в кинотеатрах, но не кино: записи спектаклей, оперы, балета (регулярное выражение по названию)
    cinema_exclude: str = (r"TheatreHD|Театр в кино|Опера в кино|Балет в кино|Метрополитен-опера|"
                           r"Королевск\w+ (опера|балет)|Royal (Opera|Ballet)|National Theatre|Ла Скала|"
                           r"Большой театр|Берлинская опера|Венская опера|Парижская опера")
    cinema_days: int = 3
    cinema_interval_hours: float = 12

    # --- Заведения: где поесть (команда places, и в цикле службы) ---
    places: bool = True
    places_sources: str = "kudago,osm"
    # Заведения меняются редко: обновляем раз в столько часов (168 = неделя)
    places_interval_hours: float = 168
    # Если KudaGo отдал по городу меньше стольких заведений — дополняем из OpenStreetMap
    places_min_kudago: int = 30
    # Новых фото заведений за один цикл, не больше (остальные — в следующих циклах)
    places_images_per_run: int = 300
    osm_endpoint: str = "https://overpass-api.de/api/interpreter"
    osm_radius_km: float = 15
    osm_amenities: str = "restaurant,cafe,bar,pub,biergarten,fast_food,food_court"
    osm_timeout: float = 180

    # --- Отправка в бэкенд Evently (пусто — не отправлять, только файлы) ---
    evently_import_url: str | None = None
    evently_import_token: str | None = None
    evently_import_chunk: int = 200

    # --- Timepad: токен на dev.timepad.ru/api/oauth/ ---
    timepad_token: str | None = None

    # --- TMDb ---
    # v3 «Ключ API» с themoviedb.org — нужен только для кино и трейлеров
    tmdb_api_key: str | None = None
    tmdb_region: str = "RU"
    tmdb_language: str = "ru-RU"

    # --- Кинопоиск (ПоискКино API): запасной источник трейлеров, где у TMDb пусто ---
    # Бесплатный токен (200 запросов в сутки): Telegram-бот @poiskkinodev_bot. Пусто — не используется
    kinopoisk_token: str | None = None
    kinopoisk_base: str = "https://api.poiskkino.dev"
    kinopoisk_requests_per_day: int = 150
    # Сколько полных карточек фильмов в сутки запрашивать ради роликов (у кого их нет в общем списке)
    kinopoisk_backfill_per_day: int = 40
    # Номера городов Кинопоиска для ссылки «билеты» (сеансы именно этого города), «город:номер» через
    # запятую. Дополняют и переопределяют cities.py. Номер — из адреса kinopoisk.ru/afisha/city/<номер>/
    kinopoisk_city_ids: str = ""

    # --- Скачивание файлов трейлеров (нужен пакет yt-dlp: pip install ".[trailers]") ---
    trailers_download: bool = False
    trailers_per_run: int = 20
    trailer_max_height: int = 720
    trailer_max_mb: int = 150
    # Прокси для скачивания роликов (YouTube из России работает плохо): socks5://host:port или http://...
    trailers_proxy: str | None = None

    def requests_per_hour_for(self, source: str | None) -> float:
        for chunk in self.source_limits.replace(";", ",").split(","):
            name, sep, value = chunk.partition(":")
            if sep and name.strip() == source:
                try:
                    return float(value)
                except ValueError:
                    break
        return self.requests_per_hour

    def kinopoisk_city_id(self, city: str) -> int | None:
        """Номер города на Кинопоиске: из AFISHA_KINOPOISK_CITY_IDS, иначе из cities.py, иначе None."""
        for chunk in self.kinopoisk_city_ids.replace(";", ",").split(","):
            name, sep, value = chunk.partition(":")
            if sep and name.strip() == city and value.strip().isdigit():
                return int(value.strip())
        from .cities import CITIES
        known = CITIES.get(city)
        return known.kinopoisk if known else None

    def source_gap_seconds(self, source: str | None = None) -> float:
        """Пауза между запросами к одному источнику (с учётом AFISHA_SOURCE_LIMITS)."""
        rate = self.requests_per_hour_for(source)
        by_rate = 3600 / rate if rate > 0 else 0.0
        return max(self.request_delay, by_rate)

    def city_slugs(self) -> list[str]:
        """Города из AFISHA_CITIES, а если он пустой — из AFISHA_TARGETS."""
        if self.cities.strip():
            return [c.strip() for c in self.cities.replace(";", ",").split(",") if c.strip()]
        return list(dict.fromkeys(city for _, city in self.target_pairs()))

    def target_pairs(self) -> list[tuple[str, str]]:
        if self.cities.strip():
            return self._pairs_from_cities()
        pairs = []
        for chunk in self.targets.replace(";", ",").split(","):
            chunk = chunk.strip()
            if not chunk:
                continue
            source, sep, city = chunk.partition(":")
            if not sep or not source.strip() or not city.strip():
                raise ValueError(f"AFISHA_TARGETS: ожидается источник:город, получено {chunk!r}")
            pairs.append((source.strip(), city.strip()))
        return pairs

    def _pairs_from_cities(self) -> list[tuple[str, str]]:
        from .cities import CITIES

        wanted_sources = [s.strip() for s in self.sources.split(",") if s.strip()]
        pairs = []
        unknown = []
        for slug in (c.strip() for c in self.cities.replace(";", ",").split(",")):
            if not slug:
                continue
            city = CITIES.get(slug)
            if city is None:
                unknown.append(slug)
                continue
            available = city.sources()
            pairs += [(source, slug) for source in wanted_sources if source in available]
        if unknown:
            raise ValueError(f"AFISHA_CITIES: неизвестные города {', '.join(unknown)}. "
                             f"Список: python -m afisha_parser cities")
        return pairs


@lru_cache
def get_settings() -> Settings:
    return Settings()
