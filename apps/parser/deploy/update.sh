#!/usr/bin/env bash
# Обновление парсера из свежего архива.
#   ./update.sh                 — взять самый свежий afisha-parser*.zip из ~/projects/parser (или из ~)
#   ./update.sh путь/к/файл.zip — взять конкретный архив
# Если архива нет — только переустановить текущий код и прогнать тесты.
# Если установлена служба — перезапускает её на новом коде.
# Обработанные архивы уезжают в ~/afisha-data/releases/, чтобы не распаковать старый ещё раз.
# Новая версия этого скрипта лежит в afisha-parser/deploy/update.sh. Скрипт не обновляет
# сам себя (bash читает файл по ходу выполнения), скопируйте вручную, когда он изменится:
#   cp ~/projects/parser/afisha-parser/deploy/update.sh ~/projects/parser/update.sh
set -euo pipefail

PROJECT_ROOT=~/projects/parser
VENV=~/.venvs/afisha-parser
DATA=~/afisha-data

if [[ ! -f "$DATA/.env" ]]; then
  echo "Нет $DATA/.env — сначала перенесите туда настройки" >&2
  exit 1
fi

if [[ $# -ge 1 ]]; then
  zip_path=$(realpath "$1")
else
  # Самый свежий архив — сначала в папке проекта, потом в домашней
  zip_path=$(find "$PROJECT_ROOT" ~ -maxdepth 1 -type f -name 'afisha-parser*.zip' -printf '%T@\t%p\n' 2>/dev/null \
             | sort -rn | head -1 | cut -f2-)
fi

cd "$PROJECT_ROOT"
if [[ -n "$zip_path" ]]; then
  echo "Распаковываю: $zip_path"
  rm -rf afisha-parser/src  # удалённые в новой версии модули не должны остаться от старой
  unzip -oq "$zip_path"
  mkdir -p "$DATA/releases"
  find "$PROJECT_ROOT" ~ -maxdepth 1 -type f -name 'afisha-parser*.zip' -exec mv -f -t "$DATA/releases/" {} + 2>/dev/null || true
  [[ -f "$zip_path" ]] && mv "$zip_path" "$DATA/releases/"
else
  echo "Новых архивов нет, переустанавливаю текущий код"
fi

ln -sf "$DATA/.env" afisha-parser/.env
chmod +x afisha-parser/deploy/*.sh
source "$VENV/bin/activate"
cd afisha-parser
python -m pip install -q ".[dev,trailers]"
python -m pytest -q

if [[ -f /etc/systemd/system/afisha-parser.service ]]; then
  echo "Перезапускаю службу на новом коде..."
  sudo systemctl restart afisha-parser
  systemctl --no-pager --lines=0 status afisha-parser | head -3
fi
