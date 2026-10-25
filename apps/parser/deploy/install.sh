#!/usr/bin/env bash
# Установка парсера как службы systemd: работает в фоне, переживает перезагрузку,
# сам поднимается после сбоев. Запуск из папки проекта:
#
#   sudo ./deploy/install.sh
#
# По умолчанию (можно переопределить переменными окружения):
#   AFISHA_USER  — от чьего имени работает служба  (тот, кто вызвал sudo)
#   AFISHA_VENV  — окружение Python                 (~/.venvs/afisha-parser)
#   AFISHA_DATA  — настройки .env и данные output/  (~/afisha-data)
# Повторный запуск безопасен: обновит код и перезапустит службу, .env и данные не трогает.
set -euo pipefail

SERVICE=afisha-parser
CODE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if [[ $EUID -ne 0 ]]; then
  echo "Нужны права root: sudo $0" >&2
  exit 1
fi
if ! command -v systemctl >/dev/null; then
  echo "systemd не найден. Используйте Docker: docker compose up -d (см. README)" >&2
  exit 1
fi

RUN_USER=${AFISHA_USER:-${SUDO_USER:-}}
if [[ -z "$RUN_USER" || "$RUN_USER" == root ]]; then
  echo "Запускайте через sudo от обычного пользователя или укажите AFISHA_USER=имя" >&2
  exit 1
fi
RUN_GROUP=$(id -gn "$RUN_USER")
USER_HOME=$(getent passwd "$RUN_USER" | cut -d: -f6)
VENV=${AFISHA_VENV:-$USER_HOME/.venvs/afisha-parser}
DATA=${AFISHA_DATA:-$USER_HOME/afisha-data}
as_user() { sudo -u "$RUN_USER" -H "$@"; }

echo "Пользователь: $RUN_USER"
echo "Код:          $CODE_DIR"
echo "Окружение:    $VENV"
echo "Данные:       $DATA"

# 1. Python 3.12+ и venv
PY=$(command -v python3 || true)
if [[ -z "$PY" ]] || ! "$PY" -c 'import sys; sys.exit(sys.version_info < (3, 12))'; then
  echo "Нужен Python 3.12 или новее (Ubuntu 24.04+). Сейчас: $($PY --version 2>&1 || echo 'нет')" >&2
  exit 1
fi
if ! "$PY" -c 'import ensurepip, venv' 2>/dev/null; then
  echo "Ставлю python3-venv..."
  apt-get update -qq && apt-get install -y -qq python3-venv
fi
# ffmpeg нужен только для трейлеров в 720p; без него yt-dlp скачает 360p
command -v ffmpeg >/dev/null || { (apt-get update -qq && apt-get install -y -qq ffmpeg) \
  || echo "ffmpeg не установлен — трейлеры будут в 360p"; }

# 2. Окружение и код (обычная, не editable-установка: служба не зависит от папки с исходниками)
if [[ ! -x "$VENV/bin/python" ]]; then
  as_user mkdir -p "$(dirname "$VENV")"
  as_user "$PY" -m venv "$VENV"
fi
as_user "$VENV/bin/python" -m pip install -q --upgrade pip
as_user "$VENV/bin/python" -m pip install -q "$CODE_DIR[trailers]"
echo "Установлена версия: $(as_user "$VENV/bin/python" -c 'import afisha_parser; print(afisha_parser.__version__)')"

# 3. Папка данных и .env
as_user mkdir -p "$DATA/output"
if [[ ! -f "$DATA/.env" ]]; then
  as_user cp "$CODE_DIR/.env.example" "$DATA/.env"
  as_user sed -i "s|^AFISHA_OUTPUT_DIR=.*|AFISHA_OUTPUT_DIR=$DATA/output|" "$DATA/.env"
  chmod 600 "$DATA/.env"
  NEW_ENV=1
elif ! grep -q '^AFISHA_OUTPUT_DIR=' "$DATA/.env"; then
  echo "AFISHA_OUTPUT_DIR=$DATA/output" | as_user tee -a "$DATA/.env" >/dev/null
fi
as_user cp "$CODE_DIR/deploy/README-service.txt" "$DATA/README-service.txt" 2>/dev/null || true

# 4. Служба
sed -e "s|@USER@|$RUN_USER|g" -e "s|@GROUP@|$RUN_GROUP|g" -e "s|@VENV@|$VENV|g" -e "s|@DATA@|$DATA|g" \
  "$CODE_DIR/deploy/afisha-parser.service" > /etc/systemd/system/$SERVICE.service
systemctl daemon-reload
systemctl enable $SERVICE >/dev/null

if [[ -n "${NEW_ENV:-}" ]]; then
  echo
  echo "Создан $DATA/.env. Впишите в него настройки (как минимум AFISHA_USER_AGENT и AFISHA_TMDB_API_KEY),"
  echo "затем запустите службу:  sudo systemctl start $SERVICE"
else
  systemctl restart $SERVICE
  echo
  echo "Служба запущена."
fi
cat <<INFO

Полезные команды:
  systemctl status $SERVICE                  — работает ли
  journalctl -u $SERVICE -f                  — журнал в реальном времени
  cd $DATA && $VENV/bin/python -m afisha_parser status   — итоги последнего цикла
  sudo systemctl restart $SERVICE            — после правки .env
INFO
