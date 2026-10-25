// ============================================================
// Кто делает запрос — ключ пользователя (User.maxUserId).
//
// 1) Валидный токен сессии (Authorization: Bearer …) —
//    аккаунт MAX: ключ = id пользователя в MAX.
// 2) Иначе x-evently-client-id — анонимный пользователь
//    этого браузера: ключ = "web:<clientId>" (вне MAX, разработка).
// 3) Иначе null.
// ============================================================

import { verifySessionToken } from './session.js'

export function getUserKey(
  headers: Record<string, unknown>,
): string | null {
  const authorization = headers.authorization

  if (
    typeof authorization === 'string' &&
    authorization.startsWith('Bearer ')
  ) {
    const key = verifySessionToken(
      authorization.slice('Bearer '.length).trim(),
    )

    if (key) {
      return key
    }
  }

  const clientId = headers['x-evently-client-id']

  if (
    typeof clientId === 'string' &&
    clientId.length >= 8
  ) {
    return `web:${clientId}`
  }

  return null
}

/*
 * Ключ принадлежит аккаунту MAX (а не анонимному браузеру).
 */
export function isMaxUserKey(
  key: string,
) {
  return !key.startsWith('web:')
}
