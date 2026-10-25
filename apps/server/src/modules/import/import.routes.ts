import type { FastifyInstance } from 'fastify'

import { z } from 'zod'

import {

  ImportEventSchema,

  type ImportEvent,

} from '@evently/shared'

import { requireImportApiKey } from './import.auth.js'

import { importEvent } from './import.service.js'

// ============================================================

// RAW PARSER FORMAT

//

// Это формат, который сейчас отдаёт KudaGo-парсер.

// ============================================================

const RawPriceSchema = z.object({

  text: z.string().nullable().optional(),

  min: z.number().nullable().optional(),

  max: z.number().nullable().optional(),

  currency: z.string().nullable().optional(),

  is_free: z.boolean().optional(),

})

const RawVenueSchema = z.object({

  source_id: z.string().nullable().optional(),

  name: z.string().min(1),

  address: z.string().nullable().optional(),

  lat: z.number().nullable().optional(),

  lon: z.number().nullable().optional(),

  subway: z.string().nullable().optional(),

  url: z.string().nullable().optional(),

}).passthrough()

const RawSessionSchema = z.object({

  starts_at: z.string().nullable().optional(),

  ends_at: z.string().nullable().optional(),

}).passthrough()

const RawImageSchema = z.object({

  url: z.string().url(),

  credit_name: z.string().nullable().optional(),

  credit_url: z.string().nullable().optional(),

  local_path: z.string().nullable().optional(),

}).passthrough()

const RawEventSchema = z.object({

  source: z.string().min(1),

  source_id: z.string().min(1),

  source_url: z.string().url().nullable().optional(),

  city: z.string().nullable().optional(),

  title: z.string().min(1),

  short_title: z.string().nullable().optional(),

  tagline: z.string().nullable().optional(),

  description: z.string().nullable().optional(),

  full_text: z.string().nullable().optional(),

  categories: z.array(z.string()).default([]),

  tags: z.array(z.string()).default([]),

  age_restriction: z.string().nullable().optional(),

  price: RawPriceSchema.nullable().optional(),

  venue: RawVenueSchema.nullable().optional(),

  sessions: z.array(RawSessionSchema).default([]),

  images: z.array(RawImageSchema).default([]),

  content_hash: z.string().nullable().optional(),

}).passthrough()

const RawBatchSchema = z.object({

  schema_version: z.string().optional(),

  source: z.string().optional(),

  city: z.string().optional(),

  fetched_at: z.string().optional(),

  count: z.number().optional(),

  events: z.array(RawEventSchema),

}).passthrough()

const NormalizedBatchSchema = z.object({

  events: z.array(z.unknown()),

}).passthrough()

function stripNulls(

  value: unknown,

): unknown {

  if (Array.isArray(value)) {

    return value.map(stripNulls)

  }

  if (

    value !== null &&

    typeof value === 'object'

  ) {

    return Object.fromEntries(

      Object.entries(value)

        .filter(([, item]) =>

          item !== null,

        )

        .map(([key, item]) => [

          key,

          stripNulls(item),

        ]),

    )

  }

  return value

}

// ============================================================

// CATEGORY NORMALIZATION

// ============================================================

const CATEGORY_MAP: Record<string, string | null> = {

  concert: 'concert',

  theater: 'theatre',

  theatre: 'theatre',

  cinema: 'cinema',

  sport: 'sport',

  exhibition: 'exhibition',

  party: 'party',

  standup: 'standup',

  food: 'food',

  kids: 'family',

  family: 'family',

  tour: 'tour',

  excursion: 'tour',

  quest: 'games',

  quiz: 'games',

  games: 'games',

  stock: null,

  education: 'education',

  // Слишком широкая категория.

  // Если есть более точная — используем её.

  entertainment: null,

}

// ============================================================

// HELPERS

// ============================================================

function normalizeCategories(categories: string[]) {

  return [

    ...new Set(

      categories

        .map((category) => CATEGORY_MAP[category])

        .filter((category): category is string => Boolean(category)),

    ),

  ]

}

function normalizeAgeRating(

  value: string | null | undefined,

) {

  if (!value) {

    return undefined

  }

  const match = value.match(/\d+/)

  if (!match) {

    return undefined

  }

  return Number(match[0])

}

function normalizeCity(

  value: string | null | undefined,

) {

  if (!value) {

    return undefined

  }

  const cities: Record<string, string> = {

    msk: 'Москва',

    spb: 'Санкт-Петербург',

  }

  return cities[value] ?? value

}

// ============================================================

// RAW KUDAGO -> EVENTLY

// ============================================================

