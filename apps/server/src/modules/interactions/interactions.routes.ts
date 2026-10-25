import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { prisma } from '@evently/db'

import { getUserKey } from '../../lib/request-user.js'

const InteractionSchema = z.object({
  eventId: z.string().uuid(),

  type: z.enum([
    'IMPRESSION',
    'OPEN',
    'DWELL',
    'FAVORITE',
    'UNFAVORITE',
    'TICKET_CLICK',
    'SHARE',
    'HIDE',
  ]),

  durationMs: z
    .number()
    .int()
    .nonnegative()
    .max(3_600_000)
    .optional(),

metadata: z
  .record(
    z.string(),
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
    ]),
  )
  .optional(),
})

export async function interactionsRoutes(
  app: FastifyInstance,
) {
  app.post('/', async (request, reply) => {
    const clientId =
      getUserKey(request.headers)

    if (
      !clientId
    ) {
      return reply.status(400).send({
        error: 'CLIENT_ID_REQUIRED',
      })
    }

    const parsed = InteractionSchema.safeParse(
      request.body,
    )

    if (!parsed.success) {
      return reply.status(400).send({
        error: 'INVALID_INTERACTION',
        details: parsed.error.flatten(),
      })
    }

    const data = parsed.data

    const event = await prisma.event.findUnique({
      where: {
        id: data.eventId,
      },

      select: {
        id: true,
        status: true,
      },
    })

    if (!event || event.status !== 'ACTIVE') {
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
        lastSeenAt: new Date(),
      },
    })

    const interaction =
      await prisma.interaction.create({
        data: {
          userId: user.id,
          eventId: data.eventId,
          type: data.type,
          durationMs: data.durationMs,
          metadata: data.metadata,
        },
      })

    return {
      ok: true,

      interaction: {
        id: interaction.id,
        type: interaction.type,
        eventId: interaction.eventId,
        createdAt:
          interaction.createdAt.toISOString(),
      },
    }
  })
}
