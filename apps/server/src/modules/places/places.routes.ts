/*
 * GET /api/places?city=nsk&kind=cafe&q=пицца&lat=55.03&lon=82.92&limit=30&offset=0
 *
 * kind  — restaurant | cafe | coffee | bar | fast_food | bakery | canteen | other (можно через запятую)
 * q     — поиск по названию и кухне
 * lat/lon — если переданы, сортировка по расстоянию (distanceM в ответе)
 *
 * У заведений из OpenStreetMap в карточке нужно показывать item.attribution
 * («© участники OpenStreetMap») — это условие лицензии ODbL.
 */
import type { FastifyInstance } from 'fastify'

import { prisma } from '@evently/db'

import { geocodeVenueNow } from '../ai/ai-food.routes.js'

const SELECT = {
  id: true,
  source: true,
  city: true,
  name: true,
  kind: true,
  cuisine: true,
  address: true,
  latitude: true,
  longitude: true,
  subway: true,
  phone: true,
  website: true,
  sourceUrl: true,
  openingHours: true,
  description: true,
  imageUrl: true,
  attribution: true,
} as const

function distanceM(lat1: number, lon1: number, lat2: number, lon2: number) {
  const rad = Math.PI / 180
  const h =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2
  return Math.round(2 * 6371000 * Math.asin(Math.sqrt(h)))
}

export async function placesRoutes(app: FastifyInstance) {
  app.get('/', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>
    const city = query.city?.trim()
    if (!city) {
      return reply.status(400).send({ error: 'CITY_REQUIRED' })
    }
    const limit = Math.min(Math.max(Number(query.limit) || 30, 1), 100)
    const offset = Math.max(Number(query.offset) || 0, 0)
    const kinds = (query.kind ?? '').split(',').map((k) => k.trim()).filter(Boolean)
    const q = query.q?.trim()
    const lat = Number(query.lat)
    const lon = Number(query.lon)
    const nearby = Number.isFinite(lat) && Number.isFinite(lon) && query.lat !== undefined

    const where = {
      city,
      active: true,
      ...(kinds.length ? { kind: { in: kinds } } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' as const } },
              { description: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    }

    if (nearby) {
      // В одном городе — максимум несколько тысяч строк, сортировать в памяти нормально
      const all = await prisma.foodPlace.findMany({ where, select: SELECT })
      const sorted = all
        .filter((p) => p.latitude !== null && p.longitude !== null)
        .map((p) => ({ ...p, distanceM: distanceM(lat, lon, p.latitude!, p.longitude!) }))
        .sort((a, b) => a.distanceM - b.distanceM)
      return { total: sorted.length, items: sorted.slice(offset, offset + limit) }
    }

    const [total, items] = await Promise.all([
      prisma.foodPlace.count({ where }),
      prisma.foodPlace.findMany({
        where,
        select: SELECT,
        // Сначала карточки с фото и описанием (KudaGo), потом остальные
        orderBy: [{ imageUrl: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
        skip: offset,
        take: limit,
      }),
    ])
    return { total, items }
  })

  /*
   * GET /api/places/near-event/:eventId?radius=1000&limit=5
   * Заведения рядом с площадкой события («Где поесть рядом»).
   * Ищем в квадрате вокруг площадки (индекс по координатам), потом точное
   * расстояние. Город не фильтруем: квадрата достаточно, и не зависим
   * от того, как назван город у события и у заведения.
   */
  app.get('/near-event/:eventId', async (request, reply) => {
    const { eventId } = request.params as { eventId: string }
    const query = request.query as Record<string, string | undefined>

    if (!/^[0-9a-f-]{36}$/i.test(eventId)) {
      return reply.status(400).send({ error: 'INVALID_EVENT_ID' })
    }

    const radiusM = Math.min(Math.max(Number(query.radius) || 1000, 100), 3000)
    const limit = Math.min(Math.max(Number(query.limit) || 5, 1), 20)

    const event = await prisma.event.findUnique({
      where: { id: eventId },
      select: {
        sourceCity: true,
        venue: { select: { id: true, name: true, address: true, latitude: true, longitude: true } },
      },
    })

    if (!event) {
      return reply.status(404).send({ error: 'EVENT_NOT_FOUND' })
    }

    let lat = event.venue?.latitude ?? null
    let lon = event.venue?.longitude ?? null

    // Координат ещё нет — ищем площадку по адресу сразу и запоминаем (#42).
    if ((lat == null || lon == null) && event.venue) {
      const found = await geocodeVenueNow(event.venue, event.sourceCity).catch(() => null)

      if (found) {
        lat = found.latitude
        lon = found.longitude
      }
    }

    if (lat == null || lon == null) {
      return { hasLocation: false, radiusM, items: [] }
    }

    const dLat = radiusM / 111_320
    const dLon = radiusM / (111_320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01))

    const candidates = await prisma.foodPlace.findMany({
      where: {
        active: true,
        latitude: { gte: lat - dLat, lte: lat + dLat },
        longitude: { gte: lon - dLon, lte: lon + dLon },
      },
      select: SELECT,
      take: 500,
    })

    const items = candidates
      .map((place) => ({
        ...place,
        distanceM: distanceM(lat, lon, place.latitude!, place.longitude!),
      }))
      .filter((place) => place.distanceM <= radiusM)
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, limit)

    return { hasLocation: true, radiusM, items }
  })

  app.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const place = await prisma.foodPlace.findUnique({ where: { id }, select: SELECT })
    if (!place) return reply.status(404).send({ error: 'PLACE_NOT_FOUND' })
    return place
  })
}
