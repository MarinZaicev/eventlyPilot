#!/usr/bin/env bash
# Остановить и удалить службу. Окружение, настройки и собранные данные не удаляются.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Нужны права root: sudo $0" >&2; exit 1; }
systemctl disable --now afisha-parser 2>/dev/null || true
rm -f /etc/systemd/system/afisha-parser.service
systemctl daemon-reload
echo "Служба удалена. Данные и .env остались на месте."
