Afisha parser — служба сбора афиши
==================================

Служба afisha-parser работает в фоне: каждые AFISHA_INTERVAL_MINUTES минут собирает события,
отбрасывает прошедшие, пишет файлы в output/ и (если задан адрес) отправляет их в бэкенд.

Настройки: .env в этой папке. После изменения: sudo systemctl restart afisha-parser

  systemctl status afisha-parser       работает ли служба
  journalctl -u afisha-parser -f       журнал в реальном времени
  journalctl -u afisha-parser --since today
  <venv>/bin/python -m afisha_parser status   итоги последнего цикла (запускать из этой папки)
  sudo systemctl stop afisha-parser    остановить
  sudo systemctl start afisha-parser   запустить
  <venv>/bin/python -m afisha_parser resume timepad   снять паузу с источника после отказа 403

Бережный режим: не больше AFISHA_REQUESTS_PER_HOUR запросов в час к каждому источнику.
Если источник ответил 401/403/429, он на AFISHA_BLOCK_PAUSE_HOURS часов ставится на паузу,
а приложение получает последние сохранённые данные.

Результат:
  output/evently/<источник>/<город>/latest.json  — события для Evently (только актуальные)
  output/events/<источник>/<город>/latest.json   — полный универсальный дамп
  output/movies/tmdb/<регион>/latest.json        — фильмы в прокате и премьеры с трейлерами
  output/status.json                             — итоги последнего цикла
