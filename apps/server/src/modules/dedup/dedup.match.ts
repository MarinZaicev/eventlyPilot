// ============================================================
// DEDUPLICATION — MATCHING LOGIC
//
// Чистые функции без обращения к БД (их легко тестировать).
// Одно и то же событие из разных источников (KudaGo, Timepad…)
// находим по трём признакам:
//   1) похожее название,
//   2) та же площадка,
//   3) близкое время начала.
// ============================================================

export type DedupCandidate = {
  id: string
  source: string
  city: string
  title: string
  venueName: string | null
  latitude: number | null
  longitude: number | null
  startTimes: number[] // ms timestamps
  completeness: number // чем больше, тем полнее карточка
  createdAt: number
}

/*
 * Веса итоговой оценки и порог.
 * score = 0.5·название + 0.3·площадка + 0.2·время
 */
export const DEDUP_WEIGHTS = {
  title: 0.5,
  venue: 0.3,
  time: 0.2,
}

export const DEDUP_THRESHOLD = 0.75

/*
 * Без похожего названия дубликатом
 * не считаем никогда — даже если
 * площадка и время совпали
 * (в одном зале бывает несколько событий).
 */
export const DEDUP_MIN_TITLE = 0.6

/*
 * Служебные слова, которые источники
 * по-разному добавляют к названию.
 */
const STOP_WORDS = new Set([
  'концерт', 'спектакль', 'шоу', 'выставка', 'лекция',
  'мастер', 'класс', 'стендап', 'фестиваль', 'показ',
  'премьера', 'экскурсия', 'вечер', 'встреча', 'квиз',
  'балет', 'опера', 'мюзикл', 'постановка', 'группа', 'группы',
  'в', 'во', 'на', 'и', 'с', 'со', 'для', 'по', 'от', 'из', 'к',
  'the', 'a', 'an', 'of', 'and', 'live',
])

export function normalizeTitle(
  value: string,
) {
  return value
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/\d{1,2}\s*\+/g, ' ') // 12+, 18+
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .split(' ')
    .filter(
      (word) =>
        word.length > 0 &&
        !STOP_WORDS.has(word),
    )
    .join(' ')
    .trim()
}

function trigrams(
  value: string,
) {
  const padded = `  ${value} `
  const result = new Set<string>()

  for (let i = 0; i < padded.length - 2; i += 1) {
    result.add(padded.slice(i, i + 3))
  }

  return result
}

/*
 * Коэффициент Дайса по триграммам:
 * устойчив к падежам и опечаткам
 * («Щелкунчик» / «Щелкунчика»).
 */
export function trigramSimilarity(
  a: string,
  b: string,
) {
  if (!a || !b) {
    return 0
  }

  if (a === b) {
    return 1
  }

  const ta = trigrams(a)
  const tb = trigrams(b)

  let common = 0

  for (const gram of ta) {
    if (tb.has(gram)) {
      common += 1
    }
  }

  return (2 * common) / (ta.size + tb.size)
}

/*
 * Источники часто дописывают площадку
 * в название: «Щелкунчик в Большом театре».
 * Убираем такие слова (сравнение по первым
 * 5 буквам — с учётом падежей).
 */
function stripVenueWords(
  title: string,
  venueNames: Array<string | null>,
) {
  const stems = new Set(
    venueNames
      .flatMap((name) =>
        name ? normalizeTitle(name).split(' ') : [],
      )
      .filter((word) => word.length >= 4)
      .map((word) => word.slice(0, 5)),
  )

  if (stems.size === 0) {
    return title
  }

  const kept = title
    .split(' ')
    .filter((word) => !stems.has(word.slice(0, 5)))
    .join(' ')

  // Не оставляем пустое название.
  return kept || title
}

export function titleSimilarity(
  a: string,
  b: string,
  venueNames: Array<string | null> = [],
) {
  const na = stripVenueWords(normalizeTitle(a), venueNames)
  const nb = stripVenueWords(normalizeTitle(b), venueNames)

  if (!na || !nb) {
    return 0
  }

  const wordsA = new Set(na.split(' '))
  const wordsB = new Set(nb.split(' '))

  let common = 0

  for (const word of wordsA) {
    if (wordsB.has(word)) {
      common += 1
    }
  }

  const jaccard =
    common /
    (wordsA.size + wordsB.size - common)

  /*
   * «Щелкунчик» vs «Балет Щелкунчик
   * в Большом» — короткое название
   * целиком входит в длинное.
   */
  const smaller =
    Math.min(wordsA.size, wordsB.size)

  const contained =
    smaller >= 1 &&
    common === smaller &&
    (smaller >= 2 || na.length >= 6 || nb.length >= 6)
      ? 0.9
      : 0

  return Math.max(
    jaccard,
    contained,
    trigramSimilarity(na, nb),
  )
}

function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
) {
  const toRad = (deg: number) =>
    (deg * Math.PI) / 180

  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2

  return 6371 * 2 * Math.asin(Math.sqrt(h))
}

