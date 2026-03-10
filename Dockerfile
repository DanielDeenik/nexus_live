# syntax=docker/dockerfile:1
# ── Nexus Live — Dockerfile ───────────────────────────────────────────────────
# Multi-stage build: deps first, then app. Keeps image lean (~120MB).
# Compatible with: Railway (Dockerfile mode), Render, Fly.io, any Docker host.
# NOTE: Railway now uses Railpack by default (railway.toml). This Dockerfile
#       is kept as a fallback. The --mount=type=cache persists npm downloads
#       between builds so you don't re-download 200MB of packages every time.

# ── Stage 1: install dependencies ────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --omit=dev --no-audit --no-fund

# ── Stage 2: runtime image ────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

# Security: run as non-root user
RUN addgroup -S nexus && adduser -S nexus -G nexus

# Copy only what we need (no .env, no test files, no Mac artifacts)
COPY --from=deps /app/node_modules ./node_modules
COPY server.js    ./
COPY package.json ./
COPY lib/         ./lib/
COPY routes/      ./routes/
COPY workers/     ./workers/
COPY public/      ./public/
COPY config/      ./config/

# The app reads PORT from env; default to 3333 for local Docker runs
ENV PORT=3333
ENV NODE_ENV=production

EXPOSE 3333

USER nexus

# Healthcheck — used by Railway/Render/Fly uptime monitors
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3333/health || exit 1

CMD ["node", "server.js"]
