"""Автономный режим: один полный цикл (команда run) и бесконечный цикл по расписанию (daemon).

Цикл для каждой пары источник:город из AFISHA_TARGETS:
  1. собрать события, отбросить прошедшие, сохранить универсальный дамп (+ картинки);
  2. если источник недоступен — взять последний сохранённый дамп и отфильтровать его заново,
     чтобы прошедшие события всё равно ушли из файла Evently;
  3. файл Evently (+ отправка в бэкенд, если задан AFISHA_EVENTLY_IMPORT_URL);
  4. трейлеры к кинопоказам источника (TMDb).
Затем один раз: афиша проката TMDb, скачивание трейлеров (если включено), уборка старых файлов,
output/status.json с итогами — по нему видно, жив ли парсер (команда status).

Ошибка на любом шаге записывается в status.json и не прерывает остальные шаги и города.

Бережный режим: у каждого источника один HTTP-клиент на все города с паузой
3600 / AFISHA_REQUESTS_PER_HOUR секунд между запросами. Источники идут параллельно (у каждого
свой счёт), города одного источника — по очереди. Отказ 401/403/429 ставит источник на паузу
(pauses.py), и остальные его города в этом цикле уже не запрашиваются.
"""

import asyncio
import json
import logging
import signal
import time
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

from . import __version__
from .config import Settings
from .enrichers.tmdb_catalog import export_catalog, fetch_catalog
from .enrichers.tmdb_catalog import CatalogMovie, load_catalog
from .enrichers.kinopoisk import KinopoiskClient
from .enrichers.tmdb_trailers import TmdbClient, enrich_batch, export_movies
from .http_client import HttpClient
from .export import load_batch, write_json_atomic
from .exporters.evently import export_evently
from .models import EventBatch
from .pauses import active_pause, load_pauses, refusal_status, set_pause
from .pipeline import fetch_and_save, source_client
from . import cinema_cycle, places_cycle
from .preview import build_trailers_page
from .publisher import publish_evently
from .retention import cleanup
from .sources import ADAPTERS
from .sources.base import SourceConfigError
from .timefilter import filter_batch, grace_from_minutes
from .trailers import download_trailers

log = logging.getLogger(__name__)

STATUS_NAME = "status.json"


class LockBusy(RuntimeError):
    pass


@contextmanager
def cycle_lock(output_dir: Path) -> Iterator[None]:
    """Не даёт двум циклам (демон + ручной run) писать в одни и те же файлы одновременно."""
    output_dir.mkdir(parents=True, exist_ok=True)
    handle = (output_dir / ".lock").open("w")
    try:
        try:
            import fcntl
        except ImportError:  # Windows: блокировки нет, запускайте что-то одно
            fcntl = None
        if fcntl is not None:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise LockBusy("другой цикл сбора уже идёт (скорее всего, работает фоновая служба)") from None
        yield
    finally:
        handle.close()


def _now() -> datetime:
    return datetime.now(UTC).replace(microsecond=0)


def _error(exc: BaseException) -> str:
    text = str(exc).strip().splitlines()
    return f"{type(exc).__name__}: {text[0] if text else ''}".strip(": ")


