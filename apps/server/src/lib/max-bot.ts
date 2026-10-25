// ============================================================
// MAX Bot API — отправка сообщений от имени бота.
//
// Документация: https://dev.max.ru/docs-api/methods/POST/messages
//   POST {MAX_API_BASE}/messages?user_id=<id>
//   Authorization: <токен бота>
//   { text, format?, attachments?: [{ type: 'inline_keyboard', payload: { buttons } }] }
// Лимит: не больше 2 сообщений в секунду в один диалог.
// ============================================================

export type MaxLinkButton = {
  text: string
  url: string
}

export type MaxSendResult = {
  ok: boolean
  status: number
  body: string
}

export async function sendMaxMessage(options: {
  userId: string
  text: string
  buttons?: MaxLinkButton[]
}): Promise<MaxSendResult> {
  const token = process.env.MAX_BOT_TOKEN

  if (!token) {
    return {
      ok: false,
      status: 0,
      body: 'MAX_BOT_TOKEN is not set',
    }
  }

  const base = (
    process.env.MAX_API_BASE ??
    'https://platform-api.max.ru'
  ).replace(/\/$/, '')

  const buttons = (options.buttons ?? []).filter(
    (button) => /^https?:\/\//.test(button.url),
  )

  const response = await fetch(
    `${base}/messages?user_id=${encodeURIComponent(options.userId)}`,
    {
      method: 'POST',

      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
      },

      body: JSON.stringify({
        text: options.text.slice(0, 4000),

        attachments:
          buttons.length > 0
            ? [
                {
                  type: 'inline_keyboard',
                  payload: {
                    // по одной кнопке в ряд
                    buttons: buttons.map((button) => [
                      {
                        type: 'link',
                        text: button.text,
                        url: button.url,
                      },
                    ]),
                  },
                },
              ]
            : undefined,
      }),

      signal: AbortSignal.timeout(15_000),
    },
  )

  return {
    ok: response.ok,
    status: response.status,
    body: (await response.text()).slice(0, 500),
  }
}

// Ссылка, открывающая событие в Mini App:
// https://max.ru/<бот>?startapp=event_<uuid>
export function eventDeepLink(eventId: string) {
  const botName =
    process.env.MAX_BOT_NAME ?? 'se14469888_bot'

  return `https://max.ru/${botName}?startapp=event_${eventId}`
}
