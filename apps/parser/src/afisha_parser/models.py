"""Контракт данных: формат JSON, который парсер отдаёт дальше (в БД, в API).

Любое несовместимое изменение здесь = повышение SCHEMA_VERSION
и предупреждение тому, кто читает эти файлы.
"""

import hashlib
import json
from datetime import datetime

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

# 1.1: добавлено необязательное поле Event.ticket_url (обратно совместимо)
SCHEMA_VERSION = "1.1"


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Session(_Model):
    """Один показ/сеанс. У фильма или спектакля их может быть много."""

    starts_at: AwareDatetime | None = Field(
        None, description="Начало, ISO 8601 со смещением часового пояса города. null — не указано"
    )
    ends_at: AwareDatetime | None = Field(
        None, description="Окончание. null — не указано или событие бессрочное"
    )


class Price(_Model):
    text: str | None = Field(None, description="Цена так, как написано у источника")
    min: int | None = None
    max: int | None = None
    currency: str = "RUB"
    is_free: bool = False


class Venue(_Model):
    source_id: str | None = Field(None, description="id площадки у источника")
    name: str
    address: str | None = None
    lat: float | None = None
    lon: float | None = None
    subway: str | None = None
    url: str | None = None


class Image(_Model):
    url: str = Field(description="Оригинальная ссылка на картинку")
    credit_name: str | None = Field(None, description="Автор или источник фото, если указан")
    credit_url: str | None = None
    local_path: str | None = Field(
        None, description="Путь к скачанному файлу относительно output/ (только с --download-images)"
    )


class Event(_Model):
    source: str = Field(description="Источник: kudago, timepad, ...")
    source_id: str = Field(description="id у источника. Пара (source, source_id) уникальна")
    source_url: str = Field(description="Ссылка на событие у источника — показывать пользователю")
    ticket_url: str | None = Field(None, description="Страница покупки/регистрации, если источник её знает")
    city: str = Field(description="slug города у источника")
    title: str
    short_title: str | None = None
    tagline: str | None = None
    description: str | None = Field(None, description="Короткое описание, простой текст")
    full_text: str | None = Field(None, description="Полное описание, простой текст")
    categories: list[str] = Field(default_factory=list, description="Категории в терминах источника")
    tags: list[str] = Field(default_factory=list)
    age_restriction: str | None = Field(None, description="Например 16+")
    price: Price = Field(default_factory=Price)
    venue: Venue | None = None
    sessions: list[Session] = Field(
        default_factory=list, description="Только актуальные сеансы, по возрастанию начала"
    )
    images: list[Image] = Field(default_factory=list)
    content_hash: str | None = Field(
        None, description="SHA-256 содержимого. Не изменился с прошлого раза — событие можно не обновлять"
    )


class EventBatch(_Model):
    schema_version: str = SCHEMA_VERSION  # файлы 1.0 читаются без изменений
    source: str
    city: str
    fetched_at: AwareDatetime
    count: int
    events: list[Event]


def compute_content_hash(event: Event) -> str:
    """Хеш по смысловому содержимому: local_path и сам хеш не учитываются."""
    payload = event.model_dump(
        mode="json",
        exclude={"content_hash": True, "images": {"__all__": {"local_path"}}},
    )
    blob = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def filename_stamp(moment: datetime) -> str:
    """Метка времени для имён файлов и папок: без двоеточий, чтобы работало на Windows."""
    return moment.strftime("%Y-%m-%dT%H-%M-%SZ")
