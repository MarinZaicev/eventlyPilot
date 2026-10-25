import { authHeaders } from './session'

import {
  getMaxInitData,
} from './max'

export type AiChatMessage = {
  role: 'user' | 'assistant'
  content: string
  eventIds?: string[]
}

export type AiEventSuggestion = {
  id: string
  title: string
  imageUrl: string | null
  venue: string | null
  address: string | null
  price: string
  startsAt: string | null
  url: string | null
}

export type AiChatResponse = {
  answer: string
  events: AiEventSuggestion[]
}

export async function sendAiMessage(
  message: string,
  history: AiChatMessage[],
): Promise<AiChatResponse> {
  const maxInitData =
    getMaxInitData()

  const headers:
    Record<string, string> = {
      'Content-Type':
        'application/json',

      ...(await authHeaders()),
    }

  if (maxInitData) {
    headers['x-max-init-data'] =
      maxInitData
  }

  const response = await fetch(
    '/api/ai/chat',
    {
      method: 'POST',
      headers,

      body: JSON.stringify({
        message,
        history:
          history.slice(-10),

        city: (() => {
          try {
            return (
              localStorage.getItem(
                'evently-city',
              ) ?? 'msk'
            )
          } catch {
            return 'msk'
          }
        })(),
      }),
    },
  )

  if (!response.ok) {
    const body =
      await response
        .text()
        .catch(() => '')

    throw new Error(
      `AI request failed: ${response.status} ${body}`,
    )
  }

  return response.json()
}

// ---------- где поесть рядом с мероприятием (#40) ----------

export type AiFoodPlace = {
  id: string
  source: string
  name: string
  kind: string
  cuisine: string[]
  address: string | null
  latitude: number
  longitude: number
  imageUrl: string | null
  attribution: string | null
  distanceM: number
  reason: string
}

export type AiFoodResponse = {
  event: { id: string; title: string } | null
  ai: boolean
  answer: string
  places: AiFoodPlace[]
}

export async function askFoodNearEvent(
  eventId: string,
): Promise<AiFoodResponse> {
  const response = await fetch('/api/ai/food-near-event', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(await authHeaders()),
    },
    body: JSON.stringify({ eventId }),
  })

  if (!response.ok) {
    throw new Error(`AI food request failed: ${response.status}`)
  }

  return response.json()
}
