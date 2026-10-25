// ============================================================
// DEDUPLICATION — DATABASE
//
// Загружает актуальные события, находит дубликаты
// (dedup.match.ts) и проставляет Event.duplicateOfId.
// Разметка пересчитывается целиком при каждом запуске,
// поэтому исправление данных в источниках «снимает» пометку.
// ============================================================

import { prisma } from '@evently/db'

import {
  findDuplicateClusters,
  type DedupCandidate,
  type DedupResult,
} from './dedup.match.js'

export type DedupRunStats = Omit<DedupResult, 'clusters'> & {
  clusters: number
  markedDuplicates: number
  cleared: number
}

export async function deduplicateEvents(): Promise<DedupRunStats> {
  // Прошедшие события не интересны — смотрим с суток назад.
  const since = new Date(Date.now() - 24 * 3_600_000)

  const events = await prisma.event.findMany({
    where: {
      status: 'ACTIVE',
      occurrences: {
        some: {
          startsAt: {
            gte: since,
          },
        },
      },
    },

    select: {
      id: true,
      source: true,
      sourceCity: true,
      title: true,
      ticketUrl: true,
      priceMin: true,
      isFree: true,
      description: true,
      createdAt: true,
      duplicateOfId: true,

      venue: {
        select: {
          name: true,
          city: true,
          latitude: true,
          longitude: true,
        },
      },

      occurrences: {
        where: {
          startsAt: {
            gte: since,
          },
        },

        select: {
          startsAt: true,
        },
      },

      _count: {
        select: {
          images: true,
        },
      },
    },
  })

  const candidates: DedupCandidate[] = events.map((event) => ({
    id: event.id,
    source: event.source,
    city: (
      event.sourceCity ??
      event.venue?.city ??
      'unknown'
    ).toLowerCase(),
    title: event.title,
    venueName: event.venue?.name ?? null,
    latitude: event.venue?.latitude ?? null,
    longitude: event.venue?.longitude ?? null,
    startTimes: event.occurrences.map((occurrence) =>
      occurrence.startsAt.getTime(),
    ),
    completeness:
      (event._count.images > 0 ? 3 : 0) +
      (event.ticketUrl ? 2 : 0) +
      (event.isFree || event.priceMin !== null ? 1 : 0) +
      ((event.description ?? '').length > 100 ? 1 : 0),
    createdAt: event.createdAt.getTime(),
  }))

  const result = findDuplicateClusters(candidates)

  const target = new Map<string, string>()

  for (const cluster of result.clusters) {
    for (const id of cluster.duplicateIds) {
      target.set(id, cluster.primaryId)
    }
  }

  let markedDuplicates = 0
  let cleared = 0

  // Группируем обновления по основному событию.
  const byPrimary = new Map<string, string[]>()

  for (const event of events) {
    const wanted = target.get(event.id) ?? null

    if (wanted === event.duplicateOfId) {
      continue
    }

    if (wanted === null) {
      cleared += 1
    } else {
      markedDuplicates += 1
    }

    const key = wanted ?? ''
    const list = byPrimary.get(key) ?? []
    list.push(event.id)
    byPrimary.set(key, list)
  }

  for (const [primaryId, ids] of byPrimary) {
    await prisma.event.updateMany({
      where: {
        id: {
          in: ids,
        },
      },

      data: {
        duplicateOfId: primaryId === '' ? null : primaryId,
      },
    })
  }

  return {
    considered: result.considered,
    pairsCompared: result.pairsCompared,
    duplicatePairs: result.duplicatePairs,
    clusters: result.clusters.length,
    markedDuplicates,
    cleared,
  }
}
