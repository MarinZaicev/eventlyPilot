// ============================================================
// Рекомендации ВНУТРИ категории (#32).
//
// Категорию лента выбирает по интересу (feed.scoring.ts →
// buildCategoryFirstFeed). Здесь — какое событие из категории
// показать раньше. Профиль строится по событиям, на которые
// пользователь реагировал положительно (лайк, «Пойду», билеты,
// «Поделиться»):
//   • цена — похожая на то, что он обычно выбирает;
//   • время — будни-вечер / выходные / будни-день, как он любит;
//   • расстояние — ближе к месту, где он последний раз включал «Рядом»;
//   • популярность — сколько ДРУГИХ людей лайкнули, идут, смотрели билеты.
// Все бонусы — в «очках» события (как бонус «скоро»): ±1–1.5 каждый.
// ============================================================

export type PreferenceEvent = {
  source: string
  sourceCity: string | null
  isFree: boolean
  priceMin: number | null
  occurrences: { startsAt: Date }[]
  venue: { latitude: number | null; longitude: number | null } | null
}

type TimeBucket = 'weekday-day' | 'weekday-evening' | 'weekend'

export type UserPreferences = {
  // Цена: доля бесплатных среди понравившихся и медиана платных.
  pricedCount: number
  freeShare: number
  paidCount: number
  medianPrice: number | null

  // Время: сколько понравившихся в каждом «окне».
  timedCount: number
  timeCounts: Record<TimeBucket, number>

  // Последнее известное место пользователя (из «Рядом»), округлённое.
  location: { latitude: number; longitude: number } | null
}

// У kinopoisk-cinema дата условная (#28) — для времени её не учитываем.
const NO_REAL_DATES = new Set(['kinopoisk-cinema'])

// Часовой пояс городов парсера (летнего времени в России нет).
const CITY_UTC_OFFSET: Record<string, number> = {
  msk: 3, spb: 3, kzn: 3, nnv: 3, nn: 3, voronezh: 3, vrn: 3, volgograd: 3,
  rostov: 3, rnd: 3, krd: 3, sochi: 3,
  smr: 4, samara: 4,
  ekb: 5, chelyabinsk: 5, perm: 5, ufa: 5, tyumen: 5,
  omsk: 6,
  nsk: 7, krasnoyarsk: 7,
}

function nextStart(event: PreferenceEvent, now: Date) {
  const upcoming = event.occurrences.find(
    (occurrence) => occurrence.startsAt >= now,
  )

  return (upcoming ?? event.occurrences[0])?.startsAt ?? null
}

export function timeBucket(
  event: PreferenceEvent,
  now: Date,
): TimeBucket | null {
  if (NO_REAL_DATES.has(event.source)) {
    return null
  }

  const start = nextStart(event, now)

  if (!start) {
    return null
  }

  const offset = CITY_UTC_OFFSET[event.sourceCity ?? ''] ?? 3
  const local = new Date(start.getTime() + offset * 3_600_000)
  const weekday = local.getUTCDay()

  if (weekday === 0 || weekday === 6) {
    return 'weekend'
  }

  return local.getUTCHours() >= 17 ? 'weekday-evening' : 'weekday-day'
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

export function buildUserPreferences(
  likedEvents: PreferenceEvent[],
  location: { latitude: number; longitude: number } | null,
  now: Date,
): UserPreferences {
  const prices: number[] = []
  let free = 0

  const timeCounts: Record<TimeBucket, number> = {
    'weekday-day': 0,
    'weekday-evening': 0,
    weekend: 0,
  }

  let timed = 0

  for (const event of likedEvents) {
    if (event.isFree) {
      free += 1
    } else if (event.priceMin !== null && event.priceMin > 0) {
      prices.push(event.priceMin)
    }

    const bucket = timeBucket(event, now)

    if (bucket) {
      timeCounts[bucket] += 1
      timed += 1
    }
  }

  const pricedCount = free + prices.length

  return {
    pricedCount,
    freeShare: pricedCount ? free / pricedCount : 0,
    paidCount: prices.length,
    medianPrice: prices.length ? median(prices) : null,
    timedCount: timed,
    timeCounts,
    location,
  }
}

function distanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
) {
  const rad = Math.PI / 180
  const h =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) *
      Math.cos(lat2 * rad) *
      Math.sin(((lon2 - lon1) * rad) / 2) ** 2

  return 2 * 6371 * Math.asin(Math.sqrt(h))
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value))

// Минимум понравившихся событий, чтобы делать выводы.
const MIN_SIGNALS = 3

export function priceBonus(
  event: PreferenceEvent,
  prefs: UserPreferences,
) {
  if (prefs.pricedCount < MIN_SIGNALS) {
    return 0
  }

  if (event.isFree) {
    // Любит бесплатное — плюс; к бесплатному равнодушен — ноль.
    return prefs.freeShare >= 0.5 ? 1 : 0
  }

  if (
    event.priceMin === null ||
    prefs.medianPrice === null ||
    prefs.paidCount < 2
  ) {
    return 0
  }

  // Во сколько раз дороже/дешевле привычного (с поправкой на мелкие суммы).
  const ratio = Math.log2(
    (event.priceMin + 300) / (prefs.medianPrice + 300),
  )

  // Как обычно → +1.2, в 2 раза → 0, в 4 раза и больше → −1.2.
  return 1.2 - 1.2 * Math.min(Math.abs(ratio), 2)
}

export function timeBonus(
  event: PreferenceEvent,
  prefs: UserPreferences,
  now: Date,
) {
  if (prefs.timedCount < MIN_SIGNALS) {
    return 0
  }

  const bucket = timeBucket(event, now)

  if (!bucket) {
    return 0
  }

  // Доля «окна» среди понравившихся (со сглаживанием), против равной 1/3.
  const share =
    (prefs.timeCounts[bucket] + 1) / (prefs.timedCount + 3)

  return clamp((share - 1 / 3) * 4.5, -1, 1.5)
}

export function distanceBonus(
  event: PreferenceEvent,
  prefs: UserPreferences,
) {
  const venue = event.venue

  if (
    !prefs.location ||
    venue?.latitude == null ||
    venue?.longitude == null
  ) {
    return 0
  }

  const km = distanceKm(
    prefs.location.latitude,
    prefs.location.longitude,
    venue.latitude,
    venue.longitude,
  )

  if (km <= 3) return 1
  if (km <= 8) return 0.5
  if (km >= 25) return -0.5

  return 0
}

// likes + 2×«Пойду» + билеты от ДРУГИХ пользователей → до +1.5.
export function socialBonus(score: number) {
  return score > 0
    ? Math.min(1.5, 0.6 * Math.log2(1 + score))
    : 0
}