async def _process_target(
    settings: Settings, source: str, city: str, now: datetime,
    tmdb: TmdbClient | None = None, catalog: list[CatalogMovie] | None = None,
    http: HttpClient | None = None, kinopoisk: KinopoiskClient | None = None,
) -> dict[str, Any]:
    report: dict[str, Any] = {"source": source, "city": city, "ok": False, "errors": []}
    batch: EventBatch | None = None

    if source not in ADAPTERS:
        report["errors"].append(f"неизвестный источник {source!r}, есть: {', '.join(sorted(ADAPTERS))}")
        return report

    result = None
    requests_before = http.requests if http else 0
    if pause := active_pause(settings, source, now):
        report["paused_until"] = pause["until"]
        report["errors"].append(f"сбор: {source} на паузе до {pause['until']} после отказа ({pause.get('reason')}). "
                                f"Снять: python -m afisha_parser resume {source}")
        log.warning("%s/%s: источник на паузе до %s, не запрашиваю", source, city, pause["until"])
    else:
        try:
            result = await fetch_and_save(
                settings, source, city, http=http,
                days=settings.days, with_images=settings.download_images, save_raw=settings.save_raw,
            )
        except (httpx.HTTPError, SourceConfigError) as exc:  # сеть, источник лежит, нет токена — без трейсбека
            log.error("%s/%s: источник недоступен: %s", source, city, _error(exc))
            report["errors"].append(f"сбор: {_error(exc)}")
            if (code := refusal_status(exc)) is not None:
                entry = set_pause(settings, source, f"HTTP {code}", _now())
                report["paused_until"] = entry["until"]
                log.error("%s ответил %d — ставлю источник на паузу до %s (все города)", source, code, entry["until"])
        except Exception as exc:
            log.exception("%s/%s: сбор упал", source, city)
            report["errors"].append(f"сбор: {_error(exc)}")
    if http is not None:
        report["requests"] = http.requests - requests_before

    if result is not None:
        batch = result.batch
        report.update(fresh=True, events=len(batch.events), dropped_past=result.dropped_events)
    else:
        latest = settings.output_dir / "events" / source / city / "latest.json"
        if not report["errors"]:
            report["errors"].append("источник вернул 0 событий")
        if latest.is_file():
            try:
                batch = load_batch(latest)
            except Exception as exc:
                report["errors"].append(f"старый дамп не читается: {_error(exc)}")
        if batch is not None:
            batch, filtered = filter_batch(batch, now, grace_from_minutes(settings.past_grace_minutes))
            log.warning("%s/%s: использую прошлый дамп от %s, после фильтра событий %d (отброшено прошедших %d)",
                        source, city, batch.fetched_at, len(batch.events), filtered.dropped_events)
            report.update(fresh=False, events=len(batch.events), dropped_past=filtered.dropped_events,
                          data_from=batch.fetched_at.isoformat())

    if batch is None:
        return report

    if settings.evently:
        try:
            evently_path = export_evently(batch, settings.output_dir)
            report["evently_file"] = str(evently_path)
            if settings.evently_import_url:
                report["published"] = await publish_evently(evently_path, settings)
        except Exception as exc:
            log.exception("%s/%s: Evently", source, city)
            report["errors"].append(f"evently: {_error(exc)}")

    if settings.movies and settings.tmdb_api_key:
        try:
            movie_batch = await enrich_batch(batch, settings, tmdb=tmdb, catalog=catalog, kinopoisk=kinopoisk)
            if movie_batch is not None:
                if settings.trailers_download:
                    await download_trailers([m.trailer for m in movie_batch.movies], settings.output_dir, settings)
                export_movies(movie_batch, settings.output_dir)
                report["movies"] = movie_batch.matched
                report["movies_with_trailer"] = sum(1 for m in movie_batch.movies if m.trailer)
        except Exception as exc:
            log.exception("%s/%s: трейлеры TMDb", source, city)
            report["errors"].append(f"tmdb: {_error(exc)}")

    report["ok"] = bool(report.get("fresh")) and not report["errors"]
    return report


async def _fill_catalog_trailers(catalog_movies: list[CatalogMovie], kinopoisk: KinopoiskClient | None) -> int:
    """Фильмам проката без ролика у TMDb — ролик с Кинопоиска."""
    if kinopoisk is None:
        return 0
    from .enrichers.kinopoisk import BudgetExhausted
    added = 0
    for movie in catalog_movies:
        if movie.trailer is not None:
            continue
        year = int(movie.release_date[:4]) if movie.release_date and movie.release_date[:4].isdigit() else None
        try:
            trailer = await kinopoisk.trailer(movie.title, year, alt_titles=(movie.original_title or "",))
        except BudgetExhausted as exc:
            log.info("Кинопоиск: %s", exc)
            break
        except httpx.HTTPError as exc:
            log.warning("Кинопоиск: %s: %s", movie.title, exc)
            continue
        if trailer is not None:
            movie.trailer = trailer
            added += 1
    return added