export function venueSimilarity(
  a: DedupCandidate,
  b: DedupCandidate,
) {
  if (
    a.latitude !== null &&
    a.longitude !== null &&
    b.latitude !== null &&
    b.longitude !== null
  ) {
    const km = haversineKm(
      a.latitude,
      a.longitude,
      b.latitude,
      b.longitude,
    )

    if (km <= 0.2) return 1
    if (km <= 0.5) return 0.6
    if (km <= 1) return 0.2

    return 0
  }

  if (a.venueName && b.venueName) {
    return trigramSimilarity(
      normalizeTitle(a.venueName),
      normalizeTitle(b.venueName),
    )
  }

  /*
   * Площадка неизвестна у одного
   * из событий — нейтрально.
   */
  return 0.5
}

export function timeSimilarity(
  a: DedupCandidate,
  b: DedupCandidate,
) {
  let best = Infinity

  for (const ta of a.startTimes) {
    for (const tb of b.startTimes) {
      best = Math.min(best, Math.abs(ta - tb))
    }
  }

  const minutes = best / 60_000

  if (minutes <= 15) return 1
  if (minutes <= 60) return 0.7
  if (minutes <= 180) return 0.3

  return 0
}

export function pairScore(
  a: DedupCandidate,
  b: DedupCandidate,
) {
  const title = titleSimilarity(
    a.title,
    b.title,
    [a.venueName, b.venueName],
  )
  const venue = venueSimilarity(a, b)
  const time = timeSimilarity(a, b)

  const score =
    DEDUP_WEIGHTS.title * title +
    DEDUP_WEIGHTS.venue * venue +
    DEDUP_WEIGHTS.time * time

  return {
    title,
    venue,
    time,
    score,
    isDuplicate:
      title >= DEDUP_MIN_TITLE &&
      score >= DEDUP_THRESHOLD,
  }
}

/*
 * Ключ блока: сравниваем только события
 * одного города с сеансом в тот же день.
 */
function dayKeys(
  candidate: DedupCandidate,
) {
  const keys = new Set<string>()

  for (const time of candidate.startTimes) {
    // сдвиг +3 ч ~ московский день; для блокировки достаточно
    const day = new Date(time + 3 * 3_600_000)
      .toISOString()
      .slice(0, 10)

    keys.add(`${candidate.city}|${day}`)
  }

  return keys
}

export type DedupResult = {
  considered: number
  pairsCompared: number
  duplicatePairs: number
  clusters: Array<{
    primaryId: string
    duplicateIds: string[]
  }>
}

/*
 * Находит группы дубликатов.
 * Основное событие группы:
 *   1) с наибольшим числом сеансов —
 *      чтобы не потерять даты (Timepad часто
 *      публикует каждую дату отдельным событием,
 *      KudaGo — одним со всем расписанием);
 *   2) затем самое полное карточкой;
 *   3) затем добавленное раньше.
 */
export function findDuplicateClusters(
  candidates: DedupCandidate[],
): DedupResult {
  const blocks = new Map<string, DedupCandidate[]>()

  for (const candidate of candidates) {
    for (const key of dayKeys(candidate)) {
      const list = blocks.get(key) ?? []
      list.push(candidate)
      blocks.set(key, list)
    }
  }

  // union-find
  const parent = new Map<string, string>()

  const find = (id: string): string => {
    let root = id

    while (parent.has(root) && parent.get(root) !== root) {
      root = parent.get(root)!
    }

    parent.set(id, root)

    return root
  }

  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)

    if (ra !== rb) {
      parent.set(rb, ra)
    }
  }

  const seenPairs = new Set<string>()
  let pairsCompared = 0
  let duplicatePairs = 0

  for (const block of blocks.values()) {
    for (let i = 0; i < block.length; i += 1) {
      for (let j = i + 1; j < block.length; j += 1) {
        const a = block[i]
        const b = block[j]

        // Внутри одного источника id уже уникальны.
        if (a.source === b.source) {
          continue
        }

        const pairKey =
          a.id < b.id
            ? `${a.id}|${b.id}`
            : `${b.id}|${a.id}`

        if (seenPairs.has(pairKey)) {
          continue
        }

        seenPairs.add(pairKey)
        pairsCompared += 1

        if (pairScore(a, b).isDuplicate) {
          duplicatePairs += 1
          union(a.id, b.id)
        }
      }
    }
  }

  const groups = new Map<string, DedupCandidate[]>()

  for (const candidate of candidates) {
    if (!parent.has(candidate.id)) {
      continue
    }

    const root = find(candidate.id)
    const list = groups.get(root) ?? []
    list.push(candidate)
    groups.set(root, list)
  }

  const clusters: DedupResult['clusters'] = []

  for (const group of groups.values()) {
    if (group.length < 2) {
      continue
    }

    const sorted = [...group].sort(
      (a, b) =>
        b.startTimes.length - a.startTimes.length ||
        b.completeness - a.completeness ||
        a.createdAt - b.createdAt,
    )

    clusters.push({
      primaryId: sorted[0].id,
      duplicateIds: sorted
        .slice(1)
        .map((item) => item.id),
    })
  }

  return {
    considered: candidates.length,
    pairsCompared,
    duplicatePairs,
    clusters,
  }
}
