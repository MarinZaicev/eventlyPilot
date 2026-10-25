import 'dotenv/config'

import Fastify from 'fastify'
import cors from '@fastify/cors'

import { categoriesRoutes } from './modules/categories/categories.routes.js'
import { importRoutes } from './modules/import/import.routes.js'
import { eventsRoutes } from './modules/events/events.routes.js'
import { interactionsRoutes } from './modules/interactions/interactions.routes.js'
import { feedRoutes } from './modules/feed/feed.routes.js'
import { feedDebugRoutes } from './modules/feed/feed-debug.routes.js'
import { interestsRoutes } from './modules/profile/interests.routes.js'
import { commentsRoutes } from './modules/comments/comments.routes.js'
import { aiRoutes } from './modules/ai/ai.routes.js'
import { aiFoodRoutes } from './modules/ai/ai-food.routes.js'
import { parserSyncPlugin } from './modules/parser-sync/parser-sync.plugin.js'
import { mediaRoutes } from './modules/media/media.routes.js'
import { favoritesRoutes } from './modules/favorites/favorites.routes.js'
import { goingRoutes } from './modules/going/going.routes.js'
import { remindersPlugin } from './modules/reminders/reminders.plugin.js'
import { authRoutes } from './modules/auth/auth.routes.js'
import { invitesRoutes } from './modules/invites/invites.routes.js'
import { placesRoutes } from './modules/places/places.routes.js'
import { metricsRoutes } from './modules/admin/metrics.routes.js'
import { geoRoutes } from './modules/geo/geo.routes.js'

const app = Fastify({
  logger: true,

  bodyLimit: 20 * 1024 * 1024,
})

await app.register(interactionsRoutes, {
  prefix: '/api/interactions',
})

await app.register(aiRoutes, {
  prefix: '/api/ai',
})

// Помощник: где поесть рядом с мероприятием (#40).
await app.register(aiFoodRoutes, {
  prefix: '/api/ai',
})

await app.register(feedRoutes, {
  prefix: '/api/feed',
})

await app.register(feedDebugRoutes, {
  prefix: '/api/feed/debug',
})

await app.register(interestsRoutes, {
  prefix: '/api/profile/interests',
})

await app.register(cors, {
  origin: true,
})

app.get('/health', async () => {
  return {
    status: 'ok',
    service: 'evently-api',
    timestamp: new Date().toISOString(),
  }
})

await app.register(categoriesRoutes, {
  prefix: '/api/categories',
})

await app.register(eventsRoutes, {
  prefix: '/api/events',
})

await app.register(favoritesRoutes, {
  prefix: '/api/favorites',
})

await app.register(goingRoutes, {
  prefix: '/api/going',
})

await app.register(authRoutes, {
  prefix: '/api/auth',
})

await app.register(invitesRoutes, {
  prefix: '/api/invites',
})

await app.register(placesRoutes, {
  prefix: '/api/places',
})

// Метрики для команды и жюри (#31): /api/admin/metrics?key=ADMIN_METRICS_KEY
await app.register(metricsRoutes, {
  prefix: '/api/admin',
})

// Поиск места по тексту — запасной путь для «Рядом» (#33).
await app.register(geoRoutes, {
  prefix: '/api/geo',
})

await app.register(importRoutes, {
  prefix: '/internal/events/import',
})

const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '0.0.0.0'

try {
  await app.register(commentsRoutes, {
    prefix: '/api/comments',
  })

  await app.register(
  mediaRoutes,
  {
    prefix: '/media',
  },
)

await app.register(parserSyncPlugin)

await app.register(remindersPlugin)

  await app.listen({
    port,
    host,
  })

  app.log.info(`Evently API started on ${host}:${port}`)
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
