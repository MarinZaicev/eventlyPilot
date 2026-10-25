// ============================================================
// AUTH — вход через MAX.
//
// POST /api/auth/max   (без тела)
//   x-max-init-data     — подписанные данные Mini App (обязательно)
//   x-evently-client-id — id браузера (необязательно: для переноса истории)
//
// 1. Проверяем подпись initData токеном бота.
// 2. Находим/создаём пользователя с maxUserId = id в MAX, обновляем имя и аватар.
// 3. Если на этом устройстве уже есть анонимная история ("web:<clientId>") —
//    переносим её в аккаунт MAX (сохранённое, «Пойду», интересы, сигналы,
//    комментарии) и удаляем анонимного пользователя.
// 4. Возвращаем токен сессии на 30 дней.
// ============================================================

import type { FastifyInstance } from 'fastify'

import { prisma } from '@evently/db'

import { verifyMaxInitData } from '../../lib/max-auth.js'

import { createSessionToken } from '../../lib/session.js'

export async function authRoutes(
  app: FastifyInstance,
) {
  app.post('/max', async (request, reply) => {
    const initData = request.headers['x-max-init-data']
    const botToken = process.env.MAX_BOT_TOKEN

    if (typeof initData !== 'string' || !botToken) {
      return reply.status(400).send({
        error: 'INIT_DATA_REQUIRED',
      })
    }

    const maxUser = verifyMaxInitData(initData, botToken)

    if (!maxUser) {
      return reply.status(401).send({
        error: 'INVALID_MAX_INIT_DATA',
      })
    }

    const userKey = String(maxUser.id)

    const firstName = maxUser.first_name.trim()
    const lastName = maxUser.last_name?.trim() || null
    const username = maxUser.username?.trim() || null
    const avatarUrl = maxUser.photo_url || null

    const displayName =
      [firstName, lastName].filter(Boolean).join(' ') ||
      username ||
      `MAX ${userKey}`

    const clientId = request.headers['x-evently-client-id']

    const webKey =
      typeof clientId === 'string' && clientId.length >= 8
        ? `web:${clientId}`
        : null

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.upsert({
        where: {
          maxUserId: userKey,
        },

        update: {
          firstName,
          lastName,
          username,
          avatarUrl,
          displayName,
          lastSeenAt: new Date(),
        },

        create: {
          maxUserId: userKey,
          firstName,
          lastName,
          username,
          avatarUrl,
          displayName,
        },
      })

      let merged = false

      const webUser = webKey
        ? await tx.user.findUnique({
            where: {
              maxUserId: webKey,
            },

            include: {
              interests: true,
              favorites: true,
              attendances: true,
            },
          })
        : null

      if (webUser && webUser.id !== user.id) {
        merged = true

        if (webUser.favorites.length > 0) {
          await tx.favorite.createMany({
            data: webUser.favorites.map((favorite) => ({
              userId: user.id,
              eventId: favorite.eventId,
              createdAt: favorite.createdAt,
            })),
            skipDuplicates: true,
          })
        }

        if (webUser.attendances.length > 0) {
          await tx.attendance.createMany({
            data: webUser.attendances.map((attendance) => ({
              userId: user.id,
              eventId: attendance.eventId,
              startsAt: attendance.startsAt,
              reminderSentAt: attendance.reminderSentAt,
              maxRecipientId: userKey,
              invitedById: attendance.invitedById,
              createdAt: attendance.createdAt,
            })),
            skipDuplicates: true,
          })
        }

        // Интересы переносим, только если в аккаунте их ещё нет.
        const existingInterests = await tx.userInterest.count({
          where: {
            userId: user.id,
          },
        })

        if (existingInterests === 0 && webUser.interests.length > 0) {
          await tx.userInterest.createMany({
            data: webUser.interests.map((interest) => ({
              userId: user.id,
              categoryId: interest.categoryId,
              weight: interest.weight,
            })),
            skipDuplicates: true,
          })
        }

        // История сигналов и комментарии — целиком.
        await tx.interaction.updateMany({
          where: {
            userId: webUser.id,
          },

          data: {
            userId: user.id,
          },
        })

        await tx.comment.updateMany({
          where: {
            userId: webUser.id,
          },

          data: {
            userId: user.id,
          },
        })

        // Кого этот телефон успел позвать «Пойдём вместе».
        await tx.attendance.updateMany({
          where: {
            invitedById: webUser.id,
          },

          data: {
            invitedById: user.id,
          },
        })

        if (webUser.onboardingCompleted && !user.onboardingCompleted) {
          await tx.user.update({
            where: {
              id: user.id,
            },

            data: {
              onboardingCompleted: true,
            },
          })
        }

        // Остатки (дубли избранного и т.п.) удалятся каскадом.
        await tx.user.delete({
          where: {
            id: webUser.id,
          },
        })
      }

      // Напоминания бота — для всех отметок «Пойду» аккаунта.
      await tx.attendance.updateMany({
        where: {
          userId: user.id,
          maxRecipientId: null,
        },

        data: {
          maxRecipientId: userKey,
        },
      })

      return {
        merged,
      }
    })

    return {
      token: createSessionToken(userKey),
      merged: result.merged,

      user: {
        firstName,
        lastName,
        displayName,
        avatarUrl,
      },
    }
  })
}
