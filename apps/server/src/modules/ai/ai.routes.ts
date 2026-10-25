import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '@evently/db'

/*
 * Настройки Ollama (модель может работать
 * на отдельном ПК с видеокартой — см.
 * OLLAMA_BASE_URL в .env).
 *
 * OLLAMA_TIMEOUT_MS — сколько ждать ответа
 * модели. Первый запрос после простоя
 * дольше: модель загружается в видеопамять.
 *
 * OLLAMA_NUM_CTX — контекст диалоговой
 * модели (история + кандидаты). Для 8B
 * на 8 ГБ видеопамяти 4096 — безопасно.
 */
const OLLAMA_TIMEOUT_MS =
  Number(
    process.env.OLLAMA_TIMEOUT_MS ??
      25_000,
  )

const OLLAMA_CONVERSATION_CTX =
  Number(
    process.env.OLLAMA_NUM_CTX ??
      4096,
  )

const CATEGORY_SLUGS = [
  'concert',
  'theatre',
  'cinema',
  'sport',
  'tour',
  'exhibition',
  'party',
  'standup',
  'games',
  'food',
  'family',
  'education',
] as const

const ChatMessageSchema = z.object({
  role: z.enum([
    'user',
    'assistant',
  ]),

  content: z
    .string()
    .trim()
    .min(1)
    .max(2000),

  eventIds: z
    .array(
      z.string().uuid(),
    )
    .max(4)
    .optional(),
})

const ChatBodySchema = z.object({
  message: z
    .string()
    .trim()
    .min(1)
    .max(700),

  history: z
    .array(
      ChatMessageSchema,
    )
    .max(10)
    .default([]),

  /*
   * Уже предусмотрено на будущее:
   * фронт сможет передавать выбранный город
   * и координаты пользователя.
   */
  city: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional(),

  latitude: z
    .number()
    .min(-90)
    .max(90)
    .optional(),

  longitude: z
    .number()
    .min(-180)
    .max(180)
    .optional(),
})

const ExtractedIntentSchema = z.object({
  city: z
    .string()
    .trim()
    .min(1)
    .nullable(),

  place: z
    .string()
    .trim()
    .min(1)
    .nullable(),

  nearMe:
    z.boolean(),

  radiusKm: z
    .number()
    .min(1)
    .max(30)
    .nullable(),

  freeOnly:
    z.boolean(),

  budgetTotal: z
    .number()
    .int()
    .positive()
    .nullable(),

  partySize: z
    .number()
    .int()
    .min(1)
    .max(10),

  occasion: z.enum([
    'date',
    'friends',
    'family',
    'solo',
    'any',
  ]),

  categories: z
    .array(
      z.enum(
        CATEGORY_SLUGS,
      ),
    )
    .max(6),

  date: z.enum([
    'today',
    'tomorrow',
    'weekend',
    'any',
  ]),

  timeOfDay: z.enum([
    'morning',
    'day',
    'evening',
    'night',
    'any',
  ]),
})

const ImageParamsSchema = z.object({
  eventId:
    z.string().uuid(),
})

type ExtractedIntent =
  z.infer<
    typeof ExtractedIntentSchema
  >

type NominatimResult = {
  place_id: number

  osm_id?: number
  osm_type?: string

  lat: string
  lon: string

  name?: string
  display_name: string

  category?: string
  type?: string

  address?: {
    city?: string
    town?: string
    village?: string
    municipality?: string
    county?: string
    state?: string
    country?: string
    country_code?: string
  }
}

type ResolvedGeo = {
  label: string

  latitude: number
  longitude: number

  city: string | null

  cached: boolean

  provider:
    | 'nominatim'
    | 'user'
}

type EventTimeWindow = {
  start: Date
  end: Date
}

type OllamaResponse = {
  message?: {
    role?: string
    content?: string
  }

  error?: string
}

const CATEGORY_KEYWORDS:
  Record<
    typeof CATEGORY_SLUGS[number],
    string[]
  > = {
    concert: [
      'концерт',
      'музыка',
      'живой звук',
    ],

    theatre: [
      'театр',
      'спектакль',
      'постановка',
    ],

    cinema: [
      'кино',
      'фильм',
      'премьера',
    ],

    sport: [
      'спорт',
      'матч',
      'футбол',
      'хоккей',
      'баскетбол',
    ],

    tour: [
      'экскурсия',
      'экскурсию',
      'прогулка',
      'прогуляться',
    ],

    exhibition: [
      'выставка',
      'выставку',
      'музей',
      'экспозиция',
    ],

    party: [
      'вечеринка',
      'вечеринку',
      'тусовка',
      'клуб',
      'потанцевать',
    ],

    standup: [
      'стендап',
      'standup',
      'юмор',
    ],

    games: [
      'квест',
      'настолки',
      'настольные игры',
    ],

    food: [
      'ресторан',
      'кафе',
      'поесть',
      'ужин',
    ],

    family: [
      'с детьми',
      'для детей',
      'семейное',
    ],

    education: [
      'лекция',
      'лекцию',
      'мастер-класс',
    ],
  }

const INTENT_JSON_SCHEMA = {
  type:
    'object',

  additionalProperties:
    false,

  properties: {
    city: {
      type: [
        'string',
        'null',
      ],
    },

    place: {
      type: [
        'string',
        'null',
      ],
    },

    nearMe: {
      type:
        'boolean',
    },

    radiusKm: {
      type: [
        'number',
        'null',
      ],

      minimum:
        1,

      maximum:
        30,
    },

    freeOnly: {
      type:
        'boolean',
    },

    budgetTotal: {
      type: [
        'integer',
        'null',
      ],
    },

    partySize: {
      type:
        'integer',

      minimum:
        1,

      maximum:
        10,
    },

    occasion: {
      type:
        'string',

      enum: [
        'date',
        'friends',
        'family',
        'solo',
        'any',
      ],
    },

    categories: {
      type:
        'array',

      maxItems:
        6,

      items: {
        type:
          'string',

        enum:
          CATEGORY_SLUGS,
      },
    },

    date: {
      type:
        'string',

      enum: [
        'today',
        'tomorrow',
        'weekend',
        'any',
      ],
    },

    timeOfDay: {
      type:
        'string',

      enum: [
        'morning',
        'day',
        'evening',
        'night',
        'any',
      ],
    },
  },

  required: [
    'city',
    'place',
    'nearMe',
    'radiusKm',
    'freeOnly',
    'budgetTotal',
    'partySize',
    'occasion',
    'categories',
    'date',
    'timeOfDay',
  ],
}

