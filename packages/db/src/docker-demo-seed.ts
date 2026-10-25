import { prisma } from './client.js'

type DemoEvent = {
  externalId: string
  city: string
  venue: string
  address: string
  title: string
  description: string
  category: string
  priceMin: number
  priceMax: number
  daysFromNow: number
  hour: number
  image: string
}

const events: DemoEvent[] = [
  {
    externalId: 'demo-msk-concert-1',
    city: 'msk',
    venue: 'Music Hall',
    address: 'Москва, центр',
    title: 'Большой вечер живой музыки',
    description: 'Концерт с живым звуком и атмосферой большого городского фестиваля.',
    category: 'concert',
    priceMin: 1200,
    priceMax: 3500,
    daysFromNow: 1,
    hour: 19,
    image: '/demo/concert.svg'
  },
  {
    externalId: 'demo-msk-theatre-1',
    city: 'msk',
    venue: 'Новая сцена',
    address: 'Москва, Театральный район',
    title: 'Спектакль «Город внутри»',
    description: 'Современная постановка о людях, встречах и жизни большого города.',
    category: 'theatre',
    priceMin: 900,
    priceMax: 2800,
    daysFromNow: 2,
    hour: 19,
    image: '/demo/theatre.svg'
  },
  {
    externalId: 'demo-msk-cinema-1',
    city: 'msk',
    venue: 'Киноцентр',
    address: 'Москва, центр',
    title: 'Ночь большого кино',
    description: 'Специальный вечер премьер, обсуждений и кинопоказов.',
    category: 'cinema',
    priceMin: 600,
    priceMax: 1100,
    daysFromNow: 3,
    hour: 20,
    image: '/demo/cinema.svg'
  },
  {
    externalId: 'demo-msk-exhibition-1',
    city: 'msk',
    venue: 'Городская галерея',
    address: 'Москва, Арт-квартал',
    title: 'Выставка цифрового искусства',
    description: 'Интерактивная выставка на стыке технологий, света и современного искусства.',
    category: 'exhibition',
    priceMin: 700,
    priceMax: 1400,
    daysFromNow: 4,
    hour: 16,
    image: '/demo/exhibition.svg'
  },
  {
    externalId: 'demo-msk-standup-1',
    city: 'msk',
    venue: 'Comedy Club Hall',
    address: 'Москва, центр',
    title: 'Стендап-вечер',
    description: 'Несколько комиков, новые монологи и большой вечер юмора.',
    category: 'standup',
    priceMin: 800,
    priceMax: 1800,
    daysFromNow: 5,
    hour: 20,
    image: '/demo/standup.svg'
  },
  {
    externalId: 'demo-msk-food-1',
    city: 'msk',
    venue: 'Гастромаркет',
    address: 'Москва, набережная',
    title: 'Городской фестиваль еды',
    description: 'Фуд-корты, локальные проекты, дегустации и музыка.',
    category: 'food',
    priceMin: 0,
    priceMax: 1500,
    daysFromNow: 6,
    hour: 13,
    image: '/demo/food.svg'
  },

  {
    externalId: 'demo-nsk-concert-1',
    city: 'nsk',
    venue: 'Сибирь Live',
    address: 'Новосибирск, центр',
    title: 'Сибирский музыкальный вечер',
    description: 'Живой концерт локальных исполнителей и приглашённых артистов.',
    category: 'concert',
    priceMin: 1000,
    priceMax: 2500,
    daysFromNow: 1,
    hour: 19,
    image: '/demo/concert.svg'
  },
  {
    externalId: 'demo-nsk-theatre-1',
    city: 'nsk',
    venue: 'Камерная сцена',
    address: 'Новосибирск, центр',
    title: 'Современный театр: новая сцена',
    description: 'Камерная постановка с современной драматургией.',
    category: 'theatre',
    priceMin: 700,
    priceMax: 1900,
    daysFromNow: 2,
    hour: 18,
    image: '/demo/theatre.svg'
  },
  {
    externalId: 'demo-nsk-sport-1',
    city: 'nsk',
    venue: 'Городская арена',
    address: 'Новосибирск, спортивный квартал',
    title: 'Большой спортивный день',
    description: 'Соревнования, активности и спортивная программа для зрителей.',
    category: 'sport',
    priceMin: 500,
    priceMax: 1600,
    daysFromNow: 3,
    hour: 15,
    image: '/demo/sport.svg'
  },
  {
    externalId: 'demo-nsk-exhibition-1',
    city: 'nsk',
    venue: 'Арт-центр',
    address: 'Новосибирск, центр',
    title: 'Выставка «Сибирь будущего»',
    description: 'Современное искусство, дизайн и мультимедийные инсталляции.',
    category: 'exhibition',
    priceMin: 500,
    priceMax: 1000,
    daysFromNow: 4,
    hour: 14,
    image: '/demo/exhibition.svg'
  },
  {
    externalId: 'demo-nsk-family-1',
    city: 'nsk',
    venue: 'Семейный центр',
    address: 'Новосибирск, центр',
    title: 'Семейный фестиваль выходного дня',
    description: 'Игры, мастер-классы и интерактивная программа для всей семьи.',
    category: 'family',
    priceMin: 0,
    priceMax: 900,
    daysFromNow: 5,
    hour: 12,
    image: '/demo/family.svg'
  },
  {
    externalId: 'demo-nsk-education-1',
    city: 'nsk',
    venue: 'Лекторий',
    address: 'Новосибирск, Академический квартал',
    title: 'Лекция о технологиях будущего',
    description: 'Открытая лекция о новых технологиях, AI и цифровых продуктах.',
    category: 'education',
    priceMin: 0,
    priceMax: 0,
    daysFromNow: 6,
    hour: 18,
    image: '/demo/education.svg'
  }
]

