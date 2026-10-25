import {
  readFile,
  readdir,
} from 'node:fs/promises'

import {
  join,
} from 'node:path'

import {
  prisma,
} from '@evently/db'

type MovieSnapshot = {
  source: string
  city: string
  path: string
}

type ImportMovieResult = {
  snapshots: number
  received: number
  matched: number
  unmatched: number
  failed: number
}

function asString(
  value: unknown,
) {
  if (
    typeof value === 'string' &&
    value.trim()
  ) {
    return value.trim()
  }

  if (
    typeof value === 'number' &&
    Number.isFinite(value)
  ) {
    return String(value)
  }

  return null
}

function asNumber(
  value: unknown,
) {
  if (
    typeof value === 'number' &&
    Number.isFinite(value)
  ) {
    return value
  }

  if (
    typeof value === 'string'
  ) {
    const parsed =
      Number(value)

    if (
      Number.isFinite(parsed)
    ) {
      return parsed
    }
  }

  return null
}

function asInteger(
  value: unknown,
) {
  const number =
    asNumber(value)

  return number === null
    ? null
    : Math.trunc(number)
}

function asObject(
  value: unknown,
): Record<string, unknown> | null {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return value as Record<
      string,
      unknown
    >
  }

  return null
}

function extractMovieItems(
  value: unknown,
): unknown[] {
  if (
    Array.isArray(value)
  ) {
    return value
  }

  const object =
    asObject(value)

  if (!object) {
    return []
  }

  const candidates = [
    object.movies,
    object.items,
    object.events,
    object.results,
  ]

  for (
    const candidate
    of candidates
  ) {
    if (
      Array.isArray(candidate)
    ) {
      return candidate
    }
  }

  /*
   * Некоторые файлы могут содержать
   * одну enrichment-запись напрямую.
   */
  if (
    'event_source' in object ||
    'event_source_id' in object
  ) {
    return [
      object,
    ]
  }

  return []
}

async function discoverMovieSnapshots(
  outputRoot: string,
): Promise<MovieSnapshot[]> {
  const moviesRoot =
    join(
      outputRoot,
      'movies',
    )

  const result:
    MovieSnapshot[] = []

  let sources:
    Array<
      import('node:fs').Dirent<string>
    >

  try {
    sources =
      await readdir(
        moviesRoot,
        {
          withFileTypes: true,
        },
      )
  } catch {
    return []
  }

  for (
    const sourceEntry
    of sources
  ) {
    if (
      !sourceEntry.isDirectory()
    ) {
      continue
    }

    /*
     * tmdb/ru/latest.json —
     * общий каталог фильмов,
     * а не enrichment конкретных Event.
     */
    if (
      sourceEntry.name ===
      'tmdb'
    ) {
      continue
    }

    const source =
      sourceEntry.name

    const sourceRoot =
      join(
        moviesRoot,
        source,
      )

    const cities =
      await readdir(
        sourceRoot,
        {
          withFileTypes: true,
        },
      )

    for (
      const cityEntry
      of cities
    ) {
      if (
        !cityEntry.isDirectory()
      ) {
        continue
      }

      result.push({
        source,
        city:
          cityEntry.name,

        path:
          join(
            sourceRoot,
            cityEntry.name,
            'latest.json',
          ),
      })
    }
  }

  return result
}

