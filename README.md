# Evently

Мини-приложение для MAX: помогает найти, куда сходить в городе. Лента событий под интересы, AI-помощник, кнопка «Пойду» с напоминанием от бота и приглашения друзей.

Делали на хакатон, кейс «Досуг и развлечения». Пилотный город — Москва.

Парсер событий живёт отдельно, у него свой README.

## Что внутри

```
apps/
  miniapp/    фронт: React 19 + Vite
  server/     API: Fastify 5, TypeScript (запускается через tsx)
packages/
  db/         Prisma 7 + PostgreSQL: схема, клиент, сиды
  shared/     общие типы и zod-схемы
deploy/       unit для systemd (геокодер площадок)
docker/       скрипт запуска для Docker-образа
```

Основные модули сервера (`apps/server/src/modules`):

- `feed` — персональная лента: сначала выбирается категория по интересам и поведению, потом событие;
- `ai` — помощник на локальной модели через Ollama, плюс подсказки «где поесть рядом»;
- `going`, `reminders`, `invites` — «Пойду», напоминания через бота MAX, ссылки-приглашения;
- `auth` — вход через аккаунт MAX;
- `import`, `parser-sync`, `dedup` — загрузка событий от парсера и склейка дублей;
- `geo`, `places` — координаты площадок (Nominatim) и заведения рядом (OpenStreetMap);
- `admin` — страница метрик ленты.

## Что нужно

- Node.js 22+ и pnpm 11 (`corepack enable`);
- Docker — для PostgreSQL;
- Ollama с моделью `qwen3:8b` — для помощника. Без неё приложение работает, помощник отвечает упрощённо, без модели.

## Запуск локально

```bash
pnpm install

# база
docker compose up -d

# схема и стартовые данные
pnpm --filter @evently/db exec prisma db push --schema prisma/schema.prisma
pnpm --filter @evently/db exec prisma generate --schema prisma/schema.prisma
pnpm --filter @evently/db exec tsx src/seed.ts               # категории
pnpm --filter @evently/db exec tsx src/docker-demo-seed.ts   # демо-события, по желанию

# API (порт 3000)
pnpm dev:server

# фронт (порт 5173), в другом терминале
pnpm dev:miniapp
```

Схему обновляем через `prisma db push`, миграции (`migrate deploy`) не используем.

Фронт проксирует `/api`, `/media` и `/health` на `127.0.0.1:3000`, настройки в `apps/miniapp/vite.config.ts`.

## Переменные окружения

Лежат в `apps/server/.env` и `packages/db/.env`, в git не попадают. Минимум для старта:

| Переменная | Зачем |
| `DATABASE_URL` | Postgres, например `postgresql://evently:evently_dev_password@127.0.0.1:5432/evently` |
| `SESSION_SECRET` | подпись сессий |
| `MAX_BOT_TOKEN`, `MAX_BOT_NAME` | бот MAX: вход, напоминания, ссылки |
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | где крутится модель (по умолчанию `http://127.0.0.1:11434`) |
| `IMPORT_API_KEY` | ключ, с которым парсер присылает события |
| `ADMIN_METRICS_KEY` | доступ к странице метрик |

Остальное (`REMINDER_*`, `GEOCODER_*`, `OLLAMA_TIMEOUT_MS` и т. д.) имеет значения по умолчанию.

## Прод

Сейчас всё крутится на своём железе: API, база и фронт на домашнем сервере с Ubuntu, модель — на отдельном ПК с RTX 4060, связь через Tailscale. Наружу фронт отдаётся через Cloudflare Tunnel.

Фронт на сервере запускаем собранным, а не в dev-режиме:

```bash
pnpm start:server
pnpm start:miniapp     # vite build + vite preview на том же порту 5173
```

После правок фронта `start:miniapp` нужно перезапустить, чтобы он пересобрался.

Геокодер площадок можно поставить отдельной службой, инструкция в начале `deploy/evently-geocoder.service`.

Есть и Docker-образ (`Dockerfile` + `docker/start.sh`) — поднимает всё разом с демо-данными, удобно для проверки.

## Полезное

- Метрики ленты: `/api/admin/metrics?key=<ADMIN_METRICS_KEY>`.
- Скрипты в `apps/server/src/scripts` запускаются так: `pnpm --filter @evently/server exec tsx src/scripts/<имя>.ts`
  - `geocode-venues.ts` — проставить координаты площадкам;
  - `dedup-stats.ts` — посмотреть, сколько дублей склеилось;
  - `recategorize.ts` — пересчитать категории событий;
  - `max-test-message.ts` — отправить тестовое сообщение от бота.
- Все изменения после отборочного этапа расписаны в `CHANGELOG.md`.

## Данные

События берём из открытых афиш (Timepad, KudaGo). Заведения — из OpenStreetMap, © участники OpenStreetMap, лицензия ODbL; подпись показываем в приложении.

## Команда

- Кирилл Скрипников — капитан, full-stack;
- Иван Ковалёв — парсер, ML;
- Никита Луговой — дизайн, тестирование.
