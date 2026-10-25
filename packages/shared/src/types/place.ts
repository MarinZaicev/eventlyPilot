export type ApiFoodPlaceKind =
  | 'restaurant'
  | 'cafe'
  | 'coffee'
  | 'bar'
  | 'fast_food'
  | 'bakery'
  | 'canteen'
  | 'other'

export type ApiFoodPlace = {
  id: string
  source: 'kudago' | 'osm' | string
  city: string
  name: string
  kind: ApiFoodPlaceKind
  cuisine: string[] | null
  address: string | null
  latitude: number | null
  longitude: number | null
  subway: string | null
  phone: string | null
  website: string | null
  sourceUrl: string | null
  openingHours: string | null
  description: string | null
  imageUrl: string | null
  // Для OSM показывать обязательно: «© участники OpenStreetMap»
  attribution: string | null
  // Только при запросе с lat/lon
  distanceM?: number
}

export type ApiFoodPlacesResponse = {
  total: number
  items: ApiFoodPlace[]
}

// GET /api/places/near-event/:eventId — заведения рядом с площадкой события.
export type ApiNearbyFoodPlacesResponse = {
  // false — у площадки нет координат, искать не по чему
  hasLocation: boolean
  radiusM: number
  items: Array<ApiFoodPlace & { distanceM: number }>
}
