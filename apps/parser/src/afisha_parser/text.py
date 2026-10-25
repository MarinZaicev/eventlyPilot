import html
import re

_TAG_RE = re.compile(r"<[^>]+>")
_SPACE_RE = re.compile(r"\s+")


def clean_text(value: object) -> str | None:
    """HTML-сущности → символы, убрать теги, схлопнуть пробелы. Пустое → None."""
    if value is None:
        return None
    text = html.unescape(str(value))
    text = _TAG_RE.sub(" ", text)
    text = _SPACE_RE.sub(" ", text).strip()
    return text or None


def capitalize_first(text: str) -> str:
    return text[:1].upper() + text[1:]
