import type { ApiEvent } from './api'

/*
 * Фильмы «в прокате» (#28): у kinopoisk-cinema нет сеансов,
 * вместо них одна условная дата на неделю вперёд. Показываем
 * «Сейчас в кино» вместо этой даты.
 */
const NOW_SHOWING_SOURCES = new Set([
  'kinopoisk-cinema',
])

export const NOW_SHOWING_LABEL = 'Сейчас в кино'

export function isNowShowing(
  event: Pick<ApiEvent, 'source'>,
) {
  return Boolean(
    event.source &&
      NOW_SHOWING_SOURCES.has(event.source),
  )
}
