"""Командная строка.

Автономная работа (всё берётся из .env):
    python -m afisha_parser daemon            # работать в фоне по расписанию (так запускает служба)
    python -m afisha_parser run               # один полный цикл сейчас
    python -m afisha_parser status            # итоги последнего цикла; код 1 — что-то не так
    python -m afisha_parser resume timepad    # снять паузу с источника после отказа (или: resume all)

Ручные команды:
    python -m afisha_parser fetch kudago --city msk --days 30 --download-images --evently --movies
    python -m afisha_parser evently output/events/kudago/msk/latest.json
    python -m afisha_parser movies output/events/kudago/msk/latest.json
    python -m afisha_parser now-playing [--download-trailers]
    python -m afisha_parser trailers output/movies/tmdb/ru/latest.json
    python -m afisha_parser trailers-page     # страница для просмотра трейлеров
    python -m afisha_parser trailers-report   # у каких фильмов нет ролика, что скачано
    python -m afisha_parser places --city omsk --force   # обновить заведения сейчас
    python -m afisha_parser cinema --city msk --force    # обновить кино (фильмы и сеансы) сейчас
    python -m afisha_parser publish output/evently/kudago/msk/latest.json
    python -m afisha_parser cleanup
    python -m afisha_parser cities            # наш справочник городов
    python -m afisha_parser cities kudago     # города у самого KudaGo
    python -m afisha_parser fetch timepad --city omsk --limit 20
    python -m afisha_parser schema --format evently
"""

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path

from pydantic import ValidationError

