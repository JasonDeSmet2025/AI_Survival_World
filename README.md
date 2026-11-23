# AI Survival World

Browser-based 3D survival world (TypeScript + Babylon.js + Vite) with a
zero-dependency Node server that serves the built game, the NPC chat API and
server-authoritative WebSocket multiplayer — all from **one port**.

- Repo: `https://github.com/JasonDeSmet2025/AI_Survival_World`
- No database: the shared world is a single JSON file (`server/store.mjs`), which
  in Docker lives on a named volume.

---

## 1. Architecture

```
                        browser  ── http://<host>:8080/
                                  │
             ┌────────────────────┴─────────────────────────┐
             │  Docker container  ai-survival-world:latest   │
             │  CMD: node server/server.mjs                  │
             │                                               │
   / ────────┼─► dist/          built frontend (Vite)        │
   /health ──┼─► health probe   {ok, players, model}         │
   /api/chat ┼─► NPC chat (solo) ──► LiteLLM gateway (Qwen)  │
   /ws ──────┼─► multiplayer WebSocket (same HTTP server)    │
             │                        │                      │
             │        /data/world-state.json  ◄── named volume
             └───────────────────────────────────────────────┘
                     host :8080  ──►  container :8080
```

One process, one port, one origin. The frontend connects to `ws(s)://<same
host>/ws` and `POST /api/chat` on its own origin (`src/game/net/identity.ts`,
`src/game/game.ts`), so there is no CORS setup and no second port to publish.

- **Frontend build**: `npm run build` (`tsc` + `vite build`) → `dist/`.
- **Backend start**: `node server/server.mjs` (also available locally as `npm start`).
  It serves `dist/`, so a production container never runs the Vite dev server —
  and the container itself runs `node server/server.mjs` directly via its `CMD`.
- **Storage**: JSON file at `MP_STATE_FILE`, written atomically on a debounce and
  flushed on `SIGINT`/`SIGTERM`. No Redis, no Postgres, no migrations.

## 2. Requirements

|                     | Minimum                                                     |
| ------------------- | ----------------------------------------------------------- |
| Docker Engine       | 24+ with the Compose v2 plugin (`docker compose`)             |
| Node.js (local dev) | Node 22 (the image uses `node:22-slim`)                       |
| Memory              | ~1.5 GB free during the frontend build (Babylon bundle)       |
| Network             | outbound HTTPS to the LLM gateway for NPC conversation         |
| Disk                | ~500 MB for the image; the world file is a few hundred KB      |

`docker --version && docker compose version` should both succeed before you start.

## 3. Local development (no Docker)

```bash
npm install          # dev dependencies: vite, typescript, vitest, playwright
npm run dev          # Vite dev server on :5173, proxies /api and /ws to :3000
npm start            # the game server on :3000 (serves dist/, /api/chat, /ws)
npm run build        # type-check + production bundle -> dist/
npm test             # vitest: client unit tests + server/llm.test.mjs
npm run test:server  # node --test: server unit + end-to-end multiplayer tests
npm run qa:mp        # headless-browser QA: two real players in one world
```

`npm run dev` is development only. In Docker the game is served by the game
server itself.

## 4. Configuration (environment variables)

Copy the sample and fill in the key:

```bash
cp .env.example .env
chmod 600 .env          # only the deploy user may read it
$EDITOR .env
```

| Variable                | Default                                | Used by            | Purpose                                                       |
| ----------------------- | -------------------------------------- | ------------------ | ------------------------------------------------------------- |
| `VIVES_LLM_KEY`         | *(empty, set it in `.env`)*            | `server/server.mjs`| Bearer key for the LiteLLM gateway. **Secret.** Empty = NPCs fall back to offline lines. |
| `VIVES_LLM_URL`         | `https://api.llm.mechatronics.be/v1`   | `server/server.mjs`| Gateway base URL.                                             |
| `VIVES_MODEL`           | `qwen3.8-27b`                          | `server/llm.mjs`   | Preferred model; re-resolved at runtime if the key may not use it. |
| `MP_STATE_FILE`         | `server/data/world-state.json` (local), `/data/world-state.json` (Docker) | `server/store.mjs` | Where the shared world and player profiles persist. |
| `PORT`                  | `3000` (local), `8080` (Docker, fixed by `compose.yaml`) | `server/server.mjs` | HTTP + WebSocket port.                     |
| `NPC_CHAT_BURST`        | `5`                                    | `server/npc.mjs`   | NPC messages allowed per player per refill window.            |
| `NPC_CHAT_REFILL_MS`    | `5000`                                 | `server/npc.mjs`   | ms per restored budget token.                                 |
| `NPC_MAX_INFLIGHT`      | `4`                                    | `server/npc.mjs`   | Concurrent gateway calls across all players.                  |
| `NPC_MEMORY_TTL_MS`     | `3600000`                              | `server/server.mjs`| Forget a conversation after this much silence.                |
| `NPC_MEMORY_SWEEP_MS`   | `300000`                               | `server/server.mjs`| Idle-conversation sweep interval.                             |
| `TIME_SYNC_MS`          | `2000`                                 | `server/server.mjs`| How often the shared day/night clock is broadcast.            |
| `BUSH_REGROW_MS`        | `90000`                                | `server/server.mjs`| Bush regrowth timer (`0` disables).                           |

