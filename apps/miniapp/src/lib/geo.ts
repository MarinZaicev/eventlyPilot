// ============================================================
// Геопозиция для «Рядом» (#33).
//
// Раньше: один точный запрос (GPS) на 10 с, и ЛЮБАЯ ошибка
// показывалась как «разреши доступ» — даже если просто не успели.
// Теперь: сначала быстрый приблизительный (по сети), потом точный;
// причина ошибки различается. Если не вышло — место вводят вручную
// (метро/улица/район), сервер находит координаты.
// ============================================================

export type GeoFailure =
  | 'unsupported'
  | 'insecure'
  | 'denied'
  | 'unavailable'
  | 'timeout'

export type GeoResult =
  | { ok: true; latitude: number; longitude: number }
  | { ok: false; reason: GeoFailure }

function requestPosition(
  options: PositionOptions,
): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options)
  })
}

function failureFromError(error: unknown): GeoFailure {
  const code = (error as GeolocationPositionError | undefined)?.code

  if (code === 1) return 'denied'
  if (code === 3) return 'timeout'

  return 'unavailable'
}

export async function getCurrentPosition(): Promise<GeoResult> {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return { ok: false, reason: 'insecure' }
  }

  if (!('geolocation' in navigator)) {
    return { ok: false, reason: 'unsupported' }
  }

  try {
    // Быстро и приблизительно: сеть/Wi‑Fi, можно недавнее значение.
    const position = await requestPosition({
      enableHighAccuracy: false,
      timeout: 8000,
      maximumAge: 10 * 60 * 1000,
    })

    return {
      ok: true,
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    }
  } catch (error) {
    const reason = failureFromError(error)

    // Нет доступа — второй запрос не поможет.
    if (reason === 'denied') {
      return { ok: false, reason }
    }
  }

  try {
    // Точно (GPS), с запасом по времени.
    const position = await requestPosition({
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0,
    })

    return {
      ok: true,
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    }
  } catch (error) {
    return { ok: false, reason: failureFromError(error) }
  }
}

// ---------- место, введённое вручную ----------

export type SavedPlace = {
  latitude: number
  longitude: number
  label: string
}

const PLACE_KEY = 'evently-nearby-place'

export function getSavedPlace(): SavedPlace | null {
  try {
    const raw = localStorage.getItem(PLACE_KEY)

    if (!raw) {
      return null
    }

    const place = JSON.parse(raw) as SavedPlace

    return Number.isFinite(place.latitude) &&
      Number.isFinite(place.longitude) &&
      typeof place.label === 'string'
      ? place
      : null
  } catch {
    return null
  }
}

export function savePlace(place: SavedPlace) {
  try {
    localStorage.setItem(PLACE_KEY, JSON.stringify(place))
  } catch {
    // хранилище недоступно — просто не запомним
  }
}

function currentCity() {
  try {
    return localStorage.getItem('evently-city') ?? 'msk'
  } catch {
    return 'msk'
  }
}

// null — место не найдено; исключение — сеть/сервер.
export async function searchPlace(
  query: string,
): Promise<SavedPlace | null> {
  const params = new URLSearchParams({
    q: query,
    city: currentCity(),
  })

  const response = await fetch(`/api/geo/search?${params}`)

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    throw new Error(`geo search failed: ${response.status}`)
  }

  return response.json()
}

export const GEO_FAILURE_TEXT: Record<GeoFailure, string> = {
  denied:
    'MAX не дал доступ к геопозиции. Проверьте: настройки телефона → MAX → Геолокация. Или укажите место вручную:',
  timeout:
    'Не успели определить, где вы. Попробуйте ещё раз или укажите место вручную:',
  unavailable:
    'Не удалось определить, где вы. Попробуйте ещё раз или укажите место вручную:',
  unsupported:
    'В этом окне геопозиция недоступна. Укажите место вручную:',
  insecure:
    'В этом окне геопозиция недоступна. Укажите место вручную:',
}

// ---------- расстояние до события (#34) ----------

export function distanceToEvent(
  from: { latitude: number; longitude: number } | null,
  venue: { latitude: number | null; longitude: number | null } | null,
): number | null {
  if (!from || venue?.latitude == null || venue?.longitude == null) {
    return null
  }

  const rad = Math.PI / 180
  const h =
    Math.sin(((venue.latitude - from.latitude) * rad) / 2) ** 2 +
    Math.cos(from.latitude * rad) *
      Math.cos(venue.latitude * rad) *
      Math.sin(((venue.longitude - from.longitude) * rad) / 2) ** 2

  return 2 * 6371 * Math.asin(Math.sqrt(h))
}

// 350 м / 1,2 км / 14 км
export function formatDistance(km: number) {
  if (km < 1) {
    return `${Math.max(50, Math.round((km * 1000) / 50) * 50)} м`
  }

  return km < 10
    ? `${km.toFixed(1).replace('.', ',')} км`
    : `${Math.round(km)} км`
}
