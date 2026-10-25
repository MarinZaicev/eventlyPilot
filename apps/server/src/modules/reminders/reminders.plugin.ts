// ============================================================
// REMINDERS — бот MAX напоминает о событиях с отметкой «Пойду».
//
// Каждые REMINDER_INTERVAL_MS (по умолчанию 5 мин) ищем отметки,
// у которых сеанс начнётся в ближайшие REMINDER_LEAD_HOURS
// (по умолчанию 24 ч), напоминание ещё не отправлено и известен
// получатель в MAX. Отправляем сообщение с кнопкой на билеты.
//
// Для показа на защите можно временно поставить
// REMINDER_LEAD_HOURS=168 (неделя) и REMINDER_INTERVAL_MS=30000.
// ============================================================

import type { FastifyInstance } from 'fastify'

import { prisma } from '@evently/db'

import { eventDeepLink, sendMaxMessage } from '../../lib/max-bot.js'

const CITY_TIME_ZONES: Record<string, string> = {
  msk: 'Europe/Moscow',
  spb: 'Europe/Moscow',
  kzn: 'Europe/Moscow',
  nnv: 'Europe/Moscow',
  krd: 'Europe/Moscow',
  rostov: 'Europe/Moscow',
  voronezh: 'Europe/Moscow',
  volgograd: 'Europe/Volgograd',
  smr: 'Europe/Samara',
  ekb: 'Asia/Yekaterinburg',
  chelyabinsk: 'Asia/Yekaterinburg',
  perm: 'Asia/Yekaterinburg',
  ufa: 'Asia/Yekaterinburg',
  omsk: 'Asia/Omsk',
  nsk: 'Asia/Novosibirsk',
  krasnoyarsk: 'Asia/Krasnoyarsk',
}

function formatWhen(
  date: Date,
  sourceCity: string | null,
) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone:
      CITY_TIME_ZONES[sourceCity ?? ''] ??
      'Europe/Moscow',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms))

export async function sendDueReminders(
  log: FastifyInstance['log'],
) {
  const leadHours = Number(
    process.env.REMINDER_LEAD_HOURS ?? 24,
  )

  const now = new Date()
  const until = new Date(now.getTime() + leadHours * 3_600_000)

  const due = await prisma.attendance.findMany({
    where: {
      reminderSentAt: null,
      maxRecipientId: {
        not: null,
      },
      startsAt: {
        gt: now,
        lte: until,
      },
      event: {
        status: 'ACTIVE',
      },
    },

    take: 100,

    orderBy: {
      startsAt: 'asc',
    },

    include: {
      event: {
        select: {
          title: true,
          sourceCity: true,
          ticketUrl: true,
          sourceUrl: true,
          venue: {
            select: {
              name: true,
              address: true,
            },
          },
        },
      },
    },
  })

  let sent = 0
  let failed = 0

  for (const attendance of due) {
    const { event } = attendance

    const place = [
      event.venue?.name,
      event.venue?.address,
    ]
      .filter(Boolean)
      .join(', ')

    const text = [
      '⏰ Напоминание от Evently',
      '',
      `Вы собирались: «${event.title}»`,
      `🗓 ${formatWhen(attendance.startsAt!, event.sourceCity)}`,
      place ? `📍 ${place}` : null,
      '',
      'Хорошего вечера!',
    ]
      .filter((line) => line !== null)
      .join('\n')

    const link = event.ticketUrl ?? event.sourceUrl

    try {
      const result = await sendMaxMessage({
        userId: attendance.maxRecipientId!,
        text,
        buttons: [
          {
            text: '📱 Открыть в Evently',
            url: eventDeepLink(attendance.eventId),
          },
          ...(link
            ? [
                {
                  text: event.ticketUrl ? '🎟 Билеты' : 'Подробнее',
                  url: link,
                },
              ]
            : []),
        ],
      })

      /*
       * 2xx — отправлено. 4xx — повторять бессмысленно
       * (нет диалога с ботом, неверный id) — тоже отмечаем,
       * чтобы не спамить попытками. 5xx/сеть — повторим позже.
       */
      if (result.ok || (result.status >= 400 && result.status < 500)) {
        await prisma.attendance.update({
          where: {
            userId_eventId: {
              userId: attendance.userId,
              eventId: attendance.eventId,
            },
          },

          data: {
            reminderSentAt: new Date(),
          },
        })
      }

      if (result.ok) {
        sent += 1
      } else {
        failed += 1
        log.warn(
          { status: result.status, body: result.body },
          'MAX reminder not delivered',
        )
      }
    } catch (error) {
      failed += 1
      log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'MAX reminder request failed',
      )
    }

    // Лимит MAX — не больше 2 сообщений в секунду.
    await sleep(600)
  }

  return {
    due: due.length,
    sent,
    failed,
  }
}

export async function remindersPlugin(
  app: FastifyInstance,
) {
  if (!process.env.MAX_BOT_TOKEN) {
    app.log.warn('MAX_BOT_TOKEN is not set — reminders are disabled')
    return
  }

  const intervalMs = Number(
    process.env.REMINDER_INTERVAL_MS ?? 5 * 60_000,
  )

  let running = false

  async function run() {
    if (running) {
      return
    }

    running = true

    try {
      const result = await sendDueReminders(app.log)

      if (result.due > 0) {
        app.log.info(result, 'Reminders processed')
      }
    } catch (error) {
      app.log.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Reminders run failed',
      )
    } finally {
      running = false
    }
  }

  const initialTimer = setTimeout(() => void run(), 5_000)
  initialTimer.unref()

  const timer = setInterval(() => void run(), intervalMs)
  timer.unref()

  app.addHook('onClose', async () => {
    clearTimeout(initialTimer)
    clearInterval(timer)
  })
}
