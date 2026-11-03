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
 *   client -> server: join | pos | place | harvest | chat
 *   server -> client: hello | p | joined | left | placed | harvested |
 *                     depleted | reject | npc_reply | npc_error
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const LLM_URL = process.env.VIVES_LLM_URL || 'https://api.llm.mechatronics.be/v1';
const LLM_MODEL = process.env.VIVES_MODEL || 'qwen3.8-27b';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Must match WORLD_SEED in src/game/world/terrain.ts
const SEED = 0x5eed2024;
const WORLD_HALF = 160; // TERRAIN_SIZE / 2

// Must match per-kind harvest counts in src/game/world/flora.ts
const MAX_HARVEST = { tree: 3, pine: 3, rock: 2, bush: 2 };

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
// NPC personas (mirrors src/game/ai/npc.ts, Dutch)
// ---------------------------------------------------------------------------
const NPC_PERSONAS = {
  mara:
    'Je speelt Mara, een praktische, warme overlevende in haar dertig die op dit eiland is gestrand. Ze kent het terrein goed, geeft directe en nuttige advies over verzamelen, eten en bouwen, en heeft een droge humor. Ze spreekt in korte, duidelijke zinnen.',
  tomas:
    'Je speelt Tomas, een voorzichtige, nieuwsgierige voormalige timmerman. Hij praat graag over bouwen en onderdak, is een beetje nerveus over de nachten en vraagt de speler hoe de dag was. Hij is vriendelijk maar iets formeel.',
};

// ---------------------------------------------------------------------------
// Shared world state (authoritative)
// ---------------------------------------------------------------------------
const state = {
  buildings: [], // {id, kind, x, z, y, rot, ownerId, fuel?}
  harvests: new Map(), // nodeId -> count
  depleted: new Set(),
};

function hpFor(nodeId) {
  if (state.depleted.has(nodeId)) return 0;
  const kind = nodeId.startsWith('n_') ? nodeId.split('_')[1] : null;
  const max = kind && MAX_HARVEST[kind] ? MAX_HARVEST[kind] : 3;
  return Math.max(0, max - (state.harvests.get(nodeId) ?? 0));
}

// ---------------------------------------------------------------------------
// WebSocket plumbing (RFC 6455, minimal)
// ---------------------------------------------------------------------------
function encodeFrame(data) {
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
  header[0] = 0x81; // FIN + text
  return Buffer.concat([header, payload]);
}

function decodeFrames(buf) {
  // Returns { frames, rest }: all complete frames plus the leftover bytes.
  const out = [];
  let off = 0;
  while (true) {
    if (buf.length - off < 2) break;
    const b0 = buf[off];
    const b1 = buf[off + 1];
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
    out.push({ opcode, payload });
    off = pos + len;
  }
  return { frames: out, rest: Buffer.from(buf.subarray(off)) };
}

const players = new Map(); // id -> { id, name, p: [x,y,z], ws }

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(encodeFrame(JSON.stringify(obj)));
}

function broadcast(obj, exceptId) {
  const data = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.id !== exceptId) send(p.ws, JSON.parse(data));
  }
}

