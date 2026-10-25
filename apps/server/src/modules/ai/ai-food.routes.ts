// ============================================================
// POST /api/ai/food-near-event  { eventId }   (#40)
//
// Помощник советует, где поесть рядом с мероприятием.
// 1) Заведения в радиусе 1 км от площадки (пусто — 2 км).
// 2) Модель (Ollama, как у основного помощника) выбирает 3 и пишет,
//    почему — с учётом времени: вечером ужин/бар после, днём кофе/обед.
// 3) Модель недоступна или ответила не по формату — подборка без ИИ:
//    ближайшие подходящих типов + короткие пояснения. Ответ есть всегда.
// Основной модуль помощника (ai.routes.ts) не меняется.
// ============================================================

import type { FastifyInstance } from 'fastify'

import { z } from 'zod'

import { prisma } from '@evently/db'

const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 25_000)

const BodySchema = z.object({
  eventId: z.string().uuid(),
})

// Часовой пояс городов парсера.
const CITY_UTC_OFFSET: Record<string, number> = {
  msk: 3, spb: 3, kzn: 3, nnv: 3, voronezh: 3, volgograd: 3, rostov: 3, krd: 3,
  smr: 4,
  ekb: 5, chelyabinsk: 5, perm: 5, ufa: 5,
  omsk: 6,
  nsk: 7, krasnoyarsk: 7,
}

const KIND_LABELS: Record<string, string> = {
  restaurant: 'ресторан',
  cafe: 'кафе',
  coffee: 'кофейня',
  bar: 'бар',
  fast_food: 'фастфуд',
  bakery: 'пекарня',
  canteen: 'столовая',
  other: 'заведение',
}

const CUISINE_LABELS: Record<string, string> = {
  russian: 'русская кухня', italian: 'итальянская кухня', pizza: 'пицца',
  japanese: 'японская кухня', sushi: 'суши', georgian: 'грузинская кухня',
  asian: 'азиатская кухня', chinese: 'китайская кухня', korean: 'корейская кухня',
  vietnamese: 'вьетнамская кухня', uzbek: 'узбекская кухня', caucasian: 'кавказская кухня',
  european: 'европейская кухня', french: 'французская кухня', american: 'американская кухня',
  burger: 'бургеры', shawarma: 'шаурма', coffee_shop: 'кофе', dessert: 'десерты',
  breakfast: 'завтраки', seafood: 'морепродукты', steak_house: 'стейки',
  vegetarian: 'вегетарианская кухня', beer: 'пиво', wine: 'вино', tea: 'чай',
}

type Moment = 'evening' | 'day' | 'unknown'

// Когда мероприятие: вечером (с 17:00) — ужин/бар после, днём — кофе/обед.
function momentOf(
  startsAt: Date | null,
  city: string | null,
): { moment: Moment; hint: string } {
  if (!startsAt) {
    return { moment: 'unknown', hint: 'время мероприятия неизвестно' }
  }

  const offset = CITY_UTC_OFFSET[city ?? ''] ?? 3
  const hour = new Date(startsAt.getTime() + offset * 3_600_000).getUTCHours()

  return hour >= 17
    ? { moment: 'evening', hint: `мероприятие вечером (начало в ${hour}:00) — поужинать или зайти в бар после` }
    : { moment: 'day', hint: `мероприятие днём (начало в ${hour}:00) — кофе или обед до/после` }
}

function distanceM(lat1: number, lon1: number, lat2: number, lon2: number) {
  const rad = Math.PI / 180
  const h =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2

  return Math.round(2 * 6371000 * Math.asin(Math.sqrt(h)))
}

function cuisineText(cuisine: unknown) {
  return Array.isArray(cuisine)
    ? cuisine
        .filter((item): item is string => typeof item === 'string')
        .slice(0, 2)
        .map((item) => CUISINE_LABELS[item.toLowerCase()] ?? item.replace(/_/g, ' '))
        .join(', ')
    : ''
}

function walk(meters: number) {
  const minutes = Math.max(1, Math.round(meters / 80))
  return meters < 1000
    ? `${Math.round(meters / 10) * 10} м, ${minutes} мин пешком`
    : `${(meters / 1000).toFixed(1).replace('.', ',')} км, ${minutes} мин пешком`
}

const PLACE_SELECT = {
  id: true,
  source: true,
  name: true,
  kind: true,
  cuisine: true,
  address: true,
  latitude: true,
  longitude: true,
  openingHours: true,
  imageUrl: true,
  attribution: true,
} as const

const ChoiceSchema = z.object({
  intro: z.string().min(1).max(600),
  picks: z
    .array(
      z.object({
        id: z.string(),
        reason: z.string().min(1).max(300),
      }),
    )
    .min(1)
    .max(3),
})

