"""Из заголовка события — варианты названия фильма, от самых надёжных к менее надёжным.

Заголовки бывают очень разные:
    Показ фильма «Территория»                                   → «Территория», надёжно
    Кинопоказ «Тихое материнство» (2025)                        → + год 2025
    Программа «Мой музей» | ДВОРЕЦ ГРЕЗ | 3 октября 19:00 | Киноцентр «ВАВИЛОН»
                                                                → «Дворец грез»; «Мой музей» и «ВАВИЛОН» — нет
    Ретроспектива советских фильмов | Кинопоказ фильма «ИДИОТ» | 2 октября 14:30 | …
                                                                → «Идиот», надёжно
    Сумерки: Сага (2008) (кинолекторий)                         → «Сумерки: Сага», год 2008
    Фестивальный показ: жизнеутверждающий сериал «Первая ракетка»  → сериал

Надёжный вариант (strong) — название в кавычках сразу после слов «фильм», «показ», «кинопоказ» и т. п.
Остальные (medium) принимаются только при очень близком совпадении с TMDb — см. MIN_SCORE_MEDIUM.
"""

import re
from dataclasses import dataclass

_YEAR_RE = re.compile(r"\((\d{4})\)")
# Год бывает и так: «Золотой теленок», 1968   или   «Медленные технологии» (Франция, 2023)
_YEAR_PATTERNS = [
    _YEAR_RE,
    re.compile(r"»\s*,\s*(\d{4})\b"),
    re.compile(r"\([^()]*?\b(\d{4})\s*\)"),
]
_PIPE_RE = re.compile(r"\s*\|\s*")

# Слова, после которых в кавычках почти наверняка название фильма
_FILM_BEFORE_RE = re.compile(
    r"(фильм|показ|кинопоказ|мультфильм|сериал|кинолекторий|премьер|ретроспектив|картин|документальн)"
    r"\w*[\s:.\-—–]*$",
    re.IGNORECASE,
)
# Слова, после которых в кавычках — название программы, площадки или фестиваля, а не фильма
_NOT_FILM_BEFORE_RE = re.compile(
    r"(к/т|программ|фестивал|центр|кинотеатр|киноцентр|цикл|проект|форум|кинокухн|клуб|библиотек|музе|"
    r"площадк|пространств|галере|кафе|бар|школ|студи|церемони|лекторий|кинофестивал|конкурс)\w*[\s:.\-—–]*$",
    re.IGNORECASE,
)
# Куски заголовка через « | », которые точно не название фильма
_DATE_RE = re.compile(
    r"\d{1,2}\s+(январ|феврал|март|апрел|ма[яй]|июн|июл|август|сентябр|октябр|ноябр|декабр)|\d{1,2}:\d{2}",
    re.IGNORECASE,
)
_SEGMENT_SKIP_RE = re.compile(
    r"^(программ|фокус|ретроспектив|форум|цикл|фестивал|лекци|встреч|обсужден|мастер-класс)"
    r"|киноцентр|культурн\w* центр|кинотеатр|библиотек|дом культуры|\bдк\b|музей|галере|кинозал"
    r"|киношкол|школ[аы]\b|университет|институт|академи",
    re.IGNORECASE,
)
# Если такое слово есть где-то перед кавычками, в кавычках скорее название мероприятия
_EVENT_WORDS_RE = re.compile(r"фестивал|церемони|конкурс|преми[ияю]|вечер\b|встреч|квиз|лекци", re.IGNORECASE)
_LIST_TAIL_RE = re.compile(r"»\s*(,|и)\s*$")
_TV_RE = re.compile(r"сериал|\d+\s*сезон|сезон\s*\d+", re.IGNORECASE)
_SEASON_RE = re.compile(r"[.,:]?\s*(\d+\s*сезон|сезон\s*\d+)\s*$", re.IGNORECASE)


