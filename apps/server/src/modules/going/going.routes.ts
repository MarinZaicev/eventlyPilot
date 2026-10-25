// ============================================================
// GOING — «Пойду».
//
// GET    /api/going/           — события, на которые пользователь
//                                собирается (ближайшие сверху)
// PUT    /api/going/:eventId   — «Пойду» (запоминается ближайший сеанс)
// DELETE /api/going/:eventId   — передумал
//
// Сервер сам пишет сигнал GOING / NOT_GOING в Interaction —
// это самый сильный сигнал для рекомендаций (feed.scoring.ts).
// Пользователь — аккаунт MAX (токен сессии) или x-evently-client-id. PUT/DELETE без тела.
// ============================================================

import type { FastifyInstance } from 'fastify'

import { z } from 'zod'

import { prisma } from '@evently/db'

import {
  getUserKey,
  isMaxUserKey,
} from '../../lib/request-user.js'

import {
  eventInclude,
  toApiEvent,
} from '../events/events.routes.js'

import { withSocial } from '../events/social.js'

import { verifyMaxInitData } from '../../lib/max-auth.js'

const ParamsSchema = z.object({
  eventId: z.string().uuid(),
})

function getClientId(
  headers: Record<string, unknown>,
) {
  // Ключ пользователя: аккаунт MAX (токен сессии) или "web:<clientId>".
  return getUserKey(headers)
}

export async function goingRoutes(
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

    const attendances = await prisma.attendance.findMany({
      where: {
        userId: user.id,

        event: {
          status: 'ACTIVE',
        },
      },

      orderBy: [
        {
          startsAt: {
            sort: 'asc',
            nulls: 'last',
          },
        },
        {
          createdAt: 'desc',
        },
      ],

      take: 200,

      include: {
        event: {
          include: eventInclude,
        },
      },
    })

    return {
      items: await withSocial(
        attendances.map((attendance) =>
          toApiEvent(attendance.event),
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

        // Ближайший предстоящий сеанс.
        occurrences: {
          where: {
            startsAt: {
              gte: new Date(),
            },
          },

          orderBy: {
            startsAt: 'asc',
          },

          take: 1,

          select: {
            startsAt: true,
          },
        },
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

    const startsAt =
      event.occurrences[0]?.startsAt ?? null

    /*
     * Кому бот пришлёт напоминание: id пользователя MAX
     * из подписанного initData (подпись проверяется
     * токеном бота). Вне MAX — null, напоминания не будет.
     */
    const initData =
      request.headers['x-max-init-data']

    const maxUser =
      typeof initData === 'string' &&
      process.env.MAX_BOT_TOKEN
        ? verifyMaxInitData(
            initData,
            process.env.MAX_BOT_TOKEN,
          )
        : null

    // Вошёл через MAX (токен сессии) — ключ и есть id в MAX.
    const maxRecipientId =
      maxUser
        ? String(maxUser.id)
        : isMaxUserKey(clientId)
          ? clientId
          : null

    const existing = await prisma.attendance.findUnique({
      where: {
        userId_eventId: {
          userId: user.id,
          eventId: event.id,
        },
      },

      select: {
        userId: true,
      },
    })

    await prisma.attendance.upsert({
      where: {
        userId_eventId: {
          userId: user.id,
          eventId: event.id,
        },
      },

      update: maxRecipientId
        ? {
            maxRecipientId,
          }
        : {},

      create: {
        userId: user.id,
        eventId: event.id,
        startsAt,
        maxRecipientId,
      },
    })

    // Сигнал для рекомендаций — только при новой отметке.
    if (!existing) {
      await prisma.interaction.create({
        data: {
          userId: user.id,
          eventId: event.id,
          type: 'GOING',
        },
      })
    }

    return {
      ok: true,
      startsAt: startsAt?.toISOString() ?? null,
      // Будет ли напоминание от бота.
      reminder: Boolean(maxRecipientId && startsAt),
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
      const removed = await prisma.attendance.deleteMany({
        where: {
          userId: user.id,
          eventId: parsed.data.eventId,
        },
      })

      if (removed.count > 0) {
        await prisma.interaction.create({
          data: {
            userId: user.id,
            eventId: parsed.data.eventId,
            type: 'NOT_GOING',
          },
        })
      }
    }

    return {
      ok: true,
    }
  })
}
