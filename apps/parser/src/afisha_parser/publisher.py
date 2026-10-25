"""Отправка файла Evently в бэкенд: POST {"events": [...]} на AFISHA_EVENTLY_IMPORT_URL.

По умолчанию выключено — парсер только пишет файлы, а бэкенд забирает их сам.
Если адрес задан, в фоновом режиме после каждого цикла события уходят в бэкенд
пачками по AFISHA_EVENTLY_IMPORT_CHUNK. Токен (если задан) передаётся заголовком
Authorization: Bearer <токен>. Формат пачки согласовать с тем, кто пишет бэкенд.
"""

import asyncio
import json
import logging
from pathlib import Path

import httpx

from .config import Settings

log = logging.getLogger(__name__)

RETRIES = 3


class PublishError(RuntimeError):
    pass


async def publish_evently(path: Path, settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None) -> int:
    """Возвращает число отправленных событий. Бросает PublishError, если бэкенд не принял."""
    url = settings.evently_import_url
    if not url:
        raise PublishError("AFISHA_EVENTLY_IMPORT_URL не задан")
    events = json.loads(path.read_text(encoding="utf-8")).get("events") or []
    headers = {"User-Agent": settings.user_agent, "Content-Type": "application/json"}
    if settings.evently_import_token:
        headers["Authorization"] = f"Bearer {settings.evently_import_token}"
    chunk = max(1, settings.evently_import_chunk)

    sent = 0
    async with httpx.AsyncClient(timeout=max(settings.request_timeout, 60), headers=headers, transport=transport) as client:
        for start in range(0, len(events), chunk):
            part = events[start : start + chunk]
            for attempt in range(1, RETRIES + 1):
                try:
                    response = await client.post(url, content=json.dumps({"events": part}, ensure_ascii=False).encode())
                except httpx.TransportError as exc:
                    error = f"сеть: {exc}"
                else:
                    if response.status_code < 300:
                        break
                    error = f"HTTP {response.status_code}: {response.text[:300]}"
                    if response.status_code < 500 and response.status_code != 429:
                        raise PublishError(f"бэкенд отклонил пачку {start}–{start + len(part)}: {error}")
                if attempt == RETRIES:
                    raise PublishError(f"бэкенд недоступен после {RETRIES} попыток: {error}")
                await asyncio.sleep(2 ** attempt)
            sent += len(part)
    log.info("Evently: отправлено событий %d → %s", sent, url)
    return sent
