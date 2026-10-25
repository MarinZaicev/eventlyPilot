import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { prisma } from '@evently/db'

import { getUserKey } from '../../lib/request-user.js'

const InterestsSchema = z.object({
  categories: z
    .array(z.string().min(1))
    .min(3)
    .max(20),
})

function getClientId(
  headers: Record<string, unknown>,
) {
  // Ключ пользователя: аккаунт MAX (токен сессии) или "web:<clientId>".
  return getUserKey(headers)
}

export async function interestsRoutes(
  app: FastifyInstance,
) {
  // Получить текущие интересы
  app.get('/', async (request, reply) => {
    const clientId =
      getClientId(request.headers)

    if (!clientId) {
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

        include: {
          interests: {
            include: {
              category: true,
            },
          },
        },
      })

    if (!user) {
      return {
        onboardingCompleted: false,
        categories: [],
      }
    }

    return {
      onboardingCompleted:
        user.onboardingCompleted,

      categories:
        user.interests.map(
          (interest) => ({
            slug:
              interest.category.slug,

            name:
              interest.category.name,

            icon:
              interest.category.icon,

            weight:
              interest.weight,
          }),
        ),
    }
  })

  // Сохранить выбранные интересы
  app.put('/', async (request, reply) => {
    const clientId =
      getClientId(request.headers)

    if (!clientId) {
      return reply.status(400).send({
        error: 'CLIENT_ID_REQUIRED',
      })
    }

    const parsed =
      InterestsSchema.safeParse(
        request.body,
      )

    if (!parsed.success) {
      return reply.status(400).send({
        error: 'INVALID_INTERESTS',
        details:
          parsed.error.flatten(),
      })
    }

    const slugs = [
      ...new Set(
        parsed.data.categories,
      ),
    ]

    const categories =
      await prisma.category.findMany({
        where: {
          slug: {
            in: slugs,
          },

          active: true,
        },
      })

    const foundSlugs =
      new Set(
        categories.map(
          (category) =>
            category.slug,
        ),
      )

    const missing =
      slugs.filter(
        (slug) =>
          !foundSlugs.has(slug),
      )

    if (missing.length > 0) {
      return reply.status(400).send({
        error:
          'CATEGORIES_NOT_FOUND',

        categories: missing,
      })
    }

    const user =
      await prisma.user.upsert({
        where: {
          maxUserId:
            clientId,
        },

        update: {
          onboardingCompleted: true,
          lastSeenAt: new Date(),
        },

        create: {
          maxUserId:
            clientId,

          onboardingCompleted: true,
          lastSeenAt: new Date(),
        },
      })

    await prisma.$transaction(
      async (tx) => {
        await tx.userInterest.deleteMany({
          where: {
            userId: user.id,
          },
        })

        if (
          categories.length > 0
        ) {
          await tx.userInterest.createMany({
            data:
              categories.map(
                (category) => ({
                  userId: user.id,
                  categoryId:
                    category.id,

                  // Начальные интересы
                  // дают умеренный вес.
                  weight: 3,
                }),
              ),
          })
        }
      },
    )

    return {
      ok: true,

      onboardingCompleted: true,

      categories:
        categories.map(
          (category) => ({
            slug:
              category.slug,

            name:
              category.name,

            icon:
              category.icon,
          }),
        ),
    }
  })
}
