/**
 * AI Survival World game server (zero external dependencies).
 *
 *  - HTTP on port 3000: serves the built game (dist/), /health and
 *    POST /api/chat (proxies NPC conversation to the Qwen model through
 *    the LiteLLM gateway; the API key never leaves the server).
 *  - WebSocket on the same port, path /ws: server-authoritative
 *    multiplayer. The server owns shared world state (buildings,
 *    harvested/depleted resources) and relays player positions.
 *
 * Protocol (matches src/game/net/mp.ts):
 *   client -> server: join | pos | place | harvest | chat | save | sleep |
 *                     fuel | name | toggle | hit | reset
 *   server -> client: hello | p | joined | left | placed | harvested |
 *                     depleted | regrow | reject | npc_reply | npc_error |
 *                     time | renamed | toggled | hit | world-reset
 *
 * What the server owns is everything a second player could disagree about:
 * shared world state, harvest rolls, campfire fuel, the day/night clock and
 * each player's own progress. That last one is why multiplayer used to feel
 * broken: `persist()` in game.ts bails out whenever a socket is attached, so
 * a reload cost you your whole bag, your level and your spot in the world.
 * Progress now lives here, keyed by a per-player token (server/store.mjs),
 * and the whole world survives a server restart.
 *
 * The server is authoritative for ALL shared state: node hp AND harvest
 * yields (clients used to roll their own Math.random() for items, so two
 * players could disagree about what entered their inventory). `harvested`
 * therefore carries the absolute `hp`, the rolled `amount` and `by` (the
 * harvester's server id); every client applies hp as an absolute value —
 * the initiator included, which is what fixes the old double-damage bug.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createLlmClient } from './llm.mjs';
import { createNpcBrain, ChatBudget, Gate } from './npc.mjs';
import { createWorldClock, DAY_LENGTH_S, MORNING } from './clock.mjs';
import { createWorldStore, BUILD_KINDS, sanitizeName } from './store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const LLM_URL = process.env.VIVES_LLM_URL || 'https://api.llm.mechatronics.be/v1';
// Preferred NPC model; the client re-resolves it at runtime when the gateway
// key no longer allows it (see server/llm.mjs).
const llm = createLlmClient({ baseUrl: LLM_URL, log: (m) => console.log(m) });
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Idle conversation memory is released: a server that runs for weeks must not
// accumulate a session per player forever.
const NPC_MEMORY_TTL_MS = Math.max(60_000, Number(process.env.NPC_MEMORY_TTL_MS || 60 * 60 * 1000));
const NPC_MEMORY_SWEEP_MS = Math.max(1_000, Number(process.env.NPC_MEMORY_SWEEP_MS || 5 * 60 * 1000));

/**
 * The conversation brain: server-side personas, per-(npc, player) memory and
 * the cost/concurrency guardrails. Both NPC endpoints (WebSocket `chat` and
 * POST /api/chat) go through it, so a solo player and a multiplayer player
 * talk to the same character with the same memory.
 */
const npcBrain = createNpcBrain({
  llm,
  key: llmKey,
  budget: new ChatBudget(),
  gate: new Gate(),
  log: (m) => console.log(m),
});

// Must match WORLD_SEED in src/game/world/heightfield.ts
const SEED = 0x5eed2024;
// Must match TERRAIN_SIZE (640) in src/game/world/heightfield.ts. The old
// value (160) made the outer half of the island unbuildable.
const WORLD_HALF = 320;

// Must match per-kind harvest counts in src/game/world/flora.ts
const MAX_HARVEST = { tree: 3, pine: 3, rock: 2, bush: 2 };

// Where the shared world and the player profiles survive a restart.
// Env-overridable: every test boots its own server with its own file, and the
// unit tests use no file at all.
const STATE_FILE = process.env.MP_STATE_FILE
  ? path.resolve(process.env.MP_STATE_FILE)
  : path.join(__dirname, 'data', 'world-state.json');

