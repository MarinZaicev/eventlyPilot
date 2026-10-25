// ============================================================
// SESSION — токен сессии пользователя MAX.
//
// После входа через MAX (POST /api/auth/max) клиент получает
// токен на 30 дней и шлёт его в `Authorization: Bearer <token>`.
// Формат: base64url(JSON {k, exp}).base64url(HMAC-SHA256).
//   k   — ключ пользователя (User.maxUserId = id в MAX),
//   exp — срок действия (unix, секунды).
// Секрет: SESSION_SECRET, иначе производный от MAX_BOT_TOKEN.
// ============================================================

import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto'

const TTL_SECONDS = 30 * 24 * 3600

function secret() {
  const explicit = process.env.SESSION_SECRET

  if (explicit) {
    return explicit
  }

  const botToken = process.env.MAX_BOT_TOKEN

  if (!botToken) {
    return null
  }

  return createHmac('sha256', 'evently-session')
    .update(botToken)
    .digest('hex')
}

function sign(payload: string, key: string) {
  return createHmac('sha256', key)
    .update(payload)
    .digest('base64url')
}

export function createSessionToken(
  userKey: string,
) {
  const key = secret()

  if (!key) {
    throw new Error('SESSION_SECRET or MAX_BOT_TOKEN is not set')
  }

  const payload = Buffer.from(
    JSON.stringify({
      k: userKey,
      exp: Math.floor(Date.now() / 1000) + TTL_SECONDS,
    }),
  ).toString('base64url')

  return `${payload}.${sign(payload, key)}`
}

/*
 * Возвращает ключ пользователя или null
 * (нет токена, подпись неверна, срок истёк).
 */
export function verifySessionToken(
  token: string,
): string | null {
  const key = secret()

  if (!key) {
    return null
  }

  const [payload, signature] = token.split('.')

  if (!payload || !signature) {
    return null
  }

  const expected = Buffer.from(sign(payload, key))
  const received = Buffer.from(signature)

  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  ) {
    return null
  }

  try {
    const data = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as {
      k?: unknown
      exp?: unknown
    }

    if (
      typeof data.k !== 'string' ||
      typeof data.exp !== 'number' ||
      data.exp < Date.now() / 1000
    ) {
      return null
    }

    return data.k
  } catch {
    return null
  }
}