function handleWsMessage(ws, msg) {
  switch (msg.t) {
    case 'join': {
      let id = typeof msg.playerId === 'string' && msg.playerId ? msg.playerId : null;
      if (!id || players.has(id)) id = crypto.randomUUID().slice(0, 8);
      const p = [0, 5, 0];
      players.set(id, { id, name: String(msg.name || 'Speler').slice(0, 24), p, ws });
      const hello = {
        t: 'hello',
        playerId: id,
        name: String(msg.name || 'Speler').slice(0, 24),
        players: [...players.values()].filter((x) => x.id !== id).map((x) => ({ id: x.id, name: x.name, p: x.p })),
        seed: SEED,
        buildings: state.buildings.map((b) => ({ ...b })),
        depleted: [...state.depleted],
        hp: Object.fromEntries(
          [...state.depleted].map((id) => [id, 0]).concat(
            [...state.harvests].map(([id, c]) => [id, Math.max(0, (MAX_HARVEST[id.split('_')[1]] ?? 3) - c)]),
          ),
        ),
      };
      send(ws, hello);
      broadcast({ t: 'joined', id, name: String(msg.name || 'Speler').slice(0, 24) }, id);
      break;
    }
    case 'pos': {
      const me = [...players.values()].find((x) => x.ws === ws);
      if (!me) return;
      const q = (v) => Math.round(Number(v) * 100) / 100;
      me.p = [q(msg.p?.[0] ?? 0), q(msg.p?.[1] ?? 0), q(msg.p?.[2] ?? 0)];
      broadcast({ t: 'p', id: me.id, p: me.p, r: Number(msg.r ?? 0) }, me.id);
      break;
    }
    case 'place': {
      const me = [...players.values()].find((x) => x.ws === ws);
      if (!me) return;
      const x = Number(msg.p?.[0] ?? 0);
      const z = Number(msg.p?.[1] ?? 0);
      const y = Number(msg.p?.[2] ?? 0);
      const kind = msg.kind;
      if (!['campfire', 'wall', 'floor', 'roof'].includes(kind)) {
        send(ws, { t: 'reject', msg: 'Onbekend bouwtype' });
        return;
      }
      if (Math.abs(x) > WORLD_HALF || Math.abs(z) > WORLD_HALF || y < -10 || y > 60) {
        send(ws, { t: 'reject', msg: 'Buiten de wereld' });
        return;
      }
      const id = typeof msg.id === 'string' ? msg.id.slice(0, 40) : `b_${me.id}`;
      if (state.buildings.some((b) => b.id === id)) {
        send(ws, { t: 'reject', msg: 'Bestaat al' });
        return;
      }
      const b = {
        id,
        kind,
        x,
        z,
        y,
        rot: Math.max(0, Math.min(3, Number(msg.rot ?? 0))),
        ownerId: me.id,
        fuel: kind === 'campfire' ? 300 : undefined,
      };
      state.buildings.push(b);
      send(ws, { t: 'placed', b });
      broadcast({ t: 'placed', b }, me.id);
      break;
    }
    case 'harvest': {
      const id = String(msg.id || '');
      if (!id.startsWith('n_')) return;
      const kind = id.split('_')[1];
      const max = MAX_HARVEST[kind];
      if (!max) return;
      const count = (state.harvests.get(id) ?? 0) + 1;
      state.harvests.set(id, count);
      const hp = Math.max(0, max - count);
      const payload = { t: 'harvested', id, hp };
      if (hp <= 0) {
        state.depleted.add(id);
        broadcast(payload);
        broadcast({ t: 'depleted', id });
      } else {
        broadcast(payload);
      }
      break;
    }
    case 'chat': {
      const me = [...players.values()].find((x) => x.ws === ws);
      if (!me) return;
      void chatNpc(me, msg);
      break;
    }
    default:
      break;
  }
}

