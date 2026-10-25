import { useState } from 'react'

import { placeKindIcon } from '../lib/places'

// Фото заведения, а если его нет или не загрузилось — значок типа (#37).
export function PlaceThumb({
  imageUrl,
  kind,
}: {
  imageUrl: string | null
  kind: string
}) {
  const [failed, setFailed] = useState(false)

  if (imageUrl && !failed) {
    return (
      <img
        className="nearby-food-photo"
        src={imageUrl}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
      />
    )
  }

  return (
    <span className="nearby-food-icon">
      {placeKindIcon(kind)}
    </span>
  )
}
