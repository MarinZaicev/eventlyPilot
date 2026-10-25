export function getInteractionWeight(
  interaction: {
    type: string
    durationMs: number | null
  },
) {
  switch (interaction.type) {
    case 'FAVORITE':
      return 5

    case 'UNFAVORITE':
      return -5

    case 'OPEN':
      return 2

    case 'SHARE':
      return 6

    case 'TICKET_CLICK':
      return 8

    case 'HIDE':
      return -8

    // «Пойду» — самый сильный сигнал интереса:
    // человек планирует потратить вечер.
    // Отмена полностью компенсирует (как лайк/дизлайк):
    // передумал — не значит «не нравится».
    case 'GOING':
      return 10

    case 'NOT_GOING':
      return -10

    case 'DWELL': {
      const duration =
        interaction.durationMs ?? 0

      if (duration >= 15_000) {
        return 3
      }

      if (duration >= 5_000) {
        return 1.5
      }

      if (duration < 1_500) {
        return -0.5
      }

      return 0
    }

    default:
      return 0
  }
}

// ============================================================
// RANDOMIZED RANKING
//
// Очки события больше не задают жёсткий порядок, а увеличивают
// шанс события оказаться выше в ленте.
// ============================================================

/*
 * Чем меньше температура, тем сильнее очки влияют на порядок.
 *
 * При 4:
 * - выбранная в онбординге категория (+12) ~ в 20 раз
 *   "шансовее" невыбранной (e^3);
 * - поведение (до ±8) меняет шанс до ~7 раз (e^2).
 */
export const FEED_TEMPERATURE = 4

/*
 * Не больше стольких событий одной категории подряд.
 */
export const FEED_MAX_SAME_CATEGORY_IN_ROW = 2

export function scoreToWeight(
  score: number,
) {
  const exponent =
    Math.max(
      -30,
      Math.min(
        30,
        score / FEED_TEMPERATURE,
      ),
    )

  return Math.exp(exponent)
}

/*
 * Взвешенное перемешивание без повторов
 * (алгоритм Efraimidis–Spirakis):
 * ключ = ln(u) / weight, сортировка по убыванию ключа.
 * Событие с весом 20 окажется выше события с весом 1
 * примерно в 20 случаях из 21.
 */
export function weightedShuffle<T>(
  items: T[],
  getWeight: (item: T) => number,
  random: () => number = Math.random,
): T[] {
  return items
    .map((item) => {
      const weight =
        Math.max(
          getWeight(item),
          1e-9,
        )

      const u =
        Math.max(
          random(),
          Number.MIN_VALUE,
        )

      return {
        item,
        key: Math.log(u) / weight,
      }
    })
    .sort((a, b) => b.key - a.key)
    .map(({ item }) => item)
}

/*
 * Если последние maxInRow событий одной категории,
 * берём ближайшее (в пределах lookahead) событие
 * другой категории. Если такого нет — оставляем как есть.
 */
export function diversifyByCategory<T>(
  items: T[],
  getCategory: (item: T) => string | null,
  maxInRow: number = FEED_MAX_SAME_CATEGORY_IN_ROW,
  lookahead = 10,
): T[] {
  const rest = [...items]
  const result: T[] = []

  while (rest.length > 0) {
    let index = 0

    const tail =
      result
        .slice(-maxInRow)
        .map(getCategory)

    const blocked =
      tail.length === maxInRow &&
      tail[0] !== null &&
      tail.every(
        (category) =>
          category === tail[0],
      )
        ? tail[0]
        : null

    if (blocked !== null) {
      const found =
        rest
          .slice(0, lookahead)
          .findIndex(
            (item) =>
              getCategory(item) !==
              blocked,
          )

      if (found !== -1) {
        index = found
      }
    }

    result.push(
      rest.splice(index, 1)[0],
    )
  }

  return result
}

