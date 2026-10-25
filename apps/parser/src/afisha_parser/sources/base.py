from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar

from ..export import write_json_atomic
from ..http_client import HttpClient
from ..models import Event

if TYPE_CHECKING:
    from ..config import Settings


class SourceConfigError(RuntimeError):
    """Источник нельзя опросить из-за настроек (нет токена, нет такого города). Трейсбек не нужен."""


class SourceAccessError(SourceConfigError):
    """Источник отказал в доступе (401/403/429). Дальше его не опрашиваем — см. pauses.py."""

    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.status = status


REFUSAL_STATUSES = {401, 403, 429}


def response_detail(response) -> str:
    """Короткое пояснение из тела отказа (Timepad пишет его в response_status.message)."""
    try:
        data = response.json()
    except Exception:
        return ""
    if isinstance(data, dict):
        status = data.get("response_status")
        message = status.get("message") if isinstance(status, dict) else data.get("detail") or data.get("message")
        if isinstance(message, str):
            return message.strip()[:200]
    return ""


class SourceAdapter(ABC):
    """Адаптер знает ровно одно: как превратить ответ своего источника в Event."""

    name: ClassVar[str]
    default_max_pages: ClassVar[int] = 20

    @property
    def max_pages(self) -> int:
        return max(1, self.settings.max_pages) if self.settings else self.default_max_pages

    def __init__(self, http: HttpClient, *, raw_dir: Path | None = None, settings: "Settings | None" = None) -> None:
        self.http = http
        self.raw_dir = raw_dir
        self.settings = settings  # для токенов и прочих настроек конкретного источника

    @abstractmethod
    def fetch_events(self, city: str, *, days: int = 30, limit: int | None = None) -> AsyncIterator[Event]:
        """Асинхронно отдаёт события города на ближайшие `days` дней."""

    async def list_cities(self) -> list[tuple[str, str]]:
        """Пары (slug, название) городов, которые поддерживает источник."""
        raise NotImplementedError(f"{self.name} не умеет отдавать список городов")

    def save_raw(self, name: str, data: Any) -> None:
        """Сохраняем сырой ответ: можно перепарсить без повторного скачивания."""
        if self.raw_dir is not None:
            write_json_atomic(self.raw_dir / f"{name}.json", data)
