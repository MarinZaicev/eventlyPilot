"""Отчёт по картинкам: где они теряются и откуда берутся одинаковые.

    python -m afisha_parser images-report

По каждому источнику и городу из events/*/latest.json:
  * сколько событий, у скольких есть картинка, у скольких она скачана и файл на месте;
  * картинки, которые стоят у нескольких событий (одинаковая ссылка);
  * файлы, в которые попало несколько разных ссылок (одинаковое содержимое).
Для Timepad дополнительно по сырым ответам (raw/, хранятся 2 дня): сколько событий пришло
вообще без постера, а сколько — с постером организатора вместо своего.
"""

import json
from collections import Counter, defaultdict
from pathlib import Path


def _load(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _raw_timepad(output_dir: Path, city: str) -> str | None:
    runs = sorted((output_dir / "raw" / "timepad" / city).glob("*/"))
    if not runs:
        return None
    total = no_poster = org_poster = 0
    for page in runs[-1].glob("events-page-*.json"):
        data = _load(page) or {}
        for item in data.get("values") or []:
            total += 1
            poster = item.get("poster_image") or {}
            urls = " ".join(str(poster.get(k) or "") for k in ("default_url", "uploadcare_url"))
            if not urls.strip():
                no_poster += 1
            elif "poster_org_" in urls:
                org_poster += 1
    if not total:
        return None
    return (f"    сырой ответ Timepad ({runs[-1].name}): записей {total}, без постера {no_poster}, "
            f"с постером организатора {org_poster}")


def build_report(output_dir: Path) -> str:
    lines: list[str] = []
    index = _load(output_dir / "images" / "index.json") or {}
    missing_in_index = sum(1 for rel in index.values() if not (output_dir / str(rel)).is_file())
    lines.append(f"images/index.json: ссылок {len(index)}, из них на отсутствующий файл {missing_in_index}")

    totals = Counter()
    for latest in sorted((output_dir / "events").glob("*/*/latest.json")):
        source, city = latest.parent.parent.name, latest.parent.name
        data = _load(latest)
        if data is None:
            lines.append(f"{source}/{city}: latest.json не читается")
            continue
        events = data.get("events") or []
        with_image = with_local = file_ok = 0
        url_events: dict[str, set] = defaultdict(set)
        path_urls: dict[str, set] = defaultdict(set)
        for event in events:
            images = event.get("images") or []
            if images:
                with_image += 1
            first = images[0] if images else {}
            if first.get("local_path"):
                with_local += 1
                if (output_dir / first["local_path"]).is_file():
                    file_ok += 1
            for image in images:
                if image.get("url"):
                    url_events[image["url"]].add(event.get("source_id"))
                    if image.get("local_path"):
                        path_urls[image["local_path"]].add(image["url"])
        n = len(events)
        pct = f"{100 * with_image // n}%" if n else "—"
        lines.append(f"{source}/{city}: событий {n}, с картинкой {with_image} ({pct}), "
                     f"скачано {with_local}, файл на месте {file_ok}")
        shared_urls = sorted(((len(ids), url) for url, ids in url_events.items() if len(ids) > 1), reverse=True)
        if shared_urls:
            top = ", ".join(f"×{count} {url[-60:]}" for count, url in shared_urls[:3])
            lines.append(f"    одна ссылка у нескольких событий: {len(shared_urls)} шт. Чаще всего: {top}")
        shared_files = sorted(((len(urls), p) for p, urls in path_urls.items() if len(urls) > 1), reverse=True)
        if shared_files:
            top = ", ".join(f"×{count} {p}" for count, p in shared_files[:3])
            lines.append(f"    один файл у разных ссылок (одинаковое содержимое): {len(shared_files)} шт. {top}")
        if source == "timepad" and (raw := _raw_timepad(output_dir, city)):
            lines.append(raw)
        totals["events"] += n
        totals["with_image"] += with_image
    if totals["events"]:
        lines.append(f"ИТОГО: событий {totals['events']}, с картинкой {totals['with_image']} "
                     f"({100 * totals['with_image'] // totals['events']}%)")
    return "\n".join(lines)
