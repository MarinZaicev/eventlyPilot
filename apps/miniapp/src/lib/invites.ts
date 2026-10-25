import type { ApiEvent } from './api'

import { authHeaders } from './session'

// ============================================================
// «Пойдём вместе» — см. apps/server/src/modules/invites.
// ============================================================

export type InviteInfo = {
  event: ApiEvent

  inviter: {
    name: string | null
    avatarUrl: string | null
  }

  isOwn: boolean
  alreadyGoing: boolean
  acceptedThisInvite: boolean
}

let myCodePromise: Promise<string | null> | null = null

// Мой постоянный код приглашений (один запрос за сессию).
export function getMyInviteCode() {
  if (!myCodePromise) {
    myCodePromise = (async () => {
      try {
        const response = await fetch(
          '/api/invites/me',
          {
            headers: {
              ...(await authHeaders()),
            },
          },
        )

        if (!response.ok) {
          return null
        }

        const data = await response.json() as {
          code?: string
        }

        return data.code ?? null
      } catch {
        return null
      }
    })()

    // Не получилось — попробуем в следующий раз.
    void myCodePromise.then((code) => {
      if (!code) {
        myCodePromise = null
      }
    })
  }

  return myCodePromise
}

// null — приглашение или событие не найдены.
export async function getInvite(
  code: string,
  eventId: string,
): Promise<InviteInfo | null> {
  const response = await fetch(
    `/api/invites/${encodeURIComponent(code)}/${encodeURIComponent(eventId)}`,
    {
      headers: {
        ...(await authHeaders()),
      },
    },
  )

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    throw new Error(
      `Failed to load invite: ${response.status}`,
    )
  }

  return response.json()
}

export async function acceptInvite(
  code: string,
  eventId: string,
) {
  const response = await fetch(
    `/api/invites/${encodeURIComponent(code)}/${encodeURIComponent(eventId)}/accept`,
    {
      method: 'POST',

      headers: {
        ...(await authHeaders()),
      },
    },
  )

  if (!response.ok) {
    throw new Error(
      `Failed to accept invite: ${response.status}`,
    )
  }

  return response.json() as Promise<{
    ok: boolean
    notified: boolean
  }>
}