async def _process_catalog(
    settings: Settings, kinopoisk: KinopoiskClient | None = None,
) -> tuple[dict[str, Any], list[CatalogMovie] | None]:
    """Прокат обновляется первым: по нему потом сверяются кинопоказы городов."""
    report: dict[str, Any] = {"region": settings.tmdb_region.upper(), "ok": False, "errors": []}
    catalog = None
    try:
        catalog = await fetch_catalog(settings)
        if catalog is None:
            report["errors"].append("TMDb не вернул фильмов")
            return report, _previous_catalog(settings)
        if added := await _fill_catalog_trailers(catalog.movies, kinopoisk):
            catalog.with_trailer = sum(1 for m in catalog.movies if m.trailer)
            report["kinopoisk_trailers"] = added
        if settings.trailers_download:
            await download_trailers([m.trailer for m in catalog.movies], settings.output_dir, settings)
            report["trailer_files"] = sum(1 for m in catalog.movies if m.trailer and m.trailer.local_path)
        export_catalog(catalog, settings.output_dir)
        report.update(ok=True, movies=catalog.count, with_trailer=catalog.with_trailer)
        return report, catalog.movies
    except httpx.HTTPError as exc:
        log.error("TMDb недоступен: %s", _error(exc))
        report["errors"].append(_error(exc))
    except Exception as exc:
        log.exception("TMDb: афиша проката")
        report["errors"].append(_error(exc))
    return report, _previous_catalog(settings)


def _previous_catalog(settings: Settings) -> list[CatalogMovie] | None:
    previous = load_catalog(settings.output_dir, settings.tmdb_region)
    return previous.movies if previous else None


