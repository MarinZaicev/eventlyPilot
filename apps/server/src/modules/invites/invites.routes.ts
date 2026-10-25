// ============================================================
// INVITES — «Пойдём вместе».
//
// Ссылка-приглашение собирается на фронте без запроса к серверу
// (MAX открывает отправку только сразу по нажатию):
//   https://max.ru/<бот>?startapp=inv_<eventId>_<inviteCode>
// inviteCode — постоянный код пригласившего (User.inviteCode),
// а не его MAX id.
//
// GET  /api/invites/me                        — мой код (создаётся при первом запросе)
// GET  /api/invites/:code/:eventId            — кто зовёт и куда (для плашки у друга)
// POST /api/invites/:code/:eventId/accept     — «Я с тобой»: «Пойду» + сообщение пригласившему
//
// Пользователь — аккаунт MAX (токен сессии) или x-evently-client-id.
// ============================================================

import { randomBytes } from 'node:crypto'

import type { FastifyInstance } from 'fastify'

import { z } from 'zod'

import { prisma } from '@evently/db'

import {
  getUserKey,
  isMaxUserKey,
} from '../../lib/request-user.js'

import {
  eventDeepLink,
  sendMaxMessage,
} from '../../lib/max-bot.js'

import {
  eventInclude,
  toApiEvent,
} from '../events/events.routes.js'

const InviteParamsSchema = z.object({
  // base64url, как генерирует createInviteCode
  code: z.string().regex(/^[A-Za-z0-9_-]{6,16}$/),
  eventId: z.string().uuid(),
})

function createInviteCode() {
  // 6 байт → 8 символов base64url; ~2.8e14 вариантов.
  return randomBytes(6).toString('base64url')
}

function displayName(user: {
  displayName: string | null
  firstName: string | null
}) {
  return (
    user.firstName?.trim() ||
    user.displayName?.trim() ||
    null
  )
}

