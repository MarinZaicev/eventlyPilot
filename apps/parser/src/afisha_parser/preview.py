"""Страница для просмотра трейлеров глазами: output/preview/trailers.html.

Собирает всё, что есть в output/movies/**/latest.json (прокат TMDb и кинопоказы источников),
и показывает постер, описание и встроенный плеер YouTube. Нужна только для проверки,
в приложение не идёт. Открыть: python -m http.server --directory <output>/preview 8000.
"""

import html
import json
from pathlib import Path


def _card(title: str, subtitle: str, overview: str | None, poster: str | None, trailer: dict | None) -> str:
    esc = html.escape
    if trailer and trailer.get("local_path"):  # скачанный файл — играет без YouTube
        player = (f'<video controls preload="none" src="../{esc(trailer["local_path"])}"></video>'
                  f'<p class="sub">файл {esc(trailer["local_path"])}</p>')
    elif trailer and trailer.get("embed_url"):
        site = trailer.get("site") or "YouTube"
        player = (f'<iframe loading="lazy" src="{esc(trailer["embed_url"])}" allowfullscreen '
                  f'allow="encrypted-media; picture-in-picture"></iframe>'
                  f'<a href="{esc(trailer["url"])}" target="_blank">открыть ({esc(site)})</a>')
    else:
        player = '<p class="none">трейлера нет</p>'
    image = f'<img src="{esc(poster)}" alt="">' if poster else ""
    return (f'<article>{image}<div><h3>{esc(title)}</h3><p class="sub">{esc(subtitle)}</p>'
            f'<p>{esc((overview or "")[:400])}</p>{player}</div></article>')


def build_trailers_page(output_dir: Path) -> Path:
    sections: list[str] = []
    for latest in sorted((output_dir / "movies").rglob("latest.json")):
        try:
            data = json.loads(latest.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        folder = latest.parent.relative_to(output_dir / "movies").as_posix()
        cards = []
        for m in data.get("movies") or []:
            trailer = m.get("trailer")
            if trailer is None and m.get("trailer_url"):  # файлы старого формата
                key = m["trailer_url"].rsplit("=", 1)[-1]
                trailer = {"url": m["trailer_url"], "embed_url": f"https://www.youtube-nocookie.com/embed/{key}"}
            if "status" in m:  # прокат TMDb
                status = "в прокате" if m["status"] == "now_playing" else "скоро"
                subtitle = " · ".join(str(x) for x in (status, m.get("release_date"), m.get("age_rating"),
                                                       ", ".join(m.get("genres") or [])) if x)
            else:  # кинопоказ источника
                subtitle = f'событие: {m.get("event_title")} · совпадение {m.get("match_score")}'
            cards.append(_card(m.get("title", "?"), subtitle, m.get("overview"), m.get("poster_url"), trailer))
        with_trailer = sum(1 for m in data.get("movies") or [] if m.get("trailer") or m.get("trailer_url"))
        sections.append(f'<h2>{html.escape(folder)} — фильмов {len(cards)}, с трейлером {with_trailer}</h2>'
                        + "".join(cards))

    page = f"""<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Трейлеры</title>
<style>
body{{font-family:system-ui,sans-serif;max-width:1100px;margin:0 auto;padding:16px;background:#111;color:#eee}}
article{{display:flex;gap:16px;padding:16px 0;border-bottom:1px solid #333}}
article img{{width:140px;height:210px;object-fit:cover;border-radius:6px;flex:none}}
article div{{flex:1;min-width:0}} h3{{margin:0 0 4px}} .sub{{color:#999;margin:0 0 8px}}
iframe,video{{width:100%;max-width:560px;aspect-ratio:16/9;border:0;display:block;margin-bottom:4px}}
a{{color:#8ab4f8}} .none{{color:#c77}}
@media (max-width:600px){{article{{flex-direction:column}}}}
</style></head><body><h1>Трейлеры</h1>{''.join(sections) or '<p>Файлов movies ещё нет</p>'}</body></html>"""
    path = output_dir / "preview" / "trailers.html"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(page, encoding="utf-8")
    return path