function occurrenceDate(daysFromNow: number, hour: number) {
  const date = new Date()

  date.setUTCDate(date.getUTCDate() + daysFromNow)
  date.setUTCHours(hour, 0, 0, 0)

  return date
}

async function main() {
  console.log('Seeding Docker demo events...')

  for (const item of events) {
    const venue = await prisma.venue.upsert({
      where: {
        source_externalId: {
          source: 'docker-demo',
          externalId: `venue-${item.externalId}`
        }
      },

      update: {
        name: item.venue,
        address: item.address,
        city: item.city
      },

      create: {
        source: 'docker-demo',
        externalId: `venue-${item.externalId}`,
        name: item.venue,
        address: item.address,
        city: item.city
      }
    })

    const event = await prisma.event.upsert({
      where: {
        source_externalId: {
          source: 'docker-demo',
          externalId: item.externalId
        }
      },

      update: {
        title: item.title,
        description: item.description,
        shortDescription: item.description,
        sourceCity: item.city,
        venueId: venue.id,
        priceMin: item.priceMin,
        priceMax: item.priceMax,
        isFree: item.priceMin === 0,
        status: 'ACTIVE',
        popularityScore: 50,
        lastSeenAt: new Date()
      },

      create: {
        source: 'docker-demo',
        externalId: item.externalId,
        sourceCity: item.city,
        title: item.title,
        description: item.description,
        shortDescription: item.description,
        venueId: venue.id,
        priceMin: item.priceMin,
        priceMax: item.priceMax,
        currency: 'RUB',
        isFree: item.priceMin === 0,
        status: 'ACTIVE',
        popularityScore: 50,
        publishedAt: new Date(),
        lastSeenAt: new Date()
      }
    })

    await prisma.eventOccurrence.deleteMany({
      where: {
        eventId: event.id
      }
    })

    await prisma.eventOccurrence.create({
      data: {
        eventId: event.id,
        startsAt: occurrenceDate(
          item.daysFromNow,
          item.hour
        )
      }
    })

    await prisma.eventImage.deleteMany({
      where: {
        eventId: event.id
      }
    })

    await prisma.eventImage.create({
      data: {
        eventId: event.id,
        url: item.image,
        position: 0
      }
    })

    await prisma.eventCategory.deleteMany({
      where: {
        eventId: event.id
      }
    })

    const category =
      await prisma.category.findUniqueOrThrow({
        where: {
          slug: item.category
        }
      })

    await prisma.eventCategory.create({
      data: {
        eventId: event.id,
        categoryId: category.id
      }
    })
  }

  const count = await prisma.event.count({
    where: {
      source: 'docker-demo'
    }
  })

  console.log(`Docker demo events seeded: ${count}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
