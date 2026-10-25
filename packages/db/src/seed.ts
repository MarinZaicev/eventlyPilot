import { prisma } from './client.js'

const categories = [
  { slug: 'concert', name: 'Концерты', icon: '🎵', sortOrder: 10 },
  { slug: 'theatre', name: 'Театр', icon: '🎭', sortOrder: 20 },
  { slug: 'cinema', name: 'Кино', icon: '🎬', sortOrder: 30 },
  { slug: 'sport', name: 'Спорт', icon: '🏃', sortOrder: 40 },
  { slug: 'exhibition', name: 'Выставки', icon: '🎨', sortOrder: 50 },
  { slug: 'party', name: 'Вечеринки', icon: '🎉', sortOrder: 60 },
  { slug: 'standup', name: 'Стендап', icon: '😂', sortOrder: 70 },
  { slug: 'food', name: 'Еда', icon: '🍔', sortOrder: 80 },
  { slug: 'family', name: 'Семья', icon: '👨‍👩‍👧', sortOrder: 90 },
  { slug: 'education', name: 'Лекции', icon: '🧠', sortOrder: 100 },
  { slug: 'tour', name: 'Экскурсии', icon: '🗺️', sortOrder: 110 },
  { slug: 'games', name: 'Квизы и квесты', icon: '🧩', sortOrder: 120 },
  { slug: 'masterclass', name: 'Мастер-классы', icon: '✂️', sortOrder: 130 },
  { slug: 'business', name: 'Бизнес и IT', icon: '💼', sortOrder: 140 },
  { slug: 'selfdev', name: 'Саморазвитие', icon: '🌱', sortOrder: 150 },
  // Запасная: события, которые не удалось разметить.
  // В онбординге и «Категориях» не показывается (categories.routes.ts).
  { slug: 'other', name: 'Разное', icon: '✨', sortOrder: 999 }
]

async function main() {
  for (const category of categories) {
    await prisma.category.upsert({
      where: {
        slug: category.slug
      },

      update: {
        name: category.name,
        icon: category.icon,
        sortOrder: category.sortOrder,
        active: true
      },

      create: {
        ...category,
        active: true
      }
    })
  }

  const count = await prisma.category.count()

  console.log(`Categories seeded successfully: ${count}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