from .cities import CITIES
from .config import Settings, get_settings
from .cycle import LockBusy, cycle_lock, format_status, is_healthy, read_status, run_cycle, run_daemon
from .enrichers.tmdb_catalog import CatalogBatch, export_catalog, fetch_catalog, load_catalog
from .enrichers.tmdb_trailers import MovieBatch, enrich_batch, export_movies
from .export import load_batch, write_json_atomic
from .exporters.evently import EventlyBatch, export_evently
from .http_client import HttpClient
from .models import EventBatch
from .pipeline import run_fetch
from .images_report import build_report as build_images_report
from .preview import build_trailers_page
from .publisher import PublishError, publish_evently
from .retention import cleanup
from .sources import ADAPTERS
from .timefilter import filter_batch, grace_from_minutes
from .trailers import download_trailers


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="afisha_parser", description="Сбор событий афиши в JSON")
    parser.add_argument("-v", "--verbose", action="store_true", help="подробный лог")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("daemon", help="работать в фоне: цикл сбора каждые AFISHA_INTERVAL_MINUTES")
    sub.add_parser("run", help="один полный цикл по настройкам из .env")
    sub.add_parser("status", help="итоги последнего цикла (код выхода 1 — ошибка или служба давно не работала)")
    resume = sub.add_parser("resume", help="снять паузу с источника, поставленную после отказа 401/403/429")
    resume.add_argument("source", help="kudago, timepad или all")
    clean = sub.add_parser("cleanup", help="удалить старые снимки, сырые ответы и ненужные картинки")
    clean.add_argument("--keep-days", type=int, help="по умолчанию AFISHA_KEEP_DAYS")

    fetch = sub.add_parser("fetch", help="собрать события и сохранить в JSON")
    fetch.add_argument("source", choices=sorted(ADAPTERS))
    fetch.add_argument("--city", required=True, help="slug города у источника, например msk")
    fetch.add_argument("--days", type=int, default=30, help="горизонт в днях (по умолчанию 30)")
    fetch.add_argument("--limit", type=int, help="остановиться после N событий (для отладки)")
    fetch.add_argument("--download-images", action="store_true", help="скачать картинки в output/images")
    fetch.add_argument("--no-raw", action="store_true", help="не сохранять сырые ответы источника")
    fetch.add_argument("--evently", action="store_true", help="дополнительно сохранить файл в формате Evently")
    fetch.add_argument("--movies", action="store_true", help="дотянуть трейлеры TMDb для категории cinema")

    evently = sub.add_parser("evently", help="преобразовать готовый дамп в формат Evently без повторного сбора")
    evently.add_argument("path", type=Path, help="универсальный JSON, например output/events/kudago/msk/latest.json")
    evently.add_argument("--keep-past", action="store_true", help="не отбрасывать прошедшие события")

    movies = sub.add_parser("movies", help="дотянуть трейлеры и постеры TMDb для событий категории cinema")
    movies.add_argument("path", type=Path, help="универсальный JSON, например output/events/kudago/msk/latest.json")
    movies.add_argument("--download-trailers", action="store_true", help="скачать файлы роликов (нужен yt-dlp)")

    playing = sub.add_parser("now-playing", help="афиша проката TMDb: фильмы в кино и премьеры с трейлерами")
    playing.add_argument("--download-trailers", action="store_true", help="скачать файлы роликов (нужен yt-dlp)")

    trailers = sub.add_parser("trailers", help="скачать файлы трейлеров для готового файла movies")
    trailers.add_argument("path", type=Path, help="например output/movies/tmdb/ru/latest.json")
    trailers.add_argument("--limit", type=int, help="сколько роликов скачать за раз (по умолчанию AFISHA_TRAILERS_PER_RUN)")

    sub.add_parser("images-report", help="отчёт: у скольких событий есть картинки и где они теряются")
    sub.add_parser("trailers-report", help="у скольких фильмов есть ролик, откуда он, скачан ли файл")
    places = sub.add_parser("places", help="обновить заведения (где поесть) сейчас, не дожидаясь недели")
    places.add_argument("--city", help="один город; по умолчанию все из AFISHA_CITIES")
    places.add_argument("--force", action="store_true", help="обновить, даже если неделя ещё не прошла")
    cinema = sub.add_parser("cinema", help="обновить кино KudaGo (фильмы и сеансы) сейчас")
    cinema.add_argument("--city", help="один город; по умолчанию все города KudaGo из AFISHA_CITIES")
    cinema.add_argument("--force", action="store_true", help="обновить, даже если интервал ещё не прошёл")
    cinema.add_argument("--source", choices=["all", "kinopoisk", "kudago"], default="all",
                        help="kinopoisk — прокат и премьеры, kudago — сеансы кинотеатров (по умолчанию оба)")
    sub.add_parser("trailers-page", help="собрать страницу output/preview/trailers.html для просмотра трейлеров")

    publish = sub.add_parser("publish", help="отправить файл Evently в бэкенд (AFISHA_EVENTLY_IMPORT_URL)")
    publish.add_argument("path", type=Path, help="например output/evently/kudago/msk/latest.json")

    cities = sub.add_parser("cities", help="справочник городов; с именем источника — города у самого источника")
    cities.add_argument("source", nargs="?", choices=sorted(ADAPTERS))

    schema = sub.add_parser("schema", help="выгрузить JSON Schema контракта")
    schema.add_argument("--format", choices=["universal", "evently"], default="universal")
    schema.add_argument("--out", type=Path, help="куда сохранить (по умолчанию schema/<формат>.schema.json)")
    return parser


async def show_cities(source: str) -> None:
    async with HttpClient(get_settings()) as http:
        for slug, name in await ADAPTERS[source](http).list_cities():
            print(f"{slug:<16} {name}")


def show_registry() -> None:
    print(f"{'slug':<13} {'город':<17} {'пояс':<19} источники")
    for city in CITIES.values():
        print(f"{city.slug:<13} {city.name:<17} {city.tz:<19} {', '.join(city.sources())}")
    print("\nВсе сразу в .env: AFISHA_CITIES=" + ",".join(c.slug for c in CITIES.values() if c.slug != "sochi"))