// How often the shared clock is re-announced. Clients extrapolate smoothly
// between these, so this only has to be often enough to bound drift.
const TIME_SYNC_MS = Math.max(250, Number(process.env.TIME_SYNC_MS || 2000));

// A player identity token (see the client's localStorage) is opaque and
// stable; anything else gets a fresh one issued.
const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Must match YIELDS in src/game/core/items.ts. The harvest amount is rolled
// HERE (server-authoritative) from a seeded hash, so every client sees the
// same inventory change for the same harvest event.
const YIELDS = {
  tree: { min: 2, max: 3 },
  pine: { min: 2, max: 3 },
  rock: { min: 2, max: 3 },
  bush: { min: 2, max: 3 },
};



// Bushes regrow on the server and are announced with a `regrow` message.
// Client-side timers only regrew locally and desynced every other player.
// Env-overridable so tests do not wait 90 s.
const BUSH_REGROW_MS = Math.max(0, Number(process.env.BUSH_REGROW_MS ?? 90_000) || 0);

// Transport hardening: a single logical message may never exceed this, and
// one connection may not push more than MSG_RATE_LIMIT messages per second
// (excess messages are silently dropped, not a disconnect — a laggy client
// resending positions must not be able to flood the broadcast loop).
const MAX_MESSAGE_BYTES = 65_536;
const MSG_RATE_LIMIT = 60;

/**
 * Deterministic harvest roll in [min, max] for (nodeId, count). Derived from
 * the world seed + node id + harvest index, so the result is reproducible and
 * — more importantly — identical for every client that receives the event.
 */
function yieldAmount(kind, nodeId, count) {
  const y = YIELDS[kind];
  const spread = y.max - y.min + 1;
  const h = crypto.createHash('sha1').update(`${SEED}:${nodeId}:${count}`).digest();
  return y.min + (h.readUInt32BE(0) % spread);
}

// Real client address for the solo /api/chat session owner key. Direct TCP
// peer only (this server sits behind no proxy); never logged, never echoed.
function clientIp(req) {
  return String(req.socket?.remoteAddress ?? 'unknown').slice(0, 45);
}

