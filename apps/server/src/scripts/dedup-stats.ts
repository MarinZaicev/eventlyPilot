// ============================================================
// Статистика дедупликации — для отчёта и защиты проекта.
//
// Запуск из корня проекта:
//   pnpm --filter @evently/server exec tsx src/scripts/dedup-stats.ts
//   pnpm --filter @evently/server exec tsx src/scripts/dedup-stats.ts --run
//     (--run — сначала заново пересчитать дубликаты)
// ============================================================

import 'dotenv/config'

import { prisma } from '@evently/db'

import { deduplicateEvents } from '../modules/dedup/dedup.service.js'

function percent(part: number, total: number) {
  return total === 0
    ? '0%'
    : `${((100 * part) / total).toFixed(2)}%`
}

async function main() {
  if (process.argv.includes('--run')) {
    console.log('Пересчёт дубликатов…')
    console.log(await deduplicateEvents())
    console.log()
  }

  const since = new Date(Date.now() - 24 * 3_600_000)

  const upcoming = await prisma.event.findMany({
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
      source: true,
      sourceCity: true,
      duplicateOfId: true,
    },
  })

  const total = upcoming.length
  const duplicates = upcoming.filter((event) => event.duplicateOfId !== null)

  console.log('=== Дедупликация событий Evently ===')
  console.log(`Актуальных событий (сеанс не раньше суток назад): ${total}`)
  console.log(`Из них дубликатов (скрыто из выдачи): ${duplicates.length} (${percent(duplicates.length, total)})`)
  console.log(`Показывается пользователям: ${total - duplicates.length}`)
  console.log()

  // --- по источникам ---
  const bySource = new Map<string, { total: number; dups: number }>()

  for (const event of upcoming) {
    const row = bySource.get(event.source) ?? { total: 0, dups: 0 }
    row.total += 1
    if (event.duplicateOfId) row.dups += 1
    bySource.set(event.source, row)
  }

  console.log('По источникам:')
  console.table(
    [...bySource].map(([source, row]) => ({
      источник: source,
      событий: row.total,
      дубликатов: row.dups,
      доля: percent(row.dups, row.total),
    })),
  )

  // --- по городам (только где есть дубликаты) ---
  const byCity = new Map<string, number>()

  for (const event of duplicates) {
    const city = event.sourceCity ?? '—'
    byCity.set(city, (byCity.get(city) ?? 0) + 1)
  }

  if (byCity.size > 0) {
    console.log('Дубликаты по городам:')
    console.table(
      [...byCity]
        .sort((a, b) => b[1] - a[1])
        .map(([city, count]) => ({ город: city, дубликатов: count })),
    )
  }

  // --- группы ---
  const groups = await prisma.event.findMany({
    where: {
      duplicates: {
        some: {},
      },
    },

    select: {
      title: true,
      source: true,
      sourceCity: true,

      _count: {
        select: {
          occurrences: true,
          duplicates: true,
        },
      },

      duplicates: {
        take: 1,
        select: {
          title: true,
          source: true,
        },
      },
    },

    orderBy: {
      duplicates: {
        _count: 'desc',
      },
    },
  })

  console.log(`Групп дубликатов: ${groups.length}`)
  console.table(
    groups.slice(0, 15).map((group) => ({
      основное: group.title.slice(0, 50),
      источник: group.source,
      город: group.sourceCity ?? '—',
      сеансов: group._count.occurrences,
      дублей: group._count.duplicates,
      'пример дубля': `${group.duplicates[0]?.title.slice(0, 40) ?? ''} (${group.duplicates[0]?.source ?? ''})`,
    })),
  )
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
