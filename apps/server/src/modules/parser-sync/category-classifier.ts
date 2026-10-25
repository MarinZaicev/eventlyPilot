// ============================================================
// Разметка категорий при импорте из парсера.
//
// Порядок, по которому событие получает категории:
//   1. категории от парсера — напрямую или через синонимы;
//   2. источник целиком про кино (kinopoisk-cinema…) → «Кино»;
//   3. ключевые слова в названии, затем в начале описания;
//   4. «Разное» (other) — чтобы событие не выпало из ленты.
//
// Наши slug'и — packages/db/src/seed.ts.
// ============================================================

export const OTHER_CATEGORY_SLUG = 'other'

/*
 * Синонимы от парсера → наш slug.
 * Ключи в нижнем регистре; есть и русские названия рубрик Timepad
 * на случай, если парсер передаёт их как есть.
 * «Другое/other» намеренно нет: такие события размечаем по словам.
 */
const CATEGORY_ALIASES: Record<string, string> = {
  concert: 'concert',
  concerts: 'concert',
  music: 'concert',
  'концерты': 'concert',
  'музыка': 'concert',

  theatre: 'theatre',
  theater: 'theatre',
  theatres: 'theatre',
  'театр': 'theatre',
  'театры': 'theatre',

  cinema: 'cinema',
  movie: 'cinema',
  movies: 'cinema',
  film: 'cinema',
  films: 'cinema',
  kino: 'cinema',
  'кино': 'cinema',

  sport: 'sport',
  sports: 'sport',
  'спорт': 'sport',

  exhibition: 'exhibition',
  exhibitions: 'exhibition',
  museum: 'exhibition',
  art: 'exhibition',
  'выставки': 'exhibition',
  'искусство и культура': 'exhibition',

  party: 'party',
  parties: 'party',
  'вечеринки': 'party',

  standup: 'standup',
  'stand-up': 'standup',
  comedy: 'standup',
  'стендап': 'standup',

  food: 'food',
  'еда': 'food',

  family: 'family',
  kids: 'family',
  children: 'family',
  'для детей': 'family',

  education: 'education',
  lecture: 'education',
  lectures: 'education',
  science: 'education',
  'наука': 'education',
  'образование': 'education',

  tour: 'tour',
  tours: 'tour',
  excursion: 'tour',
  excursions: 'tour',
  travel: 'tour',
  'экскурсии': 'tour',
  'экскурсии и путешествия': 'tour',

  games: 'games',
  game: 'games',
  quest: 'games',
  quests: 'games',
  quiz: 'games',
  'квесты': 'games',
  'интеллектуальные игры': 'games',

  masterclass: 'masterclass',
  workshop: 'masterclass',
  hobby: 'masterclass',
  creative: 'masterclass',
  'мастер-классы': 'masterclass',
  'хобби и творчество': 'masterclass',

  business: 'business',
  it: 'business',
  tech: 'business',
  technology: 'business',
  marketing: 'business',
  career: 'business',
  'бизнес': 'business',
  'ит и интернет': 'business',

  psychology: 'selfdev',
  'self-development': 'selfdev',
  selfdev: 'selfdev',
  languages: 'selfdev',
  health: 'selfdev',
  beauty: 'selfdev',
  'психология и самопознание': 'selfdev',
  'красота и здоровье': 'selfdev',
  'иностранные языки': 'selfdev',
}

// Источник целиком про кино, но категория не пришла.
const CINEMA_SOURCE_RE =
  /cinema|kino|movie|film/i

/*
 * Ключевые слова. Каждое — начало слова: перед ним не буква.
 * Окончание не проверяем («экскурси» ловит «экскурсия», «экскурсии»),
 * кроме коротких слов — там явно указано, что дальше не буква.
 *
 * Порядок важен: побеждает первое совпадение.
 * Сначала узкие и надёжные признаки, широкие («курс», «урок») — в конце.
 */
const L = '[a-zа-яё]'

