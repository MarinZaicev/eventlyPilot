import { authHeaders } from './session'
import {
  getMaxInitData,
} from './max'


export type ApiComment = {
  id: string
  text: string
  author: string
  authorAvatarUrl: string | null
  createdAt: string
}

export async function getComments(
  eventId: string,
): Promise<ApiComment[]> {
  const response = await fetch(
    `/api/comments/${eventId}`,
  )

  if (!response.ok) {
    throw new Error(
      `Failed to load comments: ${response.status}`,
    )
  }

  const data =
    await response.json() as {
      items: ApiComment[]
    }

  return data.items
}

export async function createComment(
  eventId: string,
  text: string,
): Promise<ApiComment> {
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
    '/api/comments/',
    {
      method: 'POST',

      headers,

      body: JSON.stringify({
        eventId,
        text,
      }),
    },
  )

  if (!response.ok) {
    const body =
      await response
        .text()
        .catch(() => '')

    throw new Error(
      `Failed to create comment: ${response.status} ${body}`,
    )
  }

  return response.json()
}