def export_schema(fmt: str, out: Path | None) -> None:
    out = out or Path("schema") / f"{fmt}.schema.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    if fmt == "evently":
        schema = EventlyBatch.model_json_schema(by_alias=True, mode="serialization")
    else:
        schema = EventBatch.model_json_schema(mode="serialization")
    out.write_text(json.dumps(schema, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Схема сохранена: {out}")


def _load_dump(path: Path, hint: str) -> EventBatch | None:
    if not path.is_file():
        print(f"Файл не найден: {path}\n{hint}", file=sys.stderr)
        return None
    try:
        return load_batch(path)
    except ValidationError as exc:
        print(f"{path} не похож на универсальный дамп парсера:\n{exc}", file=sys.stderr)
        return None


def _current(batch: EventBatch, settings: Settings) -> EventBatch:
    batch, result = filter_batch(batch, grace=grace_from_minutes(settings.past_grace_minutes))
    if result.dropped_events or result.dropped_sessions:
        logging.getLogger("afisha_parser").info(
            "Отброшено прошедших: событий %d, сеансов %d", result.dropped_events, result.dropped_sessions)
    return batch


def cmd_movies(args, settings: Settings) -> int:
    batch = _load_dump(args.path, "Сначала соберите данные: python -m afisha_parser fetch <источник> --city <город>")
    if batch is None:
        return 1
    previous = load_catalog(settings.output_dir, settings.tmdb_region)  # сверка с прокатом, если он уже собран
    movie_batch = asyncio.run(enrich_batch(_current(batch, settings), settings,
                                           catalog=previous.movies if previous else None))
    if movie_batch is None:
        return 1
    if args.download_trailers:
        asyncio.run(download_trailers([m.trailer for m in movie_batch.movies], settings.output_dir, settings))
    export_movies(movie_batch, settings.output_dir)
    return 0


def cmd_now_playing(args, settings: Settings) -> int:
    catalog = asyncio.run(fetch_catalog(settings))
    if catalog is None:
        return 1
    if args.download_trailers:
        asyncio.run(download_trailers([m.trailer for m in catalog.movies], settings.output_dir, settings))
    path = export_catalog(catalog, settings.output_dir)
    print(f"Фильмов: {catalog.count}, с трейлером: {catalog.with_trailer} → {path}")
    return 0


def cmd_trailers(args, settings: Settings) -> int:
    if not args.path.is_file():
        print(f"Файл не найден: {args.path}\nСначала: python -m afisha_parser now-playing", file=sys.stderr)
        return 1
    raw = args.path.read_text(encoding="utf-8")
    batch: CatalogBatch | MovieBatch | None = None
    for model in (CatalogBatch, MovieBatch):  # прокат TMDb или трейлеры к кинопоказам источника
        try:
            batch = model.model_validate_json(raw)
            break
        except ValidationError:
            continue
    if batch is None:
        print(f"{args.path} не похож ни на output/movies/tmdb/…, ни на output/movies/<источник>/…",
              file=sys.stderr)
        return 1
    if args.limit is not None:
        settings = settings.model_copy(update={"trailers_per_run": args.limit})
    asyncio.run(download_trailers([m.trailer for m in batch.movies], settings.output_dir, settings))
    write_json_atomic(args.path, batch.model_dump(mode="json"))  # проставленные local_path
    return 0


def cmd_cinema(args, settings: Settings) -> int:
    from datetime import UTC, datetime

    from . import cinema_cycle
    from .enrichers.kinopoisk import KinopoiskClient
    from .enrichers.tmdb_catalog import load_catalog
    from .enrichers.tmdb_trailers import TmdbClient
    from .http_client import SOURCE_RETRY_STATUSES
    from .sources.cinema_kudago import KudaGoCinema

    cities = [args.city] if args.city else cinema_cycle.cinema_cities(settings)

    async def run() -> list[dict]:
        now = datetime.now(UTC).replace(microsecond=0)
        catalog = load_catalog(settings.output_dir, settings.tmdb_region)
        async with HttpClient(settings, delay=settings.source_gap_seconds("kudago"),
                              retry_statuses=SOURCE_RETRY_STATUSES) as http, \
                HttpClient(settings, delay=0.25) as side_http:
            tmdb = TmdbClient(side_http, settings.tmdb_api_key) if settings.tmdb_api_key else None
            kp = (KinopoiskClient(side_http, settings.kinopoisk_token, settings.output_dir,
                                  base=settings.kinopoisk_base, requests_per_day=settings.kinopoisk_requests_per_day)
                  if settings.kinopoisk_token else None)
            sources = cinema_cycle._cinema_sources(settings)
            reports = []
            if args.source in ("all", "kinopoisk") and "kinopoisk" in sources:
                kp_reports = await cinema_cycle.kinopoisk_cinema(
                    settings, now, tmdb=tmdb, catalog=catalog.movies if catalog else None, kinopoisk=kp,
                    force=args.force)
                reports += [r for r in kp_reports if not r.get("release_events")]
                cities_done = sum(1 for r in kp_reports if r.get("release_events"))
                if cities_done:
                    print(f"Кинопоиск: события «в кино» разложены по {cities_done} городам")
                    no_link = [r["city"] for r in kp_reports if r.get("release_events") and not r.get("kinopoisk_city")]
                    if no_link:
                        print("  Ссылка «билеты» без выбора города (нет номера города Кинопоиска): "
                              + ", ".join(no_link) + " — задайте AFISHA_KINOPOISK_CITY_IDS")
            if args.source in ("all", "kudago") and "kudago" in sources:
                adapter = KudaGoCinema(http, max_pages=settings.max_pages)
                for city in cities:
                    reports.append(await cinema_cycle.update_city(
                        settings, city, adapter, http, now, tmdb=tmdb, catalog=catalog.movies if catalog else None,
                        kinopoisk=kp, force=args.force))
            if kp is not None:
                kp.save()
            return reports

    try:
        with cycle_lock(settings.output_dir):
            reports = asyncio.run(run())
    except LockBusy as exc:
        print(f"Не запускаю: {exc}", file=sys.stderr)
        return 1
    for r in reports:
        state = "обновлено" if r.get("fresh") else ("не пора" if r.get("next_due") else "НЕ обновлено")
        print(f"{r['source']}/{r['city']}: фильмов {r.get('movies', 0)}, сеансов {r.get('showings', 0)}, "
              f"с трейлером {r.get('with_trailer', '—')}, {state} {'; '.join(r['errors'])}")
    return 0 if all(r.get("ok") for r in reports) else 1


def cmd_places(args, settings: Settings) -> int:
    from datetime import UTC, datetime

    from . import places_cycle
    from .cities import get_city
    from .http_client import SOURCE_RETRY_STATUSES
    from .sources.osm import OsmPlaces
    from .sources.places_kudago import KudaGoPlaces

    cities = [args.city] if args.city else settings.city_slugs()

    async def run() -> list[dict]:
        now = datetime.now(UTC).replace(microsecond=0)
        reports = []
        sources = places_cycle._sources(settings)
        async with HttpClient(settings, delay=settings.source_gap_seconds("kudago"),
                              retry_statuses=SOURCE_RETRY_STATUSES) as http:
            kudago = KudaGoPlaces(http, max_pages=settings.max_pages)
            for city in cities:
                found = get_city(city)
                if found and found.kudago and "kudago" in sources:
                    reports.append(await places_cycle.update_city(settings, "kudago", city, kudago, http, now,
                                                                  force=args.force))
        async with HttpClient(settings, delay=settings.source_gap_seconds("osm"), retry_statuses=SOURCE_RETRY_STATUSES,
                              timeout=settings.osm_timeout, accept="application/json, text/plain, */*") as http:
            osm = OsmPlaces(http, endpoint=settings.osm_endpoint, radius_km=settings.osm_radius_km,
                            amenities=[a.strip() for a in settings.osm_amenities.split(",") if a.strip()])
            for city in cities:
                if "osm" in sources and places_cycle.needs_osm(settings, city):
                    reports.append(await places_cycle.update_city(settings, "osm", city, osm, http, now,
                                                                  force=args.force))
        places_cycle.export_app(settings)
        return reports

    try:
        with cycle_lock(settings.output_dir):
            reports = asyncio.run(run())
    except LockBusy as exc:
        print(f"Не запускаю: {exc}", file=sys.stderr)
        return 1
    for r in reports:
        state = "обновлено" if r.get("fresh") else ("не пора" if r.get("next_due") else "НЕ обновлено")
        print(f"{r['source']}/{r['city']}: {r.get('count', 0)} заведений, {state} {'; '.join(r['errors'])}")
    return 0 if all(r.get("ok") for r in reports) else 1


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):  # кириллица в старой консоли Windows
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    logging.getLogger("httpx").setLevel(logging.INFO if args.verbose else logging.WARNING)
    settings = get_settings()

    if args.command == "daemon":
        try:
            asyncio.run(run_daemon(settings))
        except KeyboardInterrupt:
            pass
        return 0
    if args.command == "run":
        try:
            status = asyncio.run(run_cycle(settings))
        except LockBusy as exc:
            print(f"Не запускаю: {exc}", file=sys.stderr)
            return 1
        print(format_status(settings, status))
        return 0 if status["ok"] else 1
    if args.command == "status":
        status = read_status(settings.output_dir)
        print(format_status(settings, status))
        return 0 if is_healthy(settings, status) else 1
    if args.command == "resume":
        from .pauses import clear_pause
        removed = clear_pause(settings.output_dir, None if args.source == "all" else args.source)
        print(f"Пауза снята: {', '.join(removed)}. Служба возьмёт источник в следующем цикле "
              f"(когда — видно в: python -m afisha_parser status)" if removed else "Пауз нет")
        return 0
    if args.command == "cleanup":
        keep = settings.keep_days if args.keep_days is None else args.keep_days
        print(cleanup(settings.output_dir, keep_days=keep, raw_keep_days=min(keep, settings.raw_keep_days)))
        return 0

    if args.command == "fetch":
        try:
            with cycle_lock(settings.output_dir):
                path = asyncio.run(run_fetch(
                    settings, args.source, args.city,
                    days=args.days, limit=args.limit,
                    with_images=args.download_images, save_raw=not args.no_raw,
                    evently=args.evently, movies=args.movies,
                ))
        except LockBusy as exc:
            print(f"Не запускаю: {exc}. Остановите службу или дождитесь конца цикла "
                  f"(python -m afisha_parser status)", file=sys.stderr)
            return 1
        return 0 if path else 1
    if args.command == "cities":
        if args.source is None:
            show_registry()
        else:
            asyncio.run(show_cities(args.source))
        return 0
    if args.command == "movies":
        return cmd_movies(args, settings)
    if args.command == "now-playing":
        return cmd_now_playing(args, settings)
    if args.command == "trailers":
        return cmd_trailers(args, settings)
    if args.command == "evently":
        batch = _load_dump(args.path, "Сначала соберите данные: "
                                      "python -m afisha_parser fetch <источник> --city <город> --evently")
        if batch is None:
            return 1
        export_evently(batch if args.keep_past else _current(batch, settings), settings.output_dir)
        return 0
    if args.command == "images-report":
        print(build_images_report(settings.output_dir))
        return 0
    if args.command == "trailers-report":
        from .trailers import build_report
        print(build_report(settings.output_dir))
        return 0
    if args.command == "places":
        return cmd_places(args, settings)
    if args.command == "cinema":
        return cmd_cinema(args, settings)
    if args.command == "trailers-page":
        path = build_trailers_page(settings.output_dir)
        print(f"Готово: {path}\nОткрыть: python -m http.server --directory {path.parent} 8000 "
              f"→ http://<адрес сервера>:8000/trailers.html")
        return 0
    if args.command == "publish":
        if not args.path.is_file():
            print(f"Файл не найден: {args.path}", file=sys.stderr)
            return 1
        try:
            asyncio.run(publish_evently(args.path, settings))
        except PublishError as exc:
            print(f"Не отправлено: {exc}", file=sys.stderr)
            return 1
        return 0
    if args.command == "schema":
        export_schema(args.format, args.out)
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