There is no `VITE_*` variable: the frontend contains no configuration and no
secret, and nothing is baked into the bundle at build time.

### Secret handling

- The key is read from `VIVES_LLM_KEY` **at container runtime** only.
- `.env` is ignored by Git (`.gitignore`) and excluded from the Docker build
  context (`.dockerignore`), so it can never reach an image layer.
- `.env.example` is committed and contains no real key.
- The server never logs the key and never sends it to the browser; gateway
  errors are truncated and stripped of headers (`server/llm.mjs`).
- Container environment values are visible to anyone who can run
  `docker inspect` on this host — keep `.env` at mode `600` and shell access
  limited.
- The server also falls back to `~/.config/ai-operations/vives-llm-key` when the
  variable is unset; inside the container that path does not exist, so the
  variable is the single source of truth there.

## 5. Run it in Docker

```bash
cd /root/AI_Survival_World
# create .env only when it does not exist yet; an existing .env is never overwritten
if [ ! -f .env ]; then cp .env.example .env && chmod 600 .env; fi
# then put the real key in .env (skip if .env already existed)
docker compose build                        # multi-stage build -> ai-survival-world:latest
docker volume create ai-survival-world-data # fresh installs only — see note below
docker compose up -d                        # start in the background
docker compose ps                           # STATUS should become "running (healthy)"
curl -s http://localhost:8080/health        # {"ok":true,"players":0,"model":"qwen3.8-27b"}
```

`compose.yaml` declares the volume as `external: true`, so `docker compose up -d`
fails with "no such volume" on a **completely fresh installation** until the
named volume exists. That is why `docker volume create ai-survival-world-data` is
listed above. **On an existing installation, skip this command and keep the
existing volume** — it holds the live world data, and creating a volume that
already exists is a no-op at best, but never re-initialize or remove it.

Open `http://<host-ip>:8080/` in the browser. A second person on the same URL is
automatically a second player in the same world (multiplayer is on by default;
`?solo=1` opts out).

The published port is `8080` on the host **and** in the container, bound to all
interfaces, so the world is reachable from other machines — not just `localhost`.

### Stop, restart, remove

```bash
docker compose restart              # restart (keeps the world file, ~1 s downtime)
docker compose stop                 # stop now, keep the container
docker compose start                # start a stopped container again
docker compose down                 # stop AND remove the container
docker compose down -v              # DANGER: also deletes the world volume
```

`docker compose down` does **not** delete data: the world lives in the named
volume `ai-survival-world-data`, which only `-v` removes. The server flushes the
world file on `SIGTERM`, and Compose gives it 30 s (`stop_grace_period`) plus a
proper `init` as PID 1 to receive that signal.

`restart: always` means the container comes back after a crash and after a host
reboot (as long as the Docker daemon starts).

### Logs and status

```bash
docker compose logs -f              # follow: HTTP/WS activity, [npc], [store], [llm]
docker compose logs --since 10m     # recent history
docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q)"
docker stats --no-stream            # CPU / RAM / net of the running container
```

Useful log lines: `AI Survival World server listening on http://localhost:8080`,
`[store] wrote/dropped …`, `[llm] model -> …`, `[npc] rate limit: …`.

## 6. Persistent world data

Everything shared — buildings, harvested and depleted nodes, the day/night
clock, campfire fuel, door states and each player's saved progress — is one JSON
document at `/data/world-state.json` inside the container, backed by the named
volume `ai-survival-world-data` on the host.