async function importMovieItem(
  raw: unknown,
) {
  const item =
    asObject(raw)

  if (!item) {
    throw new Error(
      'INVALID_MOVIE_ITEM',
    )
  }

  const eventSource =
    asString(
      item.event_source,
    )

  const eventSourceId =
    asString(
      item.event_source_id,
    )

  if (
    !eventSource ||
    !eventSourceId
  ) {
    throw new Error(
      'MOVIE_EVENT_LINK_MISSING',
    )
  }

  const event =
    await prisma.event.findUnique({
      where: {
        source_externalId: {
          source:
            eventSource,

          externalId:
            eventSourceId,
        },
      },

      select: {
        id: true,
      },
    })

  if (!event) {
    return {
      matched:
        false,
    }
  }

  const trailer =
    asObject(
      item.trailer,
    )

  const genres =
    Array.isArray(
      item.genres,
    )
      ? item.genres
      : []

  await prisma.eventMovie.upsert({
    where: {
      eventId:
        event.id,
    },

    update: {
      tmdbId:
        asInteger(
          item.tmdb_id,
        ),

      mediaType:
        asString(
          item.media_type,
        ),

      title:
        asString(
          item.title,
        ),

      originalTitle:
        asString(
          item.original_title,
        ),

      releaseYear:
        asInteger(
          item.release_year,
        ),

      overview:
        asString(
          item.overview,
        ),

      posterUrl:
        asString(
          item.poster_url,
        ),

      backdropUrl:
        asString(
          item.backdrop_url,
        ),

      trailerEmbedUrl:
        asString(
          trailer?.embed_url,
        ) ??
        asString(
          item.trailer_embed_url,
        ),

      trailerUrl:
        asString(
          trailer?.url,
        ) ??
        asString(
          item.trailer_url,
        ),

      trailerKey:
        asString(
          trailer?.key,
        ) ??
        asString(
          item.trailer_key,
        ),

      voteAverage:
        asNumber(
          item.vote_average,
        ),

      runtime:
        asInteger(
          item.runtime,
        ),

      ageRating:
        asString(
          item.age_rating,
        ),

      genres,
    },

    create: {
      eventId:
        event.id,

      tmdbId:
        asInteger(
          item.tmdb_id,
        ),

      mediaType:
        asString(
          item.media_type,
        ),

      title:
        asString(
          item.title,
        ),

      originalTitle:
        asString(
          item.original_title,
        ),

      releaseYear:
        asInteger(
          item.release_year,
        ),

      overview:
        asString(
          item.overview,
        ),

      posterUrl:
        asString(
          item.poster_url,
        ),

      backdropUrl:
        asString(
          item.backdrop_url,
        ),

      trailerEmbedUrl:
        asString(
          trailer?.embed_url,
        ) ??
        asString(
          item.trailer_embed_url,
        ),

      trailerUrl:
        asString(
          trailer?.url,
        ) ??
        asString(
          item.trailer_url,
        ),

      trailerKey:
        asString(
          trailer?.key,
        ) ??
        asString(
          item.trailer_key,
        ),

      voteAverage:
        asNumber(
          item.vote_average,
        ),

      runtime:
        asInteger(
          item.runtime,
        ),

      ageRating:
        asString(
          item.age_rating,
        ),

      genres,
    },
  })

  return {
    matched:
      true,
  }
}

export async function syncMovieEnrichments(
  outputRoot: string,

  log: {
    info:
      (
        data: unknown,
        message: string,
      ) => void

    warn:
      (
        data: unknown,
        message: string,
      ) => void
  },
): Promise<ImportMovieResult> {
  const snapshots =
    await discoverMovieSnapshots(
      outputRoot,
    )

  let received =
    0

  let matched =
    0

  let unmatched =
    0

  let failed =
    0

  for (
    const snapshot
    of snapshots
  ) {
    let rawText:
      string

    try {
      rawText =
        await readFile(
          snapshot.path,
          'utf8',
        )
    } catch {
      /*
       * У некоторых source/city enrichment
       * пока может отсутствовать.
       */
      continue
    }

    let raw:
      unknown

    try {
      raw =
        JSON.parse(
          rawText,
        )
    } catch {
      failed +=
        1

      log.warn(
        {
          source:
            snapshot.source,

          city:
            snapshot.city,

          path:
            snapshot.path,
        },

        'Movie snapshot has invalid JSON',
      )

      continue
    }

    const items =
      extractMovieItems(
        raw,
      )

    received +=
      items.length

    let snapshotMatched =
      0

    let snapshotUnmatched =
      0

    let snapshotFailed =
      0

    for (
      const item
      of items
    ) {
      try {
        const result =
          await importMovieItem(
            item,
          )

        if (
          result.matched
        ) {
          matched +=
            1

          snapshotMatched +=
            1
        } else {
          unmatched +=
            1

          snapshotUnmatched +=
            1
        }
      } catch (error) {
        failed +=
          1

        snapshotFailed +=
          1

        log.warn(
          {
            source:
              snapshot.source,

            city:
              snapshot.city,

            error:
              error instanceof Error
                ? error.message
                : String(error),
          },

          'Movie enrichment import failed',
        )
      }
    }

    log.info(
      {
        source:
          snapshot.source,

        city:
          snapshot.city,

        received:
          items.length,

        matched:
          snapshotMatched,

        unmatched:
          snapshotUnmatched,

        failed:
          snapshotFailed,
      },

      'Movie snapshot imported',
    )
  }

  return {
    snapshots:
      snapshots.length,

    received,

    matched,

    unmatched,

    failed,
  }
}
