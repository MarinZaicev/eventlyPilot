import type {
  FastifyInstance,
} from 'fastify'

import {
  access,
  readFile,
  readdir,
} from 'node:fs/promises'

import {
  join,
} from 'node:path'

import {
  z,
} from 'zod'

import {
  prisma,
} from '@evently/db'

import {
  syncMovieEnrichments,
} from './movie-sync.service.js'

import {
  syncFoodPlaces,
} from './places-sync.service.js'

import {
  resolveCategories,
  type CategoryResolution,
} from './category-classifier.js'

import {
  deduplicateEvents,
} from '../dedup/dedup.service.js'

const ExternalIdSchema =
  z.union([
    z.string(),
    z.number(),
  ]).transform(String)

const VenueSchema =
  z.object({
    source:
      z.string().nullable().optional(),

    externalId:
      z.union([
        z.string(),
        z.number(),
      ])
        .transform(String)
        .nullable()
        .optional(),

    name:
      z.string().min(1),

    address:
      z.string().nullable().optional(),

    city:
      z.string().nullable().optional(),

    latitude:
      z.number().nullable().optional(),

    longitude:
      z.number().nullable().optional(),
  })
    .passthrough()

const OccurrenceSchema =
  z.object({
    startsAt:
      z.string().min(1),

    endsAt:
      z.string().nullable().optional(),

    ticketUrl:
      z.string().nullable().optional(),
  })
    .passthrough()

const ImageSchema =
  z.object({
    url:
      z.string().nullable().optional(),

    /*
     * Пока не используем.
     * Подключим следующим этапом.
     */
    local_path:
      z.string().nullable().optional(),

    localPath:
      z.string().nullable().optional(),
  })
    .passthrough()

const EventSchema =
  z.object({
    source:
      z.string().min(1),

    externalId:
      ExternalIdSchema,

    title:
      z.string().min(1),

    shortDescription:
      z.string().nullable().optional(),

    description:
      z.string().nullable().optional(),

    sourceUrl:
      z.string().nullable().optional(),

    ticketUrl:
      z.string().nullable().optional(),

    priceMin:
      z.number().int().nullable().optional(),

    priceMax:
      z.number().int().nullable().optional(),

    currency:
      z.string().default('RUB'),

    isFree:
      z.boolean().default(false),

    ageRating:
      z.number().int().nullable().optional(),

    categories:
      z.array(z.string()).default([]),

    venue:
      VenueSchema.nullable().optional(),

    occurrences:
      z.array(
        OccurrenceSchema,
      ).default([]),

    images:
      z.array(
        ImageSchema,
      ).default([]),
  })
    .passthrough()

const SnapshotSchema =
  z.object({
    events:
      z.array(z.unknown()),
  })
    .passthrough()

const TargetStatusSchema =
  z.object({
    source:
      z.string(),

    city:
      z.string(),

    ok:
      z.boolean().optional(),

    fresh:
      z.boolean().optional(),
  })
    .passthrough()

const StatusSchema =
  z.object({
    finished_at:
      z.string(),

    targets:
      z.array(
        TargetStatusSchema,
      ).default([]),
  })
    .passthrough()

type SnapshotPath = {
  source: string
  city: string
  path: string
}

function targetKey(
  source: string,
  city: string,
) {
  return `${
    source.toLowerCase()
  }:${
    city.toLowerCase()
  }`
}

function validDate(
  value: string | null | undefined,
) {
  if (!value) {
    return null
  }

  const date =
    new Date(value)

  return Number.isNaN(
    date.getTime(),
  )
    ? null
    : date
}


async function loadImageIndex(
  outputRoot: string,
) {
  const path =
    join(
      outputRoot,
      'images',
      'index.json',
    )

  try {
    const raw =
      JSON.parse(
        await readFile(
          path,
          'utf8',
        ),
      ) as unknown

    if (
      raw === null ||
      typeof raw !==
        'object' ||
      Array.isArray(raw)
    ) {
      return new Map<
        string,
        string
      >()
    }

    const result =
      new Map<
        string,
        string
      >()

    for (
      const [url, localPath]
      of Object.entries(
        raw,
      )
    ) {
      if (
        typeof localPath ===
        'string'
      ) {
        result.set(
          url,
          localPath,
        )
      }
    }

    return result
  } catch {
    return new Map<
      string,
      string
    >()
  }
}

