# Автономный запуск в Docker:  docker compose up -d
FROM python:3.12-slim

# ffmpeg — только для скачивания трейлеров в 720p (AFISHA_TRAILERS_DOWNLOAD=true)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install --no-cache-dir ".[trailers]" && useradd --create-home --uid 1000 afisha

USER afisha
# Настройки приходят из .env через docker-compose (env_file), данные — в том /data
ENV AFISHA_OUTPUT_DIR=/data/output \
    XDG_CACHE_HOME=/data/.cache \
    PYTHONUNBUFFERED=1
WORKDIR /data
HEALTHCHECK --interval=30m --start-period=6h CMD python -m afisha_parser status > /dev/null || exit 1
CMD ["python", "-m", "afisha_parser", "daemon"]
