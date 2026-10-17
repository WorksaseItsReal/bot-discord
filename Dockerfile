# syntax=docker/dockerfile:1

# ---- Étape 1 : dépendances (outils de compilation pour better-sqlite3) ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npm cache clean --force

# ---- Étape 2 : image finale (sans outils de compilation) ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DATABASE_PATH=/app/data/gadget.sqlite \
    HEALTH_PORT=8080 \
    HEALTH_HOST=0.0.0.0
WORKDIR /app

# Code en lecture seule pour l'utilisateur du bot (propriété root) ;
# seul /app/data (base + sauvegardes) est inscriptible.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY scripts ./scripts
RUN mkdir -p /app/data/backups && chown -R node:node /app/data

USER node
VOLUME ["/app/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "scripts/docker-healthcheck.js"]

CMD ["node", "src/index.js"]
