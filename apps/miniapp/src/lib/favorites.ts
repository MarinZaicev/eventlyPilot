import { authHeaders } from './session'
import type { ApiEvent } from '@evently/shared'


/*
 * Сохранённые события (избранное) — хранятся на сервере,
 * не пропадают при перезагрузке.
 */
export async function getFavorites(): Promise<ApiEvent[]> {
  const response = await fetch('/api/favorites/', {
    headers: {
      ...(await authHeaders()),
    },
  })

  if (!response.ok) {
    throw new Error(
      `Failed to load favorites: ${response.status}`,
    )
  }

  const data = (await response.json()) as {
    items: ApiEvent[]
  }

  return data.items
}

export async function setFavorite(
  eventId: string,
  saved: boolean,
) {
  // Без тела и без Content-Type: Fastify отклоняет
  // пустое тело с Content-Type: application/json.
  const response = await fetch(
    `/api/favorites/${eventId}`,
    {
      method: saved ? 'PUT' : 'DELETE',

      headers: {
        ...(await authHeaders()),
      },
    },
  )

  if (!response.ok) {
    throw new Error(
      `Failed to update favorite: ${response.status}`,
    )
  }
}
