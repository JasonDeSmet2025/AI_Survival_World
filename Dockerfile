# AI Survival World — production image
#
# Multi-stage:
#   1. deps     — install the lockfile once, so code edits reuse that layer
#   2. build    — `npm run build` (tsc + vite build) -> dist/
#   3. runtime  — the game server + dist/ only, NO node_modules and no toolchain
#
# The runtime stage is deliberately tiny: server/server.mjs is zero-dependency
# Node (only node:* built-ins plus its own modules), and the Babylon bundle is
# already compiled into dist/. So the shipped image contains neither dev
# dependencies nor browser tooling — nothing that could leak a build secret.
#
# What the container serves, on ONE port (PORT, default 8080):
#   /            the built game (dist/)
#   /health      health probe
#   /api/chat    NPC conversation (solo)
#   /ws          WebSocket multiplayer (same HTTP server, upgrade event)
#
# Secrets: no secret is ever COPYed or baked in. VIVES_LLM_KEY is read from the
# container environment at runtime only (see compose.yaml and .env.example).

# ---------------------------------------------------------------------------
# Stage 1 — dependencies
# ---------------------------------------------------------------------------
FROM node:22-slim AS deps
WORKDIR /app
# The QA scripts use @playwright/test; a production image must never spend
# time or space on browser downloads.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# Stage 2 — frontend build (existing build command: tsc && vite build)
# ---------------------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3 — runtime
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production

WORKDIR /app

# The server is the only thing that runs here; dist/ is the compiled frontend.
COPY package.json ./
COPY server ./server
COPY --from=build /app/dist ./dist

# Persistent world data (MP_STATE_FILE) lives in a named volume mounted on
# /data. Creating it here with the right owner means a fresh named volume
# inherits the ownership on first use, so the unprivileged user can write.
RUN mkdir -p /data && chown -R node:node /data /app

# Never run the game server as root.
USER node

# PORT 8080 inside the container (compose publishes 8080 on the host too).
# MP_STATE_FILE points at the volume so the shared world survives restarts.
ENV PORT=8080 \
    MP_STATE_FILE=/data/world-state.json

EXPOSE 8080

# Start command: `npm start` is `node server/server.mjs` (package.json), and it
# is run HERE AS THAT COMMAND ON PURPOSE. Verified on this image: with
# `CMD ["npm","start"]` npm is PID 1 and does not forward signals, so the
# server's SIGTERM handler never runs — `docker stop` either killed the world
# server immediately (losing the last sub-second world changes) or, with
# StopSignal=SIGINT, hung until SIGKILL after 10 s (exit 137). Started directly
# it exits 0 within ~0,4 s and the world file is flushed before exit.
# If you ever want npm in the chain anyway: docker run --entrypoint npm <image> start
#
# The server binds all interfaces, serves dist/ + /api/chat + /ws on PORT, and
# flushes the world file on SIGINT/SIGTERM.
CMD ["node", "server/server.mjs"]