```bash
docker volume ls | grep ai-survival-world-data
# Host location (needs root):
docker volume inspect ai-survival-world-data --format '{{.Mountpoint}}'
```

**Back up** (works while the container runs; the server writes atomically):

```bash
docker run --rm -v ai-survival-world-data:/data:ro -v "$PWD:/backup" alpine \
  tar czf /backup/world-backup-$(date +%F).tgz -C /data .
```

**Restore**:

```bash
BACKUP_FILE="world-backup-YYYY-MM-DD.tgz"   # adjust to the actual backup filename
docker compose stop
docker run --rm -v ai-survival-world-data:/data -v "$PWD:/backup" alpine \
  tar xzf "/backup/$BACKUP_FILE" -C /data
docker compose up -d
```

`YYYY-MM-DD` is a placeholder: set `BACKUP_FILE` to the name of the backup you
actually want to restore (see the `date +%F` names produced by the backup
command above).

An unreadable or hand-edited file is validated on load; invalid records are
dropped with a `[store] dropped N invalid record(s)` log line instead of
corrupting the world. Wiping the world on purpose is a game action (settings
panel → world reset), not a deploy step.

## 7. Updating an existing installation safely

The volume and the `.env` file are **not** part of the image, so an update never
touches the world or the key.

```bash
cd /root/AI_Survival_World
docker compose ps -q && docker compose stop          # flush the world file first (optional but tidy)
git fetch origin && git pull --ff-only origin main   # your approved change set only
docker compose build                                 # new image, same tags
docker compose up -d                                 # recreates the container only
docker compose ps && docker compose logs --since 2m  # healthy? world intact?
```

Check after the update:

```bash
curl -s http://localhost:8080/health                 # ok:true
docker volume inspect ai-survival-world-data --format '{{.CreatedAt}}'   # unchanged volume
```

If the new build misbehaves: `git checkout <previous-tag-or-commit> && docker
compose build && docker compose up -d` — the world file is still the same file,
so rolling back costs nothing but downtime.

One caveat: `server/store.mjs` only loads a file whose format marker is `v: 1`.
If a future version ever bumps that marker, an older build would start an empty
world and its next write would replace the file. So take the backup above before
any update that changes the save format.

Never run `docker compose down -v`, `docker volume rm`, or `docker system prune
--volumes` as part of an update.

## 8. GitHub workflow

```bash
git status                       # .env must NOT appear (it is gitignored)
git add Dockerfile compose.yaml .dockerignore .env.example README.md
git commit -m "feat: Docker production deployment"   # only when you approve it
git push origin main                                 # only when you approve it
```

Rules that matter for this repo:

- `.env` is never committed; `.env.example` is the committed template.
- The deploy host pulls from `main` (or checks out a tag) and builds **there** —
  no images and no `dist/` in Git, no `node_modules` in Git.
- Before pushing: `npm run build`, `npm test`, `npm run test:server`.
- Docker layer order keeps `npm ci` cached: editing `src/` re-runs only the
  build stage, not the dependency install.

## 9. Files added for deployment

| File            | Role                                                                     |
| --------------- | ------------------------------------------------------------------------ |
| `Dockerfile`    | 3 stages: deps (`npm ci`) → build (`npm run build`) → runtime (`CMD ["node", "server/server.mjs"]`, `node:22-slim`, non-root, no `node_modules`). |
| `compose.yaml`  | service, `8080:8080`, `restart: always`, named volume on `/data`, healthcheck, `MP_STATE_FILE`, env interpolation from `.env`. |
| `.dockerignore` | keeps `.env`, Git, `node_modules`, `dist`, `server/data` and QA artifacts out of the build context. |
| `.env.example`  | documented template with safe example values and an empty key.            |
| `README.md`     | this document.                                                            |

## 10. Known state

- `npm test` (vitest): **61 files / 890 tests green**, `npm run build` clean.
- `npm run test:server`: `npc/server/quests/clock/store/mp-world` — the NPC
  conversation test file (`server/npc.test.mjs`) currently reports failures that
  exist on `main` already (test expectations drifted from `server/npc.mjs`).
  This is a pre-existing code/test issue, unrelated to the Docker setup, and is
  left untouched by this deployment work.
- The world format is `v: 1`; a future format change needs a migration step in
  `server/store.mjs` before the file is rewritten.
