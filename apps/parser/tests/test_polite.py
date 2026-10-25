"""Бережный режим: лимит запросов, лимит страниц, пауза источника после отказа."""

from datetime import UTC, datetime, timedelta

import httpx
import pytest

from afisha_parser import pipeline
from afisha_parser.__main__ import main
from afisha_parser.config import Settings
from afisha_parser.cycle import format_status, next_run_at, run_cycle
from afisha_parser.http_client import HttpClient
from afisha_parser.pauses import active_pause, load_pauses, set_pause


@pytest.fixture(autouse=True)
def no_backoff(monkeypatch):
    monkeypatch.setattr(HttpClient, "_backoff", staticmethod(lambda attempt, response: 0))


def settings_for(tmp_path, **extra) -> Settings:
    base = dict(output_dir=tmp_path, request_delay=0, max_retries=3, download_images=False, save_raw=False,
                movies=False, now_playing=False, tmdb_api_key=None, cities="msk,spb,nsk", sources="kudago")
    return Settings(**{**base, **extra})


def use_transport(monkeypatch, handler) -> list[httpx.Request]:
    seen: list[httpx.Request] = []
    real = pipeline.HttpClient

    def wrapped(request):
        seen.append(request)
        return handler(request)

    monkeypatch.setattr(pipeline, "HttpClient",
                        lambda settings, **kw: real(settings, transport=httpx.MockTransport(wrapped), **kw))
    return seen


def kudago_page(next_url=None) -> dict:
    start = int((datetime.now(UTC) + timedelta(days=1)).timestamp())
    return {"count": 1, "next": next_url, "results": [
        {"id": 1, "title": "концерт", "slug": "c", "categories": ["concert"], "dates": [{"start": start}]}]}


def test_gap_from_requests_per_hour():
    assert Settings(requests_per_hour=30, request_delay=0.5).source_gap_seconds() == 120
    assert Settings(requests_per_hour=1).source_gap_seconds() == 3600
    assert Settings(requests_per_hour=0, request_delay=2).source_gap_seconds() == 2
    client = pipeline.source_client(Settings(requests_per_hour=60))
    assert client._delay == 60


async def test_403_pauses_whole_source(tmp_path, monkeypatch):
    settings = settings_for(tmp_path)
    seen = use_transport(monkeypatch, lambda r: httpx.Response(403, text="<html>403 Forbidden</html>"))

    status = await run_cycle(settings)

    assert len(seen) == 1  # первый же отказ — остальные города не трогаем, 403 не повторяем
    assert all(t.get("paused_until") for t in status["targets"])
    assert "KudaGo ответил 403" in status["targets"][0]["errors"][0]
    assert "ПАУЗА kudago" in format_status(settings, status)
    # отказ — не повод быстро повторять: ждём обычный интервал
    finished = datetime.fromisoformat(status["finished_at"])
    assert next_run_at(settings, status) == finished + timedelta(minutes=settings.interval_minutes)

    await run_cycle(settings)
    assert len(seen) == 1  # на паузе — ни одного запроса


async def test_429_is_not_retried(tmp_path, monkeypatch):
    settings = settings_for(tmp_path, cities="msk")
    seen = use_transport(monkeypatch, lambda r: httpx.Response(429))
    status = await run_cycle(settings)
    assert len(seen) == 1 and status["targets"][0]["paused_until"]


async def test_server_errors_are_still_retried_and_not_paused(tmp_path, monkeypatch):
    settings = settings_for(tmp_path, cities="msk")
    seen = use_transport(monkeypatch, lambda r: httpx.Response(503))
    status = await run_cycle(settings)
    assert len(seen) == 3 and not load_pauses(tmp_path)
    assert status["targets"][0]["requests"] == 3


async def test_page_limit(tmp_path, monkeypatch):
    settings = settings_for(tmp_path, cities="msk", max_pages=2)
    seen = use_transport(monkeypatch, lambda r: httpx.Response(
        200, json=kudago_page("https://kudago.com/public-api/v1.4/events/?page=next")))
    status = await run_cycle(settings)
    assert len(seen) == 2 and status["targets"][0]["fresh"]
    assert status["requests"] == {"kudago": 2}


def test_new_timepad_token_lifts_pause(tmp_path):
    now = datetime.now(UTC)
    old = Settings(output_dir=tmp_path, timepad_token="old")
    set_pause(old, "timepad", "HTTP 403", now)
    assert active_pause(old, "timepad", now)
    assert active_pause(Settings(output_dir=tmp_path, timepad_token="new"), "timepad", now) is None
    assert active_pause(old, "timepad", now + timedelta(hours=25)) is None  # срок вышел


def test_resume_command(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("AFISHA_OUTPUT_DIR", str(tmp_path))
    from afisha_parser.config import get_settings
    get_settings.cache_clear()
    settings = Settings(output_dir=tmp_path)
    set_pause(settings, "kudago", "HTTP 403", datetime.now(UTC))
    assert main(["resume", "kudago"]) == 0
    assert "kudago" in capsys.readouterr().out
    assert load_pauses(tmp_path) == {}
    get_settings.cache_clear()


async def test_timepad_message_shows_reason(tmp_path, monkeypatch):
    settings = settings_for(tmp_path, cities="omsk", sources="timepad", timepad_token="tok")
    use_transport(monkeypatch, lambda r: httpx.Response(
        403, json={"response_status": {"error_code": 403, "message": "Токен не действителен"}}))
    status = await run_cycle(settings)
    error = status["targets"][0]["errors"][0]
    assert "Токен не действителен" in error and status["targets"][0]["paused_until"]
