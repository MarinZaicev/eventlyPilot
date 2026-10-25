// ============================================================
// Популярность у других пользователей (#36): сколько лайкнули
// и сколько собираются пойти. Своё приложение добавляет само
// (лайк/«Пойду» меняются мгновенно, без задвоения).
// ============================================================

import type { ApiEvent } from '@evently/shared'

import { prisma } from '@evently/db'

export async function withSocial<T extends ApiEvent>(
  items: T[],
  // Кто смотрит: его собственные лайк/«Пойду» не считаем.
  viewerUserId: string | null,
): Promise<T[]> {
  if (items.length === 0) {
    return items
  }

  const eventIds = items.map((item) => item.id)

  const notViewer = viewerUserId
    ? { userId: { not: viewerUserId } }
    : {}

  const [likeGroups, goingGroups] = await Promise.all([
    prisma.favorite.groupBy({
      by: ['eventId'],
      where: { eventId: { in: eventIds }, ...notViewer },
      _count: { _all: true },
    }),

    prisma.attendance.groupBy({
      by: ['eventId'],
      where: { eventId: { in: eventIds }, ...notViewer },
      _count: { _all: true },
    }),
  ])

  const likes = new Map(
    likeGroups.map((group) => [group.eventId, group._count._all]),
  )

  const going = new Map(
    goingGroups.map((group) => [group.eventId, group._count._all]),
  )

  return items.map((item) => ({
    ...item,
    social: {
      likes: likes.get(item.id) ?? 0,
      going: going.get(item.id) ?? 0,
    },
  }))
}