const CHOICE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    intro: { type: 'string' },
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['id', 'reason'],
      },
    },
  },
  required: ['intro', 'picks'],
}

export async function aiFoodRoutes(app: FastifyInstance) {
  app.post('/food-near-event', async (request, reply) => {
    const parsed = BodySchema.safeParse(request.body)

    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST' })
    }

    const now = new Date()

    const event = await prisma.event.findUnique({
      where: { id: parsed.data.eventId },
      select: {
        id: true,
        title: true,
        source: true,
        sourceCity: true,
        venue: { select: { id: true, name: true, address: true, latitude: true, longitude: true } },
        categories: { select: { category: { select: { name: true } } } },
        occurrences: {
          where: { startsAt: { gte: now } },
          orderBy: { startsAt: 'asc' },
          take: 1,
          select: { startsAt: true },
        },
      },
    })

    if (!event) {
      return reply.status(404).send({ error: 'EVENT_NOT_FOUND' })
    }

    const base = { event: { id: event.id, title: event.title } }

    let lat = event.venue?.latitude ?? null
    let lon = event.venue?.longitude ?? null

    // Координат ещё нет (геокодер площадок до неё не дошёл) — ищем по адресу сейчас (#41).
    if ((lat == null || lon == null) && event.venue) {
      const found = await geocodeVenueNow(event.venue, event.sourceCity).catch(
        (error: unknown) => {
          request.log.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'venue geocode on demand failed',
          )
          return null
        },
      )

      if (found) {
        lat = found.latitude
        lon = found.longitude
      }
    }

    if (lat == null || lon == null) {
      return {
        ...base,
        ai: false,
        answer: `Не получилось найти площадку «${event.title}» на карте, поэтому подсказать, где поесть рядом, пока не могу 😔`,
        places: [],
      }
    }

    // Заведения в 1 км, если пусто — в 2 км.
    let nearby: Awaited<ReturnType<typeof findNear>> = []

    for (const radiusM of [1000, 2000]) {
      nearby = await findNear(lat, lon, radiusM)

      if (nearby.length > 0) {
        break
      }
    }

    if (nearby.length === 0) {
      const cityHasPlaces = event.sourceCity
        ? (await prisma.foodPlace.count({
            where: { city: event.sourceCity, active: true },
          })) > 0
        : true

      const cityName = CITY_NAMES[event.sourceCity ?? '']

      return {
        ...base,
        ai: false,
        answer: cityHasPlaces
          ? `Рядом с «${event.title}» в нашей базе пока нет заведений — может, это повод взять перекус с собой 🙂`
          : `Кафе и рестораны${cityName ? ` города ${cityName}` : ' этого города'} мы ещё не добавили — скоро научусь советовать и здесь 🙂`,
        places: [],
      }
    }

    // kinopoisk-cinema: дата условная (#28) — время не учитываем.
    const { moment, hint } =
      event.source === 'kinopoisk-cinema'
        ? { moment: 'unknown' as Moment, hint: 'время мероприятия неизвестно' }
        : momentOf(event.occurrences[0]?.startsAt ?? null, event.sourceCity)

    const candidates = nearby.slice(0, 8)

    const byId = new Map(candidates.map((place) => [place.id, place]))

    const toPlace = (place: (typeof candidates)[number], reason: string) => ({
      ...place,
      cuisine: Array.isArray(place.cuisine) ? place.cuisine : [],
      reason,
    })

    // ---------- 1) модель ----------
    const aiChoice = await askModel({
      title: event.title,
      categories: event.categories.map((item) => item.category.name).join(', '),
      venue: event.venue?.name ?? null,
      hint,
      candidates: candidates.map((place) => ({
        id: place.id,
        name: place.name,
        type: KIND_LABELS[place.kind] ?? place.kind,
        cuisine: cuisineText(place.cuisine) || null,
        distance: walk(place.distanceM),
        hours: place.openingHours,
      })),
    }).catch((error: unknown) => {
      request.log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'AI food choice failed, using fallback',
      )
      return null
    })

    if (aiChoice) {
      const picks = aiChoice.picks
        .filter((pick) => byId.has(pick.id))
        .filter((pick, index, list) => list.findIndex((item) => item.id === pick.id) === index)
        .slice(0, 3)

      if (picks.length > 0) {
        return {
          ...base,
          ai: true,
          answer: aiChoice.intro,
          places: picks.map((pick) => toPlace(byId.get(pick.id)!, pick.reason)),
        }
      }
    }

    // ---------- 2) без ИИ ----------
    const preferred =
      moment === 'evening'
        ? ['restaurant', 'bar', 'cafe']
        : moment === 'day'
          ? ['cafe', 'coffee', 'canteen', 'bakery', 'restaurant']
          : ['cafe', 'restaurant', 'coffee']

    const chosen: typeof candidates = []

    for (const kind of preferred) {
      const place = candidates.find(
        (item) => item.kind === kind && !chosen.includes(item),
      )

      if (place && chosen.length < 3) {
        chosen.push(place)
      }
    }

    for (const place of candidates) {
      if (chosen.length >= 3) break
      if (!chosen.includes(place)) chosen.push(place)
    }

    const purpose = (kind: string) =>
      moment === 'evening'
        ? kind === 'bar'
          ? 'удобно зайти после'
          : 'можно поужинать после'
        : kind === 'coffee' || kind === 'bakery'
          ? 'можно выпить кофе до начала'
          : 'можно перекусить до или после'

    return {
      ...base,
      ai: false,
      answer:
        moment === 'evening'
          ? `После «${event.title}» можно поужинать рядом — вот что ближе всего к площадке:`
          : `Рядом с «${event.title}» есть где перекусить — вот ближайшие варианты:`,
      places: chosen.map((place) => {
        const cuisine = cuisineText(place.cuisine)
        const kind = KIND_LABELS[place.kind] ?? 'заведение'

        return toPlace(
          place,
          `${kind[0].toUpperCase()}${kind.slice(1)}${cuisine ? `, ${cuisine}` : ''} — ${walk(place.distanceM)} от площадки, ${purpose(place.kind)}.`,
        )
      }),
    }
  })
}

