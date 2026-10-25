type MaxShareParams = {
  text?: string
  link?: string
}

type MaxWebApp = {
  initData?: string

  initDataUnsafe?: {
    start_param?: string
  }

  platform?: string

  // Поделиться в чат MAX (нужен клик пользователя).
  shareMaxContent?: (
    params: MaxShareParams,
  ) => unknown

  // Системное меню «Поделиться» (нет в веб-версии MAX).
  shareContent?: (
    params: MaxShareParams,
  ) => unknown

  // Открыть ссылку во внешнем браузере (нужен клик пользователя).
  openLink?: (url: string) => unknown
}

declare global {
  interface Window {
    WebApp?: MaxWebApp
  }
}

function getInitDataFromHash() {
  if (
    typeof window ===
      'undefined'
  ) {
    return ''
  }

  const hash =
    window.location.hash

  if (!hash) {
    return ''
  }

  const params =
    new URLSearchParams(
      hash.startsWith('#')
        ? hash.slice(1)
        : hash,
    )

  return (
    params.get('WebAppData') ??
    ''
  )
}

export function getMaxInitData() {
  if (
    typeof window ===
      'undefined'
  ) {
    return ''
  }

  const bridgeInitData =
    window.WebApp?.initData

  if (bridgeInitData) {
    return bridgeInitData
  }

  return getInitDataFromHash()
}

// ============================================================
// Deep link на событие:
// https://max.ru/<бот>?startapp=event_<uuid>
// MAX открывает Mini App и передаёт "event_<uuid>"
// в WebApp.initDataUnsafe.start_param.
// ============================================================

export const MAX_BOT_NAME =
  import.meta.env.VITE_MAX_BOT_NAME ??
  'se14469888_bot'

const EVENT_PREFIX = 'event_'

export function buildEventLink(
  eventId: string,
) {
  return `https://max.ru/${MAX_BOT_NAME}?startapp=${EVENT_PREFIX}${eventId}`
}

// Один «запуск» по ссылке. MAX может не перезапускать
// уже открытое приложение, а только обновить данные
// запуска — поэтому смотрим все источники, а новый
// запуск узнаём по новой подписи initData (auth_date/hash).
// Что открыть по ссылке: событие или приглашение на него.
export type StartLink = {
  eventId: string
  // Код пригласившего — ссылка «Пойдём вместе».
  inviteCode: string | null
}

export type LaunchInfo = {
  key: string
  source: 'bridge' | 'hash' | 'url'
  startParam: string
  link: StartLink | null
}

const INVITE_PREFIX = 'inv_'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// event_<uuid>  или  inv_<uuid>_<код>
export function parseStartParam(
  param: string,
): StartLink | null {
  if (param.startsWith(EVENT_PREFIX)) {
    const id = param.slice(
      EVENT_PREFIX.length,
    )

    return UUID_RE.test(id)
      ? { eventId: id, inviteCode: null }
      : null
  }

  if (param.startsWith(INVITE_PREFIX)) {
    const rest = param.slice(
      INVITE_PREFIX.length,
    )

    const id = rest.slice(0, 36)
    const code = rest.slice(37)

    return UUID_RE.test(id) &&
      rest[36] === '_' &&
      /^[A-Za-z0-9_-]{6,16}$/.test(code)
      ? { eventId: id, inviteCode: code }
      : null
  }

  return null
}

export function buildInviteLink(
  eventId: string,
  inviteCode: string,
) {
  return `https://max.ru/${MAX_BOT_NAME}?startapp=${INVITE_PREFIX}${eventId}_${inviteCode}`
}

function launchFromInitData(
  source: LaunchInfo['source'],
  initData: string,
  unsafeParam?: string,
): LaunchInfo | null {
  if (!initData && !unsafeParam) {
    return null
  }

  const params =
    new URLSearchParams(initData)

  const startParam =
    unsafeParam ??
    params.get('start_param') ??
    ''

  return {
    key: [
      source,
      startParam,
      params.get('auth_date') ?? '',
      params.get('hash') ?? '',
    ].join('|'),
    source,
    startParam,
    link: parseStartParam(startParam),
  }
}

export function getLaunches(): LaunchInfo[] {
  if (typeof window === 'undefined') {
    return []
  }

  const launches: LaunchInfo[] = []

  const bridge = launchFromInitData(
    'bridge',
    window.WebApp?.initData ?? '',
    window.WebApp?.initDataUnsafe
      ?.start_param,
  )

  if (bridge) {
    launches.push(bridge)
  }

  const hash = launchFromInitData(
    'hash',
    getInitDataFromHash(),
  )

  if (hash) {
    launches.push(hash)
  }

  // ?startapp= в адресе — для проверки в браузере.
  const urlParam =
    new URLSearchParams(
      window.location.search,
    ).get('startapp')

  if (urlParam) {
    launches.push({
      key: `url|${urlParam}`,
      source: 'url',
      startParam: urlParam,
      link: parseStartParam(urlParam),
    })
  }

  return launches
}

// Ссылка, с которой открыли приложение.
export function getStartLink() {
  return (
    getLaunches().find(
      (launch) => launch.link,
    )?.link ?? null
  )
}

export type ShareResult =
  | 'max'
  | 'system'
  | 'copied'
  | 'failed'

export async function shareLink(params: {
  title: string
  text: string
  link: string
}): Promise<ShareResult> {
  const webApp = window.WebApp

  // Внутри MAX — сразу в чат MAX.
  if (webApp?.shareMaxContent) {
    try {
      const result =
        await webApp.shareMaxContent({
          text: params.text,
          link: params.link,
        })

      const failed =
        typeof result === 'object' &&
        result !== null &&
        'error' in result

      if (!failed) {
        return 'max'
      }
    } catch {
      // Пробуем следующий способ.
    }
  }

  if (
    navigator.share &&
    /Android|iPhone|iPad/i.test(
      navigator.userAgent,
    )
  ) {
    try {
      await navigator.share({
        title: params.title,
        text: params.text,
        url: params.link,
      })

      return 'system'
    } catch (error) {
      // Закрыли меню — не ошибка.
      if (
        error instanceof DOMException &&
        error.name === 'AbortError'
      ) {
        return 'failed'
      }
    }
  }

  const full = `${params.text}\n${params.link}`

  try {
    await navigator.clipboard.writeText(full)

    return 'copied'
  } catch {
    // Старые WebView без Clipboard API.
    return copyWithTextarea(full)
      ? 'copied'
      : 'failed'
  }
}

function copyWithTextarea(text: string) {
  const area =
    document.createElement('textarea')

  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'

  document.body.appendChild(area)
  area.select()

  let ok = false

  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }

  area.remove()

  return ok
}

// Внешняя ссылка: внутри MAX — через его мост
// (window.open в WebView MAX может не сработать).
export function openExternal(url: string) {
  const webApp = window.WebApp

  if (webApp?.openLink) {
    try {
      webApp.openLink(url)
      return
    } catch {
      // ниже — обычный способ
    }
  }

  window.open(url, '_blank', 'noopener,noreferrer')
}
