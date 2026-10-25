import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from afisha_parser.config import Settings
from afisha_parser.http_client import HttpClient
from afisha_parser.models import Event, Image, compute_content_hash
from afisha_parser.pipeline import run_fetch


def api_event(event_id: int) -> dict:
    start = datetime.now(UTC) + timedelta(days=3)
    return {
        "id": event_id,
        "title": f"событие {event_id}",
        "slug": f"event-{event_id}",
        "dates": [{"start": int(start.timestamp()), "end": int((start + timedelta(hours=2)).timestamp())}],
        "price": "500 рублей",
        "is_free": False,
    }


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(output_dir=tmp_path, request_delay=0, max_retries=3)


@pytest.fixture(autouse=True)
def no_backoff(monkeypatch):
    monkeypatch.setattr(HttpClient, "_backoff", staticmethod(lambda attempt, response: 0))


def two_pages_transport(requests: list[httpx.Request]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.params.get("page") == "2":
            return httpx.Response(200, json={"count": 3, "next": None, "results": [api_event(3), api_event(1)]})
        next_url = "https://kudago.com/public-api/v1.4/events/?page=2"
        return httpx.Response(200, json={"count": 3, "next": next_url, "results": [api_event(1), api_event(2)]})

    return httpx.MockTransport(handler)


async def test_fetch_all_pages_to_json(settings, tmp_path):
    requests: list[httpx.Request] = []
    async with HttpClient(settings, transport=two_pages_transport(requests)) as http:
        path = await run_fetch(settings, "kudago", "msk", http=http)

    assert len(requests) == 2
    assert requests[0].url.params["location"] == "msk"

    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["schema_version"] == "1.1"
    assert data["count"] == 3  # событие 1 пришло дважды, осталось одно
    assert sorted(e["source_id"] for e in data["events"]) == ["1", "2", "3"]
    assert all(e["content_hash"] for e in data["events"])
    assert (path.parent / "latest.json").exists()
    assert len(list((tmp_path / "raw" / "kudago" / "msk").rglob("events-page-*.json"))) == 2


async def test_limit_stops_early(settings):
    requests: list[httpx.Request] = []
    async with HttpClient(settings, transport=two_pages_transport(requests)) as http:
        path = await run_fetch(settings, "kudago", "msk", limit=1, save_raw=False, http=http)

    assert len(requests) == 1
    assert json.loads(path.read_text(encoding="utf-8"))["count"] == 1


async def test_empty_source_does_not_overwrite_latest(settings, tmp_path):
    transport = httpx.MockTransport(lambda r: httpx.Response(200, json={"count": 0, "next": None, "results": []}))
    async with HttpClient(settings, transport=transport) as http:
        path = await run_fetch(settings, "kudago", "nowhere", save_raw=False, http=http)

    assert path is None
    assert not (tmp_path / "events").exists()


async def test_retry_on_503(settings):
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(503)
        return httpx.Response(200, json={"count": 1, "next": None, "results": [api_event(7)]})

    async with HttpClient(settings, transport=httpx.MockTransport(handler)) as http:
        path = await run_fetch(settings, "kudago", "msk", save_raw=False, http=http)

    assert calls["n"] == 2
    assert path is not None


def test_content_hash_ignores_local_path_but_not_content():
    base = Event(
        source="kudago", source_id="1", source_url="https://kudago.com/", city="msk",
        title="Событие", images=[Image(url="https://example.org/1.jpg")],
    )
    downloaded = base.model_copy(deep=True)
    downloaded.images[0].local_path = "images/ab/abc.jpg"
    renamed = base.model_copy(update={"title": "Другое событие"})

    assert compute_content_hash(base) == compute_content_hash(downloaded)
    assert compute_content_hash(base) != compute_content_hash(renamed)
