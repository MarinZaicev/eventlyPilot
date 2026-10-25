import { authHeaders } from './session'
import type {
  ApiEvent,
  ApiEventsResponse,
} from '@evently/shared'


export async function getEvents(
  limit = 20,
  category?: string,
  latitude?: number,
  longitude?: number,
  city?: string,
  exclude?: string[],
): Promise<ApiEventsResponse> {
  const params =
    new URLSearchParams()

  params.set(
    'limit',
    String(limit),
  )

  if (category) {
    params.set(
      'category',
      category,
    )
  }

  let effectiveCity =
    city

  if (!effectiveCity) {
    try {
      effectiveCity =
        localStorage.getItem(
          'evently-city',
        ) ?? 'msk'
    } catch {
      effectiveCity = 'msk'
    }
  }

  params.set(
    'city',
    effectiveCity,
  )

  // id событий, которые уже есть в ленте:
  // сервер их не вернёт (подгрузка страниц).
  if (
    exclude &&
    exclude.length > 0
  ) {
    params.set(
      'exclude',
      exclude.join(','),
    )
  }

  if (
    latitude !== undefined &&
    longitude !== undefined
  ) {
    params.set(
      'latitude',
      String(latitude),
    )

    params.set(
      'longitude',
      String(longitude),
    )
  }

  const response = await fetch(
    `/api/feed/?${params.toString()}`,
    {
      headers: {
        ...(await authHeaders()),
      },
    },
  )

  if (!response.ok) {
    throw new Error(
      `Failed to load feed: ${response.status}`,
    )
  }

  return response.json()
}

export type {
  ApiEvent,
}

// Одно событие по id (открытие по ссылке «Поделиться»).
// null — события нет или оно уже неактивно.
export async function getEventById(
  id: string,
): Promise<ApiEvent | null> {
  const response = await fetch(
    `/api/events/${encodeURIComponent(id)}`,
  )

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    throw new Error(
      `Failed to load event: ${response.status}`,
    )
  }

  return response.json()
}
