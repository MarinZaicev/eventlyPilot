// ============================================================
// GET /api/geo/search?q=метро Курская&city=msk  (#33)
//
// Запасной путь для «Рядом»: если MAX не отдал геопозицию,
// пользователь вводит метро/улицу/район — находим координаты.
// Nominatim (OpenStreetMap), те же настройки, что у геокодера
// помощника и скрипта площадок; кеш — таблица Place.
// Не чаще 1 запроса в секунду на весь сервер (правило Nominatim).
// ============================================================

import type { FastifyInstance } from 'fastify'

import { prisma } from '@evently/db'

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
  omsk: 'Омск',
  smr: 'Самара',
  ufa: 'Уфа',
  rostov: 'Ростов-на-Дону',
  perm: 'Пермь',
  voronezh: 'Воронеж',
  volgograd: 'Волгоград',
}

type NominatimResult = {
  lat: string
  lon: string
  display_name: string
  name?: string
}

// Очередь: между запросами к Nominatim не меньше 1.1 с.
let queue: Promise<unknown> = Promise.resolve()
let lastRequestAt = 0

function throttled<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastRequestAt + 1100 - Date.now()

    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait))
    }

    lastRequestAt = Date.now()

    return task()
  })

  queue = run.catch(() => undefined)

  return run
}

function shortLabel(result: NominatimResult, query: string) {
  return (
    result.name ||
    result.display_name.split(',').slice(0, 2).join(',').trim() ||
    query
  )
}

export async function geoRoutes(app: FastifyInstance) {
  app.get('/search', async (request, reply) => {
    const { q, city } = request.query as { q?: string; city?: string }

    const text = (q ?? '').replace(/\s+/g, ' ').trim()

    if (text.length < 2 || text.length > 120) {
      return reply.status(400).send({ error: 'INVALID_QUERY' })
    }

    const cityName = city ? CITY_NAMES[city] : undefined

    const query =
      cityName && !text.toLowerCase().includes(cityName.toLowerCase())
        ? `${text}, ${cityName}`
        : text

    const queryKey = `geo|${query.toLowerCase()}`

    const cached = await prisma.place.findUnique({ where: { queryKey } })

    if (cached) {
      return {
        latitude: cached.latitude,
        longitude: cached.longitude,
        label: cached.name,
      }
    }

    const baseUrl = (
      process.env.GEOCODER_BASE_URL ?? 'https://nominatim.openstreetmap.org'
    ).replace(/\/$/, '')

    let result: NominatimResult | undefined

    try {
      result = await throttled(async () => {
        const params = new URLSearchParams({
          q: query,
          format: 'jsonv2',
          limit: '1',
          'accept-language': 'ru',
          countrycodes: process.env.GEOCODER_COUNTRY_CODES?.trim() || 'ru',
        })

        const response = await fetch(`${baseUrl}/search?${params}`, {
          headers: {
            Accept: 'application/json',
            'User-Agent':
              process.env.GEOCODER_USER_AGENT ?? 'EventlyHackathon/0.1',
          },
          signal: AbortSignal.timeout(10_000),
        })

        if (!response.ok) {
          return undefined
        }

        const items = (await response.json()) as NominatimResult[]

        return items[0]
      })
    } catch (error) {
      request.log.warn({ error: String(error) }, 'geo search failed')

      return reply.status(503).send({ error: 'GEOCODER_UNAVAILABLE' })
    }

    const latitude = Number(result?.lat)
    const longitude = Number(result?.lon)

    if (!result || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return reply.status(404).send({ error: 'PLACE_NOT_FOUND' })
    }

    const label = shortLabel(result, text)

    await prisma.place
      .upsert({
        where: { queryKey },
        update: {},
        create: {
          queryKey,
          query,
          name: label,
          displayName: result.display_name,
          city: cityName ?? null,
          latitude,
          longitude,
          provider: 'nominatim',
        },
      })
      .catch(() => undefined)

    return { latitude, longitude, label }
  })
}
