import {
  Fragment,
  useEffect,
  useRef,
  useState,
} from 'react'

import {
  ArrowRight,
  Bot,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  Home,
  MapPin,
  MessageCircle,
  PartyPopper,
  Play,
  Send,
  Sparkles,
  Ticket,
  UserRound,
  X,
} from 'lucide-react'

import {
  getFavorites,
  setFavorite,
} from './lib/favorites'

import {
  EventCover,
} from './components/EventCover'

import {
  getGoing,
  setGoing,
} from './lib/going'

import {
  getEventById,
  getEvents,
  type ApiEvent,
} from './lib/api'

import {
  isNowShowing,
  NOW_SHOWING_LABEL,
} from './lib/nowShowing'

import {
  GEO_FAILURE_TEXT,
  distanceToEvent,
  getCurrentPosition,
  getSavedPlace,
  savePlace,
  searchPlace,
  type GeoFailure,
} from './lib/geo'

import {
  acceptInvite,
  getInvite,
  getMyInviteCode,
} from './lib/invites'

import {
  buildEventLink,
  getLaunches,
  getMaxInitData,
  buildInviteLink,
  getStartLink,
  shareLink,
  type StartLink,
} from './lib/max'

import {
  askFoodNearEvent,
  sendAiMessage,
  type AiEventSuggestion,
  type AiFoodPlace,
} from './lib/ai'

import {
  placeCuisine,
  placeDistance,
  placeKindLabel,
  placeMapUrl,
} from './lib/places'

import { openExternal } from './lib/max'

import { PlaceThumb } from './components/PlaceThumb'

import {
  sendInteraction,
} from './lib/interactions'

import {
  createComment,
  getComments,
  type ApiComment,
} from './lib/comments'

import {
  getCategories,
  getProfileInterests,
  saveProfileInterests,
  type ApiCategory,
} from './lib/profile'

import {
  EventSlide,
} from './components/EventSlide'

import {
  Onboarding,
} from './components/Onboarding'

import {
  CategorySheet,
} from './components/CategorySheet'

import {
  EventDetailsSheet,
} from './components/EventDetailsSheet'


type AppPage =
  | 'home'
  | 'feed'
  | 'assistant'
  | 'profile'

type QuickFilter =
  | 'today'
  | 'weekend'
  | 'free'

function getMaxFirstName() {
  try {
    const initData =
      getMaxInitData()

    if (!initData) {
      return null
    }

    const params =
      new URLSearchParams(
        initData,
      )

    const rawUser =
      params.get('user')

    if (!rawUser) {
      return null
    }

    const user =
      JSON.parse(rawUser) as {
        first_name?: unknown
      }

    return typeof user.first_name ===
      'string'
      ? user.first_name.trim() ||
          null
      : null
  } catch {
    return null
  }
}

function getMaxPhotoUrl() {
  try {
    const rawUser =
      new URLSearchParams(
        getMaxInitData(),
      ).get('user')

    if (!rawUser) {
      return null
    }

    const user =
      JSON.parse(rawUser) as {
        photo_url?: unknown
      }

    return typeof user.photo_url === 'string' &&
      /^https?:\/\//.test(user.photo_url)
      ? user.photo_url
      : null
  } catch {
    return null
  }
}

function ProfileAvatar() {
  const [failed, setFailed] =
    useState(false)

  const photo = getMaxPhotoUrl()

  return photo && !failed ? (
    <img
      src={photo}
      alt=""
      className="profile-avatar-photo"
      onError={() => setFailed(true)}
    />
  ) : (
    <UserRound size={31} />
  )
}

function eventCategoryName(
  event: ApiEvent,
) {
  const value =
    event as ApiEvent & {
      categories?: Array<{
        name?: string | null
        slug?: string | null
      }>
    }

  return (
    value.categories?.[0]?.name ??
    value.categories?.[0]?.slug ??
    '\u0421\u043e\u0431\u044b\u0442\u0438\u0435'
  )
}

function eventVenueName(
  event: ApiEvent,
) {
  const value =
    event as ApiEvent & {
      venue?: {
        name?: string | null
      } | null
    }

  return (
    value.venue?.name ??
    '\u041c\u043e\u0441\u043a\u0432\u0430'
  )
}

function eventPrice(
  event: ApiEvent,
) {
  const value =
    event as ApiEvent & {
      isFree?: boolean
      priceMin?: number | null
    }

  if (value.isFree) {
    return '\u0411\u0435\u0441\u043f\u043b\u0430\u0442\u043d\u043e'
  }

  if (
    typeof value.priceMin ===
      'number'
  ) {
    return `\u043e\u0442 ${value.priceMin} \u20bd`
  }

  return '\u0426\u0435\u043d\u0430 \u043d\u0430 \u0441\u0430\u0439\u0442\u0435'
}

function eventOccurrenceDates(
  event: ApiEvent,
) {
  const value =
    event as ApiEvent & {
      occurrences?: Array<{
        startsAt?: string | null
      }>
    }

  return (
    value.occurrences ??
    []
  )
    .map(
      (occurrence) =>
        occurrence.startsAt
          ? new Date(
              occurrence.startsAt,
            )
          : null,
    )
    .filter(
      (date): date is Date =>
        Boolean(
          date &&
            !Number.isNaN(
              date.getTime(),
            ),
        ),
    )
}

function matchesQuickFilter(
  event: ApiEvent,
  filter: QuickFilter,
) {
  if (filter === 'free') {
    return Boolean(
      (
        event as ApiEvent & {
          isFree?: boolean
        }
      ).isFree,
    )
  }

  const now =
    new Date()

  const occurrences =
    eventOccurrenceDates(event)

  if (filter === 'today') {
    return occurrences.some(
      (date) =>
        date.getFullYear() ===
          now.getFullYear() &&
        date.getMonth() ===
          now.getMonth() &&
        date.getDate() ===
          now.getDate(),
    )
  }

  const day =
    now.getDay()

  const daysUntilSaturday =
    (6 - day + 7) % 7

  const saturday =
    new Date(now)

  saturday.setHours(
    0,
    0,
    0,
    0,
  )

  saturday.setDate(
    now.getDate() +
      daysUntilSaturday,
  )

  const monday =
    new Date(saturday)

  monday.setDate(
    saturday.getDate() + 2,
  )

  return occurrences.some(
    (date) =>
      date >= saturday &&
      date < monday,
  )
}

function getStoredCity() {
  try {
    return (
      localStorage.getItem(
        'evently-city',
      ) ?? 'msk'
    )
  } catch {
    return 'msk'
  }
}


// Ключ карточки в ленте: в бесконечной ленте (#39) одно событие
// может встретиться в разных «кругах».
function feedKeyOf(event: ApiEvent) {
  return (
    (event as ApiEvent & { feedKey?: string }).feedKey ??
    event.id
  )
}