function normalizeText(
  value: string,
) {
  return value
    .toLocaleLowerCase(
      'ru-RU',
    )
    .replace(
      /ё/g,
      'е',
    )
    .replace(
      /[«»"'`]/g,
      '',
    )
    .replace(
      /\s+/g,
      ' ',
    )
    .trim()
}

function wantsMoreOptions(
  value: string,
) {
  const text =
    normalizeText(value)

  return (
    /(?:^|\s)(?:еще|ещё)(?:\s|$)/.test(text) ||
    /друг(?:ие|ой|ое)/.test(text) ||
    /что-нибудь еще/.test(text) ||
    /что-нибудь ещё/.test(text) ||
    /есть варианты/.test(text) ||
    /есть варики/.test(text)
  )
}

function parseBudget(
  text: string,
) {
  const match =
    text.match(
      /(?:до|максимум|не больше|не дороже|бюджет(?:ом)?(?:\s+до)?|в пределах)\s*([\d\s]{2,8})\s*(?:₽|руб)/i,
    ) ??
    text.match(
      /([\d\s]{2,8})\s*(?:₽|руб(?:лей|ля|ль)?)/i,
    )

  if (!match) {
    return null
  }

  const digits =
    (
      match[1] ?? ''
    ).replace(
      /\D/g,
      '',
    )

  if (!digits) {
    return null
  }

  const value =
    Number(digits)

  return Number.isFinite(
    value,
  )
    ? value
    : null
}

function parsePartySize(
  text: string,
) {
  if (
    /вдвоем|на двоих|для двоих|с девушк|с парнем|с любим|для пары/i.test(
      text,
    )
  ) {
    return 2
  }

  if (
    /втроем|на троих|для троих/i.test(
      text,
    )
  ) {
    return 3
  }

  if (
    /вчетвером|на четверых|для четверых/i.test(
      text,
    )
  ) {
    return 4
  }

  return null
}

function explicitCategoriesFromText(
  text: string,
) {
  const normalized =
    normalizeText(text)

  const result =
    new Set<
      typeof CATEGORY_SLUGS[number]
    >()

  for (
    const [
      slug,
      keywords,
    ] of Object.entries(
      CATEGORY_KEYWORDS,
    ) as Array<
      [
        typeof CATEGORY_SLUGS[number],
        string[],
      ]
    >
  ) {
    if (
      keywords.some(
        (keyword) =>
          normalized.includes(
            normalizeText(
              keyword,
            ),
          ),
      )
    ) {
      result.add(
        slug,
      )
    }
  }

  return [
    ...result,
  ]
}


const ConversationChoiceSchema =
  z.object({
    eventIds: z
      .array(
        z.string(),
      )
      .min(1)
      .max(4),

    /*
     * Полный ответ ассистента
     * (2–5 предложений).
     */
    answer: z
      .string()
      .trim()
      .max(1200)
      .nullable(),
  })

const CONVERSATION_CHOICE_JSON_SCHEMA = {
  type: 'object',

  additionalProperties: false,

  properties: {
    eventIds: {
      type: 'array',
      minItems: 1,
      maxItems: 4,

      items: {
        type: 'string',
      },
    },

    answer: {
      type: [
        'string',
        'null',
      ],
    },
  },

  required: [
    'eventIds',
    'answer',
  ],
}

type ConversationalCandidate = {
  id: string

  title: string

  categories: string[]

  price: string

  venue: string | null

  distanceKm: number | null

  /*
   * Дата и время по-человечески,
   * в часовом поясе города события:
   * "сб, 18 окт., 19:00".
   */
  when: string | null

  description: string
}

const CITY_TIME_ZONES: Record<string, string> = {
  msk: 'Europe/Moscow',
  spb: 'Europe/Moscow',
  kzn: 'Europe/Moscow',
  nnv: 'Europe/Moscow',
  krd: 'Europe/Moscow',
  ekb: 'Asia/Yekaterinburg',
  nsk: 'Asia/Novosibirsk',
}

function formatEventWhen(
  date: Date,
  sourceCity: string | null | undefined,
) {
  return new Intl.DateTimeFormat(
    'ru-RU',
    {
      timeZone:
        CITY_TIME_ZONES[
          sourceCity ?? ''
        ] ?? 'Europe/Moscow',

      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    },
  ).format(date)
}

function excludedCategoriesFromText(
  value: string,
) {
  const text =
    normalizeText(value)

  const excluded =
    new Set<
      typeof CATEGORY_SLUGS[number]
    >()

  for (
    const [
      slug,
      keywords,
    ] of Object.entries(
      CATEGORY_KEYWORDS,
    ) as Array<
      [
        typeof CATEGORY_SLUGS[number],
        string[],
      ]
    >
  ) {
    for (
      const keyword
      of keywords
    ) {
      const normalizedKeyword =
        normalizeText(
          keyword,
        )

      let offset =
        text.indexOf(
          normalizedKeyword,
        )

      while (
        offset !== -1
      ) {
        const before =
          text.slice(
            Math.max(
              0,
              offset - 35,
            ),
            offset,
          )

        /*
         * "не кино"
         * "не хочу кино"
         * "без кино"
         * "только не кино"
         * "кроме кино"
         */
        const negative =
          /(?:^|\s)(?:не хочу|не надо|не нужно|не люблю|только не|кроме|без|не)\s*$/.test(
            before,
          )

        const notOnly =
          /не только\s*$/.test(
            before,
          )

        if (
          negative &&
          !notOnly
        ) {
          excluded.add(
            slug,
          )
        }

        offset =
          text.indexOf(
            normalizedKeyword,
            offset +
              normalizedKeyword.length,
          )
      }
    }
  }

  return [
    ...excluded,
  ]
}


function negativeTermsFromText(
  value: string,
) {
  const text =
    normalizeText(value)

  const result =
    new Set<string>()

  /*
   * Берём кусок после явного отрицания:
   *
   * "не люблю музеи"
   * "не хочу кино"
   * "только не квесты"
   * "без футбола"
   * "кроме выставок"
   */
  const patterns = [
    /(?:не люблю|не хочу|не надо|не нужно|только не|без|кроме)\s+([^,.!?;]+)/g,
  ]

  for (
    const pattern
    of patterns
  ) {
    for (
      const match
      of text.matchAll(pattern)
    ) {
      const fragment =
        (
          match[1] ??
          ''
        )
          .trim()

      if (!fragment) {
        continue
      }

      const words =
        fragment
          .split(/\s+/)
          .map(
            (word) =>
              word.replace(
                /[^a-zа-я0-9-]/gi,
                '',
              ),
          )
          .filter(
            (word) =>
              word.length >= 3,
          )

      for (
        const word
        of words
      ) {
        /*
         * Небольшой stem:
         *
         * музей / музеи / музея
         * -> музе
         *
         * квесты / квестов
         * -> квест
         *
         * Этого достаточно для
         * детерминированного safety-filter.
         */
        let stem =
          word

        stem =
          stem.replace(
            /(иями|ями|ами|ого|ему|ому|ыми|ими|ая|яя|ое|ее|ые|ие|ий|ый|ой|ам|ям|ах|ях|ов|ев|ей|ом|ем|ами|ями|у|ю|а|я|ы|и|е|о)$/i,
            '',
          )

        if (
          stem.length >= 3
        ) {
          result.add(
            stem,
          )
        }
      }
    }
  }

  return [
    ...result,
  ]
}

function collectNegativeTerms(
  currentMessage: string,

  history: Array<{
    role:
      'user' |
      'assistant'

    content:
      string

    eventIds?:
      string[]
  }>,
) {
  const result =
    new Set<string>()

  for (
    const item
    of history
  ) {
    if (
      item.role !==
      'user'
    ) {
      continue
    }

    for (
      const term
      of negativeTermsFromText(
        item.content,
      )
    ) {
      result.add(
        term,
      )
    }
  }

  for (
    const term
    of negativeTermsFromText(
      currentMessage,
    )
  ) {
    result.add(
      term,
    )
  }

  return [
    ...result,
  ]
}

function eventMatchesNegativeTerms(
  event: {
    title:
      string

    shortDescription:
      string | null

    description:
      string | null

    venue:
      {
        name:
          string

        address:
          string | null
      } | null

    categories:
      Array<{
        category: {
          name:
            string

          slug:
            string
        }
      }>
  },

  terms:
    string[],
) {
  if (
    terms.length ===
    0
  ) {
    return false
  }

  const haystack =
    normalizeText(
      [
        event.title,

        event.shortDescription ??
          '',

        event.description ??
          '',

        event.venue?.name ??
          '',

        event.venue?.address ??
          '',

        ...event.categories.map(
          (item) =>
            item.category.name,
        ),

        ...event.categories.map(
          (item) =>
            item.category.slug,
        ),
      ].join(' '),
    )

  return terms.some(
    (term) =>
      haystack.includes(
        term,
      ),
  )
}

function collectExcludedCategories(
  currentMessage: string,
  history: Array<{
    role:
      'user' |
      'assistant'

    content:
      string

    eventIds?:
      string[]
  }>,
) {
  const result =
    new Set<
      typeof CATEGORY_SLUGS[number]
    >()

  for (
    const item
    of history
  ) {
    if (
      item.role !==
      'user'
    ) {
      continue
    }

    for (
      const category
      of excludedCategoriesFromText(
        item.content,
      )
    ) {
      result.add(
        category,
      )
    }
  }

  const currentExcluded =
    excludedCategoriesFromText(
      currentMessage,
    )

  for (
    const category
    of currentExcluded
  ) {
    result.add(
      category,
    )
  }

  /*
   * Если потом пользователь явно
   * снова попросил категорию:
   *
   * "ладно, давай кино"
   *
   * убираем её из исключений.
   */
  const currentPositive =
    explicitCategoriesFromText(
      currentMessage,
    )

  for (
    const category
    of currentPositive
  ) {
    if (
      !currentExcluded.includes(
        category,
      )
    ) {
      result.delete(
        category,
      )
    }
  }

  return [
    ...result,
  ]
}

function latestPreviousEventIds(
  history: Array<{
    role:
      'user' |
      'assistant'

    content:
      string

    eventIds?:
      string[]
  }>,
) {
  for (
    let index =
      history.length - 1;
    index >= 0;
    index -= 1
  ) {
    const item =
      history[index]

    if (
      item?.role ===
        'assistant' &&
      item.eventIds &&
      item.eventIds.length >
        0
    ) {
      return item.eventIds
    }
  }

  return []
}

function refersToPreviousResults(
  message: string,
) {
  const text =
    normalizeText(
      message,
    )

  return /из этих|из них|из предлож|из вариант|из предыдущ|между ними|какое лучше|какой лучше|что лучше|выбери из|что из них/.test(
    text,
  )
}

function prefersCloser(
  message: string,
) {
  return /поближе|ближе|самое близк|самый близк/.test(
    normalizeText(
      message,
    ),
  )
}

function prefersCheaper(
  message: string,
) {
  return /подешевле|дешевле|самое дешев|самый дешев/.test(
    normalizeText(
      message,
    ),
  )
}

function looksLikeNewGeoRequest(
  message: string,
) {
  return /метро|станци|центр|улиц|район|парк|площад|проспект|набереж|около|возле|недалеко от|рядом с/.test(
    normalizeText(
      message,
    ),
  )
}

async function chooseConversationalEvents(
  message: string,

  history: Array<{
    role:
      'user' |
      'assistant'

    content:
      string

    eventIds?:
      string[]
  }>,

  candidates:
    ConversationalCandidate[],
) {
  if (
    candidates.length === 0
  ) {
    return {
      eventIds:
        [] as string[],

      answer:
        null as string | null,
    }
  }

  const ollamaUrl =
    (
      process.env
        .OLLAMA_BASE_URL ??
      'http://127.0.0.1:11434'
    ).replace(
      /\/$/,
      '',
    )

  /*
   * Для диалога пока используем
   * маленькую модель.
   *
   * Если потом сервер станет мощнее:
   * OLLAMA_RESPONSE_MODEL=qwen3:1.7b
   */
  const model =
    process.env
      .OLLAMA_RESPONSE_MODEL ??
    process.env
      .OLLAMA_INTENT_MODEL ??
    process.env
      .OLLAMA_MODEL ??
    'qwen3:0.6b'

  const historyText =
    history
      .slice(-6)
      .map(
        (item) => {
          const events =
            item.eventIds &&
            item.eventIds.length >
              0
              ? ` [eventIds: ${item.eventIds.join(', ')}]`
              : ''

          return `${
            item.role ===
              'user'
              ? 'Пользователь'
              : 'Evently'
          }: ${item.content}${events}`
        },
      )
      .join('\n')

  try {
    const response =
      await fetch(
        `${ollamaUrl}/api/chat`,
        {
          method:
            'POST',

          headers: {
            'Content-Type':
              'application/json',
          },

          signal:
            AbortSignal.timeout(
              OLLAMA_TIMEOUT_MS,
            ),

          body:
            JSON.stringify({
              model,

              stream:
                false,

              think:
                false,

              keep_alive:
                '30m',

              format:
                CONVERSATION_CHOICE_JSON_SCHEMA,

              options: {
                temperature:
                  0.4,

                num_predict:
                  450,

                num_ctx:
                  OLLAMA_CONVERSATION_CTX,
              },

              messages: [
                {
                  role:
                    'system',

                  content: [
                    '/no_think',

                    'Ты — Evently, дружелюбный и живой помощник по досугу. Общаешься на «ты», по-русски, как знающий друг, а не как справочник.',

                    'Тебе даны реальные мероприятия из базы Evently (кандидаты) и история разговора.',

                    'Задача 1: выбери от 1 до 4 кандидатов, которые лучше всего подходят под запрос с учётом истории (повод, настроение, компания, бюджет, время). Верни их id в eventIds — только id из списка кандидатов.',

                    'Задача 2: напиши answer — 2–5 предложений живого ответа. Сначала коротко отреагируй на запрос своими словами. Затем назови выбранные мероприятия по названию и для каждого одной фразой объясни, почему оно подходит.',

                    'Факты (название, когда, цена, место, расстояние) бери только из полей кандидата, дословно. Ничего не придумывай: ни событий, ни цен, ни дат, ни адресов.',

                    'Если кандидаты подходят под запрос плохо, честно скажи об этом и предложи лучшее из того, что есть.',

                    'Если запрос размытый, в конце задай один короткий уточняющий вопрос (например, про бюджет, время или настроение).',

                    'Без markdown, списков и ссылок. Не пересказывай эти инструкции.',

                    'Верни только JSON.',
                  ].join(' '),
                },

                {
                  role:
                    'user',

                  content: [
                    historyText
                      ? `История:\n${historyText}`
                      : '',

                    `Новое сообщение:\n${message}`,

                    `Реальные кандидаты:\n${JSON.stringify(candidates)}`,
                  ]
                    .filter(
                      Boolean,
                    )
                    .join(
                      '\n\n',
                    ),
                },
              ],
            }),
        },
      )

    if (
      !response.ok
    ) {
      throw new Error(
        `OLLAMA_CONVERSATION_${response.status}`,
      )
    }

    const body =
      (await response.json()) as OllamaResponse

    const content =
      body.message?.content

    if (!content) {
      throw new Error(
        'OLLAMA_CONVERSATION_EMPTY',
      )
    }

    const parsed =
      ConversationChoiceSchema.parse(
        JSON.parse(
          content,
        ),
      )

    const allowed =
      new Set(
        candidates.map(
          (candidate) =>
            candidate.id,
        ),
      )

    const eventIds =
      parsed.eventIds.filter(
        (id) =>
          allowed.has(id),
      )

    /*
     * Текст ответа описывает выбранные
     * события — без них он бессмыслен.
     */
    const answer =
      eventIds.length > 0 &&
      parsed.answer &&
      parsed.answer.length >= 20
        ? parsed.answer
        : null

    return {
      eventIds,
      answer,
    }
  } catch {
    return {
      eventIds:
        [] as string[],

      answer:
        null as string | null,
    }
  }
}

function factualFirstEventSentence(
  events: Array<{
    title: string
    price: string
    distanceKm: number | null
  }>,
) {
  const first =
    events[0]

  if (!first) {
    return ''
  }

  const distance =
    first.distanceKm !==
    null
      ? `, примерно ${first.distanceKm} км`
      : ''

  return `Первым посмотрел бы «${first.title}» — ${first.price}${distance}.`
}

function fallbackIntent(
  message: string,
): ExtractedIntent {
  const text =
    normalizeText(
      message,
    )

  const partySize =
    parsePartySize(
      text,
    ) ?? 1

  let date:
    ExtractedIntent['date'] =
      'any'

  if (
    text.includes(
      'сегодня',
    )
  ) {
    date =
      'today'
  } else if (
    text.includes(
      'завтра',
    )
  ) {
    date =
      'tomorrow'
  } else if (
    text.includes(
      'выходн',
    )
  ) {
    date =
      'weekend'
  }

  let timeOfDay:
    ExtractedIntent['timeOfDay'] =
      'any'

  if (
    /вечер|после работы/.test(
      text,
    )
  ) {
    timeOfDay =
      'evening'
  } else if (
    /утром|утро/.test(
      text,
    )
  ) {
    timeOfDay =
      'morning'
  } else if (
    /ночью|ночь/.test(
      text,
    )
  ) {
    timeOfDay =
      'night'
  }

  let occasion:
    ExtractedIntent['occasion'] =
      'any'

  if (
    /свидан|с девушк|с парнем|романтич|для пары/.test(
      text,
    )
  ) {
    occasion =
      'date'
  } else if (
    /с друзьями|компани/.test(
      text,
    )
  ) {
    occasion =
      'friends'
  } else if (
    /с детьми|семьей|семье/.test(
      text,
    )
  ) {
    occasion =
      'family'
  }

  return {
    city:
      null,

    place:
      null,

    nearMe:
      /рядом со мной|поблизости от меня|рядом с нами/.test(
        text,
      ),

    radiusKm:
      null,

    freeOnly:
      /бесплат|вход свобод/.test(
        text,
      ),

    budgetTotal:
      parseBudget(
        text,
      ),

    partySize,

    occasion,

    categories:
      explicitCategoriesFromText(
        text,
      ),

    date,

    timeOfDay,
  }
}

function applyDeterministicGuards(
  message: string,
  input: ExtractedIntent,
) {
  const text =
    normalizeText(
      message,
    )

  const result = {
    ...input,

    categories: [
      ...input.categories,
    ],
  }

  /*
   * Деньги / бесплатно / дата —
   * жёсткие условия.
   *
   * Не позволяем маленькой модели
   * случайно их потерять.
   */
  if (
    /бесплат|вход свобод/.test(
      text,
    )
  ) {
    result.freeOnly =
      true
  }

  const budget =
    parseBudget(
      text,
    )

  if (
    budget !== null
  ) {
    result.budgetTotal =
      budget
  }

  const partySize =
    parsePartySize(
      text,
    )

  if (
    partySize !== null
  ) {
    result.partySize =
      partySize
  }

  if (
    text.includes(
      'сегодня',
    )
  ) {
    result.date =
      'today'
  } else if (
    text.includes(
      'завтра',
    )
  ) {
    result.date =
      'tomorrow'
  } else if (
    text.includes(
      'выходн',
    )
  ) {
    result.date =
      'weekend'
  }

  if (
    /вечер|после работы/.test(
      text,
    )
  ) {
    result.timeOfDay =
      'evening'
  }

  const explicitCategories =
    explicitCategoriesFromText(
      text,
    )

  if (
    explicitCategories.length >
    0
  ) {
    result.categories =
      explicitCategories
  }

  if (
    /свидан|с девушк|с парнем|романтич|для пары/.test(
      text,
    )
  ) {
    result.occasion =
      'date'
  }

  if (
    /рядом со мной|поблизости от меня|рядом с нами/.test(
      text,
    )
  ) {
    result.nearMe =
      true
  }

  return result
}

const LocationIntentSchema = z.object({
  city: z
    .string()
    .trim()
    .min(1)
    .nullable(),

  place: z
    .string()
    .trim()
    .min(1)
    .nullable(),

  radiusKm: z
    .number()
    .min(1)
    .max(30)
    .nullable(),
})

const LOCATION_JSON_SCHEMA = {
  type: 'object',

  additionalProperties: false,

  properties: {
    city: {
      type: [
        'string',
        'null',
      ],
    },

    place: {
      type: [
        'string',
        'null',
      ],
    },

    radiusKm: {
      type: [
        'number',
        'null',
      ],

      minimum: 1,
      maximum: 30,
    },
  },

  required: [
    'city',
    'place',
    'radiusKm',
  ],
}

async function extractIntent(
  message: string,
  history: Array<{
    role: 'user' | 'assistant'
    content: string
  }>,
): Promise<ExtractedIntent> {
  /*
   * Все жёсткие параметры определяет
   * обычный код, а не маленькая LLM.
   *
   * Поэтому модель больше не может
   * внезапно придумать:
   * - "сегодня"
   * - "вечером"
   * - спорт
   * - кино
   * - nearMe
   * и т.д.
   */
  const base =
    fallbackIntent(message)

  const ollamaUrl =
    (
      process.env
        .OLLAMA_BASE_URL ??
      'http://127.0.0.1:11434'
    ).replace(
      /\/$/,
      '',
    )

  /*
   * Для такой маленькой задачи можно
   * использовать отдельную очень
   * маленькую модель.
   */
  const model =
    process.env
      .OLLAMA_INTENT_MODEL ??
    process.env
      .OLLAMA_MODEL ??
    'qwen3:1.7b'

  const historyText =
    history
      .slice(-4)
      .map(
        (item) =>
          `${
            item.role === 'user'
              ? 'Пользователь'
              : 'Evently'
          }: ${item.content}`,
      )
      .join('\n')

  try {
    const response =
      await fetch(
        `${ollamaUrl}/api/chat`,
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/json',
          },

          signal:
            AbortSignal.timeout(
              OLLAMA_TIMEOUT_MS,
            ),

          body:
            JSON.stringify({
              model,

              stream: false,

              think: false,

              keep_alive: '30m',

              format:
                LOCATION_JSON_SCHEMA,

              /*
               * Контекст теперь совсем
               * маленький.
               */
              options: {
                temperature: 0,
                num_predict: 80,
                num_ctx: 1024,
              },

              messages: [
                {
                  role: 'system',

                  content: [
                    '/no_think',

                    'Извлеки только географию из запроса пользователя.',

                    'city — явно указанный город. Если город не указан, null.',

                    'place — станция метро, район, улица, площадь, парк, достопримечательность или другая явно указанная точка.',

                    'Пример: "недалеко от метро Маяковская" -> place="метро Маяковская".',

                    'Пример: "в центре Москвы" -> city="Москва", place="центр Москвы".',

                    'Пример: "около Эрмитажа в Санкт-Петербурге" -> city="Санкт-Петербург", place="Эрмитаж".',

                    'Если пользователь не указал конкретное место, place=null.',

                    'Для слов "рядом", "недалеко", "около", "возле" radiusKm обычно 5.',

                    'Не извлекай категории, даты, бюджет, компанию или время суток.',

                    'Ничего не придумывай.',

                    'Верни только JSON.',
                  ].join(' '),
                },

                {
                  role: 'user',

                  content: [
                    historyText
                      ? `Предыдущий контекст:\n${historyText}`
                      : '',

                    `Запрос:\n${message}`,
                  ]
                    .filter(Boolean)
                    .join('\n\n'),
                },
              ],
            }),
        },
      )

    if (!response.ok) {
      throw new Error(
        `OLLAMA_LOCATION_${response.status}`,
      )
    }

    const body =
      (await response.json()) as OllamaResponse

    const content =
      body.message?.content

    if (!content) {
      throw new Error(
        'OLLAMA_LOCATION_EMPTY',
      )
    }

    const location =
      LocationIntentSchema.parse(
        JSON.parse(content),
      )

    /*
     * ВАЖНО:
     *
     * Берём от LLM только эти три поля.
     * Всё остальное остаётся тем, что
     * реально написал пользователь.
     */
    return {
      ...base,

      /*
       * "а что из них романтичнее?"
       * не должно забывать Маяковскую
       * из предыдущего запроса.
       */
      city:
        location.city ??
        base.city,

      place:
        location.place ??
        base.place,

      radiusKm:
        location.radiusKm ??
        base.radiusKm,
    }
  } catch {
    /*
     * Даже если Ollama не успела ответить,
     * Evently продолжит работать.
     */
    return base
  }
}

