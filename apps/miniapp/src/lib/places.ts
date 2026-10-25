import type {
  ApiNearbyFoodPlacesResponse,
} from '@evently/shared'

export type NearbyFoodPlace =
  ApiNearbyFoodPlacesResponse['items'][number]

// Заведения рядом с площадкой события.
export async function getFoodNearEvent(
  eventId: string,
  limit = 5,
): Promise<ApiNearbyFoodPlacesResponse> {
  const response = await fetch(
    `/api/places/near-event/${encodeURIComponent(eventId)}?limit=${limit}&radius=1000`,
  )

  if (!response.ok) {
    throw new Error(
      `Failed to load places: ${response.status}`,
    )
  }

  return response.json()
}

const KIND_LABELS: Record<string, string> = {
  restaurant: 'Ресторан',
  cafe: 'Кафе',
  coffee: 'Кофейня',
  bar: 'Бар',
  fast_food: 'Фастфуд',
  bakery: 'Пекарня',
  canteen: 'Столовая',
  other: 'Заведение',
}

const KIND_ICONS: Record<string, string> = {
  restaurant: '🍽️',
  cafe: '🍰',
  coffee: '☕',
  bar: '🍸',
  fast_food: '🍔',
  bakery: '🥐',
  canteen: '🍲',
  other: '🍴',
}

// Кухня из OpenStreetMap приходит по-английски.
const CUISINE_LABELS: Record<string, string> = {
  russian: 'русская',
  italian: 'итальянская',
  pizza: 'пицца',
  japanese: 'японская',
  sushi: 'суши',
  georgian: 'грузинская',
  asian: 'азиатская',
  chinese: 'китайская',
  korean: 'корейская',
  vietnamese: 'вьетнамская',
  thai: 'тайская',
  indian: 'индийская',
  uzbek: 'узбекская',
  caucasian: 'кавказская',
  european: 'европейская',
  french: 'французская',
  american: 'американская',
  mexican: 'мексиканская',
  burger: 'бургеры',
  coffee_shop: 'кофе',
  shawarma: 'шаурма',
  kebab: 'кебаб',
  steak_house: 'стейки',
  seafood: 'морепродукты',
  vegetarian: 'вегетарианская',
  vegan: 'веганская',
  regional: 'местная',
  international: 'интернациональная',
  dessert: 'десерты',
  cake: 'торты',
  ice_cream: 'мороженое',
  breakfast: 'завтраки',
  pancake: 'блины',
  noodle: 'лапша',
  ramen: 'рамен',
  dumplings: 'пельмени',
  pelmeni: 'пельмени',
  beer: 'пиво',
  wine: 'вино',
  tea: 'чай',
  sandwich: 'сэндвичи',
  chicken: 'курица',
}

export function placeKindLabel(kind: string) {
  return KIND_LABELS[kind] ?? KIND_LABELS.other
}

export function placeKindIcon(kind: string) {
  return KIND_ICONS[kind] ?? KIND_ICONS.other
}

export function placeCuisine(
  cuisine: string[] | null,
) {
  return (cuisine ?? [])
    .slice(0, 2)
    .map(
      (item) =>
        CUISINE_LABELS[item.toLowerCase()] ??
        item.replace(/_/g, ' '),
    )
    .join(', ')
}

// 340 м · 4 мин пешком
export function placeDistance(meters: number) {
  const walkMinutes = Math.max(
    1,
    Math.round(meters / 80),
  )

  const distance =
    meters < 1000
      ? `${Math.round(meters / 10) * 10} м`
      : `${(meters / 1000).toFixed(1).replace('.', ',')} км`

  return `${distance} · ${walkMinutes} мин пешком`
}

export function placeMapUrl(place: {
  name: string
  latitude: number | null
  longitude: number | null
  address: string | null
}) {
  if (
    place.latitude !== null &&
    place.longitude !== null
  ) {
    return `https://yandex.ru/maps/?pt=${place.longitude},${place.latitude},pm2rdm&z=17&ll=${place.longitude},${place.latitude}`
  }

  return `https://yandex.ru/maps/?text=${encodeURIComponent(
    [place.name, place.address].filter(Boolean).join(', '),
  )}`
}

