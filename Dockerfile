FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=true

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       openssl \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
    && corepack prepare pnpm@11.27.0 --activate

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile

RUN chmod +x /app/docker/start.sh

EXPOSE 3000
EXPOSE 5173

CMD ["bash", "/app/docker/start.sh"]