/*
 * ------------------------------------------------------------
 * GEO RESOLVER
 * ------------------------------------------------------------
 *
 * Первый запрос идёт в Nominatim.
 * После этого результат лежит в PostgreSQL
 * в таблице Place.
 */

let geocodeQueue:
  Promise<unknown> =
    Promise.resolve()

let lastGeocodeAt =
  0

function queuedGeocode<T>(
  operation:
    () => Promise<T>,
): Promise<T> {
  const run =
    geocodeQueue.then(
      async () => {
        const minInterval =
          Number(
            process.env
              .GEOCODER_MIN_INTERVAL_MS ??
              1100,
          )

        const elapsed =
          Date.now() -
          lastGeocodeAt

        const wait =
          Math.max(
            0,
            minInterval -
              elapsed,
          )

        if (
          wait > 0
        ) {
          await new Promise(
            (resolve) =>
              setTimeout(
                resolve,
                wait,
              ),
          )
        }

        lastGeocodeAt =
          Date.now()

        return operation()
      },
    )

  geocodeQueue =
    run.then(
      () =>
        undefined,

      () =>
        undefined,
    )

  return run
}

function geocodeCacheKey(
  city: string | null,
  place: string,
) {
  return normalizeText(
    `${city ?? ''}|${place}`,
  )
}

