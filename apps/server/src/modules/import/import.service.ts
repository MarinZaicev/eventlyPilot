import type { ImportEvent } from '@evently/shared'

import { prisma } from '@evently/db'

export async function importEvent(data: ImportEvent) {
  const categorySlugs = [...new Set(data.categories)]

  const categories = await prisma.category.findMany({
    where: {
      slug: {
        in: categorySlugs,
      },
      active: true,
    },
  })

  const foundSlugs = new Set(
    categories.map((category) => category.slug),
  )

  const missingCategories = categorySlugs.filter(
    (slug) => !foundSlugs.has(slug),
  )

  if (missingCategories.length > 0) {
    throw new Error(
      `CATEGORIES_NOT_FOUND:${missingCategories.join(',')}`,
    )
  }

  const result = await prisma.$transaction(async (tx) => {
    let venueId: string | null = null

    if (data.venue) {
      const venueData = data.venue

      if (venueData.source && venueData.externalId) {
        const venue = await tx.venue.upsert({
          where: {
            source_externalId: {
              source: venueData.source,
              externalId: venueData.externalId,
            },
          },

          update: {
            name: venueData.name,
            address: venueData.address,
            city: venueData.city,
            latitude: venueData.latitude,
            longitude: venueData.longitude,
          },

          create: {
            source: venueData.source,
            externalId: venueData.externalId,

            name: venueData.name,
            address: venueData.address,
            city: venueData.city,

            latitude: venueData.latitude,
            longitude: venueData.longitude,
          },
        })

        venueId = venue.id
      } else {
        const venue = await tx.venue.create({
          data: {
            name: venueData.name,
            address: venueData.address,
            city: venueData.city,
            latitude: venueData.latitude,
            longitude: venueData.longitude,
          },
        })

        venueId = venue.id
      }
    }

    const event = await tx.event.upsert({
      where: {
        source_externalId: {
          source: data.source,
          externalId: data.externalId,
        },
      },

      update: {
        title: data.title,

        shortDescription: data.shortDescription,
        description: data.description,

        sourceUrl: data.sourceUrl,
        ticketUrl: data.ticketUrl,

        priceMin: data.priceMin,
        priceMax: data.priceMax,

        currency: data.currency,

        isFree: data.isFree,
        ageRating: data.ageRating,

        venueId,

        status: 'ACTIVE',
      },

      create: {
        source: data.source,
        externalId: data.externalId,

        title: data.title,

        shortDescription: data.shortDescription,
        description: data.description,

        sourceUrl: data.sourceUrl,
        ticketUrl: data.ticketUrl,

        priceMin: data.priceMin,
        priceMax: data.priceMax,

        currency: data.currency,

        isFree: data.isFree,
        ageRating: data.ageRating,

        venueId,

        status: 'ACTIVE',
      },
    })

    await tx.eventCategory.deleteMany({
      where: {
        eventId: event.id,
      },
    })

    await tx.eventOccurrence.deleteMany({
      where: {
        eventId: event.id,
      },
    })

    await tx.eventImage.deleteMany({
      where: {
        eventId: event.id,
      },
    })

    if (categories.length > 0) {
      await tx.eventCategory.createMany({
        data: categories.map((category) => ({
          eventId: event.id,
          categoryId: category.id,
        })),
      })
    }

    if (data.occurrences.length > 0) {
      await tx.eventOccurrence.createMany({
        data: data.occurrences.map((occurrence) => ({
          eventId: event.id,

          startsAt: new Date(occurrence.startsAt),

          endsAt: occurrence.endsAt
            ? new Date(occurrence.endsAt)
            : null,

          ticketUrl: occurrence.ticketUrl,
        })),
      })
    }

    if (data.images.length > 0) {
      await tx.eventImage.createMany({
        data: data.images.map((image, index) => ({
          eventId: event.id,
          url: image.url,
          position: index,
        })),
      })
    }

    return event
  })

  return result
}
