import { useState } from 'react'

import type { ApiEvent } from '@evently/shared'

import {
  getCategoryLabel,
  getCategoryVisual,
} from '../lib/categoryVisuals'

/*
 * Обложка события: картинка, а если её нет
 * или она не загрузилась — аккуратная заглушка
 * (градиент категории, эмодзи и название категории).
 */
export function EventCover({
  event,
  className,
}: {
  event: ApiEvent
  className: string
}) {
  const [failed, setFailed] =
    useState(false)

  const image =
    event.images[0]?.url ?? null

  if (image && !failed) {
    return (
      <img
        src={image}
        alt=""
        loading="lazy"
        className={className}
        onError={() => setFailed(true)}
      />
    )
  }

  const visual =
    getCategoryVisual(event)

  return (
    <div
      className={`${className} event-cover-fallback`}
      style={{
        background: `radial-gradient(circle at 30% 20%, ${visual.from}, transparent 70%), linear-gradient(160deg, ${visual.from}55, ${visual.to})`,
      }}
    >
      <span className="event-cover-emoji">
        {visual.emoji}
      </span>

      <span className="event-cover-label">
        {getCategoryLabel(event)}
      </span>
    </div>
  )
}