function normalizeRawEvent(

  raw: z.infer<typeof RawEventSchema>,

): ImportEvent {

  const categories = normalizeCategories(raw.categories)

  if (categories.length === 0) {

    throw new Error(

      `NO_SUPPORTED_CATEGORIES:${raw.categories.join(',')}`,

    )

  }

  const normalized = {

    source: raw.source,

    externalId: raw.source_id,

    title: raw.title,

    shortDescription:

      raw.tagline ??

      raw.description ??

      raw.short_title ??

      undefined,

    description:

      raw.full_text ??

      raw.description ??

      undefined,

    sourceUrl:

      raw.source_url ??

      undefined,

    // В текущем JSON друга отдельного ticket_url пока нет.

    ticketUrl: undefined,

    priceMin:

      raw.price?.min ??

      undefined,

    priceMax:

      raw.price?.max ??

      undefined,

    currency:

      raw.price?.currency ??

      'RUB',

    isFree:

      raw.price?.is_free ??

      false,

    ageRating:

      normalizeAgeRating(raw.age_restriction),

    categories,

    venue: raw.venue

      ? {

          source: raw.source,

          externalId:

            raw.venue.source_id ??

            undefined,

          name: raw.venue.name,

          address:

            raw.venue.address ??

            undefined,

          city:

            normalizeCity(raw.city),

          latitude:

            raw.venue.lat ??

            undefined,

          longitude:

            raw.venue.lon ??

            undefined,

        }

      : undefined,

    // Сессии без starts_at пропускаем.

    occurrences: raw.sessions

      .filter(

        (

          session,

        ): session is typeof session & {

          starts_at: string

        } => Boolean(session.starts_at),

      )

      .map((session) => ({

        startsAt: session.starts_at,

        endsAt:

          session.ends_at ??

          undefined,

      })),

    images: raw.images.map((image) => ({

      url: image.url,

    })),

  }

  return ImportEventSchema.parse(normalized)

}

// ============================================================

// ROUTES

// ============================================================

export async function importRoutes(

  app: FastifyInstance,

) {

  app.addHook(

    'onRequest',

    requireImportApiKey,

  )

  // ----------------------------------------------------------

  // Canonical Evently event

  // ----------------------------------------------------------

  app.post('/', async (request, reply) => {

    const parsed = ImportEventSchema.safeParse(

      request.body,

    )

    if (!parsed.success) {

      return reply.status(400).send({

        error: 'INVALID_EVENT',

        details: parsed.error.flatten(),

      })

    }

    try {

      const event = await importEvent(

        parsed.data,

      )

      return {

        ok: true,

        event: {

          id: event.id,

          source: event.source,

          externalId: event.externalId,

          title: event.title,

        },

      }

    } catch (error) {

      request.log.error(error)

      return reply.status(400).send({

        error:

          error instanceof Error

            ? error.message

            : 'IMPORT_FAILED',

      })

    }

  })

  // ----------------------------------------------------------
  // Parser batch
  // ----------------------------------------------------------

  app.post(
    '/batch',
    async (request, reply) => {
      const normalizedBatch =
        NormalizedBatchSchema.safeParse(
          request.body,
        )

      const firstEvent =
        normalizedBatch.success
          ? normalizedBatch.data.events[0]
          : undefined

      const looksNormalized =
        normalizedBatch.success &&
        (
          normalizedBatch.data.events.length === 0 ||
          (
            firstEvent !== null &&
            typeof firstEvent === 'object' &&
            (
              'externalId' in firstEvent ||
              'occurrences' in firstEvent ||
              'sourceUrl' in firstEvent
            )
          )
        )

      let imported = 0
      let failed = 0

      const errors: Array<{
        externalId: string
        title: string
        error: string
      }> = []

      let source: string | null = null
      let received = 0

      if (
        looksNormalized &&
        normalizedBatch.success
      ) {
        const batch =
          normalizedBatch.data

        received =
          batch.events.length

        for (const candidate of batch.events) {
          const cleaned =
            stripNulls(candidate)

          const parsedEvent =
            ImportEventSchema.safeParse(
              cleaned,
            )

          if (!parsedEvent.success) {
            failed++

            const fallback =
              cleaned !== null &&
              typeof cleaned === 'object'
                ? cleaned as Record<
                    string,
                    unknown
                  >
                : {}

            errors.push({
              externalId:
                typeof fallback.externalId ===
                'string'
                  ? fallback.externalId
                  : 'unknown',

              title:
                typeof fallback.title ===
                'string'
                  ? fallback.title
                  : 'unknown',

              error:
                parsedEvent.error.issues
                  .map((issue) => {
                    const path =
                      issue.path.length > 0
                        ? issue.path.join('.')
                        : 'event'

                    return `${path}: ${issue.message}`
                  })
                  .join('; '),
            })

            continue
          }

          const event =
            parsedEvent.data

          source ??=
            event.source

          try {
            await importEvent(event)
            imported++
          } catch (error) {
            failed++

            errors.push({
              externalId:
                event.externalId,

              title:
                event.title,

              error:
                error instanceof Error
                  ? error.message
                  : 'UNKNOWN_ERROR',
            })
          }
        }
      } else {
        const rawParsed =
          RawBatchSchema.safeParse(
            request.body,
          )

        if (!rawParsed.success) {
          return reply.status(400).send({
            error: 'INVALID_BATCH',

            details:
              rawParsed.error.flatten(),
          })
        }

        const batch =
          rawParsed.data

        source =
          batch.source ??
          batch.events[0]?.source ??
          null

        received =
          batch.events.length

        for (const rawEvent of batch.events) {
          try {
            const event =
              normalizeRawEvent(rawEvent)

            await importEvent(event)
            imported++
          } catch (error) {
            failed++

            errors.push({
              externalId:
                rawEvent.source_id,

              title:
                rawEvent.title,

              error:
                error instanceof Error
                  ? error.message
                  : 'UNKNOWN_ERROR',
            })
          }
        }
      }

      return {
        ok: failed === 0,

        source,

        received,

        imported,
        failed,

        errors,
      }
    },
  )

}
