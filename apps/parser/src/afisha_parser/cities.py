"""Справочник городов: единый slug для всех источников, название, часовой пояс, центр, коды у источников.

slug — наш, общий для всех источников: output/events/<источник>/<slug>/. Там, где город есть
у KudaGo, slug совпадает с кодом KudaGo, чтобы не переименовывать уже собранные папки.

Как добавить город: строка в CITIES. Если он есть у KudaGo — указать его код (список:
python -m afisha_parser cities kudago). Timepad ищет по русскому названию, ему код не нужен.
"""

# KudaGo (проверено 30.09.2026): в списке /locations/ только msk, spb, ekb, kzn, nnv.
# nsk, krasnoyarsk, ufa, krd из списка убраны, но API по ним ещё отдаёт немного событий —
# оставляем, пока отдаёт. Самару KudaGo не знает вовсе, она только через Timepad.
#
# Номера городов Кинопоиска (поле kinopoisk) видны в адресе kinopoisk.ru/afisha/city/<номер>/
# после выбора города на сайте. Неизвестные можно задать без новой версии:
# AFISHA_KINOPOISK_CITY_IDS=nsk:<номер>,ekb:<номер> в .env

from dataclasses import dataclass
from math import asin, cos, radians, sin, sqrt
from zoneinfo import ZoneInfo


@dataclass(frozen=True)
class City:
    slug: str
    name: str
    tz: str
    lat: float
    lon: float
    kudago: str | None = None  # код у KudaGo; None — у KudaGo города нет
    timepad: bool = True
    kinopoisk: int | None = None  # номер города в адресах афиши Кинопоиска: /film/<id>/afisha/city/<номер>/

    @property
    def zone(self) -> ZoneInfo:
        return ZoneInfo(self.tz)

    def sources(self) -> list[str]:
        result = []
        if self.kudago:
            result.append("kudago")
        if self.timepad:
            result.append("timepad")
        return result


CITIES: dict[str, City] = {c.slug: c for c in [
    City("msk", "Москва", "Europe/Moscow", 55.7558, 37.6173, kudago="msk", kinopoisk=1),
    City("spb", "Санкт-Петербург", "Europe/Moscow", 59.9386, 30.3141, kudago="spb", kinopoisk=2),
    City("nsk", "Новосибирск", "Asia/Novosibirsk", 55.0084, 82.9357, kudago="nsk"),
    City("ekb", "Екатеринбург", "Asia/Yekaterinburg", 56.8389, 60.6057, kudago="ekb"),
    City("kzn", "Казань", "Europe/Moscow", 55.7961, 49.1064, kudago="kzn"),
    City("krasnoyarsk", "Красноярск", "Asia/Krasnoyarsk", 56.0153, 92.8932, kudago="krasnoyarsk"),
    City("nnv", "Нижний Новгород", "Europe/Moscow", 56.3269, 44.0059, kudago="nnv"),
    City("chelyabinsk", "Челябинск", "Asia/Yekaterinburg", 55.1644, 61.4368),
    City("ufa", "Уфа", "Asia/Yekaterinburg", 54.7388, 55.9721, kudago="ufa"),
    City("krd", "Краснодар", "Europe/Moscow", 45.0355, 38.9753, kudago="krd"),
    City("smr", "Самара", "Europe/Samara", 53.1959, 50.1002, kinopoisk=11),
    City("rostov", "Ростов-на-Дону", "Europe/Moscow", 47.2357, 39.7015),
    City("omsk", "Омск", "Asia/Omsk", 54.9885, 73.3242),
    City("voronezh", "Воронеж", "Europe/Moscow", 51.6608, 39.2003),
    City("perm", "Пермь", "Asia/Yekaterinburg", 58.0105, 56.2502),
    City("volgograd", "Волгоград", "Europe/Volgograd", 48.7080, 44.5133),
    # Есть у KudaGo, в основной список не входят
    City("sochi", "Сочи", "Europe/Moscow", 43.5855, 39.7231, kudago="sochi"),
]}


def get_city(slug: str) -> City | None:
    return CITIES.get(slug)


def city_by_kudago(code: str) -> City | None:
    return next((c for c in CITIES.values() if c.kudago == code), None)


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    lat1, lon1, lat2, lon2 = map(radians, (lat1, lon1, lat2, lon2))
    h = sin((lat2 - lat1) / 2) ** 2 + cos(lat1) * cos(lat2) * sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371 * asin(sqrt(h))
