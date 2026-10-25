import {
  CalendarCheck,
  CalendarDays,
  EyeOff,
  Heart,
  MapPin,
  MessageCircle,
  MoreHorizontal,
  Share2,
  Ticket,
  UserPlus,
  Users,
} from 'lucide-react'
import {
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import { getCategoryVisual } from '../lib/categoryVisuals'

import {
  isNowShowing,
  NOW_SHOWING_LABEL,
} from '../lib/nowShowing'

import {
  compactCount,
  goingLabel,
  priceLabel,
} from '../lib/price'

import { formatDistance } from '../lib/geo'

import type {
  ApiEvent,
} from '../lib/api'

import {
  useEventView,
} from '../hooks/useEventView'

type Props = {
  event: ApiEvent
  position: number

  liked: boolean
  commentsCount: number

  onLike: () => void

  // Режим «Рядом»: сколько до площадки, км (#34).
  distanceKm?: number | null

  // Двойной тап по карточке — только поставить лайк
  // (не снимает, как в TikTok).
  onDoubleTapLike?: () => void
  going: boolean
  onGoing: () => void
  onComments: () => void
  onShare: () => void

  // «Позвать с собой» — видна, когда отмечено «Пойду».
  onInvite?: () => void
  onDetails: () => void

  // Только в основной ленте: «Не интересно».
  onHide?: () => void
  hiding?: boolean
}

function formatDate(
  event: ApiEvent,
) {
  if (isNowShowing(event)) {
    return NOW_SHOWING_LABEL
  }

  const occurrence =
    event.occurrences[0]

  if (!occurrence) {
    return 'В любое время'
  }

  return new Intl.DateTimeFormat(
    'ru-RU',
    {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    },
  ).format(
    new Date(
      occurrence.startsAt,
    ),
  )
}


function getCategoryEmoji(
  event: ApiEvent,
) {
  return getCategoryVisual(event).emoji
}

function getFallbackLabel(
  event: ApiEvent,
) {
  return (
    event.categories[0]?.name ??
    'Событие'
  )
}

export function EventSlide({
  event,
  position,
  liked,
  commentsCount,
  onLike,
  distanceKm = null,
  onDoubleTapLike,
  going,
  onGoing,
  onComments,
  onShare,
  onInvite,
  onDetails,
  onHide,
  hiding = false,
}: Props) {
  const slideRef =
    useEventView(
      event.id,
      position,
    )

  const [imageFailed, setImageFailed] =
    useState(false)

  // Меню «…»: Поделиться и «Не интересно».
  const [menuOpen, setMenuOpen] =
    useState(false)

  // Двойной тап: сердца, которые вспыхивают в месте касания.
  const [hearts, setHearts] =
    useState<
      { id: number; x: number; y: number }[]
    >([])

  const pointerDownRef = useRef<{
    x: number
    y: number
  } | null>(null)

  const lastTapRef = useRef<{
    time: number
    x: number
    y: number
  } | null>(null)

  function isInteractive(
    target: EventTarget | null,
  ) {
    return (
      target instanceof Element &&
      Boolean(
        target.closest(
          'button, a, input, textarea, select, [role="menu"]',
        ),
      )
    )
  }

  function handlePointerDown(
    pointer: ReactPointerEvent<HTMLElement>,
  ) {
    pointerDownRef.current = {
      x: pointer.clientX,
      y: pointer.clientY,
    }
  }

  function handlePointerUp(
    pointer: ReactPointerEvent<HTMLElement>,
  ) {
    const down = pointerDownRef.current
    pointerDownRef.current = null

    if (
      !onDoubleTapLike ||
      menuOpen ||
      isInteractive(pointer.target) ||
      !down ||
      // Палец сдвинулся — это свайп, а не тап.
      Math.hypot(
        pointer.clientX - down.x,
        pointer.clientY - down.y,
      ) > 12
    ) {
      return
    }

    const now = Date.now()
    const last = lastTapRef.current

    if (
      last &&
      now - last.time < 320 &&
      Math.hypot(
        pointer.clientX - last.x,
        pointer.clientY - last.y,
      ) < 60
    ) {
      lastTapRef.current = null

      const rect =
        pointer.currentTarget.getBoundingClientRect()

      const id = now

      setHearts((current) => [
        ...current,
        {
          id,
          x: pointer.clientX - rect.left,
          y: pointer.clientY - rect.top,
        },
      ])

      window.setTimeout(() => {
        setHearts((current) =>
          current.filter(
            (heart) => heart.id !== id,
          ),
        )
      }, 900)

      onDoubleTapLike()
      return
    }

    lastTapRef.current = {
      time: now,
      x: pointer.clientX,
      y: pointer.clientY,
    }
  }

  const image =
    event.images[0]?.url ?? null

  const showImage =
    Boolean(image) && !imageFailed

  const fallbackEmoji =
    useMemo(
      () => getCategoryEmoji(event),
      [event],
    )

  const fallbackLabel =
    useMemo(
      () => getFallbackLabel(event),
      [event],
    )

  return (
    <section
      ref={slideRef}
      className={
        hiding
          ? 'event-slide hiding'
          : 'event-slide'
      }
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
    >
      {hearts.map((heart) => (
        <span
          key={heart.id}
          className="double-tap-heart"
          style={{
            left: heart.x,
            top: heart.y,
          }}
          aria-hidden="true"
        >
          <Heart
            size={96}
            fill="currentColor"
          />
        </span>
      ))}

      <div className="slide-media">
        {showImage ? (
          <>
            <img
              className="slide-image-bg"
              src={image ?? undefined}
              alt=""
              aria-hidden="true"
              loading="lazy"
            />

            <img
              className="slide-image"
              src={image ?? undefined}
              alt={event.title}
              loading="lazy"
              onError={() =>
                setImageFailed(true)
              }
            />
          </>
        ) : (
          <div
            className="slide-image-fallback"
            style={{
              background: `radial-gradient(circle at 50% 25%, ${getCategoryVisual(event).from}, transparent 60%), linear-gradient(180deg, ${getCategoryVisual(event).to}, #0d0d14)`,
            }}
          >
            <div className="slide-image-fallback-emoji">
              {fallbackEmoji}
            </div>

            <div className="slide-image-fallback-text">
              {fallbackLabel}
            </div>
          </div>
        )}

        <div className="slide-overlay" />
        <div className="slide-gradient" />
      </div>

      <div className="event-info">
        <div className="category-list">
          {event.categories
            .slice(0, 2)
            .map((category) => (
              <span
                key={category.id}
                className="category-pill"
              >
                {category.icon}{' '}
                {category.name}
              </span>
            ))}
        </div>

        <h1 className="event-name">
          {event.title}
        </h1>

        <div className="event-details">
          <div>
            <CalendarDays size={17} />

            <span>
              {formatDate(event)}
            </span>
          </div>

          {event.venue && (
            <div>
              <MapPin size={17} />

              <span>
                {event.venue.name}
                {distanceKm !== null &&
                  ` · ${formatDistance(distanceKm)} от вас`}
              </span>
            </div>
          )}

          {(() => {
            // Популярность у других (#36).
            const label = goingLabel(
              event.social?.going ?? 0,
              going,
            )

            return label ? (
              <div>
                <Users size={17} />

                <span>{label}</span>
              </div>
            ) : null
          })()}
        </div>

        {event.shortDescription && (
          <p className="event-description">
            {event.shortDescription}
          </p>
        )}

        <div className="bottom-actions">
          {(() => {
            const price = priceLabel(event, 'card')

            return price.known ? (
              <div className="price">
                {price.text}
              </div>
            ) : (
              <button
                type="button"
                className="price price-unknown"
                onClick={onDetails}
              >
                {price.text}
              </button>
            )
          })()}

          <button
            type="button"
            className="ticket-button"
            onClick={onDetails}
          >
            <Ticket size={19} />
            Подробнее
          </button>
        </div>
      </div>

      {/* Нажатие мимо меню «…» закрывает его */}
      {menuOpen && (
        <div
          className="social-menu-backdrop"
          onPointerDown={() =>
            setMenuOpen(false)
          }
        />
      )}

      <aside className="social-actions">
        <button
          type="button"
          className={
            liked
              ? 'social-button liked'
              : 'social-button'
          }
          onClick={onLike}
        >
          <span className="social-icon">
            <Heart
              size={29}
              fill={
                liked
                  ? 'currentColor'
                  : 'none'
              }
            />
          </span>

          <small>
            {compactCount(
              (event.social?.likes ?? 0) +
                (liked ? 1 : 0),
            )}
          </small>
        </button>

        <button
          type="button"
          className={
            going
              ? 'social-button going'
              : 'social-button'
          }
          onClick={onGoing}
        >
          <span className="social-icon">
            <CalendarCheck size={27} />
          </span>

          <small>
            {going ? 'Иду' : 'Пойду'}
          </small>
        </button>

        {going && onInvite && (
          <button
            type="button"
            className="social-button"
            onClick={onInvite}
          >
            <span className="social-icon">
              <UserPlus size={27} />
            </span>

            <small>Позвать</small>
          </button>
        )}

        <button
          type="button"
          className="social-button"
          onClick={onComments}
        >
          <span className="social-icon">
            <MessageCircle
              size={29}
            />
          </span>

          <small>
            {commentsCount}
          </small>
        </button>

        <div className="social-more">
          <button
            type="button"
            className={
              menuOpen
                ? 'social-button active'
                : 'social-button'
            }
            aria-label="Ещё"
            aria-expanded={menuOpen}
            onClick={() =>
              setMenuOpen((open) => !open)
            }
          >
            <span className="social-icon">
              <MoreHorizontal size={28} />
            </span>

            <small>Ещё</small>
          </button>

          {menuOpen && (
            <div
              className="social-menu"
              role="menu"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  onShare()
                }}
              >
                <Share2 size={19} />
                Поделиться
              </button>

              {onHide && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    onHide()
                  }}
                >
                  <EyeOff size={19} />
                  Не интересно
                </button>
              )}
            </div>
          )}
        </div>
      </aside>
    </section>
  )
}