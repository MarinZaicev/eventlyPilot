// ============================================================
// Координаты площадок по адресу (Nominatim / OpenStreetMap).
//
// Зачем: «Где поесть рядом» (#26) и режим «Рядом» работают только
// у событий, у площадки которых есть координаты.
//
// Запуск из корня проекта:
//   pnpm --filter @evently/server exec tsx src/scripts/geocode-venues.ts
//     — предпросмотр: первые 10 площадок, в базу ничего не пишет;
//   pnpm --filter @evently/server exec tsx src/scripts/geocode-venues.ts --apply
//     — все площадки, с записью. Можно прервать (Ctrl+C) и запустить снова:
//       уже найденные пропускаются.
//
//   … --apply --loop
//     — служба (#35): после прохода спит GEOCODER_LOOP_HOURS (по умолчанию 6)
//       и снова обрабатывает новые площадки от парсера. Ошибки сети и
//       ограничения Nominatim — пауза и повтор, а не падение.
//       Запуск как службы: deploy/evently-geocoder.service.
//
// Правила Nominatim: не больше 1 запроса в секунду и понятный User-Agent
// (GEOCODER_USER_AGENT в .env). ~1700 площадок ≈ 35 минут.
// Настройки те же, что у геокодера помощника: GEOCODER_BASE_URL,
// GEOCODER_USER_AGENT; результаты кешируются в таблице Place.
// ============================================================

import 'dotenv/config'

import { prisma } from '@evently/db'

const BASE_URL = (
  process.env.GEOCODER_BASE_URL ??
  'https://nominatim.openstreetmap.org'
).replace(/\/$/, '')

const USER_AGENT =
  process.env.GEOCODER_USER_AGENT ??
  'EventlyHackathon/0.1'

const REQUEST_GAP_MS = 1100

// Найденная точка дальше этого от «центра» города — ошибка геокодера.
const MAX_DISTANCE_FROM_CITY_KM = 80

// slug города парсера → название для запроса.
const CITY_NAMES: Record<string, string> = {
  msk: 'Москва',
  spb: 'Санкт-Петербург',
  nsk: 'Новосибирск',
  ekb: 'Екатеринбург',
  kzn: 'Казань',
  krd: 'Краснодар',
  krasnoyarsk: 'Красноярск',
  chelyabinsk: 'Челябинск',
  nnv: 'Нижний Новгород',
  nn: 'Нижний Новгород',
  omsk: 'Омск',
  samara: 'Самара',
  ufa: 'Уфа',
  rnd: 'Ростов-на-Дону',
  rostov: 'Ростов-на-Дону',
  perm: 'Пермь',
  voronezh: 'Воронеж',
  vrn: 'Воронеж',
  volgograd: 'Волгоград',
  tyumen: 'Тюмень',
  sochi: 'Сочи',
}

