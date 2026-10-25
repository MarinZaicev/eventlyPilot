import type { FastifyInstance } from 'fastify'
import type {
  ApiEvent,
  ApiEventsResponse,
} from '@evently/shared'

import { z } from 'zod'

import { prisma } from '@evently/db'

import { getUserKey } from '../../lib/request-user.js'

import { withSocial } from './social.js'

const EventsQuerySchema = z.object({
  category: z.string().min(1).optional(),

  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),

  isFree: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),

  maxPrice: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional(),

  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20),

  cursor: z.string().optional(),
})

const CursorSchema = z.object({
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
})

export const eventInclude = {
  venue: true,

  occurrences: {
    orderBy: {
      startsAt: 'asc' as const,
    },
  },

  images: {
    orderBy: {
      position: 'asc' as const,
    },
  },

  categories: {
    include: {
      category: true,
    },
  },
}

export function toApiEvent(event: any): ApiEvent {
  return {
    id: event.id,
    source: event.source,

    title: event.title,
    shortDescription: event.shortDescription,
    description: event.description,

    priceMin: event.priceMin,
    priceMax: event.priceMax,
    currency: event.currency,
    isFree: event.isFree,

    ageRating: event.ageRating,

    ticketUrl: event.ticketUrl,
    sourceUrl: event.sourceUrl,

    venue: event.venue
      ? {
          id: event.venue.id,
          name: event.venue.name,
          address: event.venue.address,
          city: event.venue.city,
          latitude: event.venue.latitude,
          longitude: event.venue.longitude,
        }
      : null,

    occurrences: event.occurrences.map((occurrence: any) => ({
      id: occurrence.id,
      startsAt: occurrence.startsAt.toISOString(),
      endsAt: occurrence.endsAt
        ? occurrence.endsAt.toISOString()
        : null,
      ticketUrl: occurrence.ticketUrl,
    })),

    images: event.images.map((image: any) => ({
      id: image.id,
      url: image.url,
      position: image.position,
    })),

    categories: event.categories.map((item: any) => ({
      id: item.category.id,
      slug: item.category.slug,
      name: item.category.name,
      icon: item.category.icon,
    })),
  }
}

function encodeCursor(event: {
  id: string
  createdAt: Date
}) {
  return Buffer.from(
    JSON.stringify({
      id: event.id,
      createdAt: event.createdAt.toISOString(),
    }),
  ).toString('base64url')
}

function decodeCursor(cursor: string) {
  try {
    const decoded = Buffer
      .from(cursor, 'base64url')
      .toString('utf8')

    return CursorSchema.safeParse(
      JSON.parse(decoded),
    )
  } catch {
    return {
      success: false,
    } as const
  }
}

export async function eventsRoutes(app: FastifyInstance) {
  app.get('/', async (request, reply) => {
    const parsed = EventsQuerySchema.safeParse(request.query)

    if (!parsed.success) {
      return reply.status(400).send({
        error: 'INVALID_QUERY',
        details: parsed.error.flatten(),
      })
    }

    const {
      category,
      dateFrom,
      dateTo,
      isFree,
      maxPrice,
      limit,
      cursor,
    } = parsed.data

    let cursorData:
      | {
          id: string
          createdAt: string
        }
      | undefined

    if (cursor) {
      const decoded = decodeCursor(cursor)

      if (!decoded.success) {
        return reply.status(400).send({
          error: 'INVALID_CURSOR',
        })
      }

      cursorData = decoded.data
    }

    const filters: any[] = []

    if (category) {
      filters.push({
        categories: {
          some: {
            category: {
              slug: category,
              active: true,
            },
          },
        },
      })
    }

    if (dateFrom || dateTo) {
      filters.push({
        occurrences: {
          some: {
            startsAt: {
              ...(dateFrom
                ? { gte: new Date(dateFrom) }
                : {}),

              ...(dateTo
                ? { lte: new Date(dateTo) }
                : {}),
            },
          },
        },
      })
    }

    if (typeof isFree === 'boolean') {
      filters.push({
        isFree,
      })
    }

    if (typeof maxPrice === 'number') {
      filters.push({
        OR: [
          {
            isFree: true,
          },
          {
            priceMin: {
              lte: maxPrice,
            },
          },
        ],
      })
    }

    if (cursorData) {
      const cursorDate = new Date(cursorData.createdAt)

      filters.push({
        OR: [
          {
            createdAt: {
              lt: cursorDate,
            },
          },
          {
            AND: [
              {
                createdAt: cursorDate,
              },
              {
                id: {
                  lt: cursorData.id,
                },
              },
            ],
          },
        ],
      })
    }

    const events = await prisma.event.findMany({
      where: {
        status: 'ACTIVE',
        // only primary events, not duplicates
        duplicateOfId: null,
        AND: filters,
      },

      orderBy: [
        {
          createdAt: 'desc',
        },
        {
          id: 'desc',
        },
      ],

      take: limit + 1,

      include: eventInclude,
    })

    const hasMore = events.length > limit

    const page = hasMore
      ? events.slice(0, limit)
      : events

    const lastEvent = page.at(-1)

    const response: ApiEventsResponse = {
      items: page.map(toApiEvent),

      nextCursor:
        hasMore && lastEvent
          ? encodeCursor(lastEvent)
          : null,
    }

    return response
  })

  app.get('/:id', async (request, reply) => {
    const { id } = request.params as {
      id: string
    }

    const event = await prisma.event.findUnique({
      where: {
        id,
      },

      include: eventInclude,
    })

    if (!event || event.status !== 'ACTIVE') {
      return reply.status(404).send({
        error: 'EVENT_NOT_FOUND',
      })
    }

    // Популярность у других (#36) — без собственных лайка/«Пойду».
    const viewerKey = getUserKey(request.headers)

    const viewer = viewerKey
      ? await prisma.user.findUnique({
          where: { maxUserId: viewerKey },
          select: { id: true },
        })
      : null

    const [withStats] = await withSocial(
      [toApiEvent(event)],
      viewer?.id ?? null,
    )

    return withStats
  })
}