@dataclass(frozen=True)
class Guess:
    query: str
    year: int | None
    strong: bool
    tv: bool = False


def extract_year(title: str) -> int | None:
    for pattern in _YEAR_PATTERNS:
        for match in pattern.finditer(title):
            year = int(match.group(1))
            if 1890 <= year <= 2035:
                return year
    return None


def _split_outside_quotes(text: str) -> list[str]:
    """Режем по « | », но не внутри кавычек: «Медленные технологии | Low-Tech» — одно название."""
    parts, depth, current = [], 0, []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "«":
            depth += 1
        elif ch == "»" and depth > 0:
            depth -= 1
        if ch == "|" and depth == 0:
            parts.append("".join(current).strip())
            current = []
        else:
            current.append(ch)
        i += 1
    parts.append("".join(current).strip())
    return [p for p in parts if p]


def _quoted_spans(text: str) -> list[tuple[int, int]]:
    """Верхнеуровневые «…» с учётом вложенных; (начало текста внутри, конец)."""
    spans, depth, start = [], 0, 0
    for i, ch in enumerate(text):
        if ch == "«":
            if depth == 0:
                start = i + 1
            depth += 1
        elif ch == "»" and depth > 0:
            depth -= 1
            if depth == 0:
                spans.append((start, i))
    if depth > 0:  # «… без закрывающей — берём до конца куска
        spans.append((start, len(text)))
    return spans


def _tidy(text: str) -> str:
    text = _YEAR_RE.sub("", text)
    text = _SEASON_RE.sub("", text)
    text = text.strip(" «»\"'.,:;—–-")
    if text.isupper() and len(text) > 3:  # «ДВОРЕЦ ГРЕЗ» → «Дворец грез»
        text = text[:1] + text[1:].lower()
    return re.sub(r"\s+", " ", text)


def extract_guesses(title: str) -> list[Guess]:
    year = extract_year(title)
    tv = bool(_TV_RE.search(title))
    strong: list[str] = []
    medium: list[str] = []

    # «Время героев»: фильм ««Человек Божий»» — лишние кавычки-ёлочки
    if title.count("«") > title.count("»"):
        title = re.sub(r"«{2,}", "«", title)
    segments = _split_outside_quotes(title)
    for segment in segments:
        spans = _quoted_spans(segment)
        previous_strong = False
        for start, end in spans:
            before = segment[: start - 1]
            # «Цель: фильм об экономике благополучия | Purpose: A Wellbeing Economies Film» — два названия
            names = [n for n in _PIPE_RE.split(segment[start:end]) if n.strip()]
            is_strong = bool(_FILM_BEFORE_RE.search(before)) or (
                previous_strong and _LIST_TAIL_RE.search(before) is not None  # Показ фильмов «А» и «Б»
            )
            if is_strong:
                strong.extend(names)
            elif len(segments) == 1 and not before.strip():
                medium.extend(names)  # «Брат» на большом экране — название в самом начале
            previous_strong = is_strong
        if not spans and len(segments) > 1 and not _DATE_RE.search(segment) and not _SEGMENT_SKIP_RE.search(segment):
            medium.append(segment)  # Программа «…» | НАЗВАНИЕ | дата | площадка

    if not strong and not medium and year is not None and f"({year})" in title:
        # «Сумерки: Сага (2008) (кинолекторий)» — название до года
        medium.append(title[: title.find(f"({year})")])

    result: list[Guess] = []
    seen: set[str] = set()
    for texts, is_strong in ((strong, True), (medium, False)):
        for text in texts:
            query = _tidy(text)
            key = query.casefold()
            if len(query) < 2 or key in seen:
                continue
            seen.add(key)
            result.append(Guess(query=query, year=year, strong=is_strong, tv=tv))
    return result


def extract_title_guess(title: str) -> str | None:
    """Самый надёжный вариант названия или None."""
    guesses = extract_guesses(title)
    return guesses[0].query if guesses else None