function resultCity(
  item: NominatimResult,
) {
  return (
    item.address?.city ??
    item.address?.town ??
    item.address?.village ??
    item.address?.municipality ??
    null
  )
}

function geocodeScore(
  item: NominatimResult,
  place: string,
  city: string | null,
) {
  const display =
    normalizeText(
      item.display_name,
    )

  const normalizedPlace =
    normalizeText(
      place,
    )

  let score =
    0

  if (
    display.includes(
      normalizedPlace,
    )
  ) {
    score +=
      20
  }

  if (
    city &&
    display.includes(
      normalizeText(
        city,
      ),
    )
  ) {
    score +=
      12
  }

  if (
    /метро|станц/.test(
      normalizedPlace,
    )
  ) {
    if (
      item.category ===
        'railway' ||
      /station|subway|halt/.test(
        item.type ?? '',
      )
    ) {
      score +=
        20
    }
  }

  return score
}

async function resolvePlace(
  place: string,
  city: string | null,
): Promise<ResolvedGeo | null> {
  const queryKey =
    geocodeCacheKey(
      city,
      place,
    )

  const cached =
    await prisma.place.findUnique({
      where: {
        queryKey,
      },
    })

  if (cached) {
    return {
      label:
        cached.name,

      latitude:
        cached.latitude,

      longitude:
        cached.longitude,

      city:
        cached.city,

      cached:
        true,

      provider:
        'nominatim',
    }
  }

  const baseUrl =
    (
      process.env
        .GEOCODER_BASE_URL ??
      'https://nominatim.openstreetmap.org'
    ).replace(
      /\/$/,
      '',
    )

  const normalizedPlace =
    normalizeText(
      place,
    )

  /*
   * "центр Москвы" — ищем сам город
   * и используем его центральную координату.
   *
   * Это общее правило,
   * а не список конкретных городов.
   */
  const looksLikeCenter =
    /\bцентр\b/.test(
      normalizedPlace,
    )

  const query =
    looksLikeCenter &&
    city
      ? city
      : [
          place,
          city,
        ]
          .filter(
            Boolean,
          )
          .join(
            ', ',
          )

  return queuedGeocode(
    async () => {
      const params =
        new URLSearchParams({
          q:
            query,

          format:
            'jsonv2',

          limit:
            '5',

          addressdetails:
            '1',

          'accept-language':
            'ru',
        })

      const countryCodes =
        process.env
          .GEOCODER_COUNTRY_CODES
          ?.trim()

      if (
        countryCodes
      ) {
        params.set(
          'countrycodes',
          countryCodes,
        )
      }

      const response =
        await fetch(
          `${baseUrl}/search?${params.toString()}`,
          {
            headers: {
              Accept:
                'application/json',

              'User-Agent':
                process.env
                  .GEOCODER_USER_AGENT ??
                'EventlyHackathon/0.1',
            },

            signal:
              AbortSignal.timeout(
                12_000,
              ),
          },
        )

      if (
        !response.ok
      ) {
        return null
      }

      const items =
        (await response.json()) as NominatimResult[]

      const best =
        [...items]
          .sort(
            (a, b) =>
              geocodeScore(
                b,
                place,
                city,
              ) -
              geocodeScore(
                a,
                place,
                city,
              ),
          )[0]

      if (!best) {
        return null
      }

      const latitude =
        Number(
          best.lat,
        )

      const longitude =
        Number(
          best.lon,
        )

      if (
        !Number.isFinite(
          latitude,
        ) ||
        !Number.isFinite(
          longitude,
        )
      ) {
        return null
      }

      const detectedCity =
        resultCity(
          best,
        ) ??
        city

      const externalId =
        best.osm_type &&
        best.osm_id
          ? `${best.osm_type}:${best.osm_id}`
          : String(
              best.place_id,
            )

      const saved =
        await prisma.place.upsert({
          where: {
            queryKey,
          },

          update: {
            query,

            name:
              best.name ??
              place,

            displayName:
              best.display_name,

            city:
              detectedCity,

            countryCode:
              best.address
                ?.country_code ??
              null,

            latitude,
            longitude,

            provider:
              'nominatim',

            externalId,
          },

          create: {
            queryKey,

            query,

            name:
              best.name ??
              place,

            displayName:
              best.display_name,

            city:
              detectedCity,

            countryCode:
              best.address
                ?.country_code ??
              null,

            latitude,
            longitude,

            provider:
              'nominatim',

            externalId,
          },
        })

      return {
        label:
          saved.name,

        latitude:
          saved.latitude,

        longitude:
          saved.longitude,

        city:
          saved.city,

        cached:
          false,

        provider:
          'nominatim',
      }
    },
  )
}

