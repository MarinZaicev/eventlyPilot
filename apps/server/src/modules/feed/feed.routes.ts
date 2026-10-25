import type { FastifyInstance } from 'fastify'
import type {
  ApiEvent,
  ApiEventsResponse,
} from '@evently/shared'

import { z } from 'zod'

import { prisma } from '@evently/db'

import { getUserKey } from '../../lib/request-user.js'

import {
  buildCategoryFirstFeed,
  getInteractionWeight,
  type FeedCandidate,
} from './feed.scoring.js'

import {
  buildUserPreferences,
  distanceBonus,
  priceBonus,
  socialBonus,
  timeBonus,
} from './feed.preferences.js'

import { withSocial } from '../events/social.js'

const FeedQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20),

  category: z
    .string()
    .min(1)
    .optional(),

  city: z
    .string()
    .min(1)
    .max(32)
    .optional(),

  /*
   * Comma-separated event ids the client
   * already has (load-more pagination).
   */
  exclude: z
    .string()
    .max(20_000)
    .optional(),

  latitude: z.coerce
    .number()
    .min(-90)
    .max(90)
    .optional(),

  longitude: z.coerce
    .number()
    .min(-180)
    .max(180)
    .optional(),
})

const eventInclude = {
  venue: true,

  movie: true,

  occurrences: {
    orderBy: {
      startsAt: 'asc' as const,
    },
  },

  images: {
    orderBy: {
      position: 'asc' as const,
    },
  },

  categories: {
    include: {
      category: true,
    },
  },
}

function toApiEvent(event: any): ApiEvent {
  return {
    id: event.id,
    source: event.source,

    title: event.title,
    shortDescription: event.shortDescription,
    description: event.description,

    priceMin: event.priceMin,
    priceMax: event.priceMax,
    currency: event.currency,
    isFree: event.isFree,

    ageRating: event.ageRating,

    ticketUrl: event.ticketUrl,
    sourceUrl: event.sourceUrl,

    venue: event.venue
      ? {
          id: event.venue.id,
          name: event.venue.name,
          address: event.venue.address,
          city: event.venue.city,
          latitude: event.venue.latitude,
          longitude: event.venue.longitude,
        }
      : null,

    occurrences: event.occurrences.map(
      (occurrence: any) => ({
        id: occurrence.id,

        startsAt:
          occurrence.startsAt.toISOString(),

        endsAt: occurrence.endsAt
          ? occurrence.endsAt.toISOString()
          : null,

        ticketUrl:
          occurrence.ticketUrl,
      }),
    ),

    images: event.images.map(
      (image: any) => ({
        id: image.id,
        url: image.url,
        position: image.position,
      }),
    ),

    categories: event.categories.map(
      (item: any) => ({
        id: item.category.id,
        slug: item.category.slug,
        name: item.category.name,
        icon: item.category.icon,
      }),
    ),

    movie: event.movie
      ? {
          tmdbId:
            event.movie.tmdbId,

          mediaType:
            event.movie.mediaType,

          title:
            event.movie.title,

          originalTitle:
            event.movie.originalTitle,

          releaseYear:
            event.movie.releaseYear,

          overview:
            event.movie.overview,

          posterUrl:
            event.movie.posterUrl,

          backdropUrl:
            event.movie.backdropUrl,

          trailerEmbedUrl:
            event.movie.trailerEmbedUrl,

          trailerUrl:
            event.movie.trailerUrl,

          trailerKey:
            event.movie.trailerKey,

          voteAverage:
            event.movie.voteAverage,

          runtime:
            event.movie.runtime,

          ageRating:
            event.movie.ageRating,

          genres:
            Array.isArray(
              event.movie.genres,
            )
              ? event.movie.genres
              : [],
        }
      : null,

  }
}

function distanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
) {
  const earthRadiusKm = 6371

  const toRadians = (
    value: number,
  ) => value * Math.PI / 180

  const dLat =
    toRadians(lat2 - lat1)

  const dLon =
    toRadians(lon2 - lon1)

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) ** 2

  return (
    earthRadiusKm *
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a),
    )
  )
}

