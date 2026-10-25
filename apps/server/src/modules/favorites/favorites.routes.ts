// ============================================================
// FAVORITES — сохранённые пользователем события.
//
// GET    /api/favorites/           — список сохранённого (новые сверху)
// PUT    /api/favorites/:eventId   — сохранить
// DELETE /api/favorites/:eventId   — убрать
//
// Пользователь — аккаунт MAX (токен сессии, lib/request-user.ts)
// или анонимный браузер (x-evently-client-id → "web:<clientId>").
// Запросы PUT/DELETE отправляются без тела.
// ============================================================

import type { FastifyInstance } from 'fastify'

import { z } from 'zod'

import { prisma } from '@evently/db'

import { getUserKey } from '../../lib/request-user.js'

import {
  eventInclude,
  toApiEvent,
} from '../events/events.routes.js'

import { withSocial } from '../events/social.js'

const ParamsSchema = z.object({
  eventId: z.string().uuid(),
})

function getClientId(
  headers: Record<string, unknown>,
) {
  // Ключ пользователя: аккаунт MAX (токен сессии) или "web:<clientId>".
  return getUserKey(headers)
}

export async function favoritesRoutes(
  app: FastifyInstance,
) {
  app.get('/', async (request, reply) => {
    const clientId = getClientId(request.headers)

    if (!clientId) {
      return reply.status(400).send({
        error: 'CLIENT_ID_REQUIRED',
      })
    }

    const user = await prisma.user.findUnique({
      where: {
        maxUserId: clientId,
      },

      select: {
        id: true,
      },
    })

    if (!user) {
      return {
        items: [],
      }
    }

    const favorites = await prisma.favorite.findMany({
      where: {
        userId: user.id,

        event: {
          status: 'ACTIVE',
        },
      },

      orderBy: {
        createdAt: 'desc',
      },

      take: 200,

      include: {
        event: {
          include: eventInclude,
        },
      },
    })

    return {
      items: await withSocial(
        favorites.map((favorite) =>
          toApiEvent(favorite.event),
        ),
        user.id,
      ),
    }
  })

  app.put('/:eventId', async (request, reply) => {
    const clientId = getClientId(request.headers)

    if (!clientId) {
      return reply.status(400).send({
        error: 'CLIENT_ID_REQUIRED',
      })
    }

    const parsed = ParamsSchema.safeParse(request.params)

    if (!parsed.success) {
      return reply.status(400).send({
        error: 'INVALID_EVENT_ID',
      })
    }

    const event = await prisma.event.findFirst({
      where: {
        id: parsed.data.eventId,
        status: 'ACTIVE',
      },

      select: {
        id: true,
      },
    })

    if (!event) {
      return reply.status(404).send({
        error: 'EVENT_NOT_FOUND',
      })
    }

    const user = await prisma.user.upsert({
      where: {
        maxUserId: clientId,
      },

      update: {
        lastSeenAt: new Date(),
      },

      create: {
        maxUserId: clientId,
      },

      select: {
        id: true,
      },
    })

    await prisma.favorite.upsert({
      where: {
        userId_eventId: {
          userId: user.id,
          eventId: event.id,
        },
      },

      update: {},

      create: {
        userId: user.id,
        eventId: event.id,
      },
    })

    return {
      ok: true,
    }
  })

  app.delete('/:eventId', async (request, reply) => {
    const clientId = getClientId(request.headers)

    if (!clientId) {
      return reply.status(400).send({
        error: 'CLIENT_ID_REQUIRED',
      })
    }

    const parsed = ParamsSchema.safeParse(request.params)

    if (!parsed.success) {
      return reply.status(400).send({
        error: 'INVALID_EVENT_ID',
      })
    }

    const user = await prisma.user.findUnique({
      where: {
        maxUserId: clientId,
      },

      select: {
        id: true,
      },
    })

    if (user) {
      await prisma.favorite.deleteMany({
        where: {
          userId: user.id,
          eventId: parsed.data.eventId,
        },
      })
    }

    return {
      ok: true,
    }
  })
}
