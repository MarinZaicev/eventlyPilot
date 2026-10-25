/*
 * Импорт заведений («где поесть») из парсера.
 *
 * Читает output/app/places/<город>/latest.json. Парсер переписывает файл, только когда
 * заведения реально поменялись (поле contentHash), — обычно раз в неделю.
 * Заведения, которых больше нет в файле, помечаются active=false (не удаляются).
 *
 * Вызывать там же, где syncMovieEnrichments (parser-sync.plugin.ts).
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { prisma } from '@evently/db'

type Log = {
  info: (data: unknown, message: string) => void
  warn: (data: unknown, message: string) => void
}

type AppPlace = {
  source?: unknown
  externalId?: unknown
  sourceUrl?: unknown
  name?: unknown
  kind?: unknown
  categories?: unknown
  cuisine?: unknown
  address?: unknown
  latitude?: unknown
  longitude?: unknown
  subway?: unknown
  phone?: unknown
  website?: unknown
  openingHours?: unknown
  description?: unknown
  images?: unknown
  attribution?: unknown
  contentHash?: unknown
}

export type PlacesSyncResult = {
  cities: number
  upserted: number
  deactivated: number
  failed: number
}

// город → contentHash последнего импортированного файла (чтобы не перечитывать каждую минуту)
const imported = new Map<string, string>()

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** images/ab/abc.jpg → /media/events/ab/abc.jpg (тот же маршрут, что и у картинок событий) */
function imageUrl(images: unknown): string | null {
  if (!Array.isArray(images)) return null
  for (const raw of images) {
    if (!raw || typeof raw !== 'object') continue
    const image = raw as { localPath?: unknown; url?: unknown }
    const local = str(image.localPath)
    if (local && local.startsWith('images/')) {
      return `/media/events/${local.slice('images/'.length).split('/').map(encodeURIComponent).join('/')}`
    }
    const remote = str(image.url)
    if (remote) return remote
  }
  return null
}

export async function syncFoodPlaces(outputRoot: string, log: Log): Promise<PlacesSyncResult> {
  const root = join(outputRoot, 'app', 'places')
  const result: PlacesSyncResult = { cities: 0, upserted: 0, deactivated: 0, failed: 0 }

  let cities: string[]
  try {
    cities = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return result // парсер ещё не собирал заведения
  }

  for (const city of cities) {
    const path = join(root, city, 'latest.json')
    let data: { contentHash?: unknown; sources?: unknown; places?: unknown }
    try {
      data = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      result.failed += 1
      log.warn({ city, path, error: String(error) }, 'Places snapshot unreadable')
      continue
    }
    const hash = str(data.contentHash) ?? ''
    if (!Array.isArray(data.places) || (hash && imported.get(city) === hash)) continue

    const syncedAt = new Date()
    let cityFailed = 0
    for (const raw of data.places as AppPlace[]) {
      const source = str(raw?.source)
      const externalId = str(raw?.externalId)
      const name = str(raw?.name)
      if (!source || !externalId || !name) {
        cityFailed += 1
        continue
      }
      const fields = {
        city,
        name,
        kind: str(raw.kind) ?? 'other',
        cuisine: list(raw.cuisine),
        categories: list(raw.categories),
        address: str(raw.address),
        latitude: num(raw.latitude),
        longitude: num(raw.longitude),
        subway: str(raw.subway),
        phone: str(raw.phone),
        website: str(raw.website),
        sourceUrl: str(raw.sourceUrl),
        openingHours: str(raw.openingHours),
        description: str(raw.description),
        imageUrl: imageUrl(raw.images),
        attribution: str(raw.attribution),
        contentHash: str(raw.contentHash),
        active: true,
        lastSeenAt: syncedAt,
      }
      try {
        await prisma.foodPlace.upsert({
          where: { source_externalId: { source, externalId } },
          update: fields,
          create: { source, externalId, ...fields },
        })
        result.upserted += 1
      } catch (error) {
        cityFailed += 1
        log.warn({ city, source, externalId, error: String(error) }, 'Food place import failed')
      }
    }

    // Пропавшие из выгрузки — закрылись. Трогаем только источники, которые есть в этом файле.
    const sources = data.sources && typeof data.sources === 'object' ? Object.keys(data.sources) : []
    if (sources.length && cityFailed === 0) {
      const gone = await prisma.foodPlace.updateMany({
        where: { city, source: { in: sources }, active: true, lastSeenAt: { lt: syncedAt } },
        data: { active: false },
      })
      result.deactivated += gone.count
    }
    result.failed += cityFailed
    result.cities += 1
    if (hash && cityFailed === 0) imported.set(city, hash)
    log.info({ city, places: data.places.length, failed: cityFailed }, 'Places snapshot imported')
  }
  return result
}
