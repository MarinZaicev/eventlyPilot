#!/usr/bin/env bash

set -Eeuo pipefail

cd /app

echo
echo "======================================"
echo " Evently Docker"
echo "======================================"
echo

echo "[1/6] Synchronizing PostgreSQL schema..."

pnpm \
  --filter @evently/db \
  exec prisma db push \
  --schema prisma/schema.prisma \
  --accept-data-loss

echo
echo "[2/6] Generating Prisma Client..."

pnpm \
  --filter @evently/db \
  exec prisma generate \
  --schema prisma/schema.prisma

echo
echo "[3/6] Seeding categories..."

pnpm \
  --filter @evently/db \
  exec tsx src/seed.ts

echo
echo "[4/6] Seeding Docker demo events..."

pnpm \
  --filter @evently/db \
  exec tsx src/docker-demo-seed.ts

echo
echo "[5/6] Starting Evently API..."

pnpm start:server &

BACKEND_PID=$!

sleep 2

if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
  echo "Backend failed to start."
  wait "$BACKEND_PID"
  exit 1
fi

echo
echo "[6/6] Starting Evently Mini App..."

pnpm dev:miniapp &

FRONTEND_PID=$!

cleanup() {
  echo
  echo "Stopping Evently..."

  kill \
    "$BACKEND_PID" \
    "$FRONTEND_PID" \
    2>/dev/null || true

  wait \
    "$BACKEND_PID" \
    "$FRONTEND_PID" \
    2>/dev/null || true
}

trap cleanup SIGINT SIGTERM EXIT

set +e

wait -n \
  "$BACKEND_PID" \
  "$FRONTEND_PID"

EXIT_CODE=$?

set -e

echo "One of the Evently processes stopped with code ${EXIT_CODE}."

exit "$EXIT_CODE"
