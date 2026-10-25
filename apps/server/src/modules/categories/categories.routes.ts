import type { FastifyInstance } from 'fastify'

import { prisma } from '@evently/db'

export async function categoriesRoutes(app: FastifyInstance) {
  app.get('/', async () => {
    const categories = await prisma.category.findMany({
      where: {
        active: true,

        // «Разное» — служебная категория для неразмеченных
        // событий: выбирать её в онбординге/фильтре незачем.
        slug: {
          not: 'other',
        },
      },

      orderBy: {
        sortOrder: 'asc',
      },

      select: {
        id: true,
        slug: true,
        name: true,
        icon: true,
        sortOrder: true,
      },
    })

    return {
      items: categories,
    }
  })
}