async function discoverSnapshots(
  outputRoot: string,
): Promise<SnapshotPath[]> {
  const eventlyRoot =
    join(
      outputRoot,
      'evently',
    )

  const result:
    SnapshotPath[] = []

  const sources =
    await readdir(
      eventlyRoot,
      {
        withFileTypes: true,
      },
    )

  for (
    const sourceEntry
    of sources
  ) {
    if (
      !sourceEntry.isDirectory()
    ) {
      continue
    }

    const source =
      sourceEntry.name

    const sourcePath =
      join(
        eventlyRoot,
        source,
      )

    const cities =
      await readdir(
        sourcePath,
        {
          withFileTypes:
            true,
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

      const city =
        cityEntry.name

      const path =
        join(
          sourcePath,
          city,
          'latest.json',
        )

      try {
        await access(path)

        result.push({
          source,
          city,
          path,
        })
      } catch {
        // У этой пары пока нет latest.json.
      }
    }
  }

  return result
}

async function importOneEvent(
  raw: unknown,
  sourceCity: string,
  seenAt: Date,
  categoryIds:
    Map<string, string>,

  imageIndex:
    Map<string, string>,
) {
  const input =
    EventSchema.parse(
      raw,
    )

  return prisma.$transaction(
    async (tx) => {
      let venueId:
        string | null =
          null

      if (input.venue) {
        const venue =
          input.venue

        const venueSource =
          venue.source ??
          input.source

        const venueData = {
          source:
            venueSource,

          name:
            venue.name,

          address:
            venue.address ??
            null,

          city:
            venue.city ??
            null,

          latitude:
            venue.latitude ??
            null,

          longitude:
            venue.longitude ??
            null,
        }

        if (
          venue.externalId
        ) {
          const savedVenue =
            await tx.venue.upsert({
              where: {
                source_externalId: {
                  source:
                    venueSource,

                  externalId:
                    venue.externalId,
                },
              },

              update: {
                ...venueData,
              },

              create: {
                ...venueData,

                externalId:
                  venue.externalId,
              },
            })

          venueId =
            savedVenue.id
        } else {
          /*
           * Timepad обычно не даёт
           * externalId площадки.
           *
           * Используем city + address,
           * а если адреса нет —
           * city + name.
           */
          const existingVenue =
            await tx.venue.findFirst({
              where: {
                source:
                  venueSource,

                externalId:
                  null,

                city:
                  venue.city ??
                  null,

                ...(venue.address
                  ? {
                      address:
                        venue.address,
                    }
                  : {
                      name:
                        venue.name,
                    }),
              },
            })

          if (
            existingVenue
          ) {
            const updatedVenue =
              await tx.venue.update({
                where: {
                  id:
                    existingVenue.id,
                },

                data:
                  venueData,
              })

            venueId =
              updatedVenue.id
          } else {
            const createdVenue =
              await tx.venue.create({
                data: {
                  ...venueData,

                  externalId:
                    null,
                },
              })

            venueId =
              createdVenue.id
          }
        }
      }

      const event =
        await tx.event.upsert({
          where: {
            source_externalId: {
              source:
                input.source,

              externalId:
                input.externalId,
            },
          },

          update: {
            sourceCity,

            lastSeenAt:
              seenAt,

            title:
              input.title,

            shortDescription:
              input.shortDescription ??
              null,

            description:
              input.description ??
              null,

            sourceUrl:
              input.sourceUrl ??
              null,

            ticketUrl:
              input.ticketUrl ??
              null,

            priceMin:
              input.priceMin ??
              null,

            priceMax:
              input.priceMax ??
              null,

            currency:
              input.currency,

            isFree:
              input.isFree,

            ageRating:
              input.ageRating ??
              null,

            venueId,

            /*
             * Если раньше событие
             * было архивировано,
             * но вернулось в snapshot.
             */
            status:
              'ACTIVE',
          },

          create: {
            source:
              input.source,

            externalId:
              input.externalId,

            sourceCity,

            lastSeenAt:
              seenAt,

            title:
              input.title,

            shortDescription:
              input.shortDescription ??
              null,

            description:
              input.description ??
              null,

            sourceUrl:
              input.sourceUrl ??
              null,

            ticketUrl:
              input.ticketUrl ??
              null,

            priceMin:
              input.priceMin ??
              null,

            priceMax:
              input.priceMax ??
              null,

            currency:
              input.currency,

            isFree:
              input.isFree,

            ageRating:
              input.ageRating ??
              null,

            venueId,

            status:
              'ACTIVE',
          },
        })

      /*
       * Snapshot содержит полный
       * актуальный список сеансов.
       */
      await tx.eventOccurrence.deleteMany({
        where: {
          eventId:
            event.id,
        },
      })

      const occurrences =
        input.occurrences
          .map(
            (occurrence) => {
              const startsAt =
                validDate(
                  occurrence.startsAt,
                )

              if (!startsAt) {
                return null
              }

              return {
                eventId:
                  event.id,

                startsAt,

                endsAt:
                  validDate(
                    occurrence.endsAt,
                  ),

                ticketUrl:
                  occurrence.ticketUrl ??
                  null,
              }
            },
          )
          .filter(
            (
              occurrence,
            ): occurrence is
              NonNullable<
                typeof occurrence
              > =>
              Boolean(
                occurrence,
              ),
          )

      if (
        occurrences.length >
        0
      ) {
        await tx.eventOccurrence.createMany({
          data:
            occurrences,
        })
      }

      /*
       * Пока сохраняем оригинальные URL.
       * local_path подключим следующим
       * этапом через /media/events.
       */
      await tx.eventImage.deleteMany({
        where: {
          eventId:
            event.id,
        },
      })

      const images =
        input.images.flatMap(
          (image, index) => {
            const indexedPath =
              image.url
                ? imageIndex.get(
                    image.url,
                  ) ??
                  null
                : null

            const rawLocalPath =
              image.local_path ??
              image.localPath ??
              indexedPath

            let localUrl:
              string | null =
                null

            if (
              rawLocalPath
            ) {
              const normalized =
                rawLocalPath
                  .replace(
                    /\\/g,
                    '/',
                  )
                  .replace(
                    /^\/+/,
                    '',
                  )

              if (
                normalized.startsWith(
                  'images/',
                )
              ) {
                const relative =
                  normalized.slice(
                    'images/'.length,
                  )

                if (
                  relative &&
                  !relative
                    .split('/')
                    .includes('..')
                ) {
                  localUrl =
                    `/media/events/${
                      relative
                        .split('/')
                        .map(
                          encodeURIComponent,
                        )
                        .join('/')
                    }`
                }
              }
            }

            /*
             * Если локальной копии
             * по какой-то причине нет,
             * оставляем исходный URL.
             */
            const url =
              localUrl ??
              image.url ??
              null

            return url
              ? [
                  {
                    eventId:
                      event.id,

                    url,

                    position:
                      index,
                  },
                ]
              : []
          },
        )

      if (
        images.length >
        0
      ) {
        await tx.eventImage.createMany({
          data:
            images,
        })
      }

      /*
       * Категории — полный snapshot: при каждом импорте
       * заменяем целиком (category-classifier.ts: парсер →
       * синонимы → источник-кино → ключевые слова → «Разное»).
       * Если не определилось ничего (нет даже «Разного») —
       * оставляем прежние.
       */
      const resolved =
        resolveCategories(
          {
            categories:
              input.categories,

            source:
              input.source,

            title:
              input.title,

            description:
              input.description,

            shortDescription:
              input.shortDescription,
          },
          categoryIds,
        )

      if (
        resolved.ids.length > 0
      ) {
        await tx.eventCategory.deleteMany({
          where: {
            eventId:
              event.id,
          },
        })

        await tx.eventCategory.createMany({
          data:
            resolved.ids.map(
              (categoryId) => ({
                eventId:
                  event.id,

                categoryId,
              }),
            ),

          skipDuplicates:
            true,
        })
      }

      return {
        event,
        unknownCategories:
          resolved.unknown,
        via:
          resolved.via,
      }
    },
  )
}

async function importSnapshot(
  snapshot:
    SnapshotPath,

  allowArchive:
    boolean,

  categoryIds:
    Map<string, string>,

  imageIndex:
    Map<string, string>,

  app:
    FastifyInstance,
) {
  const rawText =
    await readFile(
      snapshot.path,
      'utf8',
    )

  const body =
    SnapshotSchema.parse(
      JSON.parse(
        rawText,
      ),
    )

  const seenAt =
    new Date()

  const seenExternalIds =
    new Set<string>()

  let imported =
    0

  let failed =
    0

  // Диагностика категорий по snapshot:
  // откуда взялись категории событий.
  const categoriesVia: Record<
    CategoryResolution['via'],
    number
  > = {
    parser: 0,
    source: 0,
    keywords: 0,
    other: 0,
    none: 0,
  }

  const unknownCategories =
    new Map<string, number>()

  for (
    const rawEvent
    of body.events
  ) {
    /*
     * Даже если конкретная запись
     * оказалась повреждённой,
     * не архивируем её старую копию
     * только из-за ошибки валидации.
     */
    if (
      rawEvent !== null &&
      typeof rawEvent ===
        'object'
    ) {
      const candidate =
        rawEvent as
          Record<
            string,
            unknown
          >

      const externalId =
        candidate.externalId

      if (
        typeof externalId ===
          'string' ||
        typeof externalId ===
          'number'
      ) {
        seenExternalIds.add(
          String(
            externalId,
          ),
        )
      }
    }

    try {
      const {
        event,
        unknownCategories: unknown,
        via,
      } =
        await importOneEvent(
          rawEvent,
          snapshot.city,
          seenAt,
          categoryIds,
          imageIndex,
        )

      seenExternalIds.add(
        event.externalId,
      )

      categoriesVia[via] += 1

      for (const slug of unknown) {
        unknownCategories.set(
          slug,
          (unknownCategories.get(slug) ?? 0) + 1,
        )
      }

      imported +=
        1
    } catch (error) {
      failed +=
        1

      app.log.warn(
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

        'Parser event import failed',
      )
    }
  }

  let archived =
    0

  /*
   * Архивируем ТОЛЬКО если:
   *
   * 1. status.json говорит,
   *    что target свежий;
   * 2. snapshot не пустой;
   * 3. импорт snapshot прошёл
   *    без ошибок.
   *
   * Лучше оставить старое событие,
   * чем случайно скрыть полгорода.
   */
  if (
    allowArchive &&
    failed === 0 &&
    seenExternalIds.size >
      0
  ) {
    const result =
      await prisma.event.updateMany({
        where: {
          source:
            snapshot.source,

          sourceCity:
            snapshot.city,

          status:
            'ACTIVE',

          externalId: {
            notIn: [
              ...seenExternalIds,
            ],
          },
        },

        data: {
          status:
            'ARCHIVED',
        },
      })

    archived =
      result.count
  }

  if (
    unknownCategories.size > 0
  ) {
    app.log.warn(
      {
        source:
          snapshot.source,

        city:
          snapshot.city,

        // Откуда категории: parser / source / keywords / other / none.
        categoriesVia,

        // Незнакомые slug'и → сколько раз встретились.
        unknownCategories:
          Object.fromEntries(
            unknownCategories,
          ),
      },

      'Parser snapshot has unknown categories',
    )
  }

  return {
    received:
      body.events.length,

    imported,

    failed,

    archived,

    categoriesVia,
  }
}

export async function parserSyncPlugin(
  app:
    FastifyInstance,
) {
  const outputRoot =
    process.env
      .PARSER_OUTPUT_ROOT ??
    '/home/matatik/afisha-data/output'

  const intervalMs =
    Number(
      process.env
        .PARSER_SYNC_INTERVAL_MS ??
        60_000,
    )

  const staleHours =
    Number(
      process.env
        .PARSER_STALE_AFTER_HOURS ??
        7,
    )

  let running =
    false

  let lastFinishedAt:
    string | null =
      null

  let staleWarnedFor:
    string | null =
      null

  async function run() {
    if (running) {
      return
    }

    running =
      true

    try {
      const statusPath =
        join(
          outputRoot,
          'status.json',
        )

      const statusText =
        await readFile(
          statusPath,
          'utf8',
        )

      const status =
        StatusSchema.parse(
          JSON.parse(
            statusText,
          ),
        )

      /*
       * Один finished_at =
       * один законченный цикл парсера.
       */
      if (
        status.finished_at ===
        lastFinishedAt
      ) {
        return
      }

      const finishedAt =
        new Date(
          status.finished_at,
        )

      if (
        !Number.isNaN(
          finishedAt.getTime(),
        )
      ) {
        const ageMs =
          Date.now() -
          finishedAt.getTime()

        if (
          ageMs >
            staleHours *
              60 *
              60 *
              1000 &&
          staleWarnedFor !==
            status.finished_at
        ) {
          staleWarnedFor =
            status.finished_at

          app.log.warn(
            {
              finishedAt:
                status.finished_at,

              ageHours:
                Math.round(
                  ageMs /
                    3_600_000,
                ),
            },

            'PARSER_STALE',
          )
        }
      }

      const targetStatus =
        new Map(
          status.targets.map(
            (target) => [
              targetKey(
                target.source,
                target.city,
              ),

              target,
            ],
          ),
        )

      const categories =
        await prisma.category.findMany({
          select: {
            id:
              true,

            slug:
              true,
          },
        })

      const categoryIds =
        new Map(
          categories.map(
            (category) => [
              category.slug,
              category.id,
            ],
          ),
        )

      const imageIndex =
        await loadImageIndex(
          outputRoot,
        )

      app.log.info(
        {
          images:
            imageIndex.size,
        },
        'Parser image index loaded',
      )

      const snapshots =
        await discoverSnapshots(
          outputRoot,
        )

      let received =
        0

      let imported =
        0

      let failed =
        0

      let archived =
        0

      for (
        const snapshot
        of snapshots
      ) {
        try {
          const target =
            targetStatus.get(
              targetKey(
                snapshot.source,
                snapshot.city,
              ),
            )

          /*
           * fresh + ok дают право
           * скрывать пропавшие события.
           */
          const allowArchive =
            target?.fresh ===
              true &&
            target?.ok ===
              true

          const result =
            await importSnapshot(
              snapshot,
              allowArchive,
              categoryIds,
              imageIndex,
              app,
            )

          received +=
            result.received

          imported +=
            result.imported

          failed +=
            result.failed

          archived +=
            result.archived

          app.log.info(
            {
              source:
                snapshot.source,

              city:
                snapshot.city,

              allowArchive,

              ...result,
            },

            'Parser snapshot imported',
          )
        } catch (error) {
          failed +=
            1

          app.log.error(
            {
              source:
                snapshot.source,

              city:
                snapshot.city,

              path:
                snapshot.path,

              error:
                error instanceof Error
                  ? error.message
                  : String(error),
            },

            'Parser snapshot failed',
          )
        }
      }

      const movieResult =
        await syncMovieEnrichments(
          outputRoot,
          app.log,
        )

      app.log.info(
        movieResult,
        'Movie enrichment sync completed',
      )

      /*
       * Заведения «где поесть» (output/app/places/<город>/latest.json).
       * Файл меняется раз в неделю; неизменный (contentHash) пропускается.
       * Ошибка здесь не должна ломать импорт событий.
       */
      try {
        const placesResult =
          await syncFoodPlaces(
            outputRoot,
            app.log,
          )

        app.log.info(
          placesResult,
          'Food places sync completed',
        )
      } catch (error) {
        app.log.warn(
          {
            error:
              error instanceof Error
                ? error.message
                : String(error),
          },
          'Food places sync failed',
        )
      }

      /*
       * Дедупликация: одно и то же событие
       * из разных источников (KudaGo, Timepad…)
       * помечаем через duplicateOfId.
       * Ошибка здесь не должна ломать импорт.
       */
      try {
        const dedupResult =
          await deduplicateEvents()

        app.log.info(
          dedupResult,
          'Event deduplication completed',
        )
      } catch (error) {
        app.log.error(
          {
            error:
              error instanceof Error
                ? error.message
                : String(error),
          },

          'Event deduplication failed',
        )
      }

      lastFinishedAt =
        status.finished_at

      app.log.info(
        {
          finishedAt:
            status.finished_at,

          snapshots:
            snapshots.length,

          received,
          imported,
          failed,
          archived,
        },

        'Parser sync completed',
      )
    } catch (error) {
      app.log.error(
        {
          error:
            error instanceof Error
              ? error.message
              : String(error),
        },

        'Parser sync failed',
      )
    } finally {
      running =
        false
    }
  }

  /*
   * Не задерживаем запуск API
   * первым большим импортом.
   */
  const initialTimer =
    setTimeout(
      () => {
        void run()
      },
      1_000,
    )

  initialTimer.unref()

  const timer =
    setInterval(
      () => {
        void run()
      },
      intervalMs,
    )

  timer.unref()

  app.addHook(
    'onClose',
    async () => {
      clearTimeout(
        initialTimer,
      )

      clearInterval(
        timer,
      )
    },
  )
}