// ---------------------------------------------------------------------------
// LLM key resolution (never printed, never sent to the browser)
// ---------------------------------------------------------------------------
function llmKey() {
  if (process.env.VIVES_LLM_KEY) return process.env.VIVES_LLM_KEY;
  try {
    return fs
      .readFileSync(path.join(os.homedir(), '.config', 'ai-operations', 'vives-llm-key'), 'utf8')
      .trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// NPC identities live in server/npc.mjs (persona + world knowledge + limits),
// shared by every endpoint. src/game/ai/npc.ts keeps the client-side copy that
// drives the portrait and the offline fallback lines; server/npc.test.mjs
// asserts the two id lists stay in step.
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// WebSocket plumbing (RFC 6455, minimal)
// ---------------------------------------------------------------------------
function encodeFrame(data, opcode = 0x1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}

function decodeFrames(buf) {
  // Returns { frames, rest, error? }: all complete frames plus the leftover
  // bytes. `error` is set when the peer declared an impossible payload size.
  const out = [];
  let off = 0;
  while (true) {
    if (buf.length - off < 2) break;
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let pos = off + 2;
    if (len === 126) {
      if (buf.length - pos < 2) break;
      len = buf.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (buf.length - pos < 8) break;
      len = Number(buf.readBigUInt64BE(pos));
      pos += 8;
    }
    if (len > MAX_MESSAGE_BYTES) {
      return { frames: out, rest: Buffer.alloc(0), error: 'message too big' };
    }
    let maskKey = null;
    if (masked) {
      if (buf.length - pos < 4) break;
      maskKey = buf.subarray(pos, pos + 4);
      pos += 4;
    }
    if (buf.length - pos < len) break;
    let payload = buf.subarray(pos, pos + len);
    if (maskKey) {
      const unmasked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i & 3];
      payload = unmasked;
    }
    out.push({ opcode, payload, fin });
    off = pos + len;
  }
  return { frames: out, rest: Buffer.from(buf.subarray(off)) };
}

const store = createWorldStore({ file: STATE_FILE, log: (m) => console.log(m) });
store.load();

/**
 * The shared day/night clock. Restored from the world file, so the server
 * coming back up does not drop a base from night into high noon.
 */
const clock = createWorldClock({
  dayLengthS: DAY_LENGTH_S,
  start: MORNING,
  offsetS: store.clockOffset(),
});

const players = new Map(); // playerId -> { id, name, token, p, r, ws, spawnIndex }
const lastHitAt = new Map(); // playerId -> ms stamp of last accepted PvP hit (rate gate)
let lastResetAt = -1e9; // ms stamp of the last accepted world reset (global gate)

/** Round-robin ring index around the camp, so joins never overlap (B14). */
let spawnCounter = 0;

/** Players with a name already taken get "Naam ·2", ·3 … (never a duplicate). */
function uniqueName(base, exceptId = null) {
  const taken = (candidate) =>
    [...players.values()].some((p) => p.id !== exceptId && p.name.toLowerCase() === candidate.toLowerCase());
  let name = base;
  let n = 2;
  while (taken(name)) {
    name = `${base.slice(0, 21)} \u00b7${n++}`;
  }
  return name;
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(encodeFrame(JSON.stringify(obj)));
}

// Encode once per broadcast. The previous implementation JSON.parsed the
// payload again for every receiver (N parses + N encodes per event).
function broadcast(obj, exceptId) {
  const frame = encodeFrame(JSON.stringify(obj));
  for (const p of players.values()) {
    if (p.id !== exceptId && p.ws.readyState === 1) p.ws.send(frame);
  }
}

function playerByWs(ws) {
  for (const p of players.values()) {
    if (p.ws === ws) return p;
  }
  return null;
}

function roster(exceptId = null) {
  return [...players.values()]
    .filter((x) => x.id !== exceptId)
    .map((x) => ({ id: x.id, name: x.name, p: x.p, r: x.r }));
}

/**
 * Full world snapshot for a joining client. hp is sent ABSOLUTE per node
 * (depleted = 0, partial = max - harvests) so the client can apply it
 * idempotently instead of re-applying damage.
 */
function worldSnapshot() {
  const hp = {};
  for (const id of store.world.depleted) hp[id] = 0;
  for (const [id, count] of store.world.harvests) {
    hp[id] = Math.max(0, (MAX_HARVEST[id.split('_')[1]] ?? 3) - count);
  }
  return {
    seed: SEED,
    buildings: store.world.buildings.map((b) => ({ ...b })),
    depleted: [...store.world.depleted],
    hp,
  };
}

function handleWsMessage(ws, msg) {
  switch (msg.t) {
    case 'join': {
      // Identity: the token is the durable one (it comes back after a
      // reload), playerId is the session handle everyone else sees. A client
      // that reconnects with a token already in the room REPLACES its own
      // old session — that is exactly what a page refresh looks like from
      // the server's side, and the stale socket's messages simply stop
      // resolving to a player.
      const token = TOKEN_RE.test(String(msg.token ?? '')) ? String(msg.token) : crypto.randomUUID().replace(/-/g, '');
      let id = typeof msg.playerId === 'string' && msg.playerId ? msg.playerId : null;
      const previous = [...players.values()].find((p) => p.token === token) ?? null;
      if (previous) {
        // Reconnect (what a page refresh looks like from here): TAKE OVER the
        // old session, id included. Minting a new id made the reloading
        // player a different person in everyone else's world.
        players.delete(previous.id);
        id = previous.id;
      } else if (!id || players.has(id)) {
        id = crypto.randomUUID().slice(0, 8);
      }
      // Returning players resume where they left off; the saved position is
      // also what everyone else sees before the first position report.
      const profile = store.profile(token);
      const saved = profile?.pos;
      const name = uniqueName(sanitizeName(msg.name) ?? sanitizeName(store.nameOf(token)) ?? 'Speler');
      const pos = saved ? [saved.x, saved.y, saved.z] : [0, 5, 0];
      const me = { id, name, token, p: pos, r: 0, ws, spawnIndex: spawnCounter++ };
      players.set(id, me);
      store.setName(token, name);
      send(ws, {
        t: 'hello',
        playerId: id,
        token,
        name,
        players: roster(id),
        ...worldSnapshot(),
        // The shared clock and this player's own saved progress. Without
        // `me` a reload in multiplayer started from zero, every single time.
        time: clock.time(),
        // Ring offset around the camp, so a second player never materialises
        // inside the first one (the client turns this index into a spot).
        spawnIndex: me.spawnIndex,
        me: profile ? { ...profile, name } : null,
        // What the NPCs on this server already remember about this player from
        // earlier sessions. The save file stays authoritative for solo play;
        // this is what survives a reconnect on a shared server.
        npc_memory: npcBrain.memory.notesFor(name),
      });
      // joined carries the joiner's current position so remote avatars do
      // not spawn at the world origin and then teleport (B9).
      broadcast({ t: 'joined', id, name, p: [me.p[0], me.p[1], me.p[2]], r: me.r }, id);
      break;
    }
    case 'pos': {
      const me = playerByWs(ws);
      if (!me) return;
      const q = (v) => {
        const n = Math.round(Number(v) * 100) / 100;
        return Number.isFinite(n) ? n : 0;
      };
      me.p = [q(msg.p?.[0] ?? 0), q(msg.p?.[1] ?? 0), q(msg.p?.[2] ?? 0)];
      const r = Number(msg.r ?? 0);
      me.r = Number.isFinite(r) ? Math.round(r * 100) / 100 : 0;
      // Remember where they are standing: a reload should put you back where
      // you walked to, not at the spot of the last 15 s autosave.
      store.savePos(me.token, { x: me.p[0], y: me.p[1], z: me.p[2] }, me.r);
      broadcast({ t: 'p', id: me.id, p: me.p, r: me.r }, me.id);
      break;
    }
    case 'place': {
      const me = playerByWs(ws);
      if (!me) return;
      const x = Number(msg.p?.[0] ?? 0);
      const z = Number(msg.p?.[1] ?? 0);
      const y = Number(msg.p?.[2] ?? 0);
      const kind = msg.kind;
      if (!BUILD_KINDS.includes(kind)) {
        send(ws, { t: 'reject', msg: 'Onbekend bouwtype' });
        return;
      }
      if (![x, z, y].every(Number.isFinite)) {
        send(ws, { t: 'reject', msg: 'Ongeldige positie' });
        return;
      }
      if (Math.abs(x) > WORLD_HALF || Math.abs(z) > WORLD_HALF || y < -10 || y > 60) {
        send(ws, { t: 'reject', msg: 'Buiten de wereld' });
        return;
      }
      const id = typeof msg.id === 'string' ? msg.id.slice(0, 40) : `b_${me.id}`;
      const b = store.addBuilding({ id, kind, x, z, y, rot: Number(msg.rot ?? 0), ownerId: me.id, fuel: 300 });
      if (!b) {
        send(ws, { t: 'reject', msg: 'Bestaat al' });
        return;
      }
      send(ws, { t: 'placed', b });
      broadcast({ t: 'placed', b }, me.id);
      break;
    }
    case 'harvest': {
      const me = playerByWs(ws);
      if (!me) return;
      const id = String(msg.id || '');
      // Real node ids only (`n_tree_12`): an id the store cannot persist
      // would damage a node in memory that reappears after the next restart.
      if (!store.isNodeId(id)) return;
      const kind = id.split('_')[1];
      const max = MAX_HARVEST[kind];
      if (!max) return;
      if (store.isDepleted(id)) {
        // The requester's copy is stale (e.g. a local regrow timer fired
        // while the server kept the node depleted). Resync it without
        // applying damage it never dealt.
        send(ws, { t: 'harvested', id, hp: 0, amount: 0, by: me.id });
        return;
      }
      const count = store.addHarvest(id);
      const hp = Math.max(0, max - count);
      // The +1 effective-tool bonus is client knowledge (which tool is
      // selected); the server only accepts a clamped 0/1 flag for it and
      // rolls the base amount itself.
      const bonus = Number(msg.bonus) === 1 ? 1 : 0;
      const amount = yieldAmount(kind, id, count) + bonus;
      // Broadcast to EVERYONE — initiator included, who now applies hp
      // absolutely instead of damaging the node a second time locally.
      const payload = { t: 'harvested', id, hp, amount, by: me.id };
      if (hp <= 0) {
        store.deplete(id);
        broadcast(payload);
        broadcast({ t: 'depleted', id });
        if (kind === 'bush' && BUSH_REGROW_MS > 0) {
          const timer = setTimeout(() => {
            store.restoreNode(id);
            broadcast({ t: 'regrow', id, hp: max });
          }, BUSH_REGROW_MS);
          timer.unref();
        }
      } else {
        broadcast(payload);
      }
      break;
    }
    case 'chat': {
      const me = playerByWs(ws);
      if (!me) return;
      void chatNpc(me, msg);
      break;
    }
    /**
     * Per-player progress. The client sends its own solo-save shape; the
     * store validates every number and every item id, so a tampered payload
     * cannot hand out items, hit points or levels.
     */
    case 'save': {
      const me = playerByWs(ws);
      if (!me) return;
      const saved = store.putProfile(me.token, { ...msg.profile, name: me.name });
      // `dropped` = stacks the game does not know (invented or from another
      // version). The client can surface that instead of losing items in
      // silence.
      send(ws, { t: 'saved', ok: !!saved, at: saved?.savedAt ?? 0, dropped: saved?.droppedItems ?? 0 });
      break;
    }
    /**
     * A player slept: the WORLD wakes up. The clock only ever moves forward,
     * and everyone gets the jump — previously one person sleeping changed
     * only their own sky.
     */
    case 'sleep': {
      const me = playerByWs(ws);
      if (!me) return;
      const t = clock.advanceToMorning(MORNING);
      store.setClockOffset(clock.offsetAt());
      broadcast({ t: 'time', time: t, jump: true });
      break;
    }
    /** Shared campfire fuel: whoever feeds the fire feeds the whole world. */
    case 'fuel': {
      const me = playerByWs(ws);
      if (!me) return;
      const id = String(msg.id ?? '');
      const b = store.findBuilding(id);
      if (!b || b.kind !== 'campfire') return;
      const amount = Number(msg.fuel);
      // A non-numeric amount must not silently re-broadcast the current
      // value to everyone (that is how a client bug becomes world spam).
      if (!Number.isFinite(amount)) return;
      const fuel = store.setFuel(id, amount);
      if (fuel === null) return;
      broadcast({ t: 'fuel', id, fuel, by: me.id });
      break;
    }
    /** Shared doors: an open door lets everyone through, a shut one blocks. */
    case 'toggle': {
      const me = playerByWs(ws);
      if (!me) return;
      const id = String(msg.id ?? '');
      const b = store.findBuilding(id);
      if (!b || b.kind !== 'door') return;
      const open = store.setDoor(id, msg.open === true);
      if (open === null) return;
      broadcast({ t: 'toggle', id, open, by: me.id });
      break;
    }
    /**
     * A melee hit on another player. The server is a sanity gate, not an
     * authority on health (each victim applies the damage to its own
     * stats): range and rate are checked here, the damage value is clamped
     * to the known weapon band, and the victim re-validates on receipt.
     */
    case 'hit': {
      const me = playerByWs(ws);
      if (!me) return;
      const target = players.get(String(msg.id ?? ''));
      if (!target || target === me) return;
      const dmg = Number(msg.dmg);
      if (!Number.isFinite(dmg) || dmg < 2 || dmg > 16) return;
      const dx = (me.p?.[0] ?? 0) - (target.p?.[0] ?? 0);
      const dz = (me.p?.[2] ?? 0) - (target.p?.[2] ?? 0);
      if (Math.hypot(dx, dz) > 5.5) return;
      const now = Date.now();
      if (now - (lastHitAt.get(me.id) ?? -1e9) < 650) return;
      lastHitAt.set(me.id, now);
      broadcast({ t: 'hit', id: target.id, by: me.id, dmg });
      break;
    }
    /**
     * World reset (the settings-panel button). This server is the world's
     * single authority, so the wipe happens HERE and everyone — the caller
     * included — is told to start over. Rate-gated: one reset per 10 s,
     * which stops a panicked double-click storm from N clients reloading.
     */
    case 'reset': {
      const me = playerByWs(ws);
      if (!me) return;
      const now = Date.now();
      if (now - lastResetAt < 10_000) return;
      lastResetAt = now;
      store.reset();
      npcBrain.memory.clearAll();
      console.log(`[mp] world reset requested by ${me.name}`);
      broadcast({ t: 'world-reset', by: me.name });
      break;
    }
    /** Rename (the HUD name field). Duplicate names get a numeric suffix. */
    case 'name': {
      const me = playerByWs(ws);
      if (!me) return;
      const clean = sanitizeName(msg.name);
      if (!clean) return;
      me.name = uniqueName(clean, me.id);
      store.setName(me.token, me.name);
      broadcast({ t: 'renamed', id: me.id, name: me.name });
      break;
    }
    default:
      break;
  }
}

/**
 * One player message to an NPC. The character, the memory, the prompt and the
 * gateway all live in server/npc.mjs; this function only translates the
 * result into protocol messages.
 */
async function chatNpc(me, msg) {
  const result = await npcBrain.ask({
    ownerKey: me.name,
    npc: msg.npc?.id ?? msg.npc,
    text: msg.text,
    history: msg.history,
    context: msg.context,
    displayName: me.name,
  });
  const name = result.name;
  const npcId = result.npcId;
  if (!result.ok) {
    // `reason` lets the client explain itself (rate limited vs. gateway down)
    // instead of always falling back to the same canned line.
    send(me.ws, { t: 'npc_error', npc: name, npcId, reason: result.reason });
    return;
  }
  send(me.ws, { t: 'npc_reply', npc: name, npcId, text: result.reply, model: result.model, quest: result.quest ?? null });
  // Remote players see the same conversation the addressee has (B5). The
  // QUEST is deliberately not broadcast: it was offered to this player only
  // (their quest log, their bag), and a client cannot award quest rewards
  // to itself anyway — the QuestLog validates progress through real events.
  broadcast({ t: 'npc_reply', npc: name, npcId, speaker: me.name, text: result.reply, model: result.model }, me.id);
}

function onUpgrade(req, socket) {
  if (req.url !== '/ws') {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);

  const ws = { readyState: 1, buffer: Buffer.alloc(0), send: (frame) => socket.write(frame) };
  // Fragmented-message state (RFC 6455 §5.4): continuation frames (opcode
  // 0x0) used to be silently dropped, so any client message split across
  // frames — browsers do this under memory pressure / large payloads —
  // vanished without a trace.
  let fragOpcode = 0;
  let frags = [];
  let fragBytes = 0;
  // Simple per-connection message budget (see MSG_RATE_LIMIT).
  let rateWindow = Date.now();
  let rateCount = 0;

  const closeWith = (code) => {
    try {
      const body = Buffer.alloc(2);
      body.writeUInt16BE(code, 0);
      if (ws.readyState === 1) ws.send(encodeFrame(body, 0x8));
    } catch { /* ignore */ }
    socket.end();
  };

  const deliverText = (buf) => {
    const now = Date.now();
    if (now - rateWindow > 1000) {
      rateWindow = now;
      rateCount = 0;
    }
    if (++rateCount > MSG_RATE_LIMIT) return; // drop the excess, keep the link
    try {
      handleWsMessage(ws, JSON.parse(buf.toString('utf8')));
    } catch (e) {
      // Malformed input is ignored silently, but a crash INSIDE a handler
      // is a server bug and must be visible (a swallowed exception here is
      // how the old joined-broadcast regression stayed invisible).
      console.error('[ws] handler error:', e?.message ?? e);
    }
  };

  socket.on('data', (chunk) => {
    const { frames, rest, error } = decodeFrames(Buffer.concat([ws.buffer, chunk]));
    ws.buffer = rest;
    if (error) {
      closeWith(1009); // message too big
      return;
    }
    for (const f of frames) {
      if (f.opcode === 0x8) {
        // close
        try { ws.send(encodeFrame(Buffer.alloc(0), 0x8)); } catch { /* ignore */ }
        socket.end();
        return;
      }
      if (f.opcode === 0x9) {
        // ping -> pong
        try {
          const h = Buffer.from([0x8a, f.payload.length]);
          socket.write(Buffer.concat([h, f.payload]));
        } catch { /* ignore */ }
        continue;
      }
      if (f.opcode === 0xa) continue; // client pong for our keepalive ping
      if (f.opcode === 0x0) {
        // continuation of a fragmented text message
        if (!fragOpcode) continue; // stray continuation without a start
        frags.push(f.payload);
        fragBytes += f.payload.length;
        if (fragBytes > MAX_MESSAGE_BYTES) {
          closeWith(1009);
          return;
        }
        if (!f.fin) continue;
        const full = Buffer.concat(frags);
        fragOpcode = 0;
        frags = [];
        fragBytes = 0;
        deliverText(full);
        continue;
      }
      if (f.opcode !== 0x1) continue; // binary / unknown: ignore
      if (!f.fin) {
        fragOpcode = f.opcode;
        frags = [f.payload];
        fragBytes = f.payload.length;
        continue;
      }
      deliverText(f.payload);
    }
  });
  socket.on('close', () => {
    for (const [id, p] of players) {
      if (p.ws === ws) {
        players.delete(id);
        broadcast({ t: 'left', id }, id);
      }
    }
  });
  socket.on('error', () => socket.destroy());
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
// Gzip cache for static text assets. The Babylon bundle is ~7 MB raw and
// compresses ~4x; re-gzipping per request would burn CPU on a hot loop.
const gzipCache = new Map();

function serveStatic(req, res, urlPath) {
  const distDir = path.join(__dirname, '..', 'dist');
  let file = urlPath === '/' ? '/index.html' : urlPath;
  const full = path.normalize(path.join(distDir, file));
  if (!full.startsWith(distDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(distDir, 'index.html'), (err2, html) => {
        if (err2) {
          res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Build nog niet beschikbaar. Draai: npm run build');
        } else {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
          });
          res.end(html);
        }
      });
      return;
    }
    const ext = path.extname(full);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.json': 'application/json',
    };
    const headers = {
      'Content-Type': types[ext] || 'application/octet-stream',
      // Vite emits content-hashed filenames under /assets, so those may be
      // cached forever; everything else must revalidate.
      'Cache-Control': urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      Vary: 'Accept-Encoding',
    };
    const isText = ext in types;
    if (isText && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
      // Key the cache on content identity, not just the path: after a
      // rebuild the SAME path holds NEW bytes, and a path-keyed cache served
      // a stale index.html forever (hashed asset names then 404'd and the
      // SPA fallback handed out HTML for .js requests — the browser silently
      // ran nothing, or worse, an old bundle).
      let stamp = data.length;
      try {
        stamp = fs.statSync(full).mtimeMs;
      } catch {
        /* fall back to size-only key */
      }
      const key = `${full}@${stamp}`;
      let gz = gzipCache.get(key);
      if (!gz) {
        // Bound the cache: hashed assets are immutable, but stale keys from
        // every rebuild must not pile up forever.
        if (gzipCache.size > 64) gzipCache.clear();
        gz = zlib.gzipSync(data, { level: 6 });
        gzipCache.set(key, gz);
      }
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = gz.length;
      res.writeHead(200, headers);
      res.end(gz); // Node suppresses the body automatically for HEAD
      return;
    }
    headers['Content-Length'] = data.length;
    res.writeHead(200, headers);
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, players: players.size, model: llm.model() }));
    return;
  }
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', async () => {
      const json = (code, payload) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      try {
        const msg = JSON.parse(body || '{}');
        // The solo path (no WebSocket) talks to the same brain as multiplayer,
        // so the character, the memory and the guardrails are identical. The
        // session belongs to the real client address: a client-sent player
        // name is only what the NPC may call you, it can never borrow somebody
        // else's conversation.
        const result = await npcBrain.ask({
          ownerKey: `web ${clientIp(req)}`,
          npc: msg.npc,
          text: msg.message,
          history: msg.history,
          context: msg.context,
          displayName: typeof msg.player === 'string' ? msg.player : null,
        });
        if (!result.ok) {
          const status =
            result.reason === 'rate_limited' || result.reason === 'pending_full'
              ? 429
              : result.reason === 'unknown_npc' || result.reason === 'empty_message'
                ? 400
                : 502;
          json(status, { error: result.reason, npc: result.name, npcId: result.npcId });
          return;
        }
        json(200, {
          reply: result.reply,
          model: result.model,
          npc: result.name,
          npcId: result.npcId,
          quest: result.quest ?? null,
        });
      } catch (e) {
        console.error('[api/chat]', e.message);
        json(502, { error: 'llm_unavailable' });
      }
    });
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, url.pathname);
    return;
  }
  res.writeHead(405);
  res.end();
});