function HomePage({
  firstName,
  events,
  categories,
  onOpenFeed,
  onNearby,
  onQuickFilter,
  onCategory,
  onEvent,
  onAssistant,
}: {
  firstName: string | null
  events: ApiEvent[]
  categories: ApiCategory[]
  onOpenFeed: () => void
  onNearby: () => void
  onQuickFilter:
    (filter: QuickFilter) => void
  onCategory:
    (category: string) => void
  onEvent:
    (
      event: ApiEvent,
      position: number,
    ) => void
  onAssistant: () => void
}) {
  const recommendations =
    events.slice(0, 5)

  const moods = [
    {
      icon: '\ud83d\udd25',
      label: '\u0425\u043e\u0447\u0443 \u0434\u0432\u0438\u0436',
      category: 'party',
    },
    {
      icon: '\u2764\ufe0f',
      label: '\u041d\u0430 \u0441\u0432\u0438\u0434\u0430\u043d\u0438\u0435',
      category: 'exhibition',
    },
    {
      icon: '\ud83d\udc65',
      label: '\u0421 \u0434\u0440\u0443\u0437\u044c\u044f\u043c\u0438',
      category: 'games',
    },
    {
      icon: '\ud83c\udf19',
      label: '\u0421\u043f\u043e\u043a\u043e\u0439\u043d\u044b\u0439 \u0432\u0435\u0447\u0435\u0440',
      category: 'theatre',
    },
    {
      icon: '\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67',
      label: '\u0421 \u0434\u0435\u0442\u044c\u043c\u0438',
      category: 'family',
    },
  ]

  return (
    <main className="home-page">
      <div className="home-glow home-glow-one" />
      <div className="home-glow home-glow-two" />

      <div className="home-content">
        <header className="home-topbar">
          <div className="home-brand">
            Evently
          </div>

          <div className="home-city">
            <MapPin size={14} />

            <select
              className="home-city-select"
              defaultValue={
                getStoredCity()
              }
              onChange={(event) => {
                try {
                  localStorage.setItem(
                    'evently-city',
                    event.target.value,
                  )
                } catch {
                  // ignore storage errors
                }

                window.location.reload()
              }}
            >
              <option value="msk">
                {'\u041c\u043e\u0441\u043a\u0432\u0430'}
              </option>

              <option value="spb">
                {'\u0421\u0430\u043d\u043a\u0442-\u041f\u0435\u0442\u0435\u0440\u0431\u0443\u0440\u0433'}
              </option>

              <option value="nsk">
                {'\u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a'}
              </option>

              <option value="ekb">
                {'\u0415\u043a\u0430\u0442\u0435\u0440\u0438\u043d\u0431\u0443\u0440\u0433'}
              </option>

              <option value="kzn">
                {'\u041a\u0430\u0437\u0430\u043d\u044c'}
              </option>

              <option value="nnv">
                {'\u041d\u0438\u0436\u043d\u0438\u0439 \u041d\u043e\u0432\u0433\u043e\u0440\u043e\u0434'}
              </option>

              <option value="krd">
                {'\u041a\u0440\u0430\u0441\u043d\u043e\u0434\u0430\u0440'}
              </option>

              <option value="perm">
                {'\u041f\u0435\u0440\u043c\u044c'}
              </option>

              <option value="omsk">
                {'\u041e\u043c\u0441\u043a'}
              </option>

              <option value="chelyabinsk">
                {'\u0427\u0435\u043b\u044f\u0431\u0438\u043d\u0441\u043a'}
              </option>

              <option value="krasnoyarsk">
                {'\u041a\u0440\u0430\u0441\u043d\u043e\u044f\u0440\u0441\u043a'}
              </option>

              <option value="ufa">
                {'\u0423\u0444\u0430'}
              </option>

              <option value="smr">
                {'\u0421\u0430\u043c\u0430\u0440\u0430'}
              </option>

              <option value="rostov">
                {'\u0420\u043e\u0441\u0442\u043e\u0432-\u043d\u0430-\u0414\u043e\u043d\u0443'}
              </option>

              <option value="voronezh">
                {'\u0412\u043e\u0440\u043e\u043d\u0435\u0436'}
              </option>

              <option value="volgograd">
                {'\u0412\u043e\u043b\u0433\u043e\u0433\u0440\u0430\u0434'}
              </option>
            </select>

            <ChevronDown size={13} />
          </div>
        </header>

        <section className="home-hero">
          <div className="home-eyebrow">
            {'\u0422\u0432\u043e\u0439 \u0433\u0438\u0434 \u043f\u043e \u0433\u043e\u0440\u043e\u0434\u0443'}
          </div>

          <h1>
            {firstName
              ? `${firstName}, \u043a\u0443\u0434\u0430 \u0441\u0435\u0433\u043e\u0434\u043d\u044f?`
              : '\u041a\u0443\u0434\u0430 \u0441\u0435\u0433\u043e\u0434\u043d\u044f?'}
          </h1>

          <button
            type="button"
            className="ai-entry"
            onClick={onAssistant}
          >
            <span className="ai-entry-icon">
              <Sparkles size={20} />
            </span>

            <span className="ai-entry-copy">
              <strong>
                {'\u0421\u043f\u0440\u043e\u0441\u0438 Evently AI'}
              </strong>

              <small>
                {'\u041a\u0443\u0434\u0430 \u0441\u0445\u043e\u0434\u0438\u0442\u044c \u0432\u0435\u0447\u0435\u0440\u043e\u043c?'}
              </small>
            </span>

            <ArrowRight size={19} />
          </button>
        </section>

        <section className="quick-grid">
          <button
            type="button"
            className="quick-card"
            onClick={() =>
              onQuickFilter('today')
            }
          >
            <span>
              <CalendarDays size={19} />
            </span>
            {'\u0421\u0435\u0433\u043e\u0434\u043d\u044f'}
          </button>

          <button
            type="button"
            className="quick-card"
            onClick={() =>
              onQuickFilter('weekend')
            }
          >
            <span>
              <PartyPopper size={19} />
            </span>
            {'\u0412\u044b\u0445\u043e\u0434\u043d\u044b\u0435'}
          </button>

          <button
            type="button"
            className="quick-card"
            onClick={onNearby}
          >
            <span>
              <MapPin size={19} />
            </span>
            {'\u0420\u044f\u0434\u043e\u043c'}
          </button>

          <button
            type="button"
            className="quick-card"
            onClick={() =>
              onQuickFilter('free')
            }
          >
            <span>
              <Ticket size={19} />
            </span>
            {'\u0411\u0435\u0441\u043f\u043b\u0430\u0442\u043d\u043e'}
          </button>
        </section>

        <section className="home-section">
          <div className="home-section-head">
            <div>
              <span>
                {'\u041f\u0435\u0440\u0441\u043e\u043d\u0430\u043b\u044c\u043d\u0430\u044f \u043f\u043e\u0434\u0431\u043e\u0440\u043a\u0430'}
              </span>
              <h2>
                {'\u0414\u043b\u044f \u0442\u0435\u0431\u044f \u0441\u0435\u0433\u043e\u0434\u043d\u044f'}
              </h2>
            </div>

            <button
              type="button"
              className="home-link-button"
              onClick={onOpenFeed}
            >
              {'\u0412\u0441\u0435'}
              <ArrowRight size={15} />
            </button>
          </div>

          <div className="home-event-row">
            {recommendations.map(
              (event, index) => {
                return (
                  <button
                    type="button"
                    className="home-event-card"
                    key={event.id}
                    onClick={() =>
                      onEvent(
                        event,
                        index,
                      )
                    }
                  >
                    <div className="home-event-image-wrap">
                      <EventCover
                        event={event}
                        className="home-event-image"
                      />

                      <div className="home-event-price">
                        {eventPrice(
                          event,
                        )}
                      </div>
                    </div>

                    <div className="home-event-copy">
                      <span>
                        {eventCategoryName(
                          event,
                        )}
                      </span>

                      <strong>
                        {event.title}
                      </strong>

                      <small>
                        <MapPin
                          size={12}
                        />
                        {eventVenueName(
                          event,
                        )}
                      </small>
                    </div>
                  </button>
                )
              },
            )}
          </div>
        </section>

        <section className="home-section">
          <div className="home-section-head">
            <div>
              <span>
                {'\u0411\u044b\u0441\u0442\u0440\u044b\u0439 \u0432\u044b\u0431\u043e\u0440'}
              </span>
              <h2>
                {'\u041f\u043e \u043d\u0430\u0441\u0442\u0440\u043e\u0435\u043d\u0438\u044e'}
              </h2>
            </div>
          </div>

          <div className="mood-grid">
            {moods.map(
              (mood) => (
                <button
                  type="button"
                  className="mood-card"
                  key={mood.label}
                  onClick={() =>
                    onCategory(
                      mood.category,
                    )
                  }
                >
                  <span>
                    {mood.icon}
                  </span>

                  <strong>
                    {mood.label}
                  </strong>
                </button>
              ),
            )}
          </div>
        </section>

        <section className="home-section">
          <div className="home-section-head">
            <div>
              <span>
                {'\u0418\u0441\u0441\u043b\u0435\u0434\u0443\u0439'}
              </span>
              <h2>
                {'\u041a\u0430\u0442\u0435\u0433\u043e\u0440\u0438\u0438'}
              </h2>
            </div>
          </div>

          <div className="home-category-grid">
            {categories.map(
              (category) => (
                <button
                  type="button"
                  className="home-category-card"
                  key={category.slug}
                  onClick={() =>
                    onCategory(
                      category.slug,
                    )
                  }
                >
                  <span>
                    {category.icon ??
                      '\u2728'}
                  </span>

                  <strong>
                    {category.name}
                  </strong>
                </button>
              ),
            )}
          </div>
        </section>
      </div>
    </main>
  )
}

type AssistantUiMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  events?: AiEventSuggestion[]
  places?: AiFoodPlace[]
}

// Вопрос про еду после подборки событий — отвечаем про первое из них (#40).
const FOOD_QUESTION_RE =
  /(поесть|поужинать|пообедать|перекус|покушать|кафе|ресторан|\bбар|кофе|еда\b|еду\b|поблизости.*(есть|кушать))/i

export type PendingFoodRequest = {
  id: string
  title: string
  nonce: number
}

const AI_STORAGE_KEY =
  'evently_ai_messages_v1'

function getInitialAiMessages(): AssistantUiMessage[] {
  try {
    const saved =
      sessionStorage.getItem(
        AI_STORAGE_KEY,
      )

    if (saved) {
      const parsed =
        JSON.parse(saved) as
          AssistantUiMessage[]

      if (
        Array.isArray(parsed) &&
        parsed.length > 0
      ) {
        return parsed
      }
    }
  } catch {
    // Если storage недоступен, просто начинаем новый чат.
  }

  return [
    {
      id: 'welcome',
      role: 'assistant',
      content:
        '\u041f\u0440\u0438\u0432\u0435\u0442! \u042f Evently AI. \u0420\u0430\u0441\u0441\u043a\u0430\u0436\u0438, \u043a\u0443\u0434\u0430 \u0445\u043e\u0447\u0435\u0448\u044c \u0441\u0445\u043e\u0434\u0438\u0442\u044c, \u0441 \u043a\u0435\u043c \u0438 \u043a\u0430\u043a\u043e\u0439 \u0431\u044e\u0434\u0436\u0435\u0442 \u2014 \u043f\u043e\u0434\u0431\u0435\u0440\u0443 \u0432\u0430\u0440\u0438\u0430\u043d\u0442\u044b \u0438\u0437 Evently.',
    },
  ]
}

function formatAiEventDate(
  value: string | null,
) {
  if (!value) {
    return null
  }

  const date = new Date(value)

  if (
    Number.isNaN(
      date.getTime(),
    )
  ) {
    return null
  }

  return new Intl.DateTimeFormat(
    'ru-RU',
    {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    },
  ).format(date)
}

