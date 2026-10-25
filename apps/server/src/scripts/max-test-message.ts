// ============================================================
// Проверка связи с MAX Bot API: отправить тестовое сообщение.
//
//   pnpm --filter @evently/server exec tsx src/scripts/max-test-message.ts
//     — получатель: последний, кто нажал «Пойду» из MAX
//   pnpm --filter @evently/server exec tsx src/scripts/max-test-message.ts 123456789
//     — получатель: указанный id пользователя MAX
// ============================================================

import 'dotenv/config'

import { prisma } from '@evently/db'

import { sendMaxMessage } from '../lib/max-bot.js'

async function main() {
  let userId = process.argv[2]

  if (!userId) {
    const latest = await prisma.attendance.findFirst({
      where: {
        maxRecipientId: {
          not: null,
        },
      },

      orderBy: {
        createdAt: 'desc',
      },

      select: {
        maxRecipientId: true,
      },
    })

    userId = latest?.maxRecipientId ?? ''
  }

  if (!userId) {
    console.log(
      'Нет получателя: нажмите «Пойду» в Mini App, открытом из MAX, или передайте id аргументом.',
    )
    return
  }

  console.log(`Отправляю тестовое сообщение пользователю MAX ${userId}…`)

  const result = await sendMaxMessage({
    userId,
    text: '✅ Evently на связи: так будут выглядеть напоминания о событиях.',
    buttons: [
      {
        text: 'Открыть Evently',
        url: 'https://max.ru',
      },
    ],
  })

  console.log(result)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