server.on('upgrade', onUpgrade);

// Keepalive: ping every connected client every 30 s. Browsers (and the
// browser WebSocket API generally) answer pings transparently; dead sockets
// surface as write/close errors and get cleaned by their own handlers.
const pingTimer = setInterval(() => {
  const ping = encodeFrame(Buffer.alloc(0), 0x9);
  for (const p of players.values()) {
    if (p.ws.readyState === 1) {
      try { p.ws.send(ping); } catch { /* cleaned by socket error handler */ }
    }
  }
}, 30_000);
pingTimer.unref();

// Conversation memory is released when a player stops talking: a server that
// runs for weeks must not keep a session per (npc, player) forever.
const npcMemoryTimer = setInterval(() => {
  const dropped = npcBrain.memory.sweep(Date.now(), NPC_MEMORY_TTL_MS);
  if (dropped) console.log(`[npc] forgot ${dropped} idle conversation${dropped === 1 ? '' : 's'}`);
}, NPC_MEMORY_SWEEP_MS);
npcMemoryTimer.unref();

// Shared clock: announce the time of day often enough that clients can
// correct drift without ever seeing the sun jump. `jump: true` is only ever
// sent by the sleep handler, and is the one case where a client snaps the sky
// immediately instead of easing towards the server value.
let timeTicks = 0;
const timeTimer = setInterval(() => {
  if (players.size === 0) return;
  broadcast({ t: 'time', time: clock.time() });
  // Keep the persisted anchor reasonably fresh (a restart should resume at
  // roughly the same hour) WITHOUT writing the world file every 2 s.
  if (++timeTicks % 15 === 0) store.setClockOffset(clock.offsetAt());
}, TIME_SYNC_MS);
timeTimer.unref();

// The world file is written on a debounce; on a clean shutdown flush it
// immediately so `Ctrl+C` never costs the world its last few minutes.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      store.setClockOffset(clock.offsetAt());
      store.flush();
    } catch {
      /* nothing left to do but exit */
    }
    process.exit(0);
  });
}

server.listen(PORT, () => {
  // Report the ACTUAL bound port: tests start this file with PORT=0 and
  // parse the ephemeral port from this line.
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : PORT;
  console.log(`AI Survival World server listening on http://localhost:${port} (ws: /ws, seed: 0x${SEED.toString(16)})`);
});