async function findNear(lat: number, lon: number, radiusM: number) {
  const dLat = radiusM / 111_320
  const dLon = radiusM / (111_320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01))

  const rows = await prisma.foodPlace.findMany({
    where: {
      active: true,
      latitude: { gte: lat - dLat, lte: lat + dLat },
      longitude: { gte: lon - dLon, lte: lon + dLon },
    },
    select: PLACE_SELECT,
    take: 500,
  })

  return rows
    .map((place) => ({
      ...place,
      distanceM: distanceM(lat, lon, place.latitude!, place.longitude!),
    }))
    .filter((place) => place.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM)
}

async function askModel(context: {
  title: string
  categories: string
  venue: string | null
  hint: string
  candidates: Array<{
    id: string
    name: string
    type: string
    cuisine: string | null
    distance: string
    hours: string | null
  }>
}) {
  const ollamaUrl = (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '')

  const model =
    process.env.OLLAMA_RESPONSE_MODEL ??
    process.env.OLLAMA_INTENT_MODEL ??
    process.env.OLLAMA_MODEL ??
    'qwen3:0.6b'

  const response = await fetch(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      keep_alive: '30m',
      format: CHOICE_JSON_SCHEMA,
      options: { temperature: 0.4, num_predict: 400 },
      messages: [
        {
          role: 'system',
          content: [
            '/no_think',
            'Ты — Evently, дружелюбный помощник по досугу. Общаешься на «ты», по-русски, коротко и по-человечески.',
            'Пользователь идёт на мероприятие. Тебе даны реальные заведения рядом с площадкой (кандидаты).',
            'Выбери 2–3 заведения, которые лучше подходят к этому мероприятию и времени: вечером — поужинать или бар после, днём — кофе или обед. Учитывай тип, кухню, расстояние и часы работы. Желательно разные по типу.',
            'intro — 1–2 живых предложения: свяжи мероприятие и еду (например, «после концерта отлично зайдёт…»).',
            'Для каждого выбранного — reason: одна фраза, почему подходит. Расстояние, тип и кухню бери только из кандидата, ничего не придумывай.',
            'В picks — только id из списка кандидатов. Без markdown и ссылок. Верни только JSON.',
          ].join(' '),
        },
        {
          role: 'user',
          content: [
            `Мероприятие: «${context.title}»${context.categories ? ` (${context.categories})` : ''}${context.venue ? `, площадка: ${context.venue}` : ''}.`,
            `Время: ${context.hint}.`,
            `Кандидаты:\n${JSON.stringify(context.candidates)}`,
          ].join('\n'),
        },
      ],
    }),
  })

  if (!response.ok) {
    throw new Error(`OLLAMA_FOOD_${response.status}`)
  }

  const body = (await response.json()) as { message?: { content?: string } }
  const content = body.message?.content

  if (!content) {
    throw new Error('OLLAMA_FOOD_EMPTY')
  }

  return ChoiceSchema.parse(JSON.parse(content))
}

// ---------- координаты площадки по адресу, на лету (#41) ----------