async def run_cycle(settings: Settings) -> dict[str, Any]:
    """Один полный цикл. Бросает LockBusy, если другой цикл уже идёт."""
    with cycle_lock(settings.output_dir):
        started = _now()
        status: dict[str, Any] = {"version": __version__, "started_at": started.isoformat(), "targets": []}
        try:
            pairs = settings.target_pairs()
        except ValueError as exc:
            pairs = []
            status["config_error"] = str(exc)
            log.error("%s", exc)
        log.info("=== Цикл сбора: %d источник·город: %s ===", len(pairs), ", ".join(f"{s}:{c}" for s, c in pairs))

        kinopoisk: KinopoiskClient | None = None
        if settings.kinopoisk_token and (settings.movies or settings.cinema):
            kinopoisk = KinopoiskClient(HttpClient(settings, delay=1.0), settings.kinopoisk_token,
                                        settings.output_dir, base=settings.kinopoisk_base,
                                        requests_per_day=settings.kinopoisk_requests_per_day)

        catalog: list[CatalogMovie] | None = None
        if settings.tmdb_api_key:
            if settings.now_playing:
                status["catalog"], catalog = await _process_catalog(settings, kinopoisk)
            else:
                catalog = _previous_catalog(settings)

        by_source: dict[str, list[str]] = {}
        for source, city in pairs:
            by_source.setdefault(source, []).append(city)
        results: dict[tuple[str, str], dict[str, Any]] = {}
        place_reports: list[dict[str, Any]] = []
        cinema_reports: list[dict[str, Any]] = []
        if (settings.places and "kudago" in places_cycle._sources(settings)) or settings.cinema:
            by_source.setdefault("kudago", [])  # заведения KudaGo — тем же клиентом, что и события

        async with HttpClient(settings) as tmdb_http:
            tmdb = TmdbClient(tmdb_http, settings.tmdb_api_key) if settings.tmdb_api_key else None

            async def run_source(source: str, cities: list[str]) -> None:
                async with source_client(settings, source) as http:
                    for city in cities:
                        results[(source, city)] = await _process_target(
                            settings, source, city, started, tmdb, catalog, http=http, kinopoisk=kinopoisk,
                        )
                    if source == "kudago" and settings.cinema:
                        try:
                            cinema_reports.extend(await cinema_cycle.kudago_cinema(
                                settings, http, started, tmdb=tmdb, catalog=catalog, kinopoisk=kinopoisk))
                        except Exception as exc:
                            log.exception("Кино KudaGo")
                            cinema_reports.append({"source": "kudago", "city": "*", "ok": False,
                                                   "errors": [_error(exc)]})
                    if source == "kudago" and settings.places:
                        try:
                            place_reports.extend(await places_cycle.kudago_places(settings, http, started))
                        except Exception as exc:
                            log.exception("Заведения KudaGo")
                            place_reports.append({"source": "kudago", "city": "*", "ok": False,
                                                  "errors": [_error(exc)]})

            # Кинопоиск первым: два запроса — и новые фильмы в ленте через минуты, а не после всего цикла.
            # Фильмы с точными сеансами KudaGo сверяются по его прошлому файлу
            if settings.cinema:
                try:
                    cinema_reports.extend(await cinema_cycle.kinopoisk_cinema(
                        settings, started, tmdb=tmdb, catalog=catalog, kinopoisk=kinopoisk))
                except Exception as exc:
                    log.exception("Кино Кинопоиск")
                    cinema_reports.append({"source": "kinopoisk", "city": "*", "ok": False,
                                           "errors": [_error(exc)]})
            await asyncio.gather(*(run_source(s, c) for s, c in by_source.items()))
        status["targets"] = [results[pair] for pair in pairs if pair in results]
        if settings.places:
            try:
                place_reports.extend(await places_cycle.osm_places(settings, started))
            except Exception as exc:
                log.exception("Заведения OSM")
                place_reports.append({"source": "osm", "city": "*", "ok": False, "errors": [_error(exc)]})
            try:
                places_cycle.export_app(settings)
            except Exception as exc:
                log.exception("Файлы заведений для приложения")
                place_reports.append({"source": "app", "city": "*", "ok": False, "errors": [_error(exc)]})
            status["places"] = place_reports
        if settings.cinema:
            status["cinema"] = cinema_reports
            # Бэкенд Evently скрывает пропавшие события, только если цель в targets свежая и ok
            for c in cinema_reports:
                if c.get("city") not in ("*", "ru") and (c.get("fresh") or c.get("next_due")):
                    status["targets"].append({
                        "source": c["source"] + "-cinema", "city": c["city"], "ok": bool(c.get("ok")),
                        "fresh": True, "events": c.get("movies", 0), "dropped_past": 0, "errors": [],
                        "data_from": c.get("data_from"),
                    })
        requests: dict[str, int] = {}
        for report in [*results.values(), *place_reports, *cinema_reports]:
            if report.get("requests"):
                requests[report["source"]] = requests.get(report["source"], 0) + report["requests"]
        status["requests"] = requests

        if kinopoisk is not None:
            kinopoisk.save()
            with suppress(Exception):
                await kinopoisk.http.__aexit__(None, None, None)
            status["kinopoisk"] = {"used_today": kinopoisk.used_today, "limit": settings.kinopoisk_requests_per_day,
                                   "error": kinopoisk.disabled_reason}

        try:
            build_trailers_page(settings.output_dir)
        except Exception:
            log.exception("Страница трейлеров не собрана")

        try:
            status["cleanup"] = str(cleanup(
                settings.output_dir, keep_days=settings.keep_days, raw_keep_days=settings.raw_keep_days,
            ))
        except Exception as exc:
            log.exception("Уборка упала")
            status["cleanup"] = f"ошибка: {_error(exc)}"

        finished = _now()
        status["finished_at"] = finished.isoformat()
        status["duration_sec"] = int((finished - started).total_seconds())
        status["ok"] = bool(pairs) and all(t["ok"] for t in status["targets"]) and not status.get("config_error")
        write_status(settings.output_dir, status)
        log.info("=== Цикл завершён за %d с: %s ===", status["duration_sec"], "успешно" if status["ok"] else "с ошибками")
        return status


