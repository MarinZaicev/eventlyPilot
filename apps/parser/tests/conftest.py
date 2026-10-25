import json
import os
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def isolated_settings(monkeypatch, tmp_path):
    """Тесты не должны видеть настоящий .env и переменные AFISHA_* сервера:
    иначе, например, AFISHA_CITIES из рабочего .env подменяет города в тестах."""
    for key in list(os.environ):
        if key.startswith("AFISHA_"):
            monkeypatch.delenv(key)
    monkeypatch.chdir(tmp_path)  # Settings ищет .env в текущей папке — здесь его нет
    # Бережный лимит (запрос раз в 2 минуты) в тестах не нужен — отдельные тесты задают его сами
    monkeypatch.setenv("AFISHA_REQUESTS_PER_HOUR", "0")
    monkeypatch.setenv("AFISHA_SOURCE_LIMITS", "")
    # Заведения включаются только в своих тестах, чтобы не путать счётчики запросов в остальных
    monkeypatch.setenv("AFISHA_PLACES", "false")
    monkeypatch.setenv("AFISHA_CINEMA", "false")


@pytest.fixture
def kudago_page() -> dict:
    return json.loads((FIXTURES / "kudago_events_page.json").read_text(encoding="utf-8"))
