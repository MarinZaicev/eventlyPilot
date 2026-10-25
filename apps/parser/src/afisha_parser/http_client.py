"""Общий HTTP-клиент: паузы между запросами, повторы при сбоях, честный User-Agent."""

import asyncio
import logging
import time
from types import TracebackType

import httpx

from .config import Settings

log = logging.getLogger(__name__)

RETRY_STATUSES = {429, 500, 502, 503, 504}
# Для API источников 429 («слишком часто») не повторяем: это сигнал остановиться, а не долбить дальше
SOURCE_RETRY_STATUSES = {500, 502, 503, 504}


class HttpClient:
    def __init__(
        self,
        settings: Settings,
        *,
        delay: float | None = None,
        accept: str = "application/json",
        transport: httpx.AsyncBaseTransport | None = None,
        retry_statuses: set[int] | None = None,
        timeout: float | None = None,
    ) -> None:
        self._client = httpx.AsyncClient(
            timeout=settings.request_timeout if timeout is None else timeout,
            headers={"User-Agent": settings.user_agent, "Accept": accept},
            follow_redirects=True,
            transport=transport,
        )
        self._delay = settings.request_delay if delay is None else delay
        self._max_retries = max(1, settings.max_retries)
        self._last_request = 0.0
        self._lock = asyncio.Lock()
        self._retry_statuses = RETRY_STATUSES if retry_statuses is None else retry_statuses
        self.requests = 0  # сколько запросов реально ушло (с повторами) — видно в status

    async def __aenter__(self) -> "HttpClient":
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self._client.aclose()

    async def _throttle(self) -> None:
        async with self._lock:
            wait = self._last_request + self._delay - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_request = time.monotonic()

    async def get(self, url: str, *, params: dict | None = None, headers: dict | None = None) -> httpx.Response:
        for attempt in range(1, self._max_retries + 1):
            await self._throttle()
            response: httpx.Response | None = None
            self.requests += 1
            try:
                response = await self._client.get(url, params=params, headers=headers)
            except httpx.TransportError as exc:
                if attempt == self._max_retries:
                    raise
                log.warning("Сетевая ошибка %s (попытка %d/%d): %s", url, attempt, self._max_retries, exc)
            else:
                if response.status_code not in self._retry_statuses or attempt == self._max_retries:
                    response.raise_for_status()
                    return response
                log.warning(
                    "HTTP %d от %s (попытка %d/%d)", response.status_code, url, attempt, self._max_retries
                )
            await asyncio.sleep(self._backoff(attempt, response))
        raise RuntimeError("недостижимо: цикл всегда возвращает ответ или бросает исключение")

    @staticmethod
    def _backoff(attempt: int, response: httpx.Response | None) -> float:
        if response is not None:
            retry_after = response.headers.get("Retry-After", "")
            if retry_after.isdigit():
                return min(float(retry_after), 60.0)
        return min(2.0 ** attempt, 30.0)
