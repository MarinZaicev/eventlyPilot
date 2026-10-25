import { z } from 'zod'

export const VenueSchema = z.object({
  source: z.string().min(1).optional(),
  externalId: z.string().min(1).optional(),

  name: z.string().min(1),
  address: z.string().optional(),
  city: z.string().optional(),

  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
})

export const OccurrenceSchema = z.object({
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).optional(),
  ticketUrl: z.string().url().optional(),
})

export const ImageSchema = z.object({
  url: z.string().url(),
})

export const ImportEventSchema = z.object({
  source: z.string().min(1),
  externalId: z.string().min(1),

  title: z.string().min(1),

  shortDescription: z.string().optional(),
  description: z.string().optional(),

  sourceUrl: z.string().url().optional(),
  ticketUrl: z.string().url().optional(),

  priceMin: z.number().int().nonnegative().optional(),
  priceMax: z.number().int().nonnegative().optional(),

  currency: z.string().length(3).default('RUB'),

  isFree: z.boolean().default(false),

  ageRating: z.number().int().nonnegative().optional(),

  categories: z.array(z.string().min(1)).min(1),

  venue: VenueSchema.optional(),

  occurrences: z.array(OccurrenceSchema).default([]),

  images: z.array(ImageSchema).default([]),
})

export type ImportEvent = z.infer<typeof ImportEventSchema>
export type ImportVenue = z.infer<typeof VenueSchema>
export type ImportOccurrence = z.infer<typeof OccurrenceSchema>
export type ImportImage = z.infer<typeof ImageSchema>
