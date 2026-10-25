import {
  CalendarDays,
  MapPin,
  Ticket,
  X,
} from 'lucide-react'

import {
  useEffect,
  useState,
} from 'react'

import type {
  ApiEvent,
} from '../lib/api'

import {
  getFoodNearEvent,
  placeCuisine,
  placeDistance,
  placeKindLabel,
  placeMapUrl,
  type NearbyFoodPlace,
} from '../lib/places'

import { openExternal } from '../lib/max'

import { PlaceThumb } from './PlaceThumb'

import {
  isNowShowing,
  NOW_SHOWING_LABEL,
} from '../lib/nowShowing'

import { priceLabel } from '../lib/price'

type Props = {
  event: ApiEvent
  onClose: () => void
  onTicket: () => void
  onAskAiFood?: () => void
}

function formatDate(event: ApiEvent) {
  if (isNowShowing(event)) {
    return NOW_SHOWING_LABEL
  }

  const occurrence =
    event.occurrences[0]

  if (!occurrence) {
    return '\u0412 \u043b\u044e\u0431\u043e\u0435 \u0432\u0440\u0435\u043c\u044f'
  }

  return new Intl.DateTimeFormat(
    'ru-RU',
    {
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    },
  ).format(
    new Date(occurrence.startsAt),
  )
}


/*
 * «Где поесть рядом» — 5 ближайших заведений к площадке (до 1 км).
 * Нет координат или рядом ничего — блок не показывается.
 * У заведений OpenStreetMap подпись «© участники OpenStreetMap»
 * обязательна (лицензия ODbL) — выводим attribution всех источников.
 */
function NearbyFood({
  eventId,
  onAskAi,
}: {
  eventId: string
  onAskAi?: () => void
}) {
  const [places, setPlaces] =
    useState<NearbyFoodPlace[] | null>(null)

  useEffect(() => {
    let cancelled = false

    setPlaces(null)

    getFoodNearEvent(eventId)
      .then((response) => {
        if (!cancelled) {
          setPlaces(response.items)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPlaces([])
        }
      })

    return () => {
      cancelled = true
    }
  }, [eventId])

  if (places === null) {
    return (
      <section className="nearby-food">
        <h3>Где поесть рядом</h3>
        <p className="nearby-food-loading">
          Ищем заведения рядом…
        </p>
      </section>
    )
  }

  if (places.length === 0) {
    return null
  }

  const attributions = [
    ...new Set(
      places
        .map((place) =>
          place.attribution ??
          (place.source === 'osm'
            ? '© участники OpenStreetMap'
            : null),
        )
        .filter(
          (text): text is string =>
            Boolean(text),
        ),
    ),
  ]

  return (
    <section className="nearby-food">
      <h3>Где поесть рядом</h3>

      <ul>
        {places.map((place) => {
          const cuisine =
            placeCuisine(place.cuisine)

          return (
            <li key={place.id}>
              <button
                type="button"
                onClick={() =>
                  openExternal(
                    placeMapUrl(place),
                  )
                }
              >
                <PlaceThumb
                  imageUrl={place.imageUrl}
                  kind={place.kind}
                />

                <span className="nearby-food-text">
                  <strong>{place.name}</strong>

                  <small>
                    {[
                      placeKindLabel(place.kind),
                      cuisine,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>

                  <small className="nearby-food-distance">
                    {placeDistance(place.distanceM)}
                  </small>
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      {onAskAi && (
        <button
          type="button"
          className="ai-food-ask"
          onClick={onAskAi}
        >
          ✨ Совет ИИ: куда зайти до или после
        </button>
      )}

      {attributions.length > 0 && (
        <p className="nearby-food-attribution">
          {attributions.join(' · ')}
        </p>
      )}
    </section>
  )
}

export function EventDetailsSheet({
  event,
  onClose,
  onTicket,
  onAskAiFood,
}: Props) {
  const image =
    event.images[0]?.url

  const description =
    event.description ??
    event.shortDescription

  const hasLink =
    Boolean(
      event.ticketUrl ??
      event.sourceUrl,
    )

  return (
    <div
      className="details-backdrop"
      onClick={onClose}
    >
      <div
        className="details-sheet"
        onClick={(event) =>
          event.stopPropagation()
        }
      >
        <button
          type="button"
          className="details-close"
          onClick={onClose}
        >
          <X size={22} />
        </button>

        {image && (
          <img
            className="details-image"
            src={image}
            alt=""
          />
        )}

        <div className="details-body">
          <div className="details-categories">
            {event.categories
              .slice(0, 3)
              .map((category) => (
                <span key={category.id}>
                  {category.icon}{' '}
                  {category.name}
                </span>
              ))}
          </div>

          <h2>{event.title}</h2>

          <div className="details-meta">
            <div>
              <CalendarDays size={18} />
              <span>
                {formatDate(event)}
              </span>
            </div>

            {event.venue && (
              <div>
                <MapPin size={18} />
                <span>
                  {event.venue.name}
                </span>
              </div>
            )}

            {event.venue?.address && (
              <div className="details-address">
                {event.venue.address}
              </div>
            )}
          </div>

          {description && (
            <p className="details-description">
              {description}
            </p>
          )}

          {event.venue && (
            <NearbyFood
              eventId={event.id}
              onAskAi={onAskAiFood}
            />
          )}

          <div className="details-footer">
            {(() => {
              const price = priceLabel(event, 'details')

              return (
                <strong
                  className={
                    price.known
                      ? 'details-price'
                      : 'details-price details-price-unknown'
                  }
                >
                  {price.text}
                </strong>
              )
            })()}

            {hasLink && (
              <button
                type="button"
                className="details-ticket-button"
                onClick={onTicket}
              >
                <Ticket size={19} />

                {event.ticketUrl
                  ? isNowShowing(event)
                    ? 'Билеты на Кинопоиске'
                    : '\u041a\u0443\u043f\u0438\u0442\u044c \u0431\u0438\u043b\u0435\u0442'
                  : '\u041e\u0442\u043a\u0440\u044b\u0442\u044c \u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
