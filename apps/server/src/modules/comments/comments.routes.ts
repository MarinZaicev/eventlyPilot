import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto'

import type {
  FastifyInstance,
} from 'fastify'

import { z } from 'zod'

import { prisma } from '@evently/db'

import { getUserKey } from '../../lib/request-user.js'

const ParamsSchema = z.object({
  eventId: z.string().uuid(),
})

const CreateCommentSchema = z.object({
  eventId: z.string().uuid(),

  text: z
    .string()
    .trim()
    .min(1)
    .max(1000),
})

type MaxUser = {
  id: number | string
  first_name: string
  last_name?: string | null
  username?: string | null
  photo_url?: string | null
}

function getHeader(
  headers: Record<string, unknown>,
  name: string,
) {
  const value =
    headers[name]

  if (typeof value !== 'string') {
    return null
  }

  return value
}

function getClientId(
  headers: Record<string, unknown>,
) {
  // Ключ пользователя: аккаунт MAX (токен сессии) или "web:<clientId>".
  return getUserKey(headers)
}

function getMaxInitData(
  headers: Record<string, unknown>,
) {
  const initData =
    getHeader(
      headers,
      'x-max-init-data',
    )

  if (!initData) {
    return null
  }

  return initData
}

function verifyMaxInitData(
  initData: string,
  botToken: string,
): MaxUser | null {
  if (!initData || !botToken) {
    return null
  }

  try {
    const params =
      new URLSearchParams(initData)

    const seenKeys =
      new Set<string>()

    for (const [key] of params) {
      if (seenKeys.has(key)) {
        return null
      }

      seenKeys.add(key)
    }

    const hashes =
      params.getAll('hash')

    if (hashes.length !== 1) {
      return null
    }

    const originalHash =
      hashes[0]

    if (
      !/^[a-f0-9]{64}$/i.test(
        originalHash,
      )
    ) {
      return null
    }

    const launchParams =
      [...params.entries()]
        .filter(
          ([key]) =>
            key !== 'hash',
        )
        .sort(
          ([left], [right]) =>
            left.localeCompare(right),
        )
        .map(
          ([key, value]) =>
            `${key}=${value}`,
        )
        .join('\n')

    const secretKey =
      createHmac(
        'sha256',
        'WebAppData',
      )
        .update(botToken)
        .digest()

    const calculatedHash =
      createHmac(
        'sha256',
        secretKey,
      )
        .update(launchParams)
        .digest('hex')

    const calculatedBuffer =
      Buffer.from(
        calculatedHash,
        'hex',
      )

    const originalBuffer =
      Buffer.from(
        originalHash,
        'hex',
      )

    if (
      calculatedBuffer.length !==
        originalBuffer.length ||
      !timingSafeEqual(
        calculatedBuffer,
        originalBuffer,
      )
    ) {
      return null
    }

    const authDate =
      Number(
        params.get('auth_date'),
      )

    if (
      !Number.isFinite(authDate)
    ) {
      return null
    }

    const nowSeconds =
      Math.floor(
        Date.now() / 1000,
      )

    const ageSeconds =
      nowSeconds - authDate

    if (
      ageSeconds < -300 ||
      ageSeconds > 3600
    ) {
      return null
    }

    const rawUser =
      params.get('user')

    if (!rawUser) {
      return null
    }

    const parsedUser =
      JSON.parse(
        rawUser,
      ) as Partial<MaxUser>

    if (
      (
        typeof parsedUser.id !==
          'number' &&
        typeof parsedUser.id !==
          'string'
      ) ||
      typeof parsedUser.first_name !==
        'string' ||
      !parsedUser.first_name.trim()
    ) {
      return null
    }

    return {
      id: parsedUser.id,
      first_name:
        parsedUser.first_name,

      last_name:
        typeof parsedUser.last_name ===
          'string'
          ? parsedUser.last_name
          : null,

      username:
        typeof parsedUser.username ===
          'string'
          ? parsedUser.username
          : null,

      photo_url:
        typeof parsedUser.photo_url ===
          'string'
          ? parsedUser.photo_url
          : null,
    }
  } catch {
    return null
  }
}

