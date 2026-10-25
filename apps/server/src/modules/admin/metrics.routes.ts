// ============================================================
// Метрики рекомендаций — страница для команды и жюри (#31).
// Не часть Mini App: открывается в обычном браузере.
//
//   GET /api/admin/metrics?key=<ADMIN_METRICS_KEY>        — страница
//   GET /api/admin/metrics/data?key=…&days=14              — данные (JSON)
//
// Без ADMIN_METRICS_KEY в .env страница выключена (404).
// Часовой пояс дней — METRICS_TZ (по умолчанию Asia/Novosibirsk).
// ============================================================

import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { prisma } from '@evently/db'

// Реакции, которые считаем «пользователю понравилось/интересно».
const POSITIVE_TYPES = new Set([
  'FAVORITE',
  'GOING',
  'OPEN',
  'SHARE',
  'TICKET_CLICK',
])

type DayStats = {
  date: string

  // Показы: уникальные пары «пользователь + событие» за день.
  shown: number

  // Из показанных: была реакция / переход к билетам / лайк / «Пойду» / скрыли.
  engaged: number
  tickets: number
  likes: number
  going: number
  hidden: number

  // Время на карточке.
  dwellCount: number
  dwellTotalMs: number
  quickSwipes: number

  // Показы из категорий, выбранных пользователем (только у кого есть интересы).
  interestBase: number
  interestMatched: number

  // Разнообразие: окна по 20 подряд показанных карточек одного пользователя.
  diversityWindows: number
  diversityCategoriesSum: number
  diversityTopShareSum: number

  // Пользователи.
  activeUsers: number
  activeMaxUsers: number
  newUsers: number
}

function keyMatches(given: unknown) {
  const expected = process.env.ADMIN_METRICS_KEY

  if (!expected || typeof given !== 'string') {
    return false
  }

  const a = Buffer.from(given)
  const b = Buffer.from(expected)

  return a.length === b.length && timingSafeEqual(a, b)
}

function guard(request: FastifyRequest, reply: FastifyReply) {
  const { key } = request.query as { key?: string }

  if (!keyMatches(key)) {
    void reply.status(404).send({ error: 'NOT_FOUND' })
    return false
  }

  return true
}

