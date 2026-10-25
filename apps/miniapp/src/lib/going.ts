import { authHeaders } from './session'
import type { ApiEvent } from '@evently/shared'


import { getMaxInitData } from './max'

/*
 * «Пойду» — хранится на сервере. Сервер сам записывает
 * сигнал для рекомендаций (GOING / NOT_GOING) и запоминает
 * ближайший сеанс для напоминания от бота.
 */
export async function getGoing(): Promise<ApiEvent[]> {
  const response = await fetch('/api/going/', {
    headers: {
      ...(await authHeaders()),
    },
  })

  if (!response.ok) {
    throw new Error(
      `Failed to load going: ${response.status}`,
    )
  }

  const data = (await response.json()) as {
    items: ApiEvent[]
  }

  return data.items
}

export async function setGoing(
  eventId: string,
  going: boolean,
) {
  // Без тела и без Content-Type (как в избранном).
  // x-max-init-data — чтобы бот MAX мог напомнить о событии.
  const headers: Record<string, string> = {
    ...(await authHeaders()),
  }

  const maxInitData = getMaxInitData()

  if (maxInitData) {
    headers['x-max-init-data'] = maxInitData
  }

  const response = await fetch(
    `/api/going/${eventId}`,
    {
      method: going ? 'PUT' : 'DELETE',
      headers,
    },
  )

  if (!response.ok) {
    throw new Error(
      `Failed to update going: ${response.status}`,
    )
  }
}