async function chatNpc(me, msg) {
  const npcId = msg.npc?.id || '';
  const name = msg.npc?.name || npcId || 'npc';
  const persona = NPC_PERSONAS[npcId] || (msg.npc?.personality || '');
  if (!persona) {
    send(me.ws, { t: 'npc_error', npc: name });
    return;
  }
  const history = Array.isArray(msg.history) ? msg.history.slice(-12) : [];
  const userText = String(msg.text || '').slice(0, 500);
  if (!userText) {
    send(me.ws, { t: 'npc_error', npc: name });
    return;
  }
  const context = [];
  if (msg.context) {
    if (typeof msg.context.playerState === 'string') context.push('Spelerstatus: ' + msg.context.playerState);
    if (Array.isArray(msg.context.events)) {
      for (const e of msg.context.events.slice(-4)) context.push(String(e));
    }
  }
  const system =
    persona +
    '\n\nAntwoord in het Nederlands als ' +
    name +
    ', kort (maximaal drie zinnen), zonder markdown.' +
    (context.length ? '\n\nContext:\n' + context.join('\n') : '');
  const messages = [{ role: 'system', content: system }];
  for (const h of history) {
    if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string') {
      messages.push({ role: h.role, content: h.content.slice(0, 2000) });
    }
  }
  messages.push({ role: 'user', content: userText });

  const key = llmKey();
  if (!key) {
    send(me.ws, { t: 'npc_error', npc: name });
    return;
  }
  try {
    const res = await fetch(`${LLM_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages,
        stream: false,
        max_tokens: 300,
        temperature: 0.8,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`llm http ${res.status}`);
    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (!reply) throw new Error('llm empty');
    send(me.ws, { t: 'npc_reply', npc: name, text: reply });
    broadcast({ t: 'npc_reply', npc: name, text: reply }, me.id);
  } catch (e) {
    console.error('[chat] LLM error:', e.message);
    send(me.ws, { t: 'npc_error', npc: name });
  }
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
  socket.on('data', (chunk) => {
    const { frames, rest } = decodeFrames(Buffer.concat([ws.buffer, chunk]));
    ws.buffer = rest;
    for (const f of frames) {
      if (f.opcode === 0x8) {
        // close
        try { ws.send(encodeFrame(Buffer.alloc(0))); } catch { /* ignore */ }
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
      if (f.opcode !== 0x1) continue;
      try {
        handleWsMessage(ws, JSON.parse(f.payload.toString('utf8')));
      } catch {
        // ignore malformed
      }
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
function serveStatic(res, urlPath) {
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
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, players: players.size, model: LLM_MODEL }));
    return;
  }
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', async () => {
      try {
        const msg = JSON.parse(body || '{}');
        const npcId = msg.npc || '';
        const persona = NPC_PERSONAS[npcId] || '';
        if (!persona) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unknown npc' }));
          return;
        }
        const key = llmKey();
        if (!key) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'llm key missing' }));
          return;
        }
        const history = Array.isArray(msg.history) ? msg.history.slice(-12) : [];
        const context = [];
        if (msg.context) {
          if (typeof msg.context.playerState === 'string') context.push('Spelerstatus: ' + msg.context.playerState);
          if (Array.isArray(msg.context.events)) {
            for (const e of msg.context.events.slice(-4)) context.push(String(e));
          }
        }
        const name = npcId.charAt(0).toUpperCase() + npcId.slice(1);
        const system =
          persona +
          '\n\nAntwoord in het Nederlands als ' +
          name +
          ', kort (maximaal drie zinnen), zonder markdown.' +
          (context.length ? '\n\nContext:\n' + context.join('\n') : '');
        const messages = [{ role: 'system', content: system }];
        for (const h of history) {
          if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string') {
            messages.push({ role: h.role, content: h.content.slice(0, 2000) });
          }
        }
        messages.push({ role: 'user', content: String(msg.message || '').slice(0, 500) });
        const res2 = await fetch(`${LLM_URL}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: LLM_MODEL, messages, stream: false, max_tokens: 300, temperature: 0.8 }),
          signal: AbortSignal.timeout(30000),
        });
        if (!res2.ok) throw new Error(`llm http ${res2.status}`);
        const data = await res2.json();
        const reply = data?.choices?.[0]?.message?.content?.trim();
        if (!reply) throw new Error('llm empty');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply, model: LLM_MODEL }));
      } catch (e) {
        console.error('[api/chat]', e.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'llm unavailable' }));
      }
    });
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(res, url.pathname);
    return;
  }
  res.writeHead(405);
  res.end();
});

server.on('upgrade', onUpgrade);
server.listen(PORT, () => {
  console.log(`AI Survival World server listening on http://localhost:${PORT} (ws: /ws, seed: 0x${SEED.toString(16)})`);
});
