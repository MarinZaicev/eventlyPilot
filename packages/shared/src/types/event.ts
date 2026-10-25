export type ApiCategory = {
  id: string
  slug: string
  name: string
  icon: string | null
}

export type ApiVenue = {
  id: string
  name: string
  address: string | null
  city: string | null
  latitude: number | null
  longitude: number | null
}

export type ApiEventOccurrence = {
  id: string
  startsAt: string
  endsAt: string | null
  ticketUrl: string | null
}

export type ApiEventImage = {
  id: string
  url: string
  position: number
}

export type ApiEventMovie = {
  tmdbId: number | null
  mediaType: string | null

  title: string | null
  originalTitle: string | null
  releaseYear: number | null

  overview: string | null

  posterUrl: string | null
  backdropUrl: string | null

  trailerEmbedUrl: string | null
  trailerUrl: string | null
  trailerKey: string | null

  voteAverage: number | null
  runtime: number | null
  ageRating: string | null

  genres: unknown[]
}

export type ApiEvent = {
  id: string

  // Популярность у ДРУГИХ пользователей (#36): лайки и «Пойду».
  social?: {
    likes: number
    going: number
  }

  // Источник: kudago, timepad, kinopoisk-cinema…
  // У kinopoisk-cinema нет сеансов — дата условная (#28).
  source?: string

  title: string
  shortDescription: string | null
  description: string | null

  priceMin: number | null
  priceMax: number | null
  currency: string
  isFree: boolean

  ageRating: number | null

  ticketUrl: string | null
  sourceUrl: string | null

  venue: ApiVenue | null

  occurrences: ApiEventOccurrence[]

  images: ApiEventImage[]

  categories: ApiCategory[]

  movie?: ApiEventMovie | null
}

export type ApiEventsResponse = {
  items: ApiEvent[]
  nextCursor: string | null
}
