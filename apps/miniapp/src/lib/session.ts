import { getClientId } from './interactions'

import { getMaxInitData } from './max'

/*
 * Вход через MAX: один раз при запуске отправляем подписанные
 * данные Mini App и получаем токен сессии (30 дней). Дальше все
 * запросы идут с ним — сервер узнаёт пользователя по аккаунту MAX
 * на любом устройстве. История с этого телефона переносится
 * в аккаунт при первом входе.
 *
 * Вне MAX (обычный браузер) входа нет — работает анонимный
 * id браузера, как раньше.
 */

const SESSION_KEY = 'evently_session'

let sessionPromise: Promise<void> | null = null

function readToken() {
  try {
    return localStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
}

export function ensureSession(): Promise<void> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const initData = getMaxInitData()

      if (!initData) {
        return
      }

      try {
        // Без тела и без Content-Type.
        const response = await fetch('/api/auth/max', {
          method: 'POST',

          headers: {
            'x-max-init-data': initData,
            'x-evently-client-id': getClientId(),
          },
        })

        if (!response.ok) {
          return
        }

        const data = (await response.json()) as {
          token?: string
        }

        if (data.token) {
          try {
            localStorage.setItem(SESSION_KEY, data.token)
          } catch {
            // без storage токен не сохранится — сработает анонимный режим
          }
        }
      } catch {
        // сеть недоступна — анонимный режим, попробуем при следующем запуске
      }
    })()
  }

  return sessionPromise
}

/*
 * Заголовки для запросов к API: id браузера и, если вошли
 * через MAX, токен сессии. Ждёт завершения входа, чтобы
 * первые запросы не ушли от имени анонимного пользователя.
 */
export async function authHeaders(): Promise<Record<string, string>> {
  await ensureSession()

  const headers: Record<string, string> = {
    'x-evently-client-id': getClientId(),
  }

  const token = readToken()

  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  return headers
}