// ============================================================
// CATEGORY-FIRST FEED (#25)
//
// Раньше вес получало каждое событие, и доля категории в ленте
// была ≈ (число событий) × (интерес): выставок и кино много —
// они и занимали половину ленты, а мастер-классы не всплывали.
//
// Теперь каждое место в ленте заполняется в два шага:
//   1. случайно выбираем категорию — по интересу пользователя
//      (вес e^(очки/4)) с мягкой поправкой на размер категории
//      (log2(n+1): 185 событий → ×7.5, 1 событие → ×1);
//   2. берём следующее событие этой категории — внутри категории
//      порядок тоже случайный, с бонусом «скоро» и популярностью.
//
// Жёсткое правило: не больше FEED_MAX_SAME_CATEGORY_IN_ROW
// событий одной категории подряд, пока есть любая другая.
// ============================================================

export type FeedCandidate<T> = {
  item: T
  categories: string[]
  // Бонус самого события (скоро / популярность), в «очках».
  eventScore: number

  // Свежесть 0..1 (#39): 1 — ещё не показывали, меньше — показывали
  // недавно. Категория, где остались только недавно показанные,
  // выпадает реже — лента «по кругу» не повторяет только что виденное.
  freshness?: number
}

const NO_CATEGORY = '__none'

/*
 * Порядок событий ВНУТРИ уже выбранной категории (#32) — острее,
 * чем выбор категорий: бонусы цены/времени/расстояния/популярности
 * должны заметно поднимать подходящие события. Температура 2:
 * +3.5 очка → шанс выше в ~6 раз (при 4 было бы ~2.4).
 */
export const EVENT_TEMPERATURE = 2

function eventWeight(score: number) {
  return Math.exp(
    Math.max(-30, Math.min(30, score / EVENT_TEMPERATURE)),
  )
}

export function buildCategoryFirstFeed<T>(
  candidates: FeedCandidate<T>[],
  getCategoryScore: (slug: string) => number,
  limit: number,
  options: {
    maxInRow?: number
    random?: () => number
  } = {},
): T[] {
  const maxInRow =
    options.maxInRow ?? FEED_MAX_SAME_CATEGORY_IN_ROW

  const random = options.random ?? Math.random

  // Событие с несколькими категориями относим к самой интересной.
  const groups = new Map<string, FeedCandidate<T>[]>()

  for (const candidate of candidates) {
    let primary = NO_CATEGORY
    let best = -Infinity

    for (const slug of candidate.categories) {
      const score = getCategoryScore(slug)

      if (score > best) {
        best = score
        primary = slug
      }
    }

    const group = groups.get(primary) ?? []
    group.push(candidate)
    groups.set(primary, group)
  }

  const queues = new Map<string, FeedCandidate<T>[]>()
  const categoryWeights = new Map<string, number>()

  for (const [slug, group] of groups) {
    queues.set(
      slug,
      weightedShuffle(
        group,
        (candidate) => eventWeight(candidate.eventScore),
        random,
      ),
    )

    categoryWeights.set(
      slug,
      scoreToWeight(
        slug === NO_CATEGORY ? -2 : getCategoryScore(slug),
      ) * Math.log2(group.length + 1),
    )
  }

  const result: T[] = []
  const resultCategories: string[] = []

  while (result.length < limit) {
    const available = [...queues.keys()].filter(
      (slug) => (queues.get(slug)?.length ?? 0) > 0,
    )

    if (available.length === 0) {
      break
    }

    const tail = resultCategories.slice(-maxInRow)

    const blocked =
      tail.length === maxInRow &&
      tail.every((slug) => slug === tail[0])
        ? tail[0]
        : null

    const allowed =
      blocked !== null && available.some((slug) => slug !== blocked)
        ? available.filter((slug) => slug !== blocked)
        : available

    // Вес категории × свежесть лучшего оставшегося в ней события (#39).
    const weightOf = (slug: string) =>
      (categoryWeights.get(slug) ?? 0) *
      Math.max(
        ...queues.get(slug)!.map(
          (candidate) => candidate.freshness ?? 1,
        ),
      )

    const weights = new Map(
      allowed.map((slug) => [slug, weightOf(slug)]),
    )

    const total = allowed.reduce(
      (sum, slug) => sum + (weights.get(slug) ?? 0),
      0,
    )

    let pick = allowed[allowed.length - 1]
    let threshold = random() * total

    for (const slug of allowed) {
      threshold -= weights.get(slug) ?? 0

      if (threshold <= 0) {
        pick = slug
        break
      }
    }

    const next = queues.get(pick)!.shift()!

    result.push(next.item)
    resultCategories.push(pick)
  }

  return result
}