function AiFoodPlaces({
  places,
}: {
  places: AiFoodPlace[]
}) {
  const attributions = [
    ...new Set(
      places
        .map(
          (place) =>
            place.attribution ??
            (place.source === 'osm' ? '© участники OpenStreetMap' : null),
        )
        .filter((text): text is string => Boolean(text)),
    ),
  ]

  return (
    <section className="nearby-food ai-food-list">
      <ul>
        {places.map((place) => (
          <li key={place.id}>
            <button
              type="button"
              onClick={() => openExternal(placeMapUrl(place))}
            >
              <PlaceThumb imageUrl={place.imageUrl} kind={place.kind} />

              <span className="nearby-food-text">
                <strong>{place.name}</strong>

                <small>
                  {[placeKindLabel(place.kind), placeCuisine(place.cuisine)]
                    .filter(Boolean)
                    .join(' · ')}
                </small>

                <small className="nearby-food-distance">
                  {placeDistance(place.distanceM)}
                </small>

                {place.reason && (
                  <small className="ai-food-reason">{place.reason}</small>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {attributions.length > 0 && (
        <p className="nearby-food-attribution">{attributions.join(' · ')}</p>
      )}
    </section>
  )
}

function AssistantPage({
  pendingFood,
  onPendingFoodHandled,
}: {
  pendingFood?: PendingFoodRequest | null
  onPendingFoodHandled?: () => void
}) {
  const suggestions = [
    '\u041a\u0443\u0434\u0430 \u0441\u0445\u043e\u0434\u0438\u0442\u044c \u0441\u0435\u0433\u043e\u0434\u043d\u044f \u0432\u0435\u0447\u0435\u0440\u043e\u043c?',
    '\u041f\u043e\u0434\u0431\u0435\u0440\u0438 \u0438\u0434\u0435\u044e \u0434\u043b\u044f \u0441\u0432\u0438\u0434\u0430\u043d\u0438\u044f',
    '\u0425\u043e\u0447\u0443 \u0447\u0442\u043e-\u043d\u0438\u0431\u0443\u0434\u044c \u0431\u0435\u0441\u043f\u043b\u0430\u0442\u043d\u043e\u0435',
  ]

  const [messages, setMessages] =
    useState<AssistantUiMessage[]>(
      getInitialAiMessages,
    )

  const [input, setInput] =
    useState('')

  const [sending, setSending] =
    useState(false)

  const [error, setError] =
    useState<string | null>(null)

  const bottomRef =
    useRef<HTMLDivElement | null>(
      null,
    )

  useEffect(() => {
    try {
      sessionStorage.setItem(
        AI_STORAGE_KEY,
        JSON.stringify(messages),
      )
    } catch {
      // Чат продолжит работать и без storage.
    }

    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'end',
      })
    })
  }, [messages, sending])

  async function askFood(
    event: { id: string; title: string },
    questionText?: string,
  ) {
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: 'user',
        content:
          questionText ?? `Где поесть рядом с «${event.title}»?`,
      },
    ])

    setInput('')
    setSending(true)
    setError(null)

    try {
      const result = await askFoodNearEvent(event.id)

      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: result.answer,
          places: result.places,
        },
      ])
    } catch (requestError) {
      console.error('Evently AI food failed:', requestError)

      setError('Не удалось подобрать места рядом. Попробуй ещё раз.')
    } finally {
      setSending(false)
    }
  }

  // Пришли из «Подробнее» с кнопкой «Совет ИИ».
  const handledFoodRef = useRef<number | null>(null)

  useEffect(() => {
    if (!pendingFood || handledFoodRef.current === pendingFood.nonce) {
      return
    }

    handledFoodRef.current = pendingFood.nonce
    onPendingFoodHandled?.()
    void askFood(pendingFood)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFood])

  async function submitMessage(
    rawText?: string,
  ) {
    if (sending) {
      return
    }

    const text =
      (rawText ?? input).trim()

    if (!text) {
      return
    }

    // «А где поужинать после?» — про первое событие из последней подборки.
    if (FOOD_QUESTION_RE.test(text)) {
      const lastAssistant = [...messages]
        .reverse()
        .find(
          (message) =>
            message.role === 'assistant' &&
            (message.events?.length ?? 0) > 0,
        )

      const target = lastAssistant?.events?.[0]

      if (target) {
        await askFood(target, text)
        return
      }
    }

    const history =
      messages
        .filter(
          (message) =>
            message.id !==
            'welcome',
        )
        .map((message) => ({
          role: message.role,
          content: message.content,

          /*
           * Пользователь этого не видит,
           * но backend теперь знает,
           * какие именно карточки были
           * показаны в прошлом ответе.
           */
          eventIds:
            message.events?.map(
              (event) =>
                event.id,
            ),
        }))

    const userMessage:
      AssistantUiMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
      }

    setMessages((current) => [
      ...current,
      userMessage,
    ])

    setInput('')
    setSending(true)
    setError(null)

    try {
      const result =
        await sendAiMessage(
          text,
          history,
        )

      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: result.answer,
          events: result.events,
        },
      ])
    } catch (requestError) {
      console.error(
        'Evently AI failed:',
        requestError,
      )

      setError(
        '\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u043f\u043e\u043b\u0443\u0447\u0438\u0442\u044c \u043e\u0442\u0432\u0435\u0442. \u041f\u043e\u043f\u0440\u043e\u0431\u0443\u0439 \u0435\u0449\u0451 \u0440\u0430\u0437.',
      )
    } finally {
      setSending(false)
    }
  }

  return (
    <main className="assistant-page">
      <header className="assistant-header">
        <div className="assistant-logo">
          <Bot size={20} />
        </div>

        <div>
          <strong>
            Evently AI
          </strong>
          <span>
            {'\u041f\u043e\u043c\u043e\u0449\u043d\u0438\u043a \u043f\u043e \u0434\u043e\u0441\u0443\u0433\u0443'}
          </span>
        </div>

        <div className="assistant-online">
          <span />
          AI
        </div>
      </header>

      <div className="assistant-body ai-chat-mode">
        <div className="ai-chat-intro">
          <div className="assistant-orb">
            <Sparkles size={23} />
          </div>

          <div>
            <strong>
              {'\u041f\u043e\u0434\u0431\u0435\u0440\u0443 \u043c\u0435\u0440\u043e\u043f\u0440\u0438\u044f\u0442\u0438\u0435'}
            </strong>
            <span>
              {'\u0418\u0437 \u0442\u043e\u0433\u043e, \u0447\u0442\u043e \u0443\u0436\u0435 \u0435\u0441\u0442\u044c \u0432 Evently'}
            </span>
          </div>
        </div>

        {messages.map(
          (message) => (
            <div
              className={
                message.role ===
                'user'
                  ? 'ai-message-row user'
                  : 'ai-message-row assistant'
              }
              key={message.id}
            >
              {message.role ===
                'assistant' && (
                <div className="ai-message-avatar">
                  <Sparkles size={14} />
                </div>
              )}

              <div className="ai-message-stack">
                <div className="ai-message-bubble">
                  {message.content}
                </div>

                {message.events &&
                  message.events.length >
                    0 && (
                  <div className="ai-event-list">
                    {message.events.map(
                      (event) => {
                        const eventDate =
                          formatAiEventDate(
                            event.startsAt,
                          )

                        return (
                          <div
                            className="ai-event-item"
                            key={event.id}
                          >
                          <button
                            type="button"
                            className="ai-event-card"
                            disabled={!event.url}
                            onClick={() => {
                              if (
                                event.url
                              ) {
                                window.open(
                                  event.url,
                                  '_blank',
                                  'noopener,noreferrer',
                                )
                              }
                            }}
                          >
                            {event.imageUrl ? (
                              <img
                                src={event.imageUrl}
                                alt=""
                              />
                            ) : (
                              <div className="ai-event-placeholder">
                                <Ticket size={18} />
                              </div>
                            )}

                            <div className="ai-event-copy">
                              <strong>
                                {event.title}
                              </strong>

                              <span>
                                {[
                                  eventDate,
                                  event.venue,
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </span>

                              <small>
                                {event.price}
                              </small>
                            </div>

                            <ArrowRight size={16} />
                          </button>

                          {event.venue && (
                            <button
                              type="button"
                              className="ai-food-button"
                              disabled={sending}
                              onClick={() => void askFood(event)}
                            >
                              🍽 Где поесть рядом
                            </button>
                          )}
                          </div>
                        )
                      },
                    )}
                  </div>
                )}

                {message.places &&
                  message.places.length > 0 && (
                  <AiFoodPlaces places={message.places} />
                )}
              </div>
            </div>
          ),
        )}

        {sending && (
          <div className="ai-message-row assistant">
            <div className="ai-message-avatar">
              <Sparkles size={14} />
            </div>

            <div className="ai-typing">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}

        {error && (
          <div className="ai-chat-error">
            {error}
          </div>
        )}

        {messages.length === 1 && (
          <div className="assistant-suggestions">
            {suggestions.map(
              (suggestion) => (
                <button
                  type="button"
                  key={suggestion}
                  disabled={sending}
                  onClick={() =>
                    void submitMessage(
                      suggestion,
                    )
                  }
                >
                  {suggestion}
                </button>
              ),
            )}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <div className="assistant-composer">
        <input
          type="text"
          value={input}
          disabled={sending}
          placeholder={
            '\u0421\u043f\u0440\u043e\u0441\u0438 \u043e \u043c\u0435\u0441\u0442\u0430\u0445 \u0438 \u0441\u043e\u0431\u044b\u0442\u0438\u044f\u0445...'
          }
          onChange={(event) =>
            setInput(
              event.target.value,
            )
          }
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey
            ) {
              event.preventDefault()
              void submitMessage()
            }
          }}
        />

        <button
          type="button"
          aria-label={
            '\u041e\u0442\u043f\u0440\u0430\u0432\u0438\u0442\u044c'
          }
          disabled={
            sending ||
            !input.trim()
          }
          onClick={() =>
            void submitMessage()
          }
        >
          <Send size={19} />
        </button>
      </div>
    </main>
  )
}

function formatSavedDate(
  event: ApiEvent,
) {
  if (isNowShowing(event)) {
    return NOW_SHOWING_LABEL
  }

  const now = Date.now()

  const dates =
    eventOccurrenceDates(event)

  const next =
    dates.find(
      (date) =>
        date.getTime() >= now,
    ) ?? dates[0]

  if (!next) {
    return null
  }

  return next.toLocaleString(
    'ru-RU',
    {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    },
  )
}

function isPastEvent(
  event: ApiEvent,
) {
  const dates =
    eventOccurrenceDates(event)

  // Без расписания (постоянные выставки) — не прошедшее.
  return (
    dates.length > 0 &&
    dates.every(
      (date) =>
        date.getTime() < Date.now(),
    )
  )
}

type ProfileCollection =
  | 'saved'
  | 'going'

function ProfilePage({
  firstName,
  preferredCategories,
  categories,
  favorites,
  going,
  onOpenCollection,
  onEditInterests,
  onAvatarDebug,
}: {
  onEditInterests: () => void
  onAvatarDebug: () => void
  firstName: string | null
  preferredCategories: string[]
  categories: ApiCategory[]
  favorites: ApiEvent[]
  going: ApiEvent[]
  onOpenCollection: (
    collection: ProfileCollection,
    items: ApiEvent[],
    startIndex: number,
  ) => void
}) {
  const selected =
    categories.filter(
      (category) =>
        preferredCategories.includes(
          category.slug,
        ),
    )

  const [tab, setTab] =
    useState<ProfileCollection>('saved')

  const tapsRef = useRef<number[]>([])

  const source =
    tab === 'saved'
      ? favorites
      : going

  // Предстоящие сверху, прошедшие — в конце.
  const items = [
    ...source.filter(
      (event) => !isPastEvent(event),
    ),
    ...source.filter(isPastEvent),
  ]

  return (
    <main className="profile-page">
      <div
        className="profile-avatar"
        onClick={() => {
          const now = Date.now()

          tapsRef.current = [
            ...tapsRef.current.filter(
              (time) => now - time < 2000,
            ),
            now,
          ]

          if (tapsRef.current.length >= 5) {
            tapsRef.current = []
            onAvatarDebug()
          }
        }}
      >
        <ProfileAvatar />
      </div>

      <h1>
        {firstName ??
          '\u0412\u0430\u0448 \u043f\u0440\u043e\u0444\u0438\u043b\u044c'}
      </h1>

      <p>
        {'\u041f\u0440\u043e\u0444\u0438\u043b\u044c Evently \u043f\u0440\u0438\u0432\u044f\u0437\u0430\u043d \u043a MAX'}
      </p>

      <section className="profile-card">
        <div className="profile-card-head">
          <span className="profile-card-label">
            {'\u0412\u0430\u0448\u0438 \u0438\u043d\u0442\u0435\u0440\u0435\u0441\u044b'}
          </span>

          <button
            type="button"
            className="profile-card-edit"
            onClick={onEditInterests}
          >
            Изменить
          </button>
        </div>

        <div className="profile-interest-list">
          {selected.length > 0 ? (
            selected.map(
              (category) => (
                <span
                  key={category.slug}
                >
                  {category.icon}
                  {' '}
                  {category.name}
                </span>
              ),
            )
          ) : (
            <span>
              {'\u0418\u043d\u0442\u0435\u0440\u0435\u0441\u044b \u0435\u0449\u0451 \u043d\u0435 \u0432\u044b\u0431\u0440\u0430\u043d\u044b'}
            </span>
          )}
        </div>
      </section>

      <div className="profile-tabs">
        <button
          type="button"
          className={
            tab === 'saved'
              ? 'profile-tab active'
              : 'profile-tab'
          }
          onClick={() => setTab('saved')}
        >
          Сохранённое
          {favorites.length > 0 && (
            <span>{favorites.length}</span>
          )}
        </button>

        <button
          type="button"
          className={
            tab === 'going'
              ? 'profile-tab active'
              : 'profile-tab'
          }
          onClick={() => setTab('going')}
        >
          Пойду
          {going.length > 0 && (
            <span>{going.length}</span>
          )}
        </button>
      </div>

      {items.length === 0 ? (
        <p className="profile-grid-empty">
          {tab === 'saved'
            ? 'Нажмите ♥ на событии в ленте — оно появится здесь.'
            : 'Отмечайте «Пойду» на событиях — они появятся здесь, а бот напомнит о них накануне.'}
        </p>
      ) : (
        <div className="profile-grid">
          {items.map((event, index) => {
            const date =
              formatSavedDate(event)

            return (
              <button
                type="button"
                key={event.id}
                className={
                  isPastEvent(event)
                    ? 'profile-tile past'
                    : 'profile-tile'
                }
                onClick={() =>
                  onOpenCollection(
                    tab,
                    items,
                    index,
                  )
                }
              >
                <EventCover
                  event={event}
                  className="profile-tile-image"
                />

                <div className="profile-tile-copy">
                  {date && (
                    <small>{date}</small>
                  )}

                  <strong>
                    {event.title}
                  </strong>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </main>
  )
}

function BottomNav({
  page,
  onChange,
}: {
  page: AppPage
  onChange:
    (page: AppPage) => void
}) {
  const items = [
    {
      id: 'home' as const,
      label: '\u0413\u043b\u0430\u0432\u043d\u0430\u044f',
      icon: Home,
    },
    {
      id: 'feed' as const,
      label: '\u041b\u0435\u043d\u0442\u0430',
      icon: Play,
    },
    {
      id: 'assistant' as const,
      label: '\u041f\u043e\u043c\u043e\u0449\u043d\u0438\u043a',
      icon: Sparkles,
    },
    {
      id: 'profile' as const,
      label: '\u041f\u0440\u043e\u0444\u0438\u043b\u044c',
      icon: UserRound,
    },
  ]

  return (
    <nav className="bottom-nav">
      {items.map((item) => {
        const Icon =
          item.icon

        const active =
          page === item.id

        return (
          <button
            type="button"
            key={item.id}
            className={
              active
                ? 'bottom-nav-item active'
                : 'bottom-nav-item'
            }
            aria-label={item.label}
            title={item.label}
            onClick={() =>
              onChange(item.id)
            }
          >
            <span className="bottom-nav-icon">
              <Icon size={22} />
            </span>
          </button>
        )
      })}
    </nav>
  )
}


function App() {
  const [
    activePage,
    setActivePage,
  ] = useState<AppPage>('home')

  const [events, setEvents] =
    useState<ApiEvent[]>([])

  const [categories, setCategories] =
    useState<ApiCategory[]>([])
  const [
    preferredCategories,
    setPreferredCategories,
  ] = useState<string[]>([])

  const [
    activeCategory,
    setActiveCategory,
  ] = useState<string | null>(
    null,
  )

  const [
    feedLoading,
    setFeedLoading,
  ] = useState(false)

  const [
    categoriesOpen,
    setCategoriesOpen,
  ] = useState(false)

  const [
    nearbyActive,
    setNearbyActive,
  ] = useState(false)

  const [
    quickFilter,
    setQuickFilter,
  ] = useState<QuickFilter | null>(
    null,
  )

  const [
    locationError,
    setLocationError,
  ] = useState<string | null>(null)

  const [
    onboardingCompleted,
    setOnboardingCompleted,
  ] = useState<boolean | null>(null)

  // ----- Бесконечная лента -----
  // Координаты режима «Рядом» — нужны
  // для подгрузки следующих страниц.
  const nearbyCoordsRef =
    useRef<{
      latitude: number
      longitude: number
    } | null>(null)

  // id всех событий, полученных в текущей
  // ленте (включая отброшенные быстрым
  // фильтром) — сервер их больше не вернёт.
  const feedSeenIdsRef =
    useRef<Set<string>>(new Set())

  const loadingMoreRef =
    useRef(false)

  const [loadingMore, setLoadingMore] =
    useState(false)

  const [feedExhausted, setFeedExhausted] =
    useState(false)

  const [loading, setLoading] =
    useState(true)

  const [liked, setLiked] =
    useState<
      Record<string, boolean>
    >({})

  // Сохранённые события (с сервера).
  const [favorites, setFavorites] =
    useState<ApiEvent[]>([])

  // «Пойду» (с сервера).
  const [going, setGoingList] =
    useState<ApiEvent[]>([])

  const goingIds = new Set(
    going.map((event) => event.id),
  )

  useEffect(() => {
    getGoing()
      .then(setGoingList)
      .catch(() => {
        // Без сервера кнопка работает локально.
      })
  }, [])

  // «Не интересно»: карточка сразу пропадает,
  // а сигнал HIDE уходит на сервер через 5 с —
  // пока висит плашка, можно вернуть без следов.
  const [hidingEventId, setHidingEventId] =
    useState<string | null>(null)

  const [hideToast, setHideToast] =
    useState<{
      event: ApiEvent
      index: number
    } | null>(null)

  // Скрытые за эту сессию: сервер узнает о них
  // только через 5 с, а лента может перезагрузиться
  // раньше — не даём им вернуться.
  const hiddenIdsRef =
    useRef<Set<string>>(new Set())

  const pendingHideRef =
    useRef<{
      event: ApiEvent
      index: number
      timer: number
    } | null>(null)

  function commitPendingHide() {
    const pending =
      pendingHideRef.current

    if (!pending) {
      return
    }

    window.clearTimeout(pending.timer)
    pendingHideRef.current = null

    void sendInteraction(
      pending.event.id,
      'HIDE',
      {
        metadata: {
          position: pending.index,
          feed: 'for-you',
        },
      },
    )
  }

  function hideEvent(
    event: ApiEvent,
    index: number,
  ) {
    if (hidingEventId) {
      return
    }

    // Прошлое скрытие больше не отменить.
    commitPendingHide()

    setHidingEventId(event.id)
    hiddenIdsRef.current.add(event.id)

    window.setTimeout(() => {
      setEvents((current) =>
        current.filter(
          (item) =>
            item.id !== event.id,
        ),
      )

      setHidingEventId(null)

      // Скрыли карточку у конца ленты —
      // сразу догружаем, иначе прокрутки нет.
      if (events.length - index <= 4) {
        void loadMoreEvents()
      }
    }, 260)

    pendingHideRef.current = {
      event,
      index,
      timer: window.setTimeout(() => {
        commitPendingHide()
        setHideToast(null)
      }, 5000),
    }

    setHideToast({ event, index })
  }

  function undoHide() {
    const pending =
      pendingHideRef.current

    if (!pending) {
      return
    }

    window.clearTimeout(pending.timer)
    pendingHideRef.current = null
    setHideToast(null)
    hiddenIdsRef.current.delete(
      pending.event.id,
    )

    setEvents((current) => {
      if (
        current.some(
          (item) =>
            item.id === pending.event.id,
        )
      ) {
        return current
      }

      const next = [...current]

      next.splice(
        Math.min(
          pending.index,
          next.length,
        ),
        0,
        pending.event,
      )

      return next
    })
  }

  // Любая загрузка ленты (категория, фильтр,
  // дозагрузка) — вычищаем скрытые.
  useEffect(() => {
    if (
      events.some((event) =>
        hiddenIdsRef.current.has(
          event.id,
        ),
      )
    ) {
      setEvents((current) =>
        current.filter(
          (event) =>
            !hiddenIdsRef.current.has(
              event.id,
            ),
        ),
      )
    }
  }, [events])

  // Закрыли приложение, пока висит плашка —
  // скрытие засчитываем.
  useEffect(() => {
    const flush = () => {
      if (
        document.visibilityState ===
        'hidden'
      ) {
        commitPendingHide()
      }
    }

    document.addEventListener(
      'visibilitychange',
      flush,
    )

    return () =>
      document.removeEventListener(
        'visibilitychange',
        flush,
      )
  }, [])

  function toggleGoing(
    event: ApiEvent,
    willGo: boolean,
  ) {
    // Открыто приглашение на это событие —
    // «Пойду» засчитываем как «Я с тобой».
    if (
      willGo &&
      inviteBanner?.event.id === event.id
    ) {
      void acceptInviteBanner()
      return
    }

    if (willGo) {
      offerInvite(event)
    } else if (
      goingToast?.id === event.id
    ) {
      setGoingToast(null)
    }

    const apply = (value: boolean) =>
      setGoingList((current) =>
        value
          ? [
              event,
              ...current.filter(
                (item) =>
                  item.id !== event.id,
              ),
            ]
          : current.filter(
              (item) =>
                item.id !== event.id,
            ),
      )

    apply(willGo)

    // Сигнал для рекомендаций пишет сервер.
    void setGoing(
      event.id,
      willGo,
    ).catch(() => {
      // Не удалось — откатываем.
      apply(!willGo)
    })
  }

  // Полноэкранная лента подборки из профиля.
  // items — снимок на момент открытия: снятый
  // лайк не выкидывает карточку из-под пальца.
  const [collectionView, setCollectionView] =
    useState<{
      collection: ProfileCollection
      items: ApiEvent[]
      startIndex: number
    } | null>(null)

  const collectionFeedRef =
    useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!collectionView) {
      return
    }

    requestAnimationFrame(() => {
      const element =
        collectionFeedRef.current

      if (element) {
        element.scrollTo({
          top:
            collectionView.startIndex *
            element.clientHeight,
        })
      }
    })
  }, [collectionView])

  useEffect(() => {
    getFavorites()
      .then((items) => {
        setFavorites(items)

        setLiked((current) => ({
          ...Object.fromEntries(
            items.map((event) => [
              event.id,
              true,
            ]),
          ),
          ...current,
        }))
      })
      .catch(() => {
        // Без сервера лайки работают локально.
      })
  }, [])

  // Двойной тап по карточке: только ставит лайк.
  function likeByDoubleTap(
    event: ApiEvent,
    position: number,
    feed: string,
  ) {
    if (liked[event.id]) {
      return
    }

    toggleFavorite(event, true)

    void sendInteraction(
      event.id,
      'FAVORITE',
      {
        metadata: {
          position,
          feed,
          via: 'double_tap',
        },
      },
    )
  }

  function toggleFavorite(
    event: ApiEvent,
    willBeSaved: boolean,
  ) {
    setLiked((current) => ({
      ...current,
      [event.id]: willBeSaved,
    }))

    setFavorites((current) =>
      willBeSaved
        ? [
            event,
            ...current.filter(
              (item) =>
                item.id !== event.id,
            ),
          ]
        : current.filter(
            (item) =>
              item.id !== event.id,
          ),
    )

    void setFavorite(
      event.id,
      willBeSaved,
    ).catch(() => {
      // Не удалось сохранить — откатываем.
      setLiked((current) => ({
        ...current,
        [event.id]: !willBeSaved,
      }))

      setFavorites((current) =>
        willBeSaved
          ? current.filter(
              (item) =>
                item.id !== event.id,
            )
          : [event, ...current],
      )
    })
  }

  const [comments, setComments] =
    useState<
      Record<string, ApiComment[]>
    >({})

  const [
    commentsEvent,
    setCommentsEvent,
  ] = useState<ApiEvent | null>(
    null,
  )

  const [
    commentText,
    setCommentText,
  ] = useState('')

  const [
    commentsLoading,
    setCommentsLoading,
  ] = useState(false)

  const [
    commentSending,
    setCommentSending,
  ] = useState(false)

  const [
    commentError,
    setCommentError,
  ] = useState<string | null>(
    null,
  )

  const [pendingFood, setPendingFood] =
    useState<PendingFoodRequest | null>(null)

  const [
    detailsEvent,
    setDetailsEvent,
  ] = useState<{
    event: ApiEvent
    position: number
  } | null>(null)

  // Стартовая загрузка — строго один раз. В режиме разработки
  // (vite dev, StrictMode) React запускает эффекты дважды:
  // вторая загрузка затирала ленту с событием из ссылки.
  const initStartedRef = useRef(false)

  useEffect(() => {
    if (initStartedRef.current) {
      return
    }

    initStartedRef.current = true

    async function initialize() {
      try {
        const [
          profile,
          categoryItems,
        ] = await Promise.all([
          getProfileInterests(),
          getCategories(),
        ])

        setPreferredCategories(
          profile.categories.map(
            (category) =>
              category.slug,
          ),
        )

        setCategories(
          categoryItems,
        )

        setOnboardingCompleted(
          profile.onboardingCompleted,
        )

        if (
          profile.onboardingCompleted
        ) {
          const feed =
            await getEvents(20)

          setEvents(
            await withSharedEvent(
              feed.items,
            ),
          )
        }
      } finally {
        setLoading(false)
      }
    }

    void initialize()
  }, [])

  // Короткое сообщение внизу экрана
  // («Ссылка скопирована» и т. п.).
  const [flash, setFlash] =
    useState<string | null>(null)

  const flashTimerRef = useRef(0)

  function showFlash(
    message: string,
    durationMs = 2500,
  ) {
    window.clearTimeout(
      flashTimerRef.current,
    )

    setFlash(message)

    flashTimerRef.current =
      window.setTimeout(
        () => setFlash(null),
        durationMs,
      )
  }

  // ============================================================
  // Ссылки «Поделиться»: https://max.ru/<бот>?startapp=event_<id>
  //
  // Холодный запуск — событие ставим первой карточкой
  // стартовой ленты (withSharedEvent).
  // Приложение уже открыто — MAX его не перезапускает,
  // поэтому следим за данными запуска (возврат на экран,
  // смена hash, раз в 1.5 с) и открываем событие сразу.
  // ============================================================
  const startLinkRef =
    useRef<StartLink | null>(
      getStartLink(),
    )

  // Запуски, которые уже обработаны (в т. ч. стартовый).
  const handledLaunchesRef = useRef(
    new Set(
      getLaunches().map(
        (launch) => launch.key,
      ),
    ),
  )

  const lastLaunchCheckRef =
    useRef('start')

  // Плашка «X зовёт тебя пойти» (открыли приглашение).
  const [inviteBanner, setInviteBanner] =
    useState<{
      code: string
      event: ApiEvent
      inviterName: string
    } | null>(null)

  const [inviteAccepting, setInviteAccepting] =
    useState(false)

  // Событие (и приглашение) по ссылке.
  async function resolveLink(
    link: StartLink,
  ): Promise<ApiEvent | null> {
    if (link.inviteCode) {
      try {
        const invite = await getInvite(
          link.inviteCode,
          link.eventId,
        )

        if (invite) {
          hiddenIdsRef.current.delete(
            link.eventId,
          )

          if (
            invite.isOwn ||
            invite.acceptedThisInvite
          ) {
            setInviteBanner(null)

            if (invite.acceptedThisInvite) {
              showFlash(
                'Вы уже идёте вместе 🙌',
              )
            }
          } else {
            setInviteBanner({
              code: link.inviteCode,
              event: invite.event,
              inviterName:
                invite.inviter.name ??
                'Друг',
            })
          }

          return invite.event
        }
      } catch {
        // Приглашение не загрузилось — покажем хотя бы событие.
      }
    }

    try {
      const shared =
        await getEventById(link.eventId)

      if (shared) {
        // Скрывал раньше — по ссылке всё равно показываем.
        hiddenIdsRef.current.delete(
          link.eventId,
        )

        return shared
      }
    } catch {
      // ниже — общее сообщение
    }

    showFlash(
      'Событие из ссылки уже прошло или недоступно',
    )

    return null
  }

  async function withSharedEvent(
    items: ApiEvent[],
  ) {
    const link = startLinkRef.current

    if (!link) {
      return items
    }

    startLinkRef.current = null

    const shared =
      await resolveLink(link)

    if (!shared) {
      return items
    }

    setActivePage('feed')

    return [
      shared,
      ...items.filter(
        (item) => item.id !== shared.id,
      ),
    ]
  }

  // Открыть по ссылке, когда приложение уже работает.
  async function openSharedEventNow(
    link: StartLink,
  ) {
    const shared =
      await resolveLink(link)

    if (!shared) {
      return
    }

    // Закрываем всё, что поверх ленты.
    setCollectionView(null)
    setDetailsEvent(null)
    setCommentsEvent(null)
    setEditingInterests(false)

    setActivePage('feed')

    setEvents((current) => [
      shared,
      ...current.filter(
        (item) => item.id !== shared.id,
      ),
    ])

    requestAnimationFrame(() => {
      document
        .querySelector('.tiktok-feed')
        ?.scrollTo({ top: 0 })
    })
  }

  function checkNewLaunch(
    trigger: string,
  ) {
    lastLaunchCheckRef.current = trigger

    let link: StartLink | null = null

    for (const launch of getLaunches()) {
      if (
        handledLaunchesRef.current.has(
          launch.key,
        )
      ) {
        continue
      }

      handledLaunchesRef.current.add(
        launch.key,
      )

      link = launch.link ?? link
    }

    if (!link) {
      return
    }

    // Ещё онбординг/загрузка — откроем после неё.
    if (
      loading ||
      onboardingCompleted !== true
    ) {
      startLinkRef.current = link
      return
    }

    void openSharedEventNow(link)
  }

  // «Я с тобой» на плашке приглашения.
  async function acceptInviteBanner() {
    if (!inviteBanner || inviteAccepting) {
      return
    }

    const banner = inviteBanner

    setInviteAccepting(true)

    try {
      await acceptInvite(
        banner.code,
        banner.event.id,
      )

      setGoingList((current) => [
        banner.event,
        ...current.filter(
          (item) =>
            item.id !== banner.event.id,
        ),
      ])

      setInviteBanner(null)

      showFlash(
        `Готово! ${banner.inviterName} узнает, что вы идёте вместе 🎉`,
        4000,
      )
    } catch {
      showFlash(
        'Не получилось, попробуйте ещё раз',
      )
    } finally {
      setInviteAccepting(false)
    }
  }

  // Мой код приглашений — заранее, чтобы ссылка
  // собиралась мгновенно (MAX открывает отправку
  // только сразу по нажатию).
  const myInviteCodeRef =
    useRef<string | null>(null)

  useEffect(() => {
    void getMyInviteCode().then((code) => {
      myInviteCodeRef.current = code
    })
  }, [])

  // После «Пойду» — предложение позвать кого-нибудь.
  const [goingToast, setGoingToast] =
    useState<ApiEvent | null>(null)

  const goingToastTimerRef = useRef(0)

  function offerInvite(event: ApiEvent) {
    window.clearTimeout(
      goingToastTimerRef.current,
    )

    setGoingToast(event)

    goingToastTimerRef.current =
      window.setTimeout(
        () => setGoingToast(null),
        6000,
      )
  }

  async function inviteFriend(
    event: ApiEvent,
    position: number,
  ) {
    const code = myInviteCodeRef.current

    // Кода ещё нет (нет сети) — обычная ссылка на событие.
    if (!code) {
      void getMyInviteCode().then((value) => {
        myInviteCodeRef.current = value
      })

      return shareEvent(event, position)
    }

    setGoingToast(null)

    const date =
      formatSavedDate(event)

    const result = await shareLink({
      title: event.title,
      text: [
        'Пойдём вместе? 🙌',
        `«${event.title}»`,
        [
          date,
          event.venue?.name,
        ]
          .filter(Boolean)
          .join(' · '),
      ]
        .filter(Boolean)
        .join('\n'),
      link: buildInviteLink(
        event.id,
        code,
      ),
    })

    if (result === 'copied') {
      showFlash('Приглашение скопировано')
    }

    if (result === 'failed') {
      return
    }

    void sendInteraction(
      event.id,
      'SHARE',
      {
        metadata: {
          position,
          via: result,
          invite: true,
        },
      },
    )
  }

  const checkNewLaunchRef =
    useRef(checkNewLaunch)

  checkNewLaunchRef.current =
    checkNewLaunch

  useEffect(() => {
    const check = (trigger: string) =>
      () => {
        if (
          document.visibilityState !==
          'hidden'
        ) {
          checkNewLaunchRef.current(
            trigger,
          )
        }
      }

    const onVisible = check('visible')
    const onShow = check('pageshow')
    const onFocus = check('focus')
    const onHash = check('hash')

    document.addEventListener(
      'visibilitychange',
      onVisible,
    )
    window.addEventListener(
      'pageshow',
      onShow,
    )
    window.addEventListener(
      'focus',
      onFocus,
    )
    window.addEventListener(
      'hashchange',
      onHash,
    )

    const timer = window.setInterval(
      check('poll'),
      1500,
    )

    return () => {
      document.removeEventListener(
        'visibilitychange',
        onVisible,
      )
      window.removeEventListener(
        'pageshow',
        onShow,
      )
      window.removeEventListener(
        'focus',
        onFocus,
      )
      window.removeEventListener(
        'hashchange',
        onHash,
      )
      window.clearInterval(timer)
    }
  }, [])

  // Диагностика ссылок: 5 быстрых нажатий на аватар в профиле.
  function showLaunchDebug() {
    const launches = getLaunches()

    showFlash(
      [
        `platform: ${window.WebApp?.platform ?? '-'}`,
        `check: ${lastLaunchCheckRef.current}`,
        ...launches.map(
          (launch) =>
            `${launch.source}: ${launch.startParam || '(нет)'} ${launch.key.split('|')[2] ?? ''}`,
        ),
        launches.length === 0
          ? 'данных запуска нет'
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      10000,
    )
  }

  async function completeOnboarding(
    selected: string[],
  ) {
    await saveProfileInterests(
      selected,
    )

    setPreferredCategories(selected)
    setOnboardingCompleted(true)

    const feed =
      await getEvents(20)

    setEvents(
      await withSharedEvent(
        feed.items,
      ),
    )
  }

  // Редактирование интересов из профиля.
  const [editingInterests, setEditingInterests] =
    useState(false)

  async function saveEditedInterests(
    selected: string[],
  ) {
    await saveProfileInterests(
      selected,
    )

    setPreferredCategories(selected)
    setEditingInterests(false)

    // Пересобираем «Для вас» под новый выбор.
    setActiveCategory(null)
    setNearbyActive(false)
    setQuickFilter(null)

    try {
      const feed =
        await getEvents(20)

      setEvents(feed.items)

      document
        .querySelector('.tiktok-feed')
        ?.scrollTo({ top: 0 })
    } catch {
      // Интересы сохранены; лента обновится
      // при следующей загрузке.
    }
  }

  async function switchCategory(
    category: string | null,
  ) {
    setActivePage('feed')

    if (
      category === activeCategory &&
      !nearbyActive &&
      quickFilter === null
    ) {
      return
    }

    setNearbyActive(false)
    setQuickFilter(null)
    setLocationError(null)

    setActiveCategory(category)
    setFeedLoading(true)

    try {
      const feed =
        await getEvents(
          20,
          category ??
            undefined,
        )

      setEvents(feed.items)

      // После смены категории
      // возвращаем ленту наверх.
      requestAnimationFrame(
        () => {
          document
            .querySelector(
              '.tiktok-feed',
            )
            ?.scrollTo({
              top: 0,
            })
        },
      )
    } finally {
      setFeedLoading(false)
    }
  }

  // Новая лента (смена вкладки, категории,
  // фильтра или перезагрузка) — сбрасываем
  // состояние подгрузки. При дозагрузке
  // первый элемент не меняется.
  const firstEventId =
    events[0]?.id

  useEffect(() => {
    feedSeenIdsRef.current = new Set([
      ...events.map((event) => event.id),
      ...hiddenIdsRef.current,
    ])

    setFeedExhausted(false)
    setRoundBreakIds(new Set())
    roundCounterRef.current = 0
  }, [
    firstEventId,
    activeCategory,
    nearbyActive,
    quickFilter,
  ])

  // #39: лента бесконечная. Когда новое кончилось — новый «круг»
  // из уже показанного (сервер ставит давно виденное выше недавнего).
  // id первого события каждого нового круга — перед ним разделитель.
  const [roundBreakIds, setRoundBreakIds] =
    useState<Set<string>>(() => new Set())

  const roundCounterRef = useRef(0)

  async function loadMoreEvents() {
    if (
      loadingMoreRef.current ||
      feedExhausted ||
      feedLoading ||
      events.length === 0
    ) {
      return
    }

    loadingMoreRef.current = true
    setLoadingMore(true)

    try {
      const coords =
        nearbyActive
          ? nearbyCoordsRef.current
          : null

      let startedNewRound = false
      let roundStage = 0

      // С быстрым фильтром часть страницы
      // может отсеяться — пробуем до 4 раз.
      for (
        let attempt = 0;
        attempt < 5;
        attempt += 1
      ) {
        const feed =
          await getEvents(
            20,
            activeCategory ??
              undefined,
            coords?.latitude,
            coords?.longitude,
            undefined,
            [
              ...feedSeenIdsRef.current,
            ].slice(-200),
          )

        const fresh =
          feed.items.filter(
            (event) =>
              !feedSeenIdsRef.current.has(
                event.id,
              ),
          )

        if (fresh.length === 0) {
          // Новое кончилось — начинаем новый круг. Скрытые не возвращаем
          // никогда. Сначала не повторяем сразу последние карточки
          // (треть, не больше 20); если событий так мало, что и это
          // пусто — круг без ограничений.
          if (roundStage < 2) {
            roundStage += 1
            startedNewRound = true

            const keepRecent =
              roundStage === 1
                ? Math.min(20, Math.floor(events.length / 3))
                : 0

            feedSeenIdsRef.current = new Set([
              ...(keepRecent > 0
                ? events.slice(-keepRecent).map((event) => event.id)
                : []),
              ...hiddenIdsRef.current,
            ])

            continue
          }

          // Событий нет вообще (пустой город/категория).
          setFeedExhausted(true)
          return
        }

        for (const event of fresh) {
          feedSeenIdsRef.current.add(
            event.id,
          )
        }

        const visible =
          quickFilter
            ? fresh.filter((event) =>
                matchesQuickFilter(
                  event,
                  quickFilter,
                ),
              )
            : fresh

        if (visible.length > 0) {
          // В новом круге события повторяются — у каждого появления
          // свой ключ (feedKey), разделитель — перед первым из круга.
          let batch: ApiEvent[] = visible

          if (startedNewRound) {
            roundCounterRef.current += 1

            const round = roundCounterRef.current

            batch = visible.map((event) => ({
              ...event,
              feedKey: `${event.id}~${round}`,
            }))

            // Разделитель — только при первом переходе к уже виденному.
            if (round === 1) {
              const firstOfRound = feedKeyOf(batch[0])

              setRoundBreakIds((current) =>
                new Set(current).add(firstOfRound),
              )
            }
          }

          setEvents((current) => [
            ...current,
            ...batch,
          ])

          return
        }
      }
    } catch {
      // Сеть / сервер: попробуем снова
      // при следующей прокрутке.
    } finally {
      loadingMoreRef.current = false
      setLoadingMore(false)
    }
  }

  // «Рядом» (#33): своя геопозиция, а если MAX её не отдал —
  // место, введённое вручную (метро/улица/район).
  const [nearbyFallback, setNearbyFallback] =
    useState<GeoFailure | null>(null)

  const [placeQuery, setPlaceQuery] =
    useState('')

  const [placeSearching, setPlaceSearching] =
    useState(false)

  const [placeError, setPlaceError] =
    useState<string | null>(null)

  async function loadNearby(
    latitude: number,
    longitude: number,
  ) {
    setFeedLoading(true)

    try {
      nearbyCoordsRef.current = {
        latitude,
        longitude,
      }

      const feed =
        await getEvents(
          20,
          undefined,
          latitude,
          longitude,
        )

      setActiveCategory(null)
      setNearbyActive(true)
      setEvents(feed.items)
      setNearbyFallback(null)

      requestAnimationFrame(() => {
        document
          .querySelector('.tiktok-feed')
          ?.scrollTo({ top: 0 })
      })
    } catch {
      setLocationError(
        'Не удалось загрузить события рядом',
      )
    } finally {
      setFeedLoading(false)
    }
  }

  async function openNearby() {
    setActivePage('feed')
    setQuickFilter(null)
    setLocationError(null)
    setPlaceError(null)
    setFeedLoading(true)

    const position =
      await getCurrentPosition()

    if (position.ok) {
      await loadNearby(
        position.latitude,
        position.longitude,
      )

      return
    }

    setFeedLoading(false)
    setNearbyFallback(position.reason)
  }

  async function searchNearbyPlace() {
    const query = placeQuery.trim()

    if (query.length < 2 || placeSearching) {
      return
    }

    setPlaceSearching(true)
    setPlaceError(null)

    try {
      const place = await searchPlace(query)

      if (!place) {
        setPlaceError(
          'Не нашли такое место. Попробуйте точнее: «метро Курская» или «Тверская 12».',
        )

        return
      }

      savePlace(place)
      await loadNearby(
        place.latitude,
        place.longitude,
      )
    } catch {
      setPlaceError(
        'Поиск места сейчас недоступен, попробуйте чуть позже.',
      )
    } finally {
      setPlaceSearching(false)
    }
  }

  async function openQuickFilter(
    filter: QuickFilter,
  ) {
    setActivePage('feed')
    setNearbyActive(false)
    setQuickFilter(filter)
    setActiveCategory(null)
    setLocationError(null)
    setFeedLoading(true)

    try {
      const feed =
        await getEvents(50)

      const filtered =
        feed.items.filter(
          (event) =>
            matchesQuickFilter(
              event,
              filter,
            ),
        )

      setEvents(filtered)

      requestAnimationFrame(
        () => {
          document
            .querySelector(
              '.tiktok-feed',
            )
            ?.scrollTo({
              top: 0,
            })
        },
      )
    } finally {
      setFeedLoading(false)
    }
  }

  async function openComments(
    event: ApiEvent,
  ) {
    setCommentsEvent(event)
    setCommentsLoading(true)
    setCommentError(null)

    try {
      const items =
        await getComments(
          event.id,
        )

      setComments(
        (current) => ({
          ...current,

          [event.id]:
            items,
        }),
      )
    } catch {
      setCommentError(
        '\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044c \u043a\u043e\u043c\u043c\u0435\u043d\u0442\u0430\u0440\u0438\u0438',
      )
    } finally {
      setCommentsLoading(false)
    }
  }

  async function addComment() {
    if (
      !commentsEvent ||
      commentSending
    ) {
      return
    }

    const text =
      commentText.trim()

    if (!text) {
      return
    }

    const eventId =
      commentsEvent.id

    setCommentSending(true)
    setCommentError(null)

    try {
      const comment =
        await createComment(
          eventId,
          text,
        )

      setComments(
        (current) => ({
          ...current,

          [eventId]: [
            comment,
            ...(current[eventId] ??
              []),
          ],
        }),
      )

      setCommentText('')
    } catch {
      setCommentError(
        '\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u043e\u0442\u043f\u0440\u0430\u0432\u0438\u0442\u044c \u043a\u043e\u043c\u043c\u0435\u043d\u0442\u0430\u0440\u0438\u0439',
      )
    } finally {
      setCommentSending(false)
    }
  }

  function openDetails(
    event: ApiEvent,
    position: number,
  ) {
    setDetailsEvent({
      event,
      position,
    })

    void sendInteraction(
      event.id,
      'OPEN',
      {
        metadata: {
          position,
          feed: nearbyActive
            ? 'nearby'
            : activeCategory
              ? 'category'
              : 'for-you',
        },
      },
    )
  }

  function openDetailsLink() {
    if (!detailsEvent) {
      return
    }

    const {
      event,
      position,
    } = detailsEvent

    const url =
      event.ticketUrl ??
      event.sourceUrl

    if (!url) {
      return
    }

    if (event.ticketUrl) {
      void sendInteraction(
        event.id,
        'TICKET_CLICK',
        {
          metadata: {
            position,
            feed: nearbyActive
              ? 'nearby'
              : activeCategory
                ? 'category'
                : 'for-you',
          },
        },
      )
    }

    window.open(
      url,
      '_blank',
      'noopener,noreferrer',
    )
  }

  async function shareEvent(
    event: ApiEvent,
    position: number,
  ) {
    const date =
      formatSavedDate(event)

    const text = [
      `«${event.title}»`,
      [
        date,
        event.venue?.name,
      ]
        .filter(Boolean)
        .join(' · '),
      'Смотри в Evently:',
    ]
      .filter(Boolean)
      .join('\n')

    const result = await shareLink({
      title: event.title,
      text,
      link: buildEventLink(event.id),
    })

    if (result === 'copied') {
      showFlash('Ссылка скопирована')
    }

    if (result === 'failed') {
      return
    }

    void sendInteraction(
      event.id,
      'SHARE',
      {
        metadata: {
          position,
          via: result,
          feed: nearbyActive
            ? 'nearby'
            : activeCategory
              ? 'category'
              : 'for-you',
        },
      },
    )
  }

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="loading-logo">
          Evently
        </div>

        <div className="loading-text">
          Готовим всё интересное…
        </div>
      </div>
    )
  }

  if (
    onboardingCompleted === false
  ) {
    return (
      <Onboarding
        categories={categories}
        onComplete={
          completeOnboarding
        }
      />
    )
  }

  const orderedCategories =
    [...categories].sort(
      (a, b) => {
        const aIndex =
          preferredCategories.indexOf(
            a.slug,
          )

        const bIndex =
          preferredCategories.indexOf(
            b.slug,
          )

        const aPreferred =
          aIndex !== -1
 
        const bPreferred =
          bIndex !== -1

        if (
          aPreferred &&
          !bPreferred
        ) {
          return -1
        }

        if (
          !aPreferred &&
          bPreferred
        ) {
          return 1
        }

        if (
          aPreferred &&
          bPreferred
        ) {
          return (
            aIndex -
            bIndex
          )
        }

        return (
          a.sortOrder -
          b.sortOrder
        )
      },
    )
  const activeCategoryData =
    categories.find(
      (category) =>
        category.slug ===
        activeCategory,
    )

  const firstName =
    getMaxFirstName()

  return (
    <div className="app has-bottom-nav">
      {activePage === 'home' && (
        <HomePage
          firstName={firstName}
          events={events}
          categories={
            orderedCategories
          }
          onOpenFeed={() =>
            void switchCategory(null)
          }
          onNearby={() =>
            void openNearby()
          }
          onQuickFilter={(filter) =>
            void openQuickFilter(
              filter,
            )
          }
          onCategory={(category) =>
            void switchCategory(
              category,
            )
          }
          onEvent={(
            event,
            position,
          ) =>
            openDetails(
              event,
              position,
            )
          }
          onAssistant={() =>
            setActivePage(
              'assistant',
            )
          }
        />
      )}

      {activePage === 'feed' && (
        <>
      <header className="feed-header">
          <div className="feed-main-tabs">
              <button
              type="button"
              className={
                activeCategory === null &&
                !nearbyActive &&
                quickFilter === null
                  ? 'feed-main-tab active'
                  : 'feed-main-tab'
              }
              onClick={() =>
                  void switchCategory(null)
              }
              >
              Для вас
              </button>
  
             <button
               type="button"
               className={
                 nearbyActive
                   ? 'feed-main-tab active'
                   : 'feed-main-tab'
               }
               onClick={() =>
                 void openNearby()
               }
             >
               Рядом
             </button>
  
              <button
              type="button"
              className={
                  activeCategory
                  ? 'feed-main-tab category-picker-button active'
                  : 'feed-main-tab category-picker-button'
              }
              onClick={() =>
                  setCategoriesOpen(true)
              }
              >
              <span>
                  {activeCategoryData
                  ? activeCategoryData.name
                  : 'Категории'}
              </span>
  
              <ChevronDown
                  size={15}
              />
              </button>
          </div>
          </header>
  
      {categoriesOpen && (
        <CategorySheet
          categories={
            orderedCategories
          }
          preferredCategories={
            preferredCategories
          }
          activeCategory={
            activeCategory
          }
          onClose={() =>
            setCategoriesOpen(false)
          }
          onSelect={(category) => {
            setCategoriesOpen(false)
  
            void switchCategory(
              category,
            )
          }}
        />
      )}
  
      {feedLoading && (
        <div className="feed-switch-loader">
          Подбираем…
        </div>
      )}
  
      {locationError && (
        <div className="location-error">
          {locationError}
        </div>
      )}

      {nearbyFallback && (() => {
        const saved = getSavedPlace()

        return (
          <div
            className="nearby-fallback"
            role="dialog"
          >
            <button
              type="button"
              className="nearby-fallback-close"
              aria-label="Закрыть"
              onClick={() => setNearbyFallback(null)}
            >
              <X size={18} />
            </button>

            <p>{GEO_FAILURE_TEXT[nearbyFallback]}</p>

            <form
              onSubmit={(formEvent) => {
                formEvent.preventDefault()
                void searchNearbyPlace()
              }}
            >
              <input
                value={placeQuery}
                onChange={(inputEvent) =>
                  setPlaceQuery(inputEvent.target.value)
                }
                placeholder="Метро, улица или район"
                enterKeyHint="search"
              />

              <button
                type="submit"
                disabled={
                  placeSearching ||
                  placeQuery.trim().length < 2
                }
              >
                {placeSearching ? '…' : 'Найти'}
              </button>
            </form>

            {placeError && (
              <p className="nearby-fallback-error">
                {placeError}
              </p>
            )}

            <div className="nearby-fallback-actions">
              {saved && (
                <button
                  type="button"
                  onClick={() =>
                    void loadNearby(
                      saved.latitude,
                      saved.longitude,
                    )
                  }
                >
                  📍 {saved.label}
                </button>
              )}

              {nearbyFallback !== 'unsupported' &&
                nearbyFallback !== 'insecure' && (
                  <button
                    type="button"
                    onClick={() => void openNearby()}
                  >
                    Определить ещё раз
                  </button>
                )}
            </div>
          </div>
        )
      })()}
  
        <main
          className="tiktok-feed"
          onScroll={(scrollEvent) => {
            const element =
              scrollEvent.currentTarget

            // Догружаем, когда до конца
            // осталось ~3 экрана.
            if (
              element.scrollTop +
                element.clientHeight * 4 >=
              element.scrollHeight
            ) {
              void loadMoreEvents()
            }
          }}
        >
          {events.length === 0 ? (
            <div className="empty-feed">
              <div className="empty-feed-icon">
                {activeCategoryData?.icon ?? '✨'}
              </div>
  
              <h2>
                Пока ничего нет
              </h2>
  
              <p>
                {activeCategoryData
                  ? `В категории «${activeCategoryData.name}» пока нет событий`
                  : 'Пока не нашли подходящих событий'}
              </p>
  
              {activeCategory !== null && (
                <button
                  type="button"
                  className="empty-feed-button"
                  onClick={() =>
                    void switchCategory(null)
                  }
                >
                  Вернуться в «Для вас»
                </button>
              )}
            </div>
          ) : (
            events.map(
              (event, index) => {
                const eventComments =
                  comments[event.id] ?? []
  
                return (
                  <Fragment key={feedKeyOf(event)}>
                  {roundBreakIds.has(feedKeyOf(event)) && (
                    <section className="round-break">
                      <div className="round-break-emoji">🏆</div>

                      <h2>Достижение: «Видел всё»</h2>

                      <p>
                        Вы посмотрели всё новое в городе.
                        Награда — повтор лучшего по вашим
                        интересам. Свежие события уже в пути.
                      </p>

                      <small>Листайте дальше ↓</small>
                    </section>
                  )}

                  <EventSlide
                    key={feedKeyOf(event)}
                    event={event}
                    position={index}
                    distanceKm={
                      nearbyActive
                        ? distanceToEvent(
                            nearbyCoordsRef.current,
                            event.venue,
                          )
                        : null
                    }
                    liked={Boolean(
                      liked[event.id],
                    )}
                    going={goingIds.has(
                      event.id,
                    )}
                    onGoing={() =>
                      toggleGoing(
                        event,
                        !goingIds.has(
                          event.id,
                        ),
                      )
                    }
                    commentsCount={
                      eventComments.length
                    }
                    onDoubleTapLike={() =>
                      likeByDoubleTap(
                        event,
                        index,
                        'for-you',
                      )
                    }
                    onLike={() => {
                      const willBeLiked =
                        !liked[event.id]

                      toggleFavorite(
                        event,
                        willBeLiked,
                      )

                      void sendInteraction(
                        event.id,
                        willBeLiked
                          ? 'FAVORITE'
                          : 'UNFAVORITE',
                        {
                          metadata: {
                            position: index,
                            feed: 'for-you',
                          },
                        },
                      )
                    }}
                    onComments={() =>
                      void openComments(
                        event,
                      )
                    }
                    onShare={() =>
                      void shareEvent(
                        event,
                        index,
                      )
                    }
                    onInvite={() =>
                      void inviteFriend(
                        event,
                        index,
                      )
                    }
                    onDetails={() =>
                      openDetails(
                        event,
                        index,
                      )
                    }
                    hiding={
                      hidingEventId ===
                      event.id
                    }
                    onHide={() =>
                      hideEvent(
                        event,
                        index,
                      )
                    }
                  />
                  </Fragment>
                )
              },
            )
          )}

          {events.length > 0 &&
            (loadingMore ||
              feedExhausted) && (
              <div
                style={{
                  padding: '24px 16px 96px',
                  textAlign: 'center',
                  opacity: 0.7,
                  fontSize: 14,
                }}
              >
                {loadingMore
                  ? 'Загружаем ещё…'
                  : 'Здесь пока нет событий. Загляните позже!'}
              </div>
            )}
        </main>

        {hideToast && (
          <div
            className="hide-toast"
            role="status"
          >
            <span>
              Скрыли. Похожее покажем реже
            </span>

            <button
              type="button"
              onClick={undoHide}
            >
              Вернуть
            </button>
          </div>
        )}
  
          </>
      )}

      {activePage ===
        'assistant' && (
        <AssistantPage
          pendingFood={pendingFood}
          onPendingFoodHandled={() => setPendingFood(null)}
        />
      )}

      {activePage ===
        'profile' && (
        <ProfilePage
          firstName={firstName}
          preferredCategories={
            preferredCategories
          }
          categories={categories}
          favorites={favorites}
          going={going}
          onAvatarDebug={showLaunchDebug}
          onEditInterests={() =>
            setEditingInterests(true)
          }
          onOpenCollection={(
            collection,
            items,
            startIndex,
          ) =>
            setCollectionView({
              collection,
              items,
              startIndex,
            })
          }
        />
      )}

      {inviteBanner &&
        activePage === 'feed' &&
        !collectionView && (
          <div
            className="invite-banner"
            role="dialog"
          >
            <div className="invite-banner-text">
              <strong>
                {inviteBanner.inviterName} зовёт
                тебя пойти
              </strong>

              <span>
                «{inviteBanner.event.title}»
              </span>
            </div>

            <div className="invite-banner-actions">
              <button
                type="button"
                className="invite-banner-accept"
                disabled={inviteAccepting}
                onClick={() =>
                  void acceptInviteBanner()
                }
              >
                {inviteAccepting
                  ? 'Секунду…'
                  : 'Я с тобой!'}
              </button>

              <button
                type="button"
                className="invite-banner-decline"
                onClick={() =>
                  setInviteBanner(null)
                }
              >
                Не смогу
              </button>
            </div>
          </div>
        )}

      {goingToast && !inviteBanner && (
        <div
          className="hide-toast going-toast"
          role="status"
        >
          <span>
            Вы идёте! Позвать кого-нибудь с собой?
          </span>

          <button
            type="button"
            onClick={() =>
              void inviteFriend(
                goingToast,
                0,
              )
            }
          >
            Позвать
          </button>
        </div>
      )}

      {flash && (
        <div
          className="app-flash"
          role="status"
        >
          {flash}
        </div>
      )}

      {editingInterests && (
        <div className="interests-editor">
          <Onboarding
            categories={categories}
            initialSelected={preferredCategories.filter(
              (slug) =>
                categories.some(
                  (category) =>
                    category.slug === slug,
                ),
            )}
            onComplete={
              saveEditedInterests
            }
            onCancel={() =>
              setEditingInterests(false)
            }
          />
        </div>
      )}

      {collectionView && (
        <div className="collection-viewer">
          <button
            type="button"
            className="collection-back"
            onClick={() =>
              setCollectionView(null)
            }
          >
            <ChevronLeft size={20} />
            {collectionView.collection ===
            'saved'
              ? 'Сохранённое'
              : 'Пойду'}
          </button>

          <main
            className="tiktok-feed"
            ref={collectionFeedRef}
          >
            {collectionView.items.map(
              (event, index) => (
                <EventSlide
                  key={event.id}
                  event={event}
                  position={index}
                  liked={Boolean(
                    liked[event.id],
                  )}
                  going={goingIds.has(
                    event.id,
                  )}
                  onGoing={() =>
                    toggleGoing(
                      event,
                      !goingIds.has(
                        event.id,
                      ),
                    )
                  }
                  commentsCount={
                    (
                      comments[event.id] ??
                      []
                    ).length
                  }
                  onDoubleTapLike={() =>
                    likeByDoubleTap(
                      event,
                      index,
                      `profile-${collectionView.collection}`,
                    )
                  }
                  onLike={() => {
                    const willBeLiked =
                      !liked[event.id]

                    toggleFavorite(
                      event,
                      willBeLiked,
                    )

                    void sendInteraction(
                      event.id,
                      willBeLiked
                        ? 'FAVORITE'
                        : 'UNFAVORITE',
                      {
                        metadata: {
                          position: index,
                          feed: `profile-${collectionView.collection}`,
                        },
                      },
                    )
                  }}
                  onComments={() =>
                    void openComments(
                      event,
                    )
                  }
                  onShare={() =>
                    void shareEvent(
                      event,
                      index,
                    )
                  }
                  onInvite={() =>
                    void inviteFriend(
                      event,
                      index,
                    )
                  }
                  onDetails={() =>
                    openDetails(
                      event,
                      index,
                    )
                  }
                />
              ),
            )}
          </main>
        </div>
      )}

      {detailsEvent && (
        <EventDetailsSheet
          event={
            detailsEvent.event
          }
          onClose={() =>
            setDetailsEvent(null)
          }
          onTicket={() =>
            openDetailsLink()
          }
          onAskAiFood={() => {
            setPendingFood({
              id: detailsEvent.event.id,
              title: detailsEvent.event.title,
              nonce: Date.now(),
            })
            setDetailsEvent(null)
            setActivePage('assistant')
          }}
        />
      )}

      {commentsEvent && (
        <div className="comments-backdrop">
            <div className="comments-sheet">
            <div className="comments-header">
                <strong>
                {'\u041a\u043e\u043c\u043c\u0435\u043d\u0442\u0430\u0440\u0438\u0438'}
                </strong>

                <button
                type="button"
                onClick={() => {
                    setCommentsEvent(null)
                    setCommentText('')
                    setCommentError(null)
                }}
                >
                <X size={24} />
                </button>
            </div>

            <div className="comments-content">
                {commentsLoading ? (
                <div className="empty-comments">
                    <MessageCircle size={36} />

                    <strong>
                    {'\u0417\u0430\u0433\u0440\u0443\u0436\u0430\u0435\u043c\u2026'}
                    </strong>
                </div>
                ) : (
                <>
                    {commentError && (
                    <div className="empty-comments">
                        <strong>
                        {commentError}
                        </strong>
                    </div>
                    )}

                    {(comments[
                    commentsEvent.id
                    ] ?? []).length === 0 &&
                    !commentError ? (
                    <div className="empty-comments">
                        <MessageCircle
                        size={36}
                        />

                        <strong>
                        {'\u041f\u043e\u043a\u0430 \u0442\u0438\u0445\u043e'}
                        </strong>

                        <span>
                        {'\u0411\u0443\u0434\u044c \u043f\u0435\u0440\u0432\u044b\u043c, \u043a\u0442\u043e \u0447\u0442\u043e-\u043d\u0438\u0431\u0443\u0434\u044c \u043d\u0430\u043f\u0438\u0448\u0435\u0442'}
                        </span>
                    </div>
                    ) : (
                    !commentError &&
                    (
                        comments[
                        commentsEvent.id
                        ] ?? []
                    ).map(
                        (comment) => (
                        <div
                            className="comment"
                            key={comment.id}
                        >
                            <div className="comment-avatar">
                            {comment.author
                                .slice(0, 1)
                                .toUpperCase()}
                            </div>

                            <div>
                            <strong>
                                {comment.author}
                            </strong>

                            <p>
                                {comment.text}
                            </p>
                            </div>
                        </div>
                        ),
                    )
                    )}
                </>
                )}
            </div>

            <div className="comment-form">
                <input
                value={commentText}
                disabled={
                    commentSending
                }
                onChange={(event) =>
                    setCommentText(
                    event.target.value,
                    )
                }
                onKeyDown={(event) => {
                    if (
                    event.key ===
                    'Enter'
                    ) {
                    void addComment()
                    }
                }}
                placeholder={
                    '\u041d\u0430\u043f\u0438\u0441\u0430\u0442\u044c \u043a\u043e\u043c\u043c\u0435\u043d\u0442\u0430\u0440\u0438\u0439...'
                }
                />

                <button
                type="button"
                disabled={
                    commentSending ||
                    !commentText.trim()
                }
                onClick={() =>
                    void addComment()
                }
                >
                <Send size={20} />
                </button>
            </div>
            </div>
        </div>
        )}

      <BottomNav
        page={activePage}
        onChange={(page) => {
          // Переход по нижнему меню закрывает
          // ленту подборки из профиля.
          setCollectionView(null)
          setActivePage(page)
        }}
      />
    </div>
  )
}

export default App