const CITY_NAMES: Record<string, string> = {
  msk: 'Москва', spb: 'Санкт-Петербург', nsk: 'Новосибирск', ekb: 'Екатеринбург',
  kzn: 'Казань', krd: 'Краснодар', krasnoyarsk: 'Красноярск', chelyabinsk: 'Челябинск',
  nnv: 'Нижний Новгород', omsk: 'Омск', smr: 'Самара', ufa: 'Уфа',
  rostov: 'Ростов-на-Дону', perm: 'Пермь', voronezh: 'Воронеж', volgograd: 'Волгоград',
}

const NOISE =
  '(?:этаж|эт\\.|офис|оф\\.|кабинет|каб\\.|ауд\\.|аудитория|вход|подъезд|помещение|пом\\.|зал|бц|тц|трц|трк|кв\\.|стр\\.|строение|корп\\.|корпус|лит\\.|литера)'

// «ул. Гоголя, 13 ТРЦ «Галерея», 3 этаж» → «ул. Гоголя 13»
function cleanAddress(raw: string) {
  const parts = raw
    .split(/;|\n/)[0]
    .replace(/\(.*?\)/g, ' ')
    .replace(/[«»"]/g, ' ')
    .split(',')
    .map((part) => part.trim())
    // «ТРЦ Галерея», «3 этаж» — целиком; «13 ТРЦ Галерея» → дальше станет «13».
    .filter(
      (part) =>
        part &&
        !new RegExp(`^${NOISE}(\\s|$)`, 'i').test(part) &&
        !/^\d+\s*(этаж|эт\.)/i.test(part),
    )
    .map((part) => part.replace(new RegExp(`\\s+${NOISE}(\\s|$).*$`, 'i'), '').trim())
    .filter((part) => part && !/^(г\.?|город)\s/i.test(part))

  return parts.slice(0, 2).join(' ').replace(/\s+/g, ' ').trim()
}

let lastGeocodeAt = 0
let geocodeQueue: Promise<unknown> = Promise.resolve()

// Nominatim: не чаще 1 запроса в секунду. Кеш — таблица Place (как у скрипта площадок).
function nominatim(query: string): Promise<{ latitude: number; longitude: number; name: string; displayName: string } | null> {
  const run = geocodeQueue.then(async () => {
    const queryKey = `venue|${query.toLowerCase()}`
    const cached = await prisma.place.findUnique({ where: { queryKey } })

    if (cached) {
      return { latitude: cached.latitude, longitude: cached.longitude, name: cached.name, displayName: cached.displayName }
    }

    const wait = lastGeocodeAt + 1100 - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    lastGeocodeAt = Date.now()

    const params = new URLSearchParams({
      q: query,
      format: 'jsonv2',
      limit: '1',
      'accept-language': 'ru',
      countrycodes: process.env.GEOCODER_COUNTRY_CODES?.trim() || 'ru',
    })

    const baseUrl = (process.env.GEOCODER_BASE_URL ?? 'https://nominatim.openstreetmap.org').replace(/\/$/, '')

    const response = await fetch(`${baseUrl}/search?${params}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': process.env.GEOCODER_USER_AGENT ?? 'EventlyHackathon/0.1',
      },
      signal: AbortSignal.timeout(8_000),
    })

    if (!response.ok) return null

    const items = (await response.json()) as Array<{ lat: string; lon: string; display_name: string; name?: string }>
    const item = items[0]
    const latitude = Number(item?.lat)
    const longitude = Number(item?.lon)

    if (!item || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null

    const name = item.name || item.display_name.split(',')[0] || query

    await prisma.place
      .upsert({
        where: { queryKey },
        update: {},
        create: { queryKey, query, name, displayName: item.display_name, latitude, longitude, provider: 'nominatim' },
      })
      .catch(() => undefined)

    return { latitude, longitude, name, displayName: item.display_name }
  })

  geocodeQueue = run.catch(() => undefined)

  return run
}

export async function geocodeVenueNow(
  venue: { id: string; name: string; address: string | null },
  city: string | null,
) {
  const cityName = CITY_NAMES[city ?? '']
  const withCity = (text: string) =>
    cityName && !text.toLowerCase().includes(cityName.toLowerCase()) ? `${text}, ${cityName}` : text

  const queries = [
    venue.address ? cleanAddress(venue.address) : '',
    venue.name,
  ]
    .filter((text) => text.length >= 3)
    .map(withCity)

  for (const query of [...new Set(queries)]) {
    const found = await nominatim(query)

    if (found) {
      // Запоминаем у площадки — дальше и «Где поесть рядом», и «Рядом» работают сразу.
      await prisma.venue
        .update({ where: { id: venue.id }, data: { latitude: found.latitude, longitude: found.longitude } })
        .catch(() => undefined)

      return found
    }
  }

  return null
}