const KEYWORD_RULES: Array<[slug: string, stems: string[]]> = [
  ['standup', [
    'стендап', 'стенд-ап', 'stand-?up', 'открыт\\S* микрофон', 'комик',
  ]],
  ['games', [
    'квиз', 'quiz', 'квест', 'настольн\\S* игр', `мафи[яю](?!${L})`,
    'своя игра', 'интеллектуальн\\S* игр', 'брейн',
  ]],
  ['masterclass', [
    'мастер-?класс', 'воркшоп', 'workshop', 'своими руками', 'рисовани',
    'акварел', 'лепк', 'керамик', 'гончар', 'каллиграф', 'флористик',
    'рукодели',
  ]],
  ['tour', [
    'экскурси', 'прогулк', 'пешеходн', `тур(?!${L})`, 'по следам',
    'путешеств',
  ]],
  ['education', [
    'лекци', 'вебинар', 'семинар', 'конференци', 'кинолектор',
  ]],
  ['cinema', [
    'кинопоказ', 'показ фильм', 'фильм', `кино(?!${L})`, 'премьера фильм',
  ]],
  ['theatre', [
    'спектакл', 'театр', `опер[аыуе](?!${L})`, 'балет', 'мюзикл',
    'иммерсивн',
  ]],
  ['concert', [
    'концерт', 'джаз', 'оркестр', `рок(?!${L})`, `хор(?!${L})`, 'квартирник',
    'органн', 'симфони', `live(?!${L})`, 'музыкальн\\S* вечер', 'фортепиан',
    'вокал', 'трибьют',
  ]],
  ['party', [
    'вечеринк', 'дискотек', 'party', 'диджей', `dj(?!${L})`, 'рейв',
    'тусовк',
  ]],
  ['exhibition', [
    'выставк', 'экспозици', 'галере', `музе[йяюе]`, 'вернисаж',
    'арт-пространств',
  ]],
  ['business', [
    'бизнес', 'предприним', 'стартап', 'маркетинг', 'продаж', 'финанс',
    'инвест', 'нетворкинг', 'карьер', `hr(?!${L})`, `it(?!${L})`, 'айти',
    'программир', 'разработчик', 'продакт', 'менеджмент', 'аналитик',
    'нейросет', 'искусственн\\S* интеллект', `ai(?!${L})`,
  ]],
  ['food', [
    'дегустаци', 'гастро', 'кулинар', 'ужин', 'завтрак', 'бранч',
    `вин[оа](?!${L})`, 'винн', 'кофейн', 'чайн\\S* церемон', 'сыровар',
  ]],
  ['family', [
    'для детей', 'детск', 'семейн', 'малыш', 'школьник', 'подростк',
  ]],
  ['sport', [
    'забег', 'марафон', 'турнир', 'матч', 'фитнес', 'йог', 'тренировк',
    'сплав', `поход(?!${L})`, 'спортивн',
  ]],
  ['selfdev', [
    'психолог', 'медитаци', 'коучинг', 'саморазвит', 'отношени',
    'осознанн', 'эмоци', 'тревожн', 'английск', 'иностранн\\S* язык',
    'разговорн\\S* клуб', 'астролог', 'нумеролог', 'таро',
  ]],
  ['education', [
    `курс(?!${L})`, `курсы(?!${L})`, `урок(?!${L})`, 'интенсив', 'дискусси',
    'круглый стол', 'научн', 'встреча с автор', 'книжн\\S* клуб',
    'презентаци\\S* книг',
  ]],
]

const COMPILED_RULES = KEYWORD_RULES.map(
  ([slug, stems]) => ({
    slug,
    re: new RegExp(
      `(?:^|[^a-zа-яё0-9])(?:${stems.join('|')})`,
      'iu',
    ),
  }),
)

export function classifyByText(
  title: string,
  description?: string | null,
): string | null {
  const texts = [
    title,
    // Описание — запасной вариант; хвост описаний шумный.
    (description ?? '').slice(0, 600),
  ]

  for (const raw of texts) {
    const text = raw
      .toLowerCase()
      .replace(/ё/g, 'е')

    if (!text.trim()) {
      continue
    }

    for (const rule of COMPILED_RULES) {
      if (rule.re.test(text)) {
        return rule.slug
      }
    }
  }

  return null
}

export type CategoryResolution = {
  ids: string[]
  // Незнакомые slug'и от парсера (для лога).
  unknown: string[]
  // Откуда взялись категории.
  via: 'parser' | 'source' | 'keywords' | 'other' | 'none'
}

export function resolveCategories(
  input: {
    categories: string[]
    source: string
    title: string
    description?: string | null
    shortDescription?: string | null
  },
  categoryIds: Map<string, string>,
): CategoryResolution {
  const ids = new Set<string>()
  const unknown: string[] = []

  for (const raw of input.categories) {
    const key = raw.trim().toLowerCase()

    if (!key) {
      continue
    }

    const slug =
      key !== OTHER_CATEGORY_SLUG &&
      categoryIds.has(key)
        ? key
        : CATEGORY_ALIASES[key]

    const id = slug
      ? categoryIds.get(slug)
      : undefined

    if (id) {
      ids.add(id)
    } else {
      unknown.push(key)
    }
  }

  if (ids.size > 0) {
    return { ids: [...ids], unknown, via: 'parser' }
  }

  if (CINEMA_SOURCE_RE.test(input.source)) {
    const cinemaId = categoryIds.get('cinema')

    if (cinemaId) {
      return { ids: [cinemaId], unknown, via: 'source' }
    }
  }

  const bySlug = classifyByText(
    input.title,
    [input.shortDescription, input.description]
      .filter(Boolean)
      .join(' '),
  )

  const byTextId = bySlug
    ? categoryIds.get(bySlug)
    : undefined

  if (byTextId) {
    return { ids: [byTextId], unknown, via: 'keywords' }
  }

  const otherId = categoryIds.get(OTHER_CATEGORY_SLUG)

  if (otherId) {
    return { ids: [otherId], unknown, via: 'other' }
  }

  return { ids: [], unknown, via: 'none' }
}
