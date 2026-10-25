"""Пауза источника после отказа.

Если источник ответил 401/403/429, он не хочет нас видеть: продолжать опрашивать остальные
города и повторять каждый цикл — верный путь к долгому бану. Поэтому источник целиком
ставится на паузу на AFISHA_BLOCK_PAUSE_HOURS, а цикл работает на последних данных.

Паузы лежат в output/source_pause.json. Снять раньше срока:
    python -m afisha_parser resume timepad
Пауза Timepad снимается сама, если в .env вписали другой токен.
"""

import hashlib
import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

from .config import Settings
from .export import write_json_atomic
from .sources.base import REFUSAL_STATUSES, SourceAccessError

PAUSE_NAME = "source_pause.json"


def refusal_status(exc: BaseException | None) -> int | None:
    """Код отказа (401/403/429), если ошибка — это отказ источника, иначе None."""
    seen = 0
    while exc is not None and seen < 5:
        if isinstance(exc, SourceAccessError) and exc.status in REFUSAL_STATUSES:
            return exc.status
        if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code in REFUSAL_STATUSES:
            return exc.response.status_code
        exc = exc.__cause__
        seen += 1
    return None


def _credentials_key(settings: Settings, source: str) -> str:
    """Отпечаток того, с чем нас не пустили: сменили токен — пауза больше не действует."""
    secret = settings.timepad_token if source == "timepad" else None
    return hashlib.sha256(secret.encode()).hexdigest()[:12] if secret else ""


def load_pauses(output_dir: Path) -> dict[str, dict[str, Any]]:
    try:
        data = json.loads((output_dir / PAUSE_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {k: v for k, v in data.items() if isinstance(v, dict)} if isinstance(data, dict) else {}


def active_pause(settings: Settings, source: str, now: datetime) -> dict[str, Any] | None:
    entry = load_pauses(settings.output_dir).get(source)
    if not entry or entry.get("key", "") != _credentials_key(settings, source):
        return None
    try:
        until = datetime.fromisoformat(entry["until"])
    except (KeyError, TypeError, ValueError):
        return None
    return entry if until > now else None


def set_pause(settings: Settings, source: str, reason: str, now: datetime) -> dict[str, Any]:
    pauses = load_pauses(settings.output_dir)
    entry = {
        "until": (now + timedelta(hours=max(0.0, settings.block_pause_hours))).isoformat(),
        "since": now.isoformat(),
        "reason": reason,
        "key": _credentials_key(settings, source),
    }
    pauses[source] = entry
    write_json_atomic(settings.output_dir / PAUSE_NAME, pauses)
    return entry


def clear_pause(output_dir: Path, source: str | None = None) -> list[str]:
    """Снять паузу с источника (или со всех). Возвращает, с каких сняли."""
    pauses = load_pauses(output_dir)
    removed = [s for s in pauses if source in (None, s)]
    for s in removed:
        pauses.pop(s)
    if removed:
        write_json_atomic(output_dir / PAUSE_NAME, pauses)
    return removed
