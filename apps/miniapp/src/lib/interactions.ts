import { authHeaders } from './session'
export type InteractionType =
  | 'IMPRESSION'
  | 'OPEN'
  | 'DWELL'
  | 'FAVORITE'
  | 'UNFAVORITE'
  | 'TICKET_CLICK'
  | 'SHARE'
  | 'HIDE'

type InteractionMetadataValue =
  | string
  | number
  | boolean
  | null

type SendInteractionOptions = {
  durationMs?: number

  metadata?: Record<
    string,
    InteractionMetadataValue
  >
}

const CLIENT_ID_KEY = 'evently_client_id'

function createClientId() {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID()
  }

  return [
    Date.now().toString(36),
    Math.random().toString(36).slice(2),
    Math.random().toString(36).slice(2),
  ].join('-')
}

export function getClientId() {
  let clientId = localStorage.getItem(
    CLIENT_ID_KEY,
  )

  if (!clientId) {
    clientId = createClientId()

    localStorage.setItem(
      CLIENT_ID_KEY,
      clientId,
    )
  }

  return clientId
}

export async function sendInteraction(
  eventId: string,
  type: InteractionType,
  options: SendInteractionOptions = {},
) {
  try {
    const response = await fetch(
      '/api/interactions/',
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',

          ...(await authHeaders()),
        },

        body: JSON.stringify({
          eventId,
          type,

          durationMs:
            options.durationMs,

          metadata:
            options.metadata,
        }),

        keepalive: true,
      },
    )

    if (!response.ok) {
      console.error(
        'Interaction failed:',
        type,
        response.status,
      )
    }
  } catch (error) {
    // Аналитика никогда не должна ломать UI.
    console.error(
      'Interaction request failed:',
      error,
    )
  }
}