# ---------- status.json ----------

def read_status(output_dir: Path) -> dict[str, Any] | None:
    try:
        data = json.loads((output_dir / STATUS_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def write_status(output_dir: Path, status: dict[str, Any]) -> None:
    write_json_atomic(output_dir / STATUS_NAME, status)


def next_run_at(settings: Settings, status: dict[str, Any] | None) -> datetime:
    """Когда пора запускаться: после успешного цикла — через interval, после неудачного — через retry."""
    if not status or not status.get("finished_at"):
        return _now()
    try:
        finished = datetime.fromisoformat(status["finished_at"])
    except (TypeError, ValueError):
        return _now()
    # Быстрый повтор — только если цикл не дал ничего (нет сети, упал целиком). Если источник
    # отказал (пауза) или часть городов собралась — ждём обычный интервал, лишний раз не стучимся
    targets = status.get("targets") or []
    nothing = not any(t.get("fresh") for t in targets) and not any(t.get("paused_until") for t in targets)
    quick = not status.get("ok") and nothing
    minutes = min(settings.retry_minutes, settings.interval_minutes) if quick else settings.interval_minutes
    return finished + timedelta(minutes=max(1, minutes))


def is_healthy(settings: Settings, status: dict[str, Any] | None, now: datetime | None = None) -> bool:
    """Последний цикл успешный и не старше двух интервалов (служба не зависла и не умерла)."""
    if not status or not status.get("ok") or not status.get("finished_at"):
        return False
    try:
        finished = datetime.fromisoformat(status["finished_at"])
    except (TypeError, ValueError):
        return False
    # Бережный цикл может идти часами: даём запас на два интервала и две длительности цикла
    duration = status.get("duration_sec") if isinstance(status.get("duration_sec"), int) else 0
    allowed = timedelta(minutes=2 * settings.interval_minutes + 30) + timedelta(seconds=2 * duration)
    return (now or _now()) - finished <= allowed


def format_status(settings: Settings, status: dict[str, Any] | None) -> str:
    if status is None:
        return f"Циклов ещё не было ({settings.output_dir / STATUS_NAME} нет)"
    lines = [
        f"Последний цикл: {status.get('started_at')} → {status.get('finished_at')} "
        f"({status.get('duration_sec')} с), {'успешно' if status.get('ok') else 'С ОШИБКАМИ'}",
    ]
    for t in status.get("targets", []):
        if t.get("fresh"):
            state = "свежие данные"
        elif t.get("data_from"):
            state = f"старые данные от {t['data_from']}"
        else:
            state = "данных нет"
        lines.append(f"  {t['source']}/{t['city']}: событий {t.get('events', 0)}, "
                     f"отброшено прошедших {t.get('dropped_past', 0)}, {state}, трейлеров {t.get('movies', 0)}, "
                     f"запросов {t.get('requests', 0)}")
        lines += [f"    ошибка: {e}" for e in t.get("errors", [])]
    if cat := status.get("catalog"):
        lines.append(f"  прокат TMDb {cat.get('region')}: фильмов {cat.get('movies', 0)}, "
                     f"с трейлером {cat.get('with_trailer', 0)}")
        lines += [f"    ошибка: {e}" for e in cat.get("errors", [])]
    for c in status.get("cinema") or []:
        if c.get("release_events"):
            continue  # по городам — то же, что в строке «кино kinopoisk/ru»
        state = "обновлено" if c.get("fresh") else (
            f"следующее обновление {c['next_due'][:16]}" if c.get("next_due") else "не обновлено")
        lines.append(f"  кино {c.get('source')}/{c.get('city')}: фильмов {c.get('movies', 0)}, "
                     f"сеансов {c.get('showings', 0)}, с трейлером {c.get('with_trailer', '—')}, {state}")
        lines += [f"    ошибка: {e}" for e in c.get("errors", [])]
    for p in status.get("places") or []:
        if p.get("fresh"):
            state = "обновлено"
        elif p.get("next_due"):
            state = f"следующее обновление {p['next_due'][:10]}"
        else:
            state = "не обновлено"
        lines.append(f"  заведения {p.get('source')}/{p.get('city')}: {p.get('count', 0)}, {state}")
        lines += [f"    ошибка: {e}" for e in p.get("errors", [])]
    if requests := status.get("requests"):
        lines.append("  запросов к источникам за цикл: " + ", ".join(
            f"{s} {n} (раз в {settings.source_gap_seconds(s):.0f} с)" for s, n in requests.items()))
    pauses = load_pauses(settings.output_dir)
    for source, entry in pauses.items():
        if active_pause(settings, source, _now()):
            lines.append(f"  ПАУЗА {source} до {entry.get('until')} ({entry.get('reason')}); "
                         f"снять: python -m afisha_parser resume {source}")
    if status.get("cleanup"):
        lines.append(f"  уборка: {status['cleanup']}")
    if status.get("config_error"):
        lines.append(f"  ошибка настроек: {status['config_error']}")
    if status.get("error"):
        lines.append(f"  ошибка: {status['error']}")
    if status.get("next_run_at"):
        lines.append(f"Следующий цикл: {status['next_run_at']}")
    return "\n".join(lines)


# ---------- daemon ----------

async def _sleep_or_stop(stop: asyncio.Event, seconds: float) -> None:
    with suppress(TimeoutError):
        await asyncio.wait_for(stop.wait(), timeout=max(0.0, seconds))


async def run_daemon(settings: Settings, *, max_cycles: int | None = None) -> None:
    """Бесконечный цикл. Останавливается по SIGTERM/SIGINT (systemctl stop, Ctrl+C)."""
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        with suppress(NotImplementedError, RuntimeError):  # Windows
            loop.add_signal_handler(sig, stop.set)

    log.info("Фоновый режим: %s, каждые %d мин, горизонт %d дн., данные в %s",
             settings.cities or settings.targets, settings.interval_minutes, settings.days, settings.output_dir.resolve())
    cycles = 0
    while not stop.is_set():
        due = next_run_at(settings, read_status(settings.output_dir))
        wait = (due - _now()).total_seconds()
        if wait > 0:
            log.info("Следующий цикл в %s (через %d мин)", due.isoformat(), wait // 60)
            await _sleep_or_stop(stop, wait)
            if stop.is_set():
                break

        started = time.monotonic()
        cycle = asyncio.create_task(run_cycle(settings))
        stopper = asyncio.create_task(stop.wait())
        done, _ = await asyncio.wait({cycle, stopper}, return_when=asyncio.FIRST_COMPLETED)
        stopper.cancel()
        if cycle not in done:
            log.info("Получен сигнал остановки, прерываю цикл (все файлы пишутся атомарно, ничего не испортится)")
            cycle.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await cycle
            break
        try:
            cycle.result()
        except LockBusy as exc:
            log.warning("%s — жду минуту", exc)
            await _sleep_or_stop(stop, 60)
            continue
        except Exception:
            log.exception("Цикл упал целиком")
            write_status(settings.output_dir, {
                "version": __version__, "ok": False, "targets": [],
                "finished_at": _now().isoformat(), "duration_sec": int(time.monotonic() - started),
                "error": "цикл упал целиком, подробности в журнале",
            })

        status = read_status(settings.output_dir) or {}
        status["next_run_at"] = next_run_at(settings, status).isoformat()
        write_status(settings.output_dir, status)
        cycles += 1
        if max_cycles is not None and cycles >= max_cycles:
            break
    log.info("Фоновый режим остановлен")
