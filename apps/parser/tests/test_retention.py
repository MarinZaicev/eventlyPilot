import json
import os
import time

import httpx

from afisha_parser.config import Settings
from afisha_parser.http_client import HttpClient
from afisha_parser.images import download_images
from afisha_parser.models import Event, Image
from afisha_parser.retention import KEEP_LAST, cleanup

DAY = 86400


def touch(path, *, age_days: float, content: str = "{}") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    moment = time.time() - age_days * DAY
    os.utime(path, (moment, moment))


def test_old_snapshots_removed_latest_and_recent_kept(tmp_path):
    folder = tmp_path / "events" / "kudago" / "msk"
    touch(folder / "latest.json", age_days=30, content='{"events": []}')
    for i in range(6):
        touch(folder / f"2026-09-0{i + 1}T00-00-00Z.json", age_days=30 - i)
    touch(folder / "2026-09-28T00-00-00Z.json", age_days=1)

    report = cleanup(tmp_path, keep_days=7)

    left = sorted(p.name for p in folder.iterdir())
    assert "latest.json" in left
    assert len(left) == 1 + KEEP_LAST  # latest + последние снимки
    assert report.snapshots == 7 - KEEP_LAST


def test_raw_and_unreferenced_images(tmp_path):
    touch(tmp_path / "raw" / "kudago" / "msk" / "2026-09-01T00-00-00Z" / "events-page-001.json", age_days=5)
    os.utime(tmp_path / "raw" / "kudago" / "msk" / "2026-09-01T00-00-00Z", (time.time() - 5 * DAY,) * 2)
    touch(tmp_path / "raw" / "kudago" / "msk" / "2026-09-29T00-00-00Z" / "events-page-001.json", age_days=0)

    used, unused_old, unused_new = "images/aa/used.jpg", "images/bb/old.jpg", "images/cc/new.jpg"
    for rel in (used, unused_old):
        touch(tmp_path / rel, age_days=30)
    touch(tmp_path / unused_new, age_days=1)
    latest = {"events": [{"images": [{"url": "https://x/1.jpg", "local_path": used}]}]}
    touch(tmp_path / "events" / "kudago" / "msk" / "latest.json", age_days=0, content=json.dumps(latest))

    report = cleanup(tmp_path, keep_days=7, raw_keep_days=2)

    assert report.raw_dirs == 1
    assert (tmp_path / used).exists()
    assert not (tmp_path / unused_old).exists()
    assert (tmp_path / unused_new).exists()  # ещё молодая — может понадобиться


def test_images_untouched_if_latest_is_broken(tmp_path):
    touch(tmp_path / "images" / "aa" / "old.jpg", age_days=30)
    touch(tmp_path / "events" / "kudago" / "msk" / "latest.json", age_days=0, content="{битый")
    cleanup(tmp_path, keep_days=7)
    assert (tmp_path / "images" / "aa" / "old.jpg").exists()


async def test_images_index_skips_already_downloaded(tmp_path):
    calls = []

    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(200, content=b"jpeg-bytes", headers={"content-type": "image/jpeg"})

    settings = Settings(output_dir=tmp_path, request_delay=0)
    event = Event(source="kudago", source_id="1", source_url="https://kudago.com/", city="msk", title="Т",
                  images=[Image(url="https://img/1.jpg")])
    async with HttpClient(settings, delay=0, transport=httpx.MockTransport(handler)) as http:
        await download_images([event], http, tmp_path, 2)
        again = event.model_copy(deep=True)
        again.images[0].local_path = None
        await download_images([again], http, tmp_path, 2)

    assert len(calls) == 1
    assert again.images[0].local_path == event.images[0].local_path
    assert json.loads((tmp_path / "images" / "index.json").read_text())["https://img/1.jpg"]


def test_index_forgets_deleted_files(tmp_path):
    touch(tmp_path / "images" / "aa" / "old.jpg", age_days=30)
    touch(tmp_path / "images" / "bb" / "kept.jpg", age_days=30)
    latest = {"events": [{"images": [{"url": "https://x/kept.jpg", "local_path": "images/bb/kept.jpg"}]}]}
    touch(tmp_path / "events" / "kudago" / "msk" / "latest.json", age_days=0, content=json.dumps(latest))
    index = {"https://x/old.jpg": "images/aa/old.jpg", "https://x/kept.jpg": "images/bb/kept.jpg"}
    touch(tmp_path / "images" / "index.json", age_days=0, content=json.dumps(index))

    cleanup(tmp_path, keep_days=7)

    assert json.loads((tmp_path / "images" / "index.json").read_text()) == {"https://x/kept.jpg": "images/bb/kept.jpg"}


def test_images_report(tmp_path):
    from afisha_parser.images_report import build_report
    touch(tmp_path / "images" / "aa" / "a.jpg", age_days=0)
    events = {"events": [
        {"source_id": "1", "images": [{"url": "https://x/a.jpg", "local_path": "images/aa/a.jpg"}]},
        {"source_id": "2", "images": [{"url": "https://x/a.jpg", "local_path": "images/aa/a.jpg"}]},
        {"source_id": "3", "images": []},
    ]}
    touch(tmp_path / "events" / "timepad" / "omsk" / "latest.json", age_days=0, content=json.dumps(events))
    report = build_report(tmp_path)
    assert "timepad/omsk: событий 3, с картинкой 2 (66%), скачано 2, файл на месте 2" in report
    assert "одна ссылка у нескольких событий: 1" in report