function haversineKm(
  latitude1: number,
  longitude1: number,
  latitude2: number,
  longitude2: number,
) {
  const toRadians =
    (value: number) =>
      value *
      Math.PI /
      180

  const radius =
    6371

  const dLat =
    toRadians(
      latitude2 -
      latitude1,
    )

  const dLon =
    toRadians(
      longitude2 -
      longitude1,
    )

  const lat1 =
    toRadians(
      latitude1,
    )

  const lat2 =
    toRadians(
      latitude2,
    )

  const a =
    Math.sin(
      dLat / 2,
    ) ** 2 +
    Math.cos(
      lat1,
    ) *
      Math.cos(
        lat2,
      ) *
      Math.sin(
        dLon / 2,
      ) ** 2

  return (
    radius *
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a),
    )
  )
}

function moscowDateParts(
  date: Date,
) {
  const parts =
    new Intl.DateTimeFormat(
      'en-CA',
      {
        timeZone:
          'Europe/Moscow',

        year:
          'numeric',

        month:
          '2-digit',

        day:
          '2-digit',
      },
    ).formatToParts(
      date,
    )

  const get =
    (type: string) =>
      parts.find(
        (item) =>
          item.type ===
          type,
      )?.value ?? ''

  return {
    year:
      Number(
        get('year'),
      ),

    month:
      Number(
        get('month'),
      ),

    day:
      Number(
        get('day'),
      ),
  }
}

function addDays(
  value: {
    year: number
    month: number
    day: number
  },
  days: number,
) {
  const date =
    new Date(
      Date.UTC(
        value.year,
        value.month - 1,
        value.day + days,
        12,
      ),
    )

  return {
    year:
      date.getUTCFullYear(),

    month:
      date.getUTCMonth() +
      1,

    day:
      date.getUTCDate(),
  }
}

function moscowBoundary(
  value: {
    year: number
    month: number
    day: number
  },
) {
  return new Date(
    `${String(value.year).padStart(4, '0')}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}T00:00:00+03:00`,
  )
}

function dateWindow(
  mode:
    ExtractedIntent['date'],
  now: Date,
): EventTimeWindow | null {
  if (
    mode === 'any'
  ) {
    return null
  }

  const today =
    moscowDateParts(
      now,
    )

  if (
    mode === 'today'
  ) {
    return {
      start:
        now,

      end:
        moscowBoundary(
          addDays(
            today,
            1,
          ),
        ),
    }
  }

  if (
    mode === 'tomorrow'
  ) {
    return {
      start:
        moscowBoundary(
          addDays(
            today,
            1,
          ),
        ),

      end:
        moscowBoundary(
          addDays(
            today,
            2,
          ),
        ),
    }
  }

  const noon =
    new Date(
      `${String(today.year).padStart(4, '0')}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}T12:00:00+03:00`,
    )

  const weekday =
    noon.getUTCDay()

  let untilSaturday =
    (
      6 -
      weekday +
      7
    ) % 7

  if (
    weekday === 0
  ) {
    untilSaturday =
      -1
  }

  const saturday =
    addDays(
      today,
      untilSaturday,
    )

  return {
    start:
      untilSaturday <
      0
        ? now
        : moscowBoundary(
            saturday,
          ),

    end:
      moscowBoundary(
        addDays(
          saturday,
          2,
        ),
      ),
  }
}

function moscowHour(
  date: Date,
) {
  return Number(
    new Intl.DateTimeFormat(
      'en-US',
      {
        timeZone:
          'Europe/Moscow',

        hour:
          '2-digit',

        hourCycle:
          'h23',
      },
    ).format(
      date,
    ),
  )
}

function timeMatches(
  date: Date,
  mode:
    ExtractedIntent['timeOfDay'],
) {
  if (
    mode === 'any'
  ) {
    return true
  }

  const hour =
    moscowHour(
      date,
    )

  if (
    mode === 'morning'
  ) {
    return (
      hour >= 5 &&
      hour < 12
    )
  }

  if (
    mode === 'day'
  ) {
    return (
      hour >= 12 &&
      hour < 17
    )
  }

  if (
    mode === 'evening'
  ) {
    return (
      hour >= 17 &&
      hour < 23
    )
  }

  return (
    hour >= 23 ||
    hour < 5
  )
}

function isEffectivelyFree(
  event: {
    isFree:
      boolean

    priceMin:
      number | null

    title:
      string

    shortDescription:
      string | null

    description:
      string | null
  },
) {
  if (
    event.isFree ||
    event.priceMin ===
      0
  ) {
    return true
  }

  if (
    event.priceMin !==
    null
  ) {
    return false
  }

  const text =
    normalizeText(
      [
        event.title,

        event.shortDescription ??
          '',

        event.description ??
          '',
      ].join(
        ' ',
      ),
    )

  return /вход свобод|бесплатн/.test(
    text,
  )
}

function formatPrice(
  event: {
    isFree:
      boolean

    priceMin:
      number | null

    priceMax:
      number | null

    currency:
      string

    title:
      string

    shortDescription:
      string | null

    description:
      string | null
  },
) {
  if (
    isEffectivelyFree(
      event,
    )
  ) {
    return 'Бесплатно'
  }

  const currency =
    event.currency ===
    'RUB'
      ? '₽'
      : event.currency

  if (
    event.priceMin !==
      null &&
    event.priceMax !==
      null &&
    event.priceMin !==
      event.priceMax
  ) {
    return `${event.priceMin}–${event.priceMax} ${currency}`
  }

  if (
    event.priceMin !==
    null
  ) {
    return `от ${event.priceMin} ${currency}`
  }

  return 'Цена не указана'
}

function occasionBoost(
  categories:
    string[],
  occasion:
    ExtractedIntent['occasion'],
) {
  if (
    occasion ===
    'date'
  ) {
    const preferred =
      new Set([
        'theatre',
        'exhibition',
        'concert',
        'cinema',
        'tour',
      ])

    return categories.some(
      (category) =>
        preferred.has(
          category,
        ),
    )
      ? 8
      : 0
  }

  if (
    occasion ===
    'friends'
  ) {
    const preferred =
      new Set([
        'party',
        'games',
        'standup',
        'concert',
        'sport',
      ])

    return categories.some(
      (category) =>
        preferred.has(
          category,
        ),
    )
      ? 8
      : 0
  }

  if (
    occasion ===
    'family'
  ) {
    const preferred =
      new Set([
        'family',
        'theatre',
        'cinema',
        'exhibition',
      ])

    return categories.some(
      (category) =>
        preferred.has(
          category,
        ),
    )
      ? 8
      : 0
  }

  return 0
}

