import type { ApiEvent } from './api'

import { isNowShowing } from './nowShowing'

/*
 * Подпись цены (#29). Вместо скучного «Цена уточняется» —
 * подсказка, где цену узнать, по ситуации.
 *
 * known: false — цены в данных нет; такую подпись рисуем
 * акцентом и (на карточке) делаем нажимаемой.
 */
export function priceLabel(
  event: ApiEvent,
  place: 'card' | 'details',
): { text: string; known: boolean } {
  if (event.isFree) {
    return { text: 'Бесплатно', known: true }
  }

  if (event.priceMin !== null) {
    return {
      text: `от ${event.priceMin.toLocaleString('ru-RU')} ₽`,
      known: true,
    }
  }

  const hasLink = Boolean(event.ticketUrl ?? event.sourceUrl)

  if (isNowShowing(event)) {
    return {
      text: place === 'card' ? 'Билеты в кино' : 'Цены на Кинопоиске',
      known: false,
    }
  }

  if (hasLink) {
    return {
      text: place === 'card' ? 'Узнать цену ›' : 'Цена на сайте',
      known: false,
    }
  }

  return { text: 'Цена у организатора', known: false }
}

// 999 → «999», 1250 → «1,2 тыс.» (#36)
export function compactCount(value: number) {
  if (value < 1000) {
    return String(value)
  }

  return `${(value / 1000)
    .toFixed(value < 10_000 ? 1 : 0)
    .replace('.', ',')
    .replace(',0', '')} тыс.`
}

// Строка про «Пойду» с учётом себя (#36). null — не показывать.
export function goingLabel(
  othersGoing: number,
  meGoing: boolean,
) {
  if (meGoing) {
    return othersGoing > 0
      ? `Вы и ещё ${othersGoing} собираетесь пойти`
      : null
  }

  return othersGoing > 0
    ? `Собираются пойти: ${othersGoing}`
    : null
}