export async function metricsRoutes(app: FastifyInstance) {
  const timeZone = process.env.METRICS_TZ ?? 'Asia/Novosibirsk'

  const dayKey = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })

  const toDay = (date: Date) => dayKey.format(date)

  app.get('/metrics', async (request, reply) => {
    if (!guard(request, reply)) {
      return reply
    }

    const html = await readFile(
      new URL('./metrics-page.html', import.meta.url),
      'utf8',
    )

    return reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('X-Robots-Tag', 'noindex')
      .send(html)
  })

  app.get('/metrics/data', async (request, reply) => {
    if (!guard(request, reply)) {
      return reply
    }

    const { days: rawDays } = request.query as { days?: string }
    const days = Math.min(Math.max(Number(rawDays) || 14, 1), 60)

    const now = new Date()
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)

    const interactions = await prisma.interaction.findMany({
      where: {
        createdAt: { gte: since },
      },

      orderBy: { createdAt: 'asc' },

      select: {
        userId: true,
        eventId: true,
        type: true,
        durationMs: true,
        createdAt: true,
      },
    })

    // Основная категория события (первая по порядку категорий).
    const eventIds = [...new Set(interactions.map((row) => row.eventId))]
    const primaryCategory = new Map<string, { slug: string; order: number }>()
    const eventCategories = new Map<string, Set<string>>()

    for (let index = 0; index < eventIds.length; index += 5000) {
      const rows = await prisma.eventCategory.findMany({
        where: { eventId: { in: eventIds.slice(index, index + 5000) } },
        select: {
          eventId: true,
          category: { select: { slug: true, sortOrder: true } },
        },
      })

      for (const row of rows) {
        const current = primaryCategory.get(row.eventId)

        if (!current || row.category.sortOrder < current.order) {
          primaryCategory.set(row.eventId, {
            slug: row.category.slug,
            order: row.category.sortOrder,
          })
        }

        const set = eventCategories.get(row.eventId) ?? new Set<string>()
        set.add(row.category.slug)
        eventCategories.set(row.eventId, set)
      }
    }

    const interestRows = await prisma.userInterest.findMany({
      select: { userId: true, category: { select: { slug: true } } },
    })

    const interests = new Map<string, Set<string>>()

    for (const row of interestRows) {
      const set = interests.get(row.userId) ?? new Set<string>()
      set.add(row.category.slug)
      interests.set(row.userId, set)
    }

    const activeUserIds = [...new Set(interactions.map((row) => row.userId))]

    const users = await prisma.user.findMany({
      where: {
        OR: [{ id: { in: activeUserIds } }, { createdAt: { gte: since } }],
      },
      select: { id: true, maxUserId: true, createdAt: true },
    })

    const isMaxUser = new Map(
      users.map((user) => [user.id, !user.maxUserId.startsWith('web:')]),
    )

    // Пустые дни тоже показываем — нулями.
    const stats = new Map<string, DayStats>()

    for (let offset = days; offset >= 0; offset -= 1) {
      const date = toDay(new Date(now.getTime() - offset * 24 * 60 * 60 * 1000))

      if (!stats.has(date)) {
        stats.set(date, {
          date,
          shown: 0,
          engaged: 0,
          tickets: 0,
          likes: 0,
          going: 0,
          hidden: 0,
          dwellCount: 0,
          dwellTotalMs: 0,
          quickSwipes: 0,
          interestBase: 0,
          interestMatched: 0,
          diversityWindows: 0,
          diversityCategoriesSum: 0,
          diversityTopShareSum: 0,
          activeUsers: 0,
          activeMaxUsers: 0,
          newUsers: 0,
        })
      }
    }

    // Показы (уникальные пары за день) и реакции на них в тот же день.
    const shownPairs = new Map<string, Set<string>>()
    const reacted = new Map<string, Map<string, Set<string>>>()
    const activeByDay = new Map<string, Set<string>>()
    const sequences = new Map<string, string[]>()

    for (const row of interactions) {
      const date = toDay(row.createdAt)
      const day = stats.get(date)

      if (!day) {
        continue
      }

      const active = activeByDay.get(date) ?? new Set<string>()
      active.add(row.userId)
      activeByDay.set(date, active)

      const pair = `${row.userId}|${row.eventId}`

      if (row.type === 'IMPRESSION') {
        const pairs = shownPairs.get(date) ?? new Set<string>()

        if (!pairs.has(pair)) {
          pairs.add(pair)
          shownPairs.set(date, pairs)

          day.shown += 1

          const userInterests = interests.get(row.userId)

          if (userInterests && userInterests.size > 0) {
            day.interestBase += 1

            const categories = eventCategories.get(row.eventId)

            if (categories && [...categories].some((slug) => userInterests.has(slug))) {
              day.interestMatched += 1
            }
          }

          const slug = primaryCategory.get(row.eventId)?.slug ?? '—'
          const sequenceKey = `${date}|${row.userId}`
          const sequence = sequences.get(sequenceKey) ?? []
          sequence.push(slug)
          sequences.set(sequenceKey, sequence)
        }

        continue
      }

      if (row.type === 'DWELL' && row.durationMs !== null) {
        day.dwellCount += 1
        day.dwellTotalMs += Math.min(row.durationMs, 60_000)

        if (row.durationMs < 1500) {
          day.quickSwipes += 1
        }

        continue
      }

      const byPair = reacted.get(date) ?? new Map<string, Set<string>>()
      const types = byPair.get(pair) ?? new Set<string>()
      types.add(row.type)
      byPair.set(pair, types)
      reacted.set(date, byPair)
    }

    for (const [date, pairs] of shownPairs) {
      const day = stats.get(date)!
      const byPair = reacted.get(date)

      if (!byPair) {
        continue
      }

      for (const pair of pairs) {
        const types = byPair.get(pair)

        if (!types) {
          continue
        }

        if ([...types].some((type) => POSITIVE_TYPES.has(type))) {
          day.engaged += 1
        }

        if (types.has('TICKET_CLICK')) day.tickets += 1
        if (types.has('FAVORITE')) day.likes += 1
        if (types.has('GOING')) day.going += 1
        if (types.has('HIDE')) day.hidden += 1
      }
    }

    // Разнообразие: окна по 20 карточек (хвост от 10 тоже считаем).
    for (const [key, sequence] of sequences) {
      const day = stats.get(key.split('|')[0])!

      for (let start = 0; start < sequence.length; start += 20) {
        const window = sequence.slice(start, start + 20)

        if (window.length < 10) {
          continue
        }

        const counts = new Map<string, number>()

        for (const slug of window) {
          counts.set(slug, (counts.get(slug) ?? 0) + 1)
        }

        day.diversityWindows += 1
        day.diversityCategoriesSum += counts.size
        day.diversityTopShareSum += Math.max(...counts.values()) / window.length
      }
    }

    for (const [date, active] of activeByDay) {
      const day = stats.get(date)!

      day.activeUsers = active.size
      day.activeMaxUsers = [...active].filter((id) => isMaxUser.get(id)).length
    }

    for (const user of users) {
      const day = stats.get(toDay(user.createdAt))

      if (day && user.createdAt >= since) {
        day.newUsers += 1
      }
    }

    // Покрытие: какая доля актуальных событий хоть раз попала в ленту за период.
    const shownEvents = new Set(
      interactions
        .filter((row) => row.type === 'IMPRESSION')
        .map((row) => row.eventId),
    )

    const activeEvents = await prisma.event.count({
      where: { status: 'ACTIVE', duplicateOfId: null },
    })

    return {
      generatedAt: now.toISOString(),
      timeZone,
      days: [...stats.values()],
      totals: {
        activeEvents,
        shownEvents: shownEvents.size,
        users: await prisma.user.count(),
      },
    }
  })
}