type NominatimResult = {
  lat: string
  lon: string
  display_name: string
  name?: string
  osm_type?: string
  osm_id?: number
  place_id?: number
  address?: {
    country_code?: string
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

// ------------------------------------------------------------
// Разбор адреса. Адреса из Timepad пишут как попало:
// «Ул.Мира д.3, бц Троицкий, ауд 416», «- м.Горьковская, …; - м.Парк Победы, …»,
// «Surf Coffee x CHIZHIK, ул. Пестеля, 13-15», «город УФА, филармония, ул. Гоголя 58».
// Nominatim понимает «улица Пестеля 13, Санкт-Петербург».
// ------------------------------------------------------------

// Сокращение — только как отдельное слово: за ним точка, пробел или конец,
// но не буква («наб» не должно срабатывать внутри «Набережная»).
const abbr = (short: string) =>
  new RegExp(`(^|[\\s,])${short}(?:\\.|(?![а-яё]))\\s*`, 'gi')

const STREET_ABBREVIATIONS: Array<[RegExp, string]> = [
  [abbr('ул'), '$1улица '],
  [abbr('пр-т'), '$1проспект '],
  [abbr('просп'), '$1проспект '],
  [abbr('пр'), '$1проспект '],
  [abbr('пер'), '$1переулок '],
  [abbr('наб'), '$1набережная '],
  [abbr('б-р'), '$1бульвар '],
  [abbr('бул'), '$1бульвар '],
  [abbr('пл'), '$1площадь '],
  [abbr('ш'), '$1шоссе '],
  [abbr('туп'), '$1тупик '],
  [abbr('пр-д'), '$1проезд '],
  [/(^|[\s,])П\.\s?С\./g, '$1Петроградской стороны'],
  [/(^|[\s,])В\.\s?О\./g, '$1Васильевского острова'],
]

const STREET_WORD =
  /(улица|проспект|переулок|набережная|бульвар|площадь|шоссе|тупик|проезд|аллея|линия|канал)/i

// Части адреса, которые геокодеру только мешают.
const NOISE_WORDS =
  'этаж|эт\\.?|офис|оф\\.?|кабинет|каб\\.?|ауд\\.?|аудитория|вход|подъезд|помещение|пом\\.?|зал|бц|тц|трц|кв\\.?|комн\\.?|стр\\.?|строение|корп\\.?|корпус|к\\.|лит\\.?|литера'

// Часть целиком про этаж/офис/корпус: «3 этаж», «бц Троицкий», «к.1».
const NOISE_PART =
  new RegExp(`^(\\d+\\s*)?(?:${NOISE_WORDS})(?:[\\s\\d.]|$)`, 'i')

// Хвост внутри части: «д.15 офис 111» → «д.15».
const NOISE_TAIL =
  new RegExp(`\\s+(?:${NOISE_WORDS})(?:[\\s\\d.]|$).*$`, 'i')

const KNOWN_CITIES = [
  ...new Set(Object.values(CITY_NAMES)),
]

export type AddressQueries = {
  // Город, найденный в самом адресе (если есть).
  cityFromAddress: string | null
  // Улица + дом — главный вариант запроса.
  street: string | null
  // Станция метро — запасной вариант.
  metro: string | null
}

export function parseAddress(raw: string): AddressQueries {
  // Несколько адресов через «;» — берём первый.
  let text = raw.split(/;|\n/)[0]
    .replace(/^[\s\-–—•]+/, '')
    .replace(/\(.*?\)/g, ' ')

  let metro: string | null = null

  const metroMatch =
    /(?:^|[\s,])(?:м\.|метро|ст\.\s*м\.)\s*([^,;]+)/i.exec(text)

  if (metroMatch) {
    metro = metroMatch[1].replace(/\.\s*$/, '').trim() || null
    text = text.replace(metroMatch[0], ',')
  }

  let cityFromAddress: string | null = null

  for (const city of KNOWN_CITIES) {
    if (text.toLowerCase().includes(city.toLowerCase())) {
      cityFromAddress = city
    }
  }

  for (const [pattern, replacement] of STREET_ABBREVIATIONS) {
    text = text.replace(pattern, replacement)
  }

  const parts = text
    .split(',')
    .filter((part) => !NOISE_PART.test(part.trim()))
    .map((part) =>
      part
        .replace(NOISE_TAIL, '')
        .replace(/(^|\s)д\.?\s*(\d)/gi, '$1$2')
        .replace(/(^|\s)дом\s+(\d)/gi, '$1$2')
        .replace(/(\d+[а-яa-z]?)\s*[-–\/]\s*\d+[а-яa-z]?/gi, '$1')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .filter(
      (part) =>
        !/^(г\.?|город)\s/i.test(part) &&
        !KNOWN_CITIES.some(
          (city) => part.toLowerCase() === city.toLowerCase(),
        ),
    )

  // Улица и следующий за ней номер дома.
  const streetIndex = parts.findIndex((part) => STREET_WORD.test(part))

  let street: string | null = null

  if (streetIndex !== -1) {
    const streetPart = parts[streetIndex]
    const next = parts[streetIndex + 1]

    street =
      /\d/.test(streetPart) || !next || !/^\d/.test(next)
        ? streetPart
        : `${streetPart} ${next}`
  } else {
    // «Мучной пер, 5» и т.п. без распознанного слова — часть с номером дома.
    const withNumber = parts.findIndex((part) => /\d/.test(part))

    if (withNumber > 0) {
      street = `${parts[withNumber - 1]} ${parts[withNumber]}`
    } else if (withNumber === 0) {
      street = parts[0]
    }
  }

  return {
    cityFromAddress,
    street: street?.replace(/\s+/g, ' ').trim() || null,
    metro,
  }
}

let lastRequestAt = 0

// Временная ошибка: сеть, сервер Nominatim, ограничение частоты.
class RetryableError extends Error {
  constructor(
    readonly kind: 'network' | 'server' | 'rate',
    message: string,
  ) {
    super(message)
  }
}

function log(message: string) {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

let stopping = false

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (stopping) {
      process.exit(1)
    }

    stopping = true
    log('Останавливаемся после текущей площадки…')
  })
}

async function geocode(
  query: string,
): Promise<NominatimResult | null> {
  const queryKey = `venue|${query.toLowerCase()}`

  const cached = await prisma.place.findUnique({
    where: { queryKey },
  })

  if (cached) {
    return {
      lat: String(cached.latitude),
      lon: String(cached.longitude),
      display_name: cached.displayName,
      name: cached.name,
    }
  }

  const wait = lastRequestAt + REQUEST_GAP_MS - Date.now()

  if (wait > 0) {
    await sleep(wait)
  }

  lastRequestAt = Date.now()

  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: '1',
    addressdetails: '1',
    'accept-language': 'ru',
    countrycodes:
      process.env.GEOCODER_COUNTRY_CODES?.trim() || 'ru',
  })

  let response: Response

  try {
    response = await fetch(
      `${BASE_URL}/search?${params.toString()}`,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
        signal: AbortSignal.timeout(15_000),
      },
    )
  } catch (error) {
    throw new RetryableError(
      'network',
      `сеть: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (response.status === 429 || response.status === 403) {
    throw new RetryableError('rate', `Nominatim ограничил запросы (HTTP ${response.status})`)
  }

  if (response.status >= 500) {
    throw new RetryableError('server', `Nominatim HTTP ${response.status}`)
  }

  if (!response.ok) {
    return null
  }

  let items: NominatimResult[]

  try {
    items = (await response.json()) as NominatimResult[]
  } catch {
    throw new RetryableError('server', 'Nominatim вернул не JSON')
  }

  const [best] = items

  if (!best) {
    return null
  }

  const latitude = Number(best.lat)
  const longitude = Number(best.lon)

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null
  }

  await prisma.place.upsert({
    where: { queryKey },
    update: {},
    create: {
      queryKey,
      query,
      name: best.name || query,
      displayName: best.display_name,
      countryCode: best.address?.country_code ?? null,
      latitude,
      longitude,
      provider: 'nominatim',
      externalId:
        best.osm_type && best.osm_id
          ? `${best.osm_type}:${best.osm_id}`
          : best.place_id
            ? String(best.place_id)
            : null,
    },
  })

  return best
}

// Повтор с нарастающей паузой: ограничение — от 5 минут, сеть — от 30 секунд.
async function withRetry<T>(task: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task()
    } catch (error) {
      if (!(error instanceof RetryableError) || attempt >= 5 || stopping) {
        throw error
      }

      const base = error.kind === 'rate' ? 5 * 60_000 : 30_000
      const cap = error.kind === 'rate' ? 30 * 60_000 : 10 * 60_000
      const pause = Math.min(base * 2 ** attempt, cap)

      log(`${error.message} — пауза ${Math.round(pause / 1000)} с, повтор ${attempt + 1}/5`)
      await sleep(pause)
    }
  }
}

// Площадки, которые не нашлись: в режиме службы пробуем снова через сутки.
const failedAt = new Map<string, number>()
const RETRY_FAILED_AFTER_MS = 24 * 60 * 60 * 1000

async function runPass(apply: boolean) {

  // Площадки без координат, у которых есть активные события.
  const venues = await prisma.venue.findMany({
    where: {
      OR: [{ latitude: null }, { longitude: null }],
      address: { not: null },
      events: { some: { status: 'ACTIVE' } },
    },
    select: {
      id: true,
      name: true,
      address: true,
      city: true,
      events: {
        where: { status: 'ACTIVE' },
        select: { sourceCity: true },
        take: 1,
      },
    },
  })

  // «Центр» каждого города — медиана уже известных координат площадок.
  const located = await prisma.venue.findMany({
    where: {
      latitude: { not: null },
      longitude: { not: null },
      events: { some: { status: 'ACTIVE' } },
    },
    select: {
      latitude: true,
      longitude: true,
      events: { select: { sourceCity: true }, take: 1 },
    },
  })

  const byCity = new Map<string, { lat: number[]; lon: number[] }>()

  for (const venue of located) {
    const city = venue.events[0]?.sourceCity

    if (!city || venue.latitude === null || venue.longitude === null) {
      continue
    }

    const bucket = byCity.get(city) ?? { lat: [], lon: [] }
    bucket.lat.push(venue.latitude)
    bucket.lon.push(venue.longitude)
    byCity.set(city, bucket)
  }

  const cityCenter = new Map<string, { lat: number; lon: number }>()

  for (const [city, bucket] of byCity) {
    if (bucket.lat.length >= 5) {
      cityCenter.set(city, {
        lat: median(bucket.lat),
        lon: median(bucket.lon),
      })
    }
  }

  const now = Date.now()

  const pending = venues.filter((venue) => {
    const failed = failedAt.get(venue.id)
    return !failed || now - failed > RETRY_FAILED_AFTER_MS
  })

  const todo = apply ? pending : pending.slice(0, 10)

  log(
    `Площадок без координат: ${venues.length} (к обработке: ${todo.length}). ${
      apply ? 'Определяем все.' : 'Предпросмотр первых 10 (в базу не пишем).'
    }`,
  )

  let found = 0
  let notFound = 0
  let rejected = 0

  let errors = 0

  for (const [index, venue] of todo.entries()) {
    if (stopping) {
      break
    }

    const slug = venue.events[0]?.sourceCity ?? null
    const cityName =
      (slug ? CITY_NAMES[slug] : undefined) ??
      (venue.city && /[а-яё]/i.test(venue.city) ? venue.city : null)

    const parsed = parseAddress(venue.address ?? '')

    // Город из адреса важнее города события: Timepad кладёт в выгрузку
    // одного города события из других («город УФА, …» среди Петербурга).
    const queryCity = parsed.cityFromAddress ?? cityName
    const sameCity = !parsed.cityFromAddress || parsed.cityFromAddress === cityName

    const withCity = (text: string) =>
      queryCity && !text.toLowerCase().includes(queryCity.toLowerCase())
        ? `${text}, ${queryCity}`
        : text

    const queries = [
      parsed.street ? withCity(parsed.street) : null,
      venue.name && venue.name !== venue.address ? withCity(venue.name) : null,
      parsed.metro ? withCity(`станция метро ${parsed.metro}`) : null,
    ]
      .filter((query): query is string => Boolean(query))
      .filter((query, index, list) => list.indexOf(query) === index)

    let result: { lat: number; lon: number; label: string } | null = null
    let reason = 'не найдено'

    let failedHard = false

    for (const query of queries) {
      let hit: NominatimResult | null

      try {
        hit = await withRetry(() => geocode(query))
      } catch (error) {
        // Не вышло и после повторов — пропускаем площадку, идём дальше.
        log(`Площадка «${venue.name}» пропущена: ${error instanceof Error ? error.message : String(error)}`)
        failedHard = true

        // Ограничение не снимают — не стучимся сразу дальше, отдыхаем полчаса.
        if (error instanceof RetryableError && error.kind === 'rate' && !stopping) {
          log('Долгое ограничение Nominatim — пауза 30 минут')
          await sleep(30 * 60_000)
        }

        break
      }

      if (!hit) {
        continue
      }

      const lat = Number(hit.lat)
      const lon = Number(hit.lon)
      // Проверка «в своём городе» — только если город площадки = город события.
      const center = slug && sameCity ? cityCenter.get(slug) : undefined

      if (
        center &&
        distanceKm(lat, lon, center.lat, center.lon) > MAX_DISTANCE_FROM_CITY_KM
      ) {
        reason = `найдено далеко от города: ${hit.display_name.slice(0, 60)}`
        continue
      }

      result = { lat, lon, label: hit.display_name }
      break
    }

    if (failedHard) {
      errors += 1
    } else if (result) {
      found += 1

      if (apply) {
        try {
          await prisma.venue.update({
            where: { id: venue.id },
            data: { latitude: result.lat, longitude: result.lon },
          })
        } catch (error) {
          errors += 1
          log(`Не записали «${venue.name}»: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } else if (reason.startsWith('найдено далеко')) {
      rejected += 1
      failedAt.set(venue.id, Date.now())
    } else {
      notFound += 1
      failedAt.set(venue.id, Date.now())
    }

    if (!apply) {
      console.log(
        `\n${venue.name}\n  адрес: ${venue.address}\n  запросы: ${queries.join(' | ')}\n  → ${
          result
            ? `${result.lat.toFixed(5)}, ${result.lon.toFixed(5)}  (${result.label.slice(0, 80)})`
            : reason
        }`,
      )
    } else if ((index + 1) % 50 === 0 || index + 1 === todo.length) {
      log(
        `${index + 1}/${todo.length}: найдено ${found}, не найдено ${notFound}, отброшено ${rejected}, ошибок ${errors}`,
      )
    }
  }

  log(
    `Итого: найдено ${found}, не найдено ${notFound}, отброшено (не тот город) ${rejected}, ошибок ${errors}.`,
  )

  if (!apply) {
    console.log('Это предпросмотр. Записать для всех: добавьте --apply')
  }
}

async function main() {
  const apply = process.argv.includes('--apply')
  const loop = apply && process.argv.includes('--loop')

  const loopHours = Math.max(
    Number(process.env.GEOCODER_LOOP_HOURS) || 6,
    0.5,
  )

  do {
    try {
      await runPass(apply)
    } catch (error) {
      // Например, база недоступна: в режиме службы — подождать и снова.
      log(`Проход прерван: ${error instanceof Error ? error.message : String(error)}`)

      if (!loop) {
        throw error
      }
    }

    if (loop && !stopping) {
      log(`Следующий проход через ${loopHours} ч.`)

      // Спим кусками, чтобы быстро реагировать на остановку службы.
      const until = Date.now() + loopHours * 3_600_000

      while (Date.now() < until && !stopping) {
        await sleep(Math.min(30_000, until - Date.now()))
      }
    }
  } while (loop && !stopping)
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