/*
 * ------------------------------------------------------------
 * TEXT SIGNALS
 * ------------------------------------------------------------
 *
 * Категории парсера грубые: научная
 * конференция или детские чтения в
 * библиотеке для кода выглядят так же,
 * как концерт. Поэтому дополнительно
 * смотрим на текст события.
 */

/*
 * Деловые и учебные мероприятия —
 * не досуг. Штраф, если пользователь
 * сам не просил лекции.
 */
const BUSINESS_EVENT_RE =
  /конференц|семинар|вебинар|форум|симпозиум|научно-практ|заседани|собрани|совещани|круглый стол|повышени. квалификац/

const OCCASION_TEXT_SIGNALS: Record<
  'date' | 'friends' | 'family',
  {
    plus: RegExp
    minus: RegExp
  }
> = {
  date: {
    plus:
      /романтич|свидан|для двоих|для пар|джаз|вин(о|а|ный|ная)|дегустац|ужин|концерт|спектакл|балет|опер[аы]|мюзикл|кинопоказ|мастер-класс|прогулк|экскурси|фестивал|выставк|стендап|органн|при свечах|свечи/,
    minus:
      /детск|для детей|малыш|дошкольн|школьник|родител|семейн|библиотек|лекци|кружок|утренник/,
  },

  friends: {
    plus:
      /вечеринк|квиз|квест|стендап|фестивал|концерт|бар|настольн|игр[аыу]|караоке|тусовк|рейв/,
    minus:
      /детск|для детей|малыш|дошкольн|утренник|библиотек/,
  },

  family: {
    plus:
      /детск|для детей|семейн|малыш|мульт|сказк|кукольн|для всей семьи|родител/,
    minus:
      /18\+|вечеринк|бар|стендап|рейв|вино|дегустац/,
  },
}

function eventTextScore(
  event: {
    title: string
    shortDescription: string | null
    description: string | null
  },
  occasion:
    ExtractedIntent['occasion'],
  educationRequested: boolean,
) {
  const titleText =
    normalizeText(
      event.title,
    )

  const fullText =
    normalizeText(
      [
        event.title,
        event.shortDescription ?? '',
        (event.description ?? '').slice(
          0,
          400,
        ),
      ].join(' '),
    )

  let score = 0

  if (
    !educationRequested &&
    BUSINESS_EVENT_RE.test(
      titleText,
    )
  ) {
    score -= 10
  }

  if (
    occasion === 'date' ||
    occasion === 'friends' ||
    occasion === 'family'
  ) {
    const signals =
      OCCASION_TEXT_SIGNALS[
        occasion
      ]

    if (
      signals.plus.test(
        fullText,
      )
    ) {
      score += 4
    }

    if (
      signals.minus.test(
        fullText,
      )
    ) {
      score -= 7
    }
  }

  return score
}

/*
 * Шортлист для LLM: не больше
 * maxPerCategory событий одной
 * (первой) категории, чтобы модели
 * было из чего выбирать.
 */
function diverseShortlist<
  T extends {
    event: {
      categories: Array<{
        category: {
          slug: string
        }
      }>
    }
  },
>(
  ranked: T[],
  size: number,
  maxPerCategory = 3,
) {
  const result: T[] = []
  const skipped: T[] = []
  const perCategory =
    new Map<string, number>()

  for (const item of ranked) {
    if (result.length >= size) {
      break
    }

    const slug =
      item.event.categories[0]
        ?.category.slug ??
      'none'

    const count =
      perCategory.get(slug) ?? 0

    if (count >= maxPerCategory) {
      skipped.push(item)
      continue
    }

    perCategory.set(
      slug,
      count + 1,
    )

    result.push(item)
  }

  /*
   * Если разнообразия не хватило —
   * добираем лучшими из пропущенных.
   */
  for (const item of skipped) {
    if (result.length >= size) {
      break
    }

    result.push(item)
  }

  return result
}

function formatVariantCount(
  count: number,
) {
  return count === 1
    ? '1 вариант'
    : `${count} варианта`
}

function buildAnswer(
  events: Array<{
    title:
      string

    price:
      string

    distanceKm:
      number | null
  }>,
  intent:
    ExtractedIntent,
  geo:
    ResolvedGeo | null,
  searchMode:
    'strict' |
    'relaxed' |
    'city' |
    'none',
  geoFailed:
    boolean,
) {
  if (
    events.length === 0
  ) {
    if (
      intent.freeOnly
    ) {
      return 'В текущей афише не нашёл бесплатных вариантов по этим условиям. Платные события специально не подмешиваю.'
    }

    return 'По этим условиям в текущей афише ничего подходящего не нашлось. Попробуй немного расширить запрос.'
  }

  const count =
    events.length

  let prefix =
    `Нашёл ${formatVariantCount(count)} из афиши Evently.`

  if (
    intent.freeOnly
  ) {
    prefix =
      count === 1
        ? 'Нашёл 1 бесплатный вариант.'
        : `Нашёл ${count} бесплатных варианта.`
  }

  if (
    geo &&
    searchMode ===
      'strict'
  ) {
    prefix +=
      ` Все рядом с «${geo.label}».`
  }

  if (
    geo &&
    searchMode ===
      'relaxed'
  ) {
    prefix +=
      ` Совсем рядом с «${geo.label}» выбор маленький, поэтому немного расширил радиус.`
  }

  if (
    geo &&
    searchMode ===
      'city'
  ) {
    prefix +=
      ` Рядом с «${geo.label}» вариантов мало, поэтому добавил подходящие по городу.`
  }

  if (
    geoFailed &&
    intent.place
  ) {
    prefix +=
      ` Точно определить «${intent.place}» на карте не получилось, поэтому ищу по городу.`
  }

  const first =
    events[0]

  if (!first) {
    return prefix
  }

  const distance =
    first.distanceKm !==
    null
      ? `, примерно ${first.distanceKm} км`
      : ''

  return `${prefix} Первым посмотрел бы «${first.title}» — ${first.price}${distance}.`
}