export async function invitesRoutes(
  app: FastifyInstance,
) {
  // Мой код приглашений.
  app.get('/me', async (request, reply) => {
    const userKey = getUserKey(request.headers)

    if (!userKey) {
      return reply.status(400).send({
        error: 'CLIENT_ID_REQUIRED',
      })
    }

    const user = await prisma.user.upsert({
      where: {
        maxUserId: userKey,
      },

      update: {},

      create: {
        maxUserId: userKey,
      },

      select: {
        id: true,
        inviteCode: true,
      },
    })

    if (user.inviteCode) {
      return {
        code: user.inviteCode,
      }
    }

    // Коллизия кода почти невозможна, но на всякий случай — 3 попытки.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const updated = await prisma.user.update({
          where: {
            id: user.id,
          },

          data: {
            inviteCode: createInviteCode(),
          },

          select: {
            inviteCode: true,
          },
        })

        return {
          code: updated.inviteCode,
        }
      } catch (error) {
        request.log.warn({ error }, 'invite code collision, retrying')
      }
    }

    return reply.status(500).send({
      error: 'INVITE_CODE_FAILED',
    })
  })

  // Кто зовёт и куда.
  app.get('/:code/:eventId', async (request, reply) => {
    const parsed = InviteParamsSchema.safeParse(request.params)

    if (!parsed.success) {
      return reply.status(400).send({
        error: 'INVALID_INVITE',
      })
    }

    const [inviter, event] = await Promise.all([
      prisma.user.findUnique({
        where: {
          inviteCode: parsed.data.code,
        },

        select: {
          id: true,
          firstName: true,
          displayName: true,
          avatarUrl: true,
        },
      }),

      prisma.event.findFirst({
        where: {
          id: parsed.data.eventId,
          status: 'ACTIVE',
        },

        include: eventInclude,
      }),
    ])

    if (!event) {
      return reply.status(404).send({
        error: 'EVENT_NOT_FOUND',
      })
    }

    if (!inviter) {
      return reply.status(404).send({
        error: 'INVITE_NOT_FOUND',
      })
    }

    // Состояние для того, кто открыл ссылку.
    const userKey = getUserKey(request.headers)

    const viewer = userKey
      ? await prisma.user.findUnique({
          where: {
            maxUserId: userKey,
          },

          select: {
            id: true,

            attendances: {
              where: {
                eventId: event.id,
              },

              select: {
                invitedById: true,
              },
            },
          },
        })
      : null

    const attendance = viewer?.attendances[0] ?? null

    return {
      event: toApiEvent(event),

      inviter: {
        name: displayName(inviter),
        avatarUrl: inviter.avatarUrl,
      },

      // Открыл собственную ссылку.
      isOwn: viewer?.id === inviter.id,

      // Уже идёт (сам или по этому приглашению).
      alreadyGoing: Boolean(attendance),
      acceptedThisInvite: attendance?.invitedById === inviter.id,
    }
  })

  // «Я с тобой».
  app.post('/:code/:eventId/accept', async (request, reply) => {
    const userKey = getUserKey(request.headers)

    if (!userKey) {
      return reply.status(400).send({
        error: 'CLIENT_ID_REQUIRED',
      })
    }

    const parsed = InviteParamsSchema.safeParse(request.params)

    if (!parsed.success) {
      return reply.status(400).send({
        error: 'INVALID_INVITE',
      })
    }

    const [inviter, event] = await Promise.all([
      prisma.user.findUnique({
        where: {
          inviteCode: parsed.data.code,
        },

        select: {
          id: true,
          maxUserId: true,
        },
      }),

      prisma.event.findFirst({
        where: {
          id: parsed.data.eventId,
          status: 'ACTIVE',
        },

        select: {
          id: true,
          title: true,

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
      }),
    ])

    if (!event) {
      return reply.status(404).send({
        error: 'EVENT_NOT_FOUND',
      })
    }

    if (!inviter) {
      return reply.status(404).send({
        error: 'INVITE_NOT_FOUND',
      })
    }

    const user = await prisma.user.upsert({
      where: {
        maxUserId: userKey,
      },

      update: {
        lastSeenAt: new Date(),
      },

      create: {
        maxUserId: userKey,
      },

      select: {
        id: true,
        firstName: true,
        displayName: true,
      },
    })

    if (user.id === inviter.id) {
      return reply.status(400).send({
        error: 'OWN_INVITE',
      })
    }

    const existing = await prisma.attendance.findUnique({
      where: {
        userId_eventId: {
          userId: user.id,
          eventId: event.id,
        },
      },

      select: {
        invitedById: true,
      },
    })

    const maxRecipientId = isMaxUserKey(userKey)
      ? userKey
      : null

    await prisma.attendance.upsert({
      where: {
        userId_eventId: {
          userId: user.id,
          eventId: event.id,
        },
      },

      update: {
        // Уже шёл сам — просто связываем с пригласившим.
        invitedById: existing?.invitedById ?? inviter.id,
        ...(maxRecipientId ? { maxRecipientId } : {}),
      },

      create: {
        userId: user.id,
        eventId: event.id,
        startsAt: event.occurrences[0]?.startsAt ?? null,
        maxRecipientId,
        invitedById: inviter.id,
      },
    })

    // Сигнал для рекомендаций — только при новой отметке.
    if (!existing) {
      await prisma.interaction.create({
        data: {
          userId: user.id,
          eventId: event.id,
          type: 'GOING',
          metadata: {
            via: 'invite',
          },
        },
      })
    }

    // Сообщение пригласившему — один раз на человека и событие.
    let notified = false

    const firstAccept = !existing?.invitedById

    if (firstAccept && isMaxUserKey(inviter.maxUserId)) {
      const name = displayName(user) ?? 'Ваш друг'

      try {
        const result = await sendMaxMessage({
          userId: inviter.maxUserId,
          text: [
            `🎉 ${name} тоже идёт на «${event.title}»!`,
            '',
            'Напомню вам обоим накануне.',
          ].join('\n'),
          buttons: [
            {
              text: '📱 Открыть в Evently',
              url: eventDeepLink(event.id),
            },
          ],
        })

        notified = result.ok

        if (!result.ok) {
          request.log.warn(
            { status: result.status, body: result.body },
            'invite accept notification not delivered',
          )
        }
      } catch (error) {
        request.log.warn({ error }, 'invite accept notification failed')
      }
    }

    return {
      ok: true,
      startsAt: event.occurrences[0]?.startsAt?.toISOString() ?? null,
      notified,
    }
  })
}
