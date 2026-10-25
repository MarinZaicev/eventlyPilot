"""Автономный режим: цикл, работа на старых данных при падении источника, блокировка, расписание."""

import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from afisha_parser import cycle as cycle_module
from afisha_parser import pipeline
from afisha_parser.config import Settings
from afisha_parser.cycle import (
    LockBusy,
    cycle_lock,
    format_status,
    is_healthy,
    next_run_at,
    read_status,
    run_cycle,
    run_daemon,
)
from afisha_parser.export import export_batch
from afisha_parser.http_client import HttpClient
from afisha_parser.models import Event, EventBatch, Session


def api_event(event_id: int, *, hours_from_now: float) -> dict:
    start = datetime.now(UTC) + timedelta(hours=hours_from_now)
    return {
        "id": event_id,
        "title": f"концерт {event_id}",
        "slug": f"event-{event_id}",
        "categories": ["concert"],
        "dates": [{"start": int(start.timestamp()), "end": int((start + timedelta(hours=2)).timestamp())}],
        "price": "500 рублей",
    }


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(
        output_dir=tmp_path, request_delay=0, max_retries=2, targets="kudago:msk",
        download_images=False, save_raw=False, movies=False, now_playing=False, tmdb_api_key=None,
    )


@pytest.fixture(autouse=True)
def no_backoff(monkeypatch):
    monkeypatch.setattr(HttpClient, "_backoff", staticmethod(lambda attempt, response: 0))


def use_transport(monkeypatch, handler) -> None:
    real = pipeline.HttpClient
    monkeypatch.setattr(
        pipeline, "HttpClient",
        lambda settings, **kw: real(settings, transport=httpx.MockTransport(handler), **kw),
    )


async def test_cycle_writes_dump_evently_and_status(settings, tmp_path, monkeypatch):
    use_transport(monkeypatch, lambda r: httpx.Response(
        200, json={"count": 2, "next": None, "results": [api_event(1, hours_from_now=24), api_event(2, hours_from_now=48)]},
    ))

    status = await run_cycle(settings)

    assert status["ok"] is True
    target = status["targets"][0]
    assert target["fresh"] is True and target["events"] == 2
    evently = json.loads((tmp_path / "evently" / "kudago" / "msk" / "latest.json").read_text(encoding="utf-8"))
    assert len(evently["events"]) == 2
    assert read_status(tmp_path)["ok"] is True
    assert is_healthy(settings, read_status(tmp_path))


async def test_source_down_uses_previous_dump_without_past_events(settings, tmp_path, monkeypatch):
    now = datetime.now(UTC)
    old = EventBatch(
        source="kudago", city="msk", fetched_at=now - timedelta(days=2), count=2,
        events=[
            Event(source="kudago", source_id="past", source_url="https://kudago.com/", city="msk", title="Прошло",
                  categories=["concert"], sessions=[Session(starts_at=now - timedelta(days=1))]),
            Event(source="kudago", source_id="soon", source_url="https://kudago.com/", city="msk", title="Скоро",
                  categories=["concert"], sessions=[Session(starts_at=now + timedelta(days=1))]),
        ],
    )
    export_batch(old, tmp_path)
    use_transport(monkeypatch, lambda r: httpx.Response(503))

    status = await run_cycle(settings)

    target = status["targets"][0]
    assert status["ok"] is False
    assert target["fresh"] is False and target["dropped_past"] == 1
    assert target["errors"]
    evently = json.loads((tmp_path / "evently" / "kudago" / "msk" / "latest.json").read_text(encoding="utf-8"))
    assert [e["externalId"] for e in evently["events"]] == ["soon"]
    assert "старые данные" in format_status(settings, status)


async def test_bad_targets_do_not_crash(tmp_path):
    settings = Settings(output_dir=tmp_path, targets="kudago", movies=False, now_playing=False)
    status = await run_cycle(settings)
    assert status["ok"] is False and "config_error" in status


async def test_unknown_source_is_reported(tmp_path):
    settings = Settings(output_dir=tmp_path, targets="nosuch:msk", movies=False, now_playing=False)
    status = await run_cycle(settings)
    assert "неизвестный источник" in status["targets"][0]["errors"][0]


def test_lock_blocks_second_cycle(tmp_path):
    with cycle_lock(tmp_path):
        with pytest.raises(LockBusy):
            with cycle_lock(tmp_path):
                pass
    with cycle_lock(tmp_path):  # после освобождения — снова можно
        pass


def test_next_run_schedule(settings):
    finished = datetime(2026, 9, 29, 12, 0, tzinfo=UTC)
    settings = settings.model_copy(update={"interval_minutes": 180, "retry_minutes": 20})
    assert next_run_at(settings, {"ok": True, "finished_at": finished.isoformat()}) == finished + timedelta(hours=3)
    assert next_run_at(settings, {"ok": False, "finished_at": finished.isoformat()}) == finished + timedelta(minutes=20)
    assert next_run_at(settings, None) <= datetime.now(UTC)


def test_health_detects_stale_status(settings):
    old = (datetime.now(UTC) - timedelta(days=2)).isoformat()
    assert not is_healthy(settings, {"ok": True, "finished_at": old})
    assert not is_healthy(settings, None)


async def test_daemon_runs_one_cycle_and_plans_next(settings, tmp_path, monkeypatch):
    use_transport(monkeypatch, lambda r: httpx.Response(
        200, json={"count": 1, "next": None, "results": [api_event(1, hours_from_now=24)]},
    ))
    await run_daemon(settings, max_cycles=1)

    status = read_status(tmp_path)
    assert status["ok"] is True
    planned = datetime.fromisoformat(status["next_run_at"])
    assert planned - datetime.fromisoformat(status["finished_at"]) == timedelta(minutes=settings.interval_minutes)


async def test_daemon_does_not_rerun_if_recent_cycle(settings, tmp_path, monkeypatch):
    """После перезапуска службы демон не дёргает источник, если свежий цикл уже был."""
    cycle_module.write_status(tmp_path, {"ok": True, "finished_at": datetime.now(UTC).isoformat()})
    calls = []

    async def fake_cycle(s):
        calls.append(1)
        return {}

    monkeypatch.setattr(cycle_module, "run_cycle", fake_cycle)

    async def instant_stop(stop, seconds):
        stop.set()

    monkeypatch.setattr(cycle_module, "_sleep_or_stop", instant_stop)
    await run_daemon(settings, max_cycles=1)
    assert calls == []