export async function aiRoutes(
  app:
    FastifyInstance,
) {
  /*
   * ----------------------------------------------------------
   * IMAGE PROXY
   * ----------------------------------------------------------
   */

  app.get(
    '/image/:eventId',

    async (
      request,
      reply,
    ) => {
      const parsed =
        ImageParamsSchema.safeParse(
          request.params,
        )

      if (
        !parsed.success
      ) {
        return reply
          .status(400)
          .send({
            error:
              'INVALID_EVENT_ID',
          })
      }

      const event =
        await prisma.event.findFirst({
          where: {
            id:
              parsed.data.eventId,

            status:
              'ACTIVE',
          },

          select: {
            images: {
              orderBy: {
                position:
                  'asc',
              },

              take:
                1,

              select: {
                url:
                  true,
              },
            },
          },
        })

      const sourceUrl =
        event
          ?.images[0]
          ?.url

      if (!sourceUrl) {
        return reply
          .status(404)
          .send({
            error:
              'IMAGE_NOT_FOUND',
          })
      }

      if (
        sourceUrl.startsWith(
          '/media/',
        )
      ) {
        return reply.redirect(
          sourceUrl,
        )
      }

      let url: URL

      try {
        url =
          new URL(
            sourceUrl,
          )
      } catch {
        return reply
          .status(404)
          .send({
            error:
              'INVALID_IMAGE_URL',
          })
      }

      const allowedHosts =
        new Set(
          (
            process.env
              .AI_IMAGE_ALLOWED_HOSTS ??
            'media.kudago.com'
          )
            .split(',')
            .map(
              (host) =>
                host.trim(),
            )
            .filter(
              Boolean,
            ),
        )

      if (
        url.protocol !==
          'https:' ||
        !allowedHosts.has(
          url.hostname,
        )
      ) {
        return reply
          .status(404)
          .send({
            error:
              'IMAGE_HOST_NOT_ALLOWED',
          })
      }

      try {
        const upstream =
          await fetch(
            sourceUrl,
            {
              headers: {
                Accept:
                  'image/*,*/*;q=0.8',

                'User-Agent':
                  'Evently/1.0',
              },

              signal:
                AbortSignal.timeout(
                  15_000,
                ),
            },
          )

        if (
          !upstream.ok
        ) {
          return reply
            .status(404)
            .send({
              error:
                'IMAGE_UPSTREAM_FAILED',
            })
        }

        const buffer =
          Buffer.from(
            await upstream.arrayBuffer(),
          )

        if (
          buffer.length >
          15 * 1024 * 1024
        ) {
          return reply
            .status(413)
            .send({
              error:
                'IMAGE_TOO_LARGE',
            })
        }

        let contentType =
          upstream.headers.get(
            'content-type',
          )

        if (
          !contentType ||
          !contentType.startsWith(
            'image/',
          )
        ) {
          contentType =
            'image/jpeg'
        }

        reply.header(
          'Content-Type',
          contentType,
        )

        reply.header(
          'Cache-Control',
          'public, max-age=86400',
        )

        return reply.send(
          buffer,
        )
      } catch {
        return reply
          .status(404)
          .send({
            error:
              'IMAGE_PROXY_FAILED',
          })
      }
    },
  )

  /*
   * ----------------------------------------------------------
   * AI CHAT
   * ----------------------------------------------------------
   */

  app.post(
    '/chat',

    async (
      request,
      reply,
    ) => {
      const parsed =
        ChatBodySchema.safeParse(
          request.body,
        )

      if (
        !parsed.success
      ) {
        return reply
          .status(400)
          .send({
            error:
              'INVALID_AI_REQUEST',

            details:
              parsed.error.flatten(),
          })
      }

      const {
        message,
        history,
      } =
        parsed.data

      /*
       * Единственный LLM-вызов.
       *
       * На Ryzen 3 это намного быстрее,
       * чем отдельно парсить запрос,
       * а потом ещё раз просить Qwen
       * ранжировать мероприятия.
       */
      const intent =
        await extractIntent(
          message,
          history,
        )

      const defaultCity =
        parsed.data.city ??
        process.env
          .EVENTLY_DEFAULT_CITY ??
        null

      const effectiveCity =
        intent.city ??
        defaultCity

      let geo:
        ResolvedGeo | null =
          null

      let geoFailed =
        false

      /*
       * "рядом со мной"
       */
      if (
        intent.nearMe &&
        parsed.data.latitude !==
          undefined &&
        parsed.data.longitude !==
          undefined
      ) {
        geo = {
          label:
            'вашей геопозицией',

          latitude:
            parsed.data.latitude,

          longitude:
            parsed.data.longitude,

          city:
            effectiveCity,

          cached:
            true,

          provider:
            'user',
        }
      } else if (
        intent.place
      ) {
        /*
         * Любой город / метро / улица /
         * район / парк / достопримечательность.
         *
         * Никаких MOSCOW_PLACES.
         */
        geo =
          await resolvePlace(
            intent.place,
            effectiveCity,
          )

        geoFailed =
          !geo
      }

      const now =
        new Date()

      const window =
        dateWindow(
          intent.date,
          now,
        )

      const maxTicketPrice =
        intent.budgetTotal !==
        null
          ? Math.max(
              1,
              Math.floor(
                intent.budgetTotal /
                  Math.max(
                    intent.partySize,
                    1,
                  ),
              ),
            )
          : null

      /*
       * ------------------------------------------------------
       * CONVERSATION STATE
       * ------------------------------------------------------
       */

      const previousEventIds =
        latestPreviousEventIds(
          history,
        )

      const previousEventSet =
        new Set(
          previousEventIds,
        )

      const shownEventIds =
        new Set(
          history.flatMap(
            (item) =>
              item.eventIds ?? [],
          ),
        )

      const moreOptions =
        wantsMoreOptions(
          message,
        )

      const excludedCategories =
        collectExcludedCategories(
          message,
          history,
        )

      const negativeTerms =
        collectNegativeTerms(
          message,
          history,
        )

      const preferCloser =
        prefersCloser(
          message,
        )

      const preferCheaper =
        prefersCheaper(
          message,
        )

      const explicitPreviousReference =
        refersToPreviousResults(
          message,
        )

      /*
       * Короткие follow-up запросы:
       *
       * "а что романтичнее?"
       * "покажи поближе"
       * "а что дешевле?"
       *
       * логично применять к карточкам,
       * которые пользователь уже видит.
       */
      const softFollowUp =
        previousEventIds.length >
          0 &&
        !looksLikeNewGeoRequest(
          message,
        ) &&
        (
          preferCloser ||
          preferCheaper ||
          /романтич|повесел|весел|спокойн|необычн|интереснее|лучше/.test(
            normalizeText(
              message,
            ),
          )
        )

      const usePreviousResults =
        previousEventIds.length >
          0 &&
        (
          explicitPreviousReference ||
          softFollowUp
        )

      /*
       * Берём весь актуальный каталог.
       *
       * Не делаем старую ошибку:
       * take 120 -> потом filter.
       */
      const events =
        await prisma.event.findMany({
          where: {
            status:
              'ACTIVE',

            // Только основные события,
            // без дубликатов из других
            // источников.
            duplicateOfId:
              null,

            ...(parsed.data.city
              ? {
                  sourceCity:
                    parsed.data.city,
                }
              : {}),

            OR: [
              {
                occurrences: {
                  none: {},
                },
              },

              {
                occurrences: {
                  some: {
                    startsAt: {
                      gte:
                        now,
                    },
                  },
                },
              },
            ],
          },

          include: {
            venue: {
              select: {
                name:
                  true,

                address:
                  true,

                city:
                  true,

                latitude:
                  true,

                longitude:
                  true,
              },
            },

            occurrences: {
              where: {
                startsAt: {
                  gte:
                    now,
                },
              },

              orderBy: {
                startsAt:
                  'asc',
              },

              take:
                12,

              select: {
                startsAt:
                  true,

                endsAt:
                  true,
              },
            },

            images: {
              orderBy: {
                position:
                  'asc',
              },

              take:
                1,

              select: {
                url:
                  true,
              },
            },

            categories: {
              include: {
                category: {
                  select: {
                    slug:
                      true,

                    name:
                      true,
                  },
                },
              },
            },
          },
        })

      function rankEvents(
        maximumDistanceKm:
          number | null,
      ) {
        return events
          .map(
            (event) => {
              let score =
                Number(
                  event.popularityScore ??
                    0,
                ) * 0.05

              const categorySlugs =
                event.categories.map(
                  (item) =>
                    item.category.slug,
                )

              /*
               * "из этих какое лучше?"
               *
               * Работаем именно с карточками
               * прошлого ответа.
               */
              if (
                usePreviousResults &&
                !previousEventSet.has(
                  event.id,
                )
              ) {
                return null
              }

              /*
               * "ещё варианты"
               * "покажи другое"
               *
               * Уже показанные карточки больше
               * не возвращаем.
               */
              if (
                moreOptions &&
                shownEventIds.has(
                  event.id,
                )
              ) {
                return null
              }

              /*
               * "не кино"
               * "только не выставку"
               *
               * Сначала категория.
               */
              if (
                excludedCategories.length >
                  0 &&
                categorySlugs.some(
                  (slug) =>
                    excludedCategories.includes(
                      slug as typeof CATEGORY_SLUGS[number],
                    ),
                )
              ) {
                return null
              }

              /*
               * Потом проверяем сам текст
               * события.
               *
               * Это важно, потому что
               * парсер может присвоить
               * музейному событию другую
               * категорию или вообще
               * потерять категорию.
               */
              if (
                eventMatchesNegativeTerms(
                  event,
                  negativeTerms,
                )
              ) {
                return null
              }

              /*
               * Явно попросил театр?
               * Значит круиз не показываем.
               */
              if (
                intent.categories.length >
                  0 &&
                !categorySlugs.some(
                  (slug) =>
                    intent.categories.includes(
                      slug as typeof CATEGORY_SLUGS[number],
                    ),
                )
              ) {
                return null
              }

              const free =
                isEffectivelyFree(
                  event,
                )

              /*
               * Бесплатно — жёсткий фильтр.
               */
              if (
                intent.freeOnly
              ) {
                if (!free) {
                  return null
                }

                score +=
                  15
              }

              /*
               * Бюджет — тоже жёсткий.
               */
              if (
                maxTicketPrice !==
                null
              ) {
                if (free) {
                  score +=
                    10
                } else if (
                  event.priceMin !==
                  null
                ) {
                  if (
                    event.priceMin >
                    maxTicketPrice
                  ) {
                    return null
                  }

                  score +=
                    8
                } else {
                  return null
                }
              }

              score +=
                occasionBoost(
                  categorySlugs,
                  intent.occasion,
                )

              score +=
                eventTextScore(
                  event,
                  intent.occasion,
                  intent.categories.includes(
                    'education',
                  ),
                )

              /*
               * Подбираем правильный сеанс.
               */
              let matchingOccurrences =
                event.occurrences

              if (
                window
              ) {
                matchingOccurrences =
                  matchingOccurrences.filter(
                    (occurrence) =>
                      occurrence.startsAt >=
                        window.start &&
                      occurrence.startsAt <
                        window.end,
                  )
              }

              if (
                intent.timeOfDay !==
                'any'
              ) {
                matchingOccurrences =
                  matchingOccurrences.filter(
                    (occurrence) =>
                      timeMatches(
                        occurrence.startsAt,
                        intent.timeOfDay,
                      ),
                  )
              }

              /*
               * Если у события есть известные
               * сеансы, но ни один не подходит —
               * событие убираем.
               *
               * Если sessions вообще нет,
               * оставляем с небольшим штрафом:
               * в данных есть постоянные
               * выставки без occurrences.
               */
              const hasSchedule =
                event.occurrences.length >
                0

              const scheduleWasRequested =
                intent.date !==
                  'any' ||
                intent.timeOfDay !==
                  'any'

              if (
                scheduleWasRequested &&
                hasSchedule &&
                matchingOccurrences.length ===
                  0
              ) {
                return null
              }

              if (
                scheduleWasRequested &&
                !hasSchedule
              ) {
                score -=
                  3
              }

              if (
                matchingOccurrences.length >
                0
              ) {
                score +=
                  8
              }

              const selectedOccurrence =
                matchingOccurrences[0] ??
                event.occurrences[0] ??
                null

              let distanceKm:
                number | null =
                  null

              if (
                geo
              ) {
                const latitude =
                  event.venue
                    ?.latitude

                const longitude =
                  event.venue
                    ?.longitude

                if (
                  latitude !==
                    null &&
                  latitude !==
                    undefined &&
                  longitude !==
                    null &&
                  longitude !==
                    undefined
                ) {
                  distanceKm =
                    haversineKm(
                      geo.latitude,
                      geo.longitude,
                      latitude,
                      longitude,
                    )

                  if (
                    maximumDistanceKm !==
                      null &&
                    distanceKm >
                      maximumDistanceKm
                  ) {
                    return null
                  }

                  /*
                   * Ближе = выше.
                   */
                  score +=
                    Math.max(
                      0,
                      20 -
                        distanceKm *
                          2,
                    )
                } else if (
                  maximumDistanceKm !==
                  null
                ) {
                  return null
                } else {
                  score -=
                    8
                }
              }

              if (free) {
                score +=
                  2
              }

              return {
                event,

                score,

                distanceKm,

                selectedOccurrence,
              }
            },
          )
          .filter(
            (
              item,
            ): item is NonNullable<
              typeof item
            > =>
              Boolean(item),
          )
          .sort(
            (a, b) =>
              b.score -
              a.score,
          )
      }

      let searchMode:
        'strict' |
        'relaxed' |
        'city' |
        'none' =
          geo
            ? 'strict'
            : 'none'

      const defaultRadius =
        Number(
          process.env
            .GEO_DEFAULT_RADIUS_KM ??
            4,
        )

      const strictRadius =
        intent.radiusKm ??
        defaultRadius

      let ranked =
        geo
          ? rankEvents(
              strictRadius,
            )
          : rankEvents(
              null,
            )

      /*
       * Географию ослабляем постепенно.
       *
       * Бесплатность / бюджет /
       * категория / дата сохраняются.
       */
      if (
        geo &&
        ranked.length < 3
      ) {
        const relaxedRadius =
          Math.max(
            12,
            strictRadius *
              3,
          )

        const relaxed =
          rankEvents(
            relaxedRadius,
          )

        if (
          relaxed.length >
          ranked.length
        ) {
          ranked =
            relaxed

          searchMode =
            'relaxed'
        }
      }

      if (
        geo &&
        ranked.length < 3
      ) {
        const cityWide =
          rankEvents(
            null,
          )

        if (
          cityWide.length >
          ranked.length
        ) {
          ranked =
            cityWide

          searchMode =
            'city'
        }
      }

      /*
       * Follow-up "поближе" / "подешевле"
       * можно сначала переставить
       * детерминированно.
       */
      if (
        preferCloser
      ) {
        ranked =
          [...ranked].sort(
            (a, b) => {
              const aDistance =
                a.distanceKm ??
                Number.POSITIVE_INFINITY

              const bDistance =
                b.distanceKm ??
                Number.POSITIVE_INFINITY

              return (
                aDistance -
                bDistance
              )
            },
          )
      } else if (
        preferCheaper
      ) {
        ranked =
          [...ranked].sort(
            (a, b) => {
              const price = (
                item:
                  typeof a,
              ) => {
                if (
                  isEffectivelyFree(
                    item.event,
                  )
                ) {
                  return 0
                }

                return (
                  item.event.priceMin ??
                  Number.POSITIVE_INFINITY
                )
              }

              return (
                price(a) -
                price(b)
              )
            },
          )
      }

      /*
       * Код оставляет максимум 8
       * настоящих кандидатов.
       *
       * И только теперь LLM делает
       * "человеческий" выбор между ними.
       */
      const shortlist =
        diverseShortlist(
          ranked,
          8,
        )

      const conversationChoice =
        await chooseConversationalEvents(
          message,

          history,

          shortlist.map(
            ({
              event,
              distanceKm,
              selectedOccurrence,
            }) => ({
              id:
                event.id,

              title:
                event.title,

              categories:
                event.categories.map(
                  (item) =>
                    item.category.slug,
                ),

              price:
                formatPrice(
                  event,
                ),

              venue:
                event.venue
                  ?.name ??
                null,

              distanceKm:
                distanceKm !==
                null
                  ? Number(
                      distanceKm.toFixed(
                        1,
                      ),
                    )
                  : null,

              when:
                selectedOccurrence
                  ? formatEventWhen(
                      selectedOccurrence.startsAt,
                      event.sourceCity,
                    )
                  : null,

              description:
                (
                  event.shortDescription ??
                  event.description ??
                  ''
                ).slice(
                  0,
                  180,
                ),
            }),
          ),
        )

      const shortlistById =
        new Map(
          shortlist.map(
            (item) =>
              [
                item.event.id,
                item,
              ] as const,
          ),
        )

      let selected =
        conversationChoice
          .eventIds
          .flatMap(
            (id) => {
              const item =
                shortlistById.get(
                  id,
                )

              return item
                ? [item]
                : []
            },
          )

      /*
       * Если маленькая модель дала
       * невалидный ответ — приложение
       * всё равно продолжает работать.
       */
      if (
        selected.length ===
        0
      ) {
        selected =
          shortlist.slice(
            0,
            4,
          )
      }

      const apiEvents =
        selected.map(
          ({
            event,
            distanceKm,
            selectedOccurrence,
          }) => ({
            id:
              event.id,

            title:
              event.title,

            imageUrl:
              event.images[0]
                ?.url
                ? `/api/ai/image/${event.id}`
                : null,

            venue:
              event.venue
                ?.name ??
              null,

            address:
              event.venue
                ?.address ??
              null,

            price:
              formatPrice(
                event,
              ),

            startsAt:
              selectedOccurrence
                ?.startsAt
                .toISOString() ??
              null,

            distanceKm:
              distanceKm !==
              null
                ? Number(
                    distanceKm.toFixed(
                      1,
                    ),
                  )
                : null,

            url:
              event.ticketUrl ??
              event.sourceUrl,
          }),
        )

      const factualEvents =
        apiEvents.map(
          (event) => ({
            title:
              event.title,

            price:
              event.price,

            distanceKm:
              event.distanceKm,
          }),
        )

      const fallbackAnswer =
        buildAnswer(
          factualEvents,

          intent,

          geo,

          searchMode,

          geoFailed,
        )

      /*
       * Ответ пишет модель целиком.
       * Если её нет или ответ невалидный —
       * шаблонный ответ кодом.
       */
      const conversationalAnswer =
        conversationChoice.answer &&
        apiEvents.length > 0
          ? conversationChoice.answer
          : fallbackAnswer

      return {
        answer:
          conversationalAnswer,

        events:
          apiEvents,

        /*
         * Пока оставляем debug meta.
         *
         * Очень удобно видеть,
         * что именно понял Qwen.
         *
         * Фронт лишние поля просто игнорирует.
         */
        meta: {
          intent: {
            ...intent,

            effectiveCity,

            maxTicketPrice,
          },

          geo,

          geoFailed,

          searchMode,

          candidates:
            ranked.length,

          conversation: {
            previousEventIds,

            excludedCategories,

            negativeTerms,

            usePreviousResults,

            preferCloser,

            preferCheaper,

            aiSelectedIds:
              conversationChoice.eventIds,
          },

          attribution:
            geo?.provider ===
              'nominatim'
              ? '© OpenStreetMap contributors'
              : null,
        },
      }
    },
  )
}