export async function feedRoutes(
  app: FastifyInstance,
) {
  app.get('/', async (request, reply) => {
    const parsed =
      FeedQuerySchema.safeParse(
        request.query,
      )

    if (!parsed.success) {
      return reply.status(400).send({
        error: 'INVALID_QUERY',
        details:
          parsed.error.flatten(),
      })
    }

    const {
      limit,
      category,
      city,
      latitude,
      longitude,
      exclude,
    } = parsed.data

    const clientId =
      getUserKey(request.headers)

    let user:
      | {
          id: string

          // Last place where the user pressed "Nearby" (rounded, ~1 km).
          latitude: number | null
          longitude: number | null

          interests: Array<{
            weight: number

            category: {
              slug: string
            }
          }>
        }
      | null = null

    if (
      clientId
    ) {
      user =
        await prisma.user.findUnique({
          where: {
            maxUserId:
              clientId,
          },

          select: {
            id: true,
            latitude: true,
            longitude: true,

            interests: {
              select: {
                weight: true,

                category: {
                  select: {
                    slug: true,
                  },
                },
              },
            },
          },
        })
    }

    /*
     * Remember an approximate location (2 decimals ~ 1 km) when the user
     * opens "Nearby" - used later to slightly prefer closer events (#32).
     */
    if (
      user &&
      latitude !== undefined &&
      longitude !== undefined
    ) {
      const roundedLatitude =
        Math.round(latitude * 100) / 100
      const roundedLongitude =
        Math.round(longitude * 100) / 100

      if (
        user.latitude !== roundedLatitude ||
        user.longitude !== roundedLongitude
      ) {
        await prisma.user
          .update({
            where: { id: user.id },
            data: {
              latitude: roundedLatitude,
              longitude: roundedLongitude,
            },
          })
          .catch(() => undefined)
      }
    }

    const now = new Date()

    const DAY_MS = 24 * 60 * 60 * 1000

    /*
     * Taste memory (#25). Before, the last 500 interactions were used,
     * but IMPRESSION + DWELL (2 per card) filled that window: after
     * ~250 swipes the feed forgot likes and "going".
     *
     * - strong signals (likes, going, hide, share, tickets, opens): 90 days;
     * - DWELL: only the last 300 (recent mood);
     * - IMPRESSION: only to know what was already shown (30 days).
     */
    const signalSelect = {
      type: true,
      durationMs: true,
      eventId: true,

      event: {
        select: {
          categories: {
            select: {
              category: {
                select: {
                  slug: true,
                },
              },
            },
          },
        },
      },
    } as const

    const [
      strongSignals,
      dwellSignals,
      impressions,
    ] = user
      ? await Promise.all([
          prisma.interaction.findMany({
            where: {
              userId: user.id,

              type: {
                in: [
                  'FAVORITE',
                  'UNFAVORITE',
                  'OPEN',
                  'SHARE',
                  'TICKET_CLICK',
                  'HIDE',
                  'GOING',
                  'NOT_GOING',
                ],
              },

              createdAt: {
                gte: new Date(
                  now.getTime() - 90 * DAY_MS,
                ),
              },
            },

            orderBy: {
              createdAt: 'desc',
            },

            take: 2000,

            select: signalSelect,
          }),

          prisma.interaction.findMany({
            where: {
              userId: user.id,
              type: 'DWELL',
            },

            orderBy: {
              createdAt: 'desc',
            },

            take: 300,

            select: signalSelect,
          }),

          prisma.interaction.findMany({
            where: {
              userId: user.id,
              type: 'IMPRESSION',

              createdAt: {
                gte: new Date(
                  now.getTime() - 30 * DAY_MS,
                ),
              },
            },

            orderBy: {
              createdAt: 'desc',
            },

            take: 5000,

            select: {
              eventId: true,
              createdAt: true,
            },
          }),
        ])
      : [[], [], []]

    const interactions = [
      ...strongSignals,
      ...dwellSignals,
    ]

    /*
     * Preferences inside a category (#32): price, time, distance -
     * learned from events the user reacted to positively.
     */
    const likedEventIds = [
      ...new Set(
        strongSignals
          .filter((signal) =>
            ['FAVORITE', 'GOING', 'TICKET_CLICK', 'SHARE'].includes(
              signal.type,
            ),
          )
          .map((signal) => signal.eventId),
      ),
    ].slice(0, 200)

    const likedEvents =
      likedEventIds.length > 0
        ? await prisma.event.findMany({
            where: {
              id: { in: likedEventIds },
            },

            select: {
              source: true,
              sourceCity: true,
              isFree: true,
              priceMin: true,

              occurrences: {
                select: { startsAt: true },
                orderBy: { startsAt: 'asc' },
              },

              venue: {
                select: {
                  latitude: true,
                  longitude: true,
                },
              },
            },
          })
        : []

    const preferences = buildUserPreferences(
      likedEvents,
      latitude !== undefined && longitude !== undefined
        ? { latitude, longitude }
        : user?.latitude != null && user?.longitude != null
          ? { latitude: user.latitude, longitude: user.longitude }
          : null,
      now,
    )

    /*
     * Social popularity (#32): likes, "going" and ticket clicks
     * of OTHER users. Small tables - grouped as a whole.
     */
    const notMe = user
      ? { userId: { not: user.id } }
      : {}

    const [likeGroups, goingGroups, ticketGroups] =
      await Promise.all([
        prisma.favorite.groupBy({
          by: ['eventId'],
          where: notMe,
          _count: { _all: true },
        }),

        prisma.attendance.groupBy({
          by: ['eventId'],
          where: notMe,
          _count: { _all: true },
        }),

        prisma.interaction.groupBy({
          by: ['eventId'],
          where: {
            ...notMe,
            type: 'TICKET_CLICK',
            createdAt: {
              gte: new Date(
                now.getTime() - 30 * DAY_MS,
              ),
            },
          },
          _count: { _all: true },
        }),
      ])

    const socialScore =
      new Map<string, number>()

    const addSocial = (
      groups: { eventId: string; _count: { _all: number } }[],
      weight: number,
    ) => {
      for (const group of groups) {
        socialScore.set(
          group.eventId,
          (socialScore.get(group.eventId) ?? 0) +
            group._count._all * weight,
        )
      }
    }

    addSocial(likeGroups, 1)
    addSocial(goingGroups, 2)
    addSocial(ticketGroups, 1)

    // eventId -> when it was last shown (impressions are newest first).
    const lastShownAt =
      new Map<string, Date>()

    for (const impression of impressions) {
      if (!lastShownAt.has(impression.eventId)) {
        lastShownAt.set(
          impression.eventId,
          impression.createdAt,
        )
      }
    }

    const behaviorScores =
      new Map<string, number>()

    const onboardingScores =
      new Map<string, number>()

    // Strong cold-start signal from onboarding.
    for (
      const interest
      of user?.interests ?? []
    ) {
      onboardingScores.set(
        interest.category.slug,
        12,
      )
    }

    const hiddenEventIds =
      new Set<string>()

    /*
     * "Not interested" is permanent: load every HIDE,
     * not only those within the last 500 interactions.
     */
    if (user) {
      const hiddenRows =
        await prisma.interaction.findMany({
          where: {
            userId: user.id,
            type: 'HIDE',
          },

          select: {
            eventId: true,
          },

          distinct: ['eventId'],
        })

      for (const row of hiddenRows) {
        hiddenEventIds.add(row.eventId)
      }
    }

    for (
      const interaction
      of interactions
    ) {
      if (
        interaction.type === 'HIDE'
      ) {
        hiddenEventIds.add(
          interaction.eventId,
        )
      }

      const weight =
        getInteractionWeight(
          interaction,
        )

      if (weight === 0) {
        continue
      }

      for (
        const item
        of interaction.event.categories
      ) {
        const slug =
          item.category.slug

        const current =
          behaviorScores.get(slug) ??
          0

        behaviorScores.set(
          slug,
          current + weight,
        )
      }
    }

    /*
     * Events already loaded on the client
     * are excluded like hidden ones, so
     * the next page brings only new events.
     */
    for (
      const rawId
      of (exclude ?? '').split(',')
    ) {
      const id = rawId.trim()

      if (
        /^[0-9a-f-]{36}$/i.test(id)
      ) {
        hiddenEventIds.add(id)
      }
    }

    const events =
      await prisma.event.findMany({
        where: {
          status: 'ACTIVE',

          // only primary events, not duplicates
          duplicateOfId: null,

          images: {
            some: {},
          },

          ...(city
            ? {
                sourceCity: city,
              }
            : {}),

          ...(category
            ? {
                categories: {
                  some: {
                    category: {
                      slug: category,
                    },
                  },
                },
              }
            : {}),

          // Already shown events are NOT excluded here any more:
          // they come back when nothing new is left (see below).
          ...(hiddenEventIds.size > 0
            ? {
                id: {
                  notIn: [
                    ...hiddenEventIds,
                  ],
                },
              }
            : {}),
        },

        include: eventInclude,
      })

    const currentEvents =
      events.filter((event) => {
        if (
          event.occurrences.length === 0
        ) {
          return true
        }

        return event.occurrences.some(
          (occurrence) => {
            const startsAt =
              occurrence.startsAt

            const endsAt =
              occurrence.endsAt

            // Событие без конкретной даты
            // считаем постоянным / актуальным.
            if (
              !startsAt &&
              !endsAt
            ) {
              return true
            }

            // Если есть дата окончания,
            // событие актуально до неё.
            if (endsAt) {
              return endsAt >= now
            }

            // Если окончания нет,
            // будущий старт означает,
            // что событие ещё актуально.
            if (startsAt) {
              return startsAt >= now
            }

            return true
          },
        )
      })

    const categoryScore = (
      slug: string,
    ): number => {
      const behavior =
        behaviorScores.get(slug) ?? 0

      const cappedBehavior =
        Math.max(
          -8,
          Math.min(8, behavior),
        )

      const onboarding =
        onboardingScores.get(slug) ?? 0

      // "other" = events we could not categorize:
      // slightly less likely than an unknown real category.
      const penalty =
        slug === 'other' ? -2 : 0

      return (
        onboarding +
        cappedBehavior +
        penalty
      )
    }

    // Soon events get a small boost inside their category.
    const soonBonus = (
      event: (typeof currentEvents)[number],
    ): number => {
      // kinopoisk-cinema: no real sessions, the date is a placeholder
      // a week ahead (#28) - "soon" means nothing here.
      if (event.source === 'kinopoisk-cinema') {
        return 0
      }

      const next = event.occurrences.find(
        (occurrence) =>
          occurrence.startsAt >= now,
      )

      if (!next) {
        return 0
      }

      const daysAhead =
        (next.startsAt.getTime() - now.getTime()) /
        DAY_MS

      if (daysAhead <= 2) {
        return 2
      }

      if (daysAhead <= 7) {
        return 1
      }

      return 0
    }

    /*
     * Already shown events (#30). One pool instead of "fresh first,
     * then the rest": for an active user the unseen leftovers are exactly
     * the categories he does NOT like, so "unseen" must not beat "interesting".
     * The category is chosen by interest; inside it unseen events go first,
     * recently shown ones sink:
     *   shown < 6 h ago   - not shown at all;
     *   6 h .. 3 days     - strong penalty;
     *   3 .. 14 days      - medium;
     *   older             - small.
     * Returns null when the event must be skipped.
     */
    const HOUR_MS = 60 * 60 * 1000

    /*
     * #39: the feed never ends. Shown events are no longer dropped
     * (before: shown < 6 h ago were excluded and the feed ran dry);
     * they come back "in a circle": oldest shown first, just shown last.
     * penalty  - inside the category (event order);
     * freshness - for the category itself (see buildCategoryFirstFeed).
     */
    const seenInfo = (
      event: (typeof currentEvents)[number],
    ): { penalty: number; freshness: number } => {
      const shownAt =
        lastShownAt.get(event.id)

      if (!shownAt) {
        return { penalty: 0, freshness: 1 }
      }

      const age =
        now.getTime() - shownAt.getTime()

      if (age < 6 * HOUR_MS) {
        return { penalty: -12, freshness: 0.08 }
      }

      if (age < 3 * DAY_MS) {
        return { penalty: -8, freshness: 0.2 }
      }

      if (age < 14 * DAY_MS) {
        return { penalty: -4, freshness: 0.4 }
      }

      return { penalty: -2, freshness: 0.6 }
    }

    let orderedEvents: (typeof currentEvents) = []

    if (
      latitude !== undefined &&
      longitude !== undefined
    ) {
      // Nearby: strict order by distance, within 50 km.
      const userLatitude = latitude
      const userLongitude = longitude

      const withDistance = currentEvents
        .map((event) => ({
          event,
          distance:
            event.venue?.latitude != null &&
            event.venue?.longitude != null
              ? distanceKm(
                  userLatitude,
                  userLongitude,
                  event.venue.latitude,
                  event.venue.longitude,
                )
              : null,
        }))
        .filter(
          (item): item is {
            event: (typeof currentEvents)[number]
            distance: number
          } =>
            item.distance !== null &&
            item.distance <= 50,
        )
        .sort((a, b) => a.distance - b.distance)

      /*
       * Strictly by distance (#34). The user asked for "near this place",
       * so already shown events are NOT hidden or pushed down here
       * (in #30 a new place right after the previous one returned nothing:
       * everything close had just been shown). Pagination - via client exclude.
       */
      orderedEvents = withDistance
        .slice(0, limit)
        .map((item) => item.event)
    } else {
      const candidates: FeedCandidate<(typeof currentEvents)[number]>[] = []

      for (const event of currentEvents) {
        const { penalty, freshness } = seenInfo(event)

        candidates.push({
          freshness,

          item: event,

          categories: event.categories.map(
            (item) => item.category.slug,
          ),

          eventScore:
            event.popularityScore * 0.1 +
            soonBonus(event) +
            priceBonus(event, preferences) +
            timeBonus(event, preferences, now) +
            distanceBonus(event, preferences) +
            socialBonus(socialScore.get(event.id) ?? 0) +
            penalty,
        })
      }

      orderedEvents = buildCategoryFirstFeed(
        candidates,
        categoryScore,
        limit,
      )
    }

    const response:
      ApiEventsResponse = {
        items: await withSocial(
          orderedEvents
            .slice(0, limit)
            .map((event) =>
              toApiEvent(event),
            ),
          user?.id ?? null,
        ),

        nextCursor: null,
      }

    return response
  })
}
