import { authHeaders } from './session'

export type ApiCategory = {
  id: string
  slug: string
  name: string
  icon: string | null
  sortOrder: number
}

export type ProfileInterest = {
  slug: string
  name: string
  icon: string | null
  weight: number
}

export type ProfileInterestsResponse = {
  onboardingCompleted: boolean
  categories: ProfileInterest[]
}

export async function getCategories() {
  const response = await fetch('/api/categories/')

  if (!response.ok) {
    throw new Error(
      `Failed to load categories: ${response.status}`,
    )
  }

  const data = await response.json() as {
    items: ApiCategory[]
  }

  return data.items
}

export async function getProfileInterests():
  Promise<ProfileInterestsResponse> {
  const response = await fetch(
    '/api/profile/interests/',
    {
      headers: {
        ...(await authHeaders()),
      },
    },
  )

  if (!response.ok) {
    throw new Error(
      `Failed to load profile: ${response.status}`,
    )
  }

  return response.json()
}

export async function saveProfileInterests(
  categories: string[],
) {
  const response = await fetch(
    '/api/profile/interests/',
    {
      method: 'PUT',

      headers: {
        'Content-Type': 'application/json',
        ...(await authHeaders()),
      },

      body: JSON.stringify({
        categories,
      }),
    },
  )

  if (!response.ok) {
    throw new Error(
      `Failed to save interests: ${response.status}`,
    )
  }

  return response.json()
}