function buildDisplayName(
  user: {
    firstName: string | null
    lastName: string | null
    username: string | null
    displayName: string | null
  },
) {
  if (
    user.displayName?.trim()
  ) {
    return user.displayName.trim()
  }

  const fullName =
    [
      user.firstName,
      user.lastName,
    ]
      .filter(
        (part): part is string =>
          Boolean(part?.trim()),
      )
      .join(' ')
      .trim()

  if (fullName) {
    return fullName
  }

  if (user.username?.trim()) {
    return user.username.trim()
  }

  return '\u041f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c'
}

function toApiComment(
  comment: {
    id: string
    text: string
    createdAt: Date

    user: {
      firstName: string | null
      lastName: string | null
      username: string | null
      avatarUrl: string | null
      displayName: string | null
    }
  },
) {
  return {
    id: comment.id,
    text: comment.text,

    author:
      buildDisplayName(
        comment.user,
      ),

    authorAvatarUrl:
      comment.user.avatarUrl,

    createdAt:
      comment.createdAt.toISOString(),
  }
}

const userSelect = {
  firstName: true,
  lastName: true,
  username: true,
  avatarUrl: true,
  displayName: true,
} as const

export async function commentsRoutes(
  app: FastifyInstance,
) {
  app.get(
    '/:eventId',
    async (request, reply) => {
      const parsed =
        ParamsSchema.safeParse(
          request.params,
        )

      if (!parsed.success) {
        return reply.status(400).send({
          error: 'INVALID_EVENT_ID',
        })
      }

      const comments =
        await prisma.comment.findMany({
          where: {
            eventId:
              parsed.data.eventId,
          },

          orderBy: {
            createdAt: 'desc',
          },

          take: 100,

          include: {
            user: {
              select: userSelect,
            },
          },
        })

      return {
        items:
          comments.map(
            toApiComment,
          ),
      }
    },
  )

  app.post(
    '/',
    async (request, reply) => {
      const parsed =
        CreateCommentSchema.safeParse(
          request.body,
        )

      if (!parsed.success) {
        return reply
          .status(400)
          .send({
            error:
              'INVALID_COMMENT',

            details:
              parsed.error.flatten(),
          })
      }

      const event =
        await prisma.event.findFirst({
          where: {
            id: parsed.data.eventId,
            status: 'ACTIVE',
          },

          select: {
            id: true,
          },
        })

      if (!event) {
        return reply
          .status(404)
          .send({
            error:
              'EVENT_NOT_FOUND',
          })
      }

      const maxInitData =
        getMaxInitData(
          request.headers,
        )

      const clientId =
        getClientId(
          request.headers,
        )

      let user

      if (maxInitData) {
        const botToken =
          process.env.MAX_BOT_TOKEN ??
          ''

        const maxUser =
          verifyMaxInitData(
            maxInitData,
            botToken,
          )

        if (!maxUser) {
          return reply
            .status(401)
            .send({
              error:
                'INVALID_MAX_INIT_DATA',
            })
        }

        const firstName =
          maxUser.first_name.trim()

        const lastName =
          maxUser.last_name
            ?.trim() ||
          null

        const username =
          maxUser.username
            ?.trim() ||
          null

        const displayName =
          [
            firstName,
            lastName,
          ]
            .filter(Boolean)
            .join(' ')
            .trim() ||
          username ||
          `MAX ${String(maxUser.id)}`

        user =
          await prisma.user.upsert({
            where: {
              maxUserId:
                String(maxUser.id),
            },

            update: {
              firstName,
              lastName,
              username,

              avatarUrl:
                maxUser.photo_url ??
                null,

              displayName,
              lastSeenAt:
                new Date(),
            },

            create: {
              maxUserId:
                String(maxUser.id),

              firstName,
              lastName,
              username,

              avatarUrl:
                maxUser.photo_url ??
                null,

              displayName,
              lastSeenAt:
                new Date(),
            },
          })
      } else {
        if (!clientId) {
          return reply
            .status(400)
            .send({
              error:
                'CLIENT_ID_REQUIRED',
            })
        }

        user =
          await prisma.user.upsert({
            where: {
              maxUserId:
                clientId,
            },

            update: {
              lastSeenAt:
                new Date(),
            },

            create: {
              maxUserId:
                clientId,

              displayName:
                '\u041f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c',

              lastSeenAt:
                new Date(),
            },
          })
      }

      const comment =
        await prisma.comment.create({
          data: {
            userId: user.id,
            eventId: event.id,
            text: parsed.data.text,
          },

          include: {
            user: {
              select: userSelect,
            },
          },
        })

      return reply
        .status(201)
        .send(
          toApiComment(comment),
        )
    },
  )
}
