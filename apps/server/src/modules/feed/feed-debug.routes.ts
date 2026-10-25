import type { FastifyInstance } from 'fastify'

import { prisma } from '@evently/db'

import { getUserKey } from '../../lib/request-user.js'

import {
  getInteractionWeight,
} from './feed.scoring.js'

export async function feedDebugRoutes(
  app: FastifyInstance,
) {
  app.get('/', async (request, reply) => {
    const clientId =
      getUserKey(request.headers)

    if (
      !clientId
    ) {
      return reply.status(400).send({
        error: 'CLIENT_ID_REQUIRED',
      })
    }

    const user =
      await prisma.user.findUnique({
        where: {
          maxUserId:
            clientId,
        },

        select: {
          id: true,
          maxUserId: true,
        },
      })

    if (!user) {
      return {
        clientId,
        interactionCount: 0,
        interests: [],
      }
    }

    const interactions =
      await prisma.interaction.findMany({
        where: {
          userId: user.id,
        },

        orderBy: {
          createdAt: 'desc',
        },

        take: 500,

        include: {
          event: {
            include: {
              categories: {
                include: {
                  category: true,
                },
              },
            },
          },
        },
      })

    const categories =
      await prisma.category.findMany({
        where: {
          active: true,
        },

        orderBy: {
          sortOrder: 'asc',
        },
      })

    const scores =
      new Map<string, number>()

    const signals =
      new Map<
        string,
        {
          favorite: number
          unfavorite: number
          open: number
          share: number
          dwell: number
          impression: number
        }
      >()

    for (const category of categories) {
      scores.set(
        category.slug,
        0,
      )

      signals.set(
        category.slug,
        {
          favorite: 0,
          unfavorite: 0,
          open: 0,
          share: 0,
          dwell: 0,
          impression: 0,
        },
      )
    }

    for (
      const interaction
      of interactions
    ) {
      const weight =
        getInteractionWeight(
          interaction,
        )

      for (
        const item
        of interaction.event.categories
      ) {
        const slug =
          item.category.slug

        scores.set(
          slug,
          (scores.get(slug) ?? 0) +
            weight,
        )

        const stats =
          signals.get(slug)

        if (!stats) {
          continue
        }

        switch (interaction.type) {
          case 'FAVORITE':
            stats.favorite++
            break

          case 'UNFAVORITE':
            stats.unfavorite++
            break

          case 'OPEN':
            stats.open++
            break

          case 'SHARE':
            stats.share++
            break

          case 'DWELL':
            stats.dwell++
            break

          case 'IMPRESSION':
            stats.impression++
            break
        }
      }
    }

    const interests =
      categories
        .map((category) => ({
          slug: category.slug,
          name: category.name,
          icon: category.icon,

          score:
            Math.round(
              (scores.get(
                category.slug,
              ) ?? 0) * 10,
            ) / 10,

          signals:
            signals.get(
              category.slug,
            ),
        }))
        .sort(
          (a, b) =>
            b.score - a.score,
        )

    return {
      clientId,

      interactionCount:
        interactions.length,

      interests,
    }
  })
}
