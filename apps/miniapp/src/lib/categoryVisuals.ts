import type { ApiEvent } from '@evently/shared'

/*
 * Оформление заглушек для событий без картинки
 * (или когда картинка не загрузилась):
 * эмодзи и градиент по категории.
 */
const CATEGORY_VISUALS: Record<
  string,
  {
    emoji: string
    from: string
    to: string
  }
> = {
  concert: { emoji: '🎵', from: '#7c4dff', to: '#2a1060' },
  theatre: { emoji: '🎭', from: '#c2185b', to: '#3d0a22' },
  cinema: { emoji: '🎬', from: '#1e88e5', to: '#0b2545' },
  sport: { emoji: '🏃', from: '#43a047', to: '#123d16' },
  tour: { emoji: '🗺️', from: '#00897b', to: '#06302b' },
  exhibition: { emoji: '🎨', from: '#fb8c00', to: '#4a2400' },
  party: { emoji: '🎉', from: '#e040fb', to: '#3b0a45' },
  standup: { emoji: '😂', from: '#fdd835', to: '#4a3d00' },
  games: { emoji: '🧩', from: '#5c6bc0', to: '#1a1f45' },
  food: { emoji: '🍔', from: '#f4511e', to: '#4a1405' },
  family: { emoji: '👨‍👩‍👧', from: '#26c6da', to: '#06363d' },
  education: { emoji: '🧠', from: '#8d6e63', to: '#2b1f1a' },
  masterclass: { emoji: '✂️', from: '#ec407a', to: '#40101f' },
  business: { emoji: '💼', from: '#546e7a', to: '#172226' },
  selfdev: { emoji: '🌱', from: '#66bb6a', to: '#16331a' },
  other: { emoji: '✨', from: '#7c4dff', to: '#15151b' },
}

const DEFAULT_VISUAL = {
  emoji: '✨',
  from: '#7c4dff',
  to: '#15151b',
}

export function getCategoryVisual(
  event: ApiEvent,
) {
  const slug =
    event.categories[0]?.slug ?? ''

  return (
    CATEGORY_VISUALS[slug] ??
    DEFAULT_VISUAL
  )
}

export function getCategoryLabel(
  event: ApiEvent,
) {
  return (
    event.categories[0]?.name ??
    'Событие'
  )
}
