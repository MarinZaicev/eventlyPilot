// ============================================================
// Разовая разметка событий без категории — не дожидаясь
// следующего цикла парсера. Те же правила, что при импорте
// (modules/parser-sync/category-classifier.ts).
//
// Запуск из корня проекта:
//   pnpm --filter @evently/server exec tsx src/scripts/recategorize.ts
//     — только показать, что получится (база не меняется);
//   pnpm --filter @evently/server exec tsx src/scripts/recategorize.ts --apply
//     — записать категории.
//
// Перед запуском: новые категории должны быть в базе (seed.ts).
// ============================================================

import 'dotenv/config'

import { prisma } from '@evently/db'

import {
  OTHER_CATEGORY_SLUG,
  resolveCategories,
} from '../modules/parser-sync/category-classifier.js'

async function main() {
  const apply = process.argv.includes('--apply')

  const categories = await prisma.category.findMany({
    select: {
      id: true,
      slug: true,
    },
  })

  const categoryIds = new Map<string, string>(
    categories.map((category: { id: string; slug: string }) => [
      category.slug,
      category.id,
    ]),
  )

  const slugById = new Map<string, string>(
    categories.map((category: { id: string; slug: string }) => [
      category.id,
      category.slug,
    ]),
  )

  if (!categoryIds.has(OTHER_CATEGORY_SLUG)) {
    console.log(
      'В базе нет новых категорий. Сначала: pnpm --filter @evently/db exec tsx src/seed.ts',
    )
    return
  }

  const events = await prisma.event.findMany({
    where: {
      status: 'ACTIVE',
      categories: {
        none: {},
      },
    },

    select: {
      id: true,
      source: true,
      title: true,
      shortDescription: true,
      description: true,
    },
  })

  console.log(`Событий без категории: ${events.length}`)

  const bySlug = new Map<string, number>()
  const samples = new Map<string, string[]>()
  const rows: { eventId: string; categoryId: string }[] = []

  for (const event of events) {
    const resolved = resolveCategories(
      {
        categories: [],
        source: event.source,
        title: event.title,
        description: event.description,
        shortDescription: event.shortDescription,
      },
      categoryIds,
    )

    for (const categoryId of resolved.ids) {
      rows.push({ eventId: event.id, categoryId })

      const slug = slugById.get(categoryId) ?? '?'

      bySlug.set(slug, (bySlug.get(slug) ?? 0) + 1)

      const list = samples.get(slug) ?? []

      if (list.length < 5) {
        list.push(event.title)
        samples.set(slug, list)
      }
    }
  }

  console.log()
  console.log('Куда попадут:')

  for (const [slug, count] of [...bySlug].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${slug.padEnd(12)} ${String(count).padStart(5)}`)

    for (const title of samples.get(slug) ?? []) {
      console.log(`      · ${title.slice(0, 90)}`)
    }
  }

  if (!apply) {
    console.log()
    console.log('Это предпросмотр. Записать: добавьте --apply')
    return
  }

  // Пачками, чтобы не упереться в лимит параметров запроса.
  for (let index = 0; index < rows.length; index += 1000) {
    await prisma.eventCategory.createMany({
      data: rows.slice(index, index + 1000),
      skipDuplicates: true,
    })
  }

  console.log()
  console.log(`Записано: ${rows.length}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
