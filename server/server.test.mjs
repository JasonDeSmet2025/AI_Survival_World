/**
 * Multiplayer server integration tests (Multiplayer Agent scope).
 *
 * Boots the REAL server (server/server.mjs) as a child process on an
 * ephemeral port and talks to it over real WebSockets:
 *   - Node's built-in WebSocket client for normal traffic;
 *   - a hand-rolled raw RFC 6455 client for transport-edge tests
 *     (fragmented messages, oversized frames), which the browser API
 *     cannot express.
 *
 * Run with:  node --test server/          (also picked up by vitest)
 *
 * The LLM gateway is never contacted: chat tests only exercise paths that
 * reject before the gateway call (unknown npc, blank message).
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const SERVER_FILE = new URL('./server.mjs', import.meta.url);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

let child = null;
let port = 0;

async function startServer(env = {}) {
  const c = spawn(process.execPath, [SERVER_FILE.pathname], {
    env: { ...process.env, PORT: '0', BUSH_REGROW_MS: '150', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const p = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('server start timeout')), 8000);
    c.stdout.on('data', (d) => {
      const m = /localhost:(\d+)/.exec(String(d));
      if (m) {
        clearTimeout(to);
        resolve(Number(m[1]));
      }
    });
    c.once('exit', (code) => {
      clearTimeout(to);
      reject(new Error('server exited early: ' + code));
    });
  });
  return { child: c, port: p };
}

/** Browser-like WebSocket client with predicate-based message picking. */
function connectWs(p) {
  const ws = new WebSocket(`ws://127.0.0.1:${p}/ws`);
  const queue = [];
  const emitter = new EventEmitter();
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    queue.push(msg);
    emitter.emit('msg');
  };
  const api = {
    ws,
    queue,
    open() {
      return new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onclose = () => reject(new Error('socket closed before open'));
        ws.onerror = () => reject(new Error('socket error'));
      });
    },
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    /** Await the next queued message matching pred (removes it from the queue). */
    async recv(pred = () => true, timeout = 3000, label = 'message') {
      const scan = () => {
        const i = queue.findIndex(pred);
        return i >= 0 ? queue.splice(i, 1)[0] : undefined;
      };
      let m = scan();
      if (m !== undefined) return m;
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        await onceTimed(emitter, 'msg', Math.max(1, deadline - Date.now()));
        m = scan();
        if (m !== undefined) return m;
      }
      throw new Error(`timeout waiting for ${label}`);
    },
    /** Assert nothing matching pred arrives within ms. */
    async expectNone(pred, ms = 300, label = 'message') {
      const start = queue.length;
      await sleep(ms);
      const hit = queue.slice(start).find(pred);
      assert.equal(hit, undefined, `unexpected ${label}: ${JSON.stringify(hit)}`);
    },
    join(name = 'Tester') {
      this.send({ t: 'join', name });
      return this.recv((m) => m.t === 'hello', 3000, 'hello');
    },
    close() {
      try { ws.close(); } catch { /* ignore */ }
    },
  };
  return api;
}

function onceTimed(emitter, event, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      emitter.off(event, on);
      resolve();
    }, ms);
    const on = () => {
      clearTimeout(t);
      resolve();
    };
    emitter.once(event, on);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Raw RFC 6455 client (for frames the browser WebSocket API cannot produce)
// ---------------------------------------------------------------------------
function rawMaskedFrame(opcode, payload, fin) {
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
  header[0] = (fin ? 0x80 : 0x00) | opcode;
  header[1] |= 0x80; // client frames MUST be masked
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

async function rawConnect(p) {
  const sock = net.connect(p, '127.0.0.1');
  await new Promise((res, rej) => {
    sock.once('connect', res);
    sock.once('error', rej);
  });
  const key = crypto.randomBytes(16).toString('base64');
  const frames = [];
  const emitter = new EventEmitter();
  let closed = false;
  let buf = Buffer.alloc(0);
  let handshakeDone = false;

  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (!handshakeDone) {
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      const head = buf.subarray(0, i).toString();
      buf = buf.subarray(i + 4);
      const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
      assert.match(head, /^HTTP\/1\.1 101/);
      assert.ok(head.includes(accept), 'Sec-WebSocket-Accept mismatch');
      handshakeDone = true;
      emitter.emit('handshake');
    }
    // Parse unmasked server frames.
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let pos = 2;
      if (len === 126) {
        if (buf.length < pos + 2) break;
        len = buf.readUInt16BE(pos);
        pos += 2;
      } else if (len === 127) {
        if (buf.length < pos + 8) break;
        len = Number(buf.readBigUInt64BE(pos));
        pos += 8;
      }
      if (buf.length < pos + len) break;
      frames.push({ opcode, payload: buf.subarray(pos, pos + len) });
      buf = buf.subarray(pos + len);
      emitter.emit('frame');
    }
  });
  sock.on('close', () => {
    closed = true;
    emitter.emit('close');
  });
  sock.write(
    'GET /ws HTTP/1.1\r\n' +
      'Host: 127.0.0.1\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n\r\n',
  );
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('raw handshake timeout')), 3000);
    emitter.once('handshake', () => { clearTimeout(t); res(); });
  });

  return {
    sock,
    sendFrame(opcode, payload, fin = true) {
      sock.write(rawMaskedFrame(opcode, Buffer.from(payload), fin));
    },
    sendText(text) {
      this.sendFrame(0x1, text);
    },
    async nextText(timeout = 3000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const i = frames.findIndex((f) => f.opcode === 0x1);
        if (i >= 0) return JSON.parse(frames.splice(i, 1)[0].payload.toString('utf8'));
        await onceTimed(emitter, 'frame', Math.max(1, deadline - Date.now()));
      }
      throw new Error('raw timeout waiting for text frame');
    },
    waitForClose(timeout = 3000) {
      if (closed) return Promise.resolve();
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('expected socket close')), timeout);
        emitter.once('close', () => { clearTimeout(t); res(); });
      });
    },
    destroy() {
      sock.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
let stateFile = '';

before(async () => {
  // Persistence is on by default now, so this file MUST be per run: sharing
  // the server's default state file makes building ids collide with whatever
  // an earlier run stored ('placed' never arrives, "Bestaat al").
  stateFile = path.join(os.tmpdir(), `asw-server-test-${process.pid}.json`);
  try {
    fs.unlinkSync(stateFile);
  } catch {}
  ({ child, port } = await startServer({ MP_STATE_FILE: stateFile }));
});

after(() => {
  if (child) child.kill('SIGTERM');
  try {
    fs.unlinkSync(stateFile);
  } catch {}
});

test('join: hello carries seed/buildings and others see joined WITH position (B9)', async () => {
  const a = connectWs(port);
  await a.open();
  const helloA = await a.join('Alice');
  assert.equal(helloA.seed, 0x5eed2024);
  assert.equal(typeof helloA.playerId, 'string');
  assert.ok(Array.isArray(helloA.buildings));

  const b = connectWs(port);
  await b.open();
  const helloB = await b.join('Bob');
  // B's hello must list A.
  assert.ok(helloB.players.some((p) => p.id === helloA.playerId && Array.isArray(p.p) && p.p.length === 3));
  // A must see joined carrying B's position, not the world origin (B9).
  const joined = await a.recv((m) => m.t === 'joined' && m.id === helloB.playerId, 3000, 'joined');
  assert.ok(Array.isArray(joined.p), 'joined must carry p');
  assert.equal(joined.p.length, 3);
  assert.equal(typeof joined.p[1], 'number');
  a.close();
  b.close();
});

test('pos: relayed with rounding and NaN-hardened coordinates', async () => {
  const a = connectWs(port);
  await a.open();
  const ha = await a.join();
  const b = connectWs(port);
  await b.open();
  await b.join();

  a.send({ t: 'pos', p: [12.345, 3.14159, -6.789], r: 1.25 });
  const relay = await b.recv((m) => m.t === 'p' && m.id === ha.playerId, 3000, 'p relay');
  assert.deepEqual(relay.p, [12.35, 3.14, -6.79]);
  assert.equal(relay.r, 1.25);

  // Garbage coordinates must never poison the shared state.
  a.send({ t: 'pos', p: ['x', null, undefined], r: 'nope' });
  const junk = await b.recv((m) => m.t === 'p' && m.id === ha.playerId, 3000, 'p relay 2');
  assert.deepEqual(junk.p, [0, 0, 0]);
  assert.equal(junk.r, 0);
  a.close();
  b.close();
});

test('harvest: one click = -1 hp for EVERYONE, yields are server-rolled and consistent (B1, B11)', async () => {
  const a = connectWs(port);
  await a.open();
  const ha = await a.join('Alice');
  const b = connectWs(port);
  await b.open();
  await b.join('Bob');

  const id = 'n_tree_9001';
  a.send({ t: 'harvest', id, bonus: 0 });

  // BOTH clients see the same absolute hp and the same amount.
  const hA = await a.recv((m) => m.t === 'harvested' && m.id === id, 3000, 'harvested a');
  const hB = await b.recv((m) => m.t === 'harvested' && m.id === id, 3000, 'harvested b');
  assert.equal(hA.hp, 2, 'single harvest on a tree must leave hp 2, not 1 (B1)');
  assert.equal(hB.hp, 2);
  assert.equal(hA.by, ha.playerId);
  assert.equal(hA.amount, hB.amount, 'every client must see the same yield (B11)');
  assert.ok(hA.amount >= 2 && hA.amount <= 3, `amount ${hA.amount} outside [2,3]`);

  // Second harvest by the OTHER player: hp 1.
  b.send({ t: 'harvest', id, bonus: 0 });
  const h2 = await a.recv((m) => m.t === 'harvested' && m.id === id && m.hp === 1, 3000, 'hp 1');
  assert.equal(h2.hp, 1);

  // Third: depleted.
  a.send({ t: 'harvest', id, bonus: 0 });
  await a.recv((m) => m.t === 'depleted' && m.id === id, 3000, 'depleted');

  // A fresh joiner's snapshot must match what the two clients applied —
  // the parity assertion from the audit (hp som between client en server
  // identiek), collapsed to a single authoritative snapshot.
  const c = connectWs(port);
  await c.open();
  const helloC = await c.join('Carol');
  assert.equal(helloC.hp[id], 0, 'server hp must equal the hp the clients applied');
  assert.ok(helloC.depleted.includes(id));
  a.close();
  b.close();
  c.close();
});

test('harvest: bonus flag is clamped and stale harvests of depleted nodes resync without damage', async () => {
  const a = connectWs(port);
  await a.open();
  await a.join();
  const id = 'n_pine_9002';
  // Abusive bonus value must never exceed the +1 tool bonus.
  a.send({ t: 'harvest', id, bonus: 99 });
  const h = await a.recv((m) => m.t === 'harvested' && m.id === id, 3000, 'harvested');
  assert.ok(h.amount >= 2 && h.amount <= 4, `bonus-clamped amount ${h.amount}`);
  a.close();
});

test('harvest: depleted node answers the requester with hp 0 / amount 0 and no broadcast', async () => {
  const a = connectWs(port);
  await a.open();
  await a.join();
  const b = connectWs(port);
  await b.open();
  await b.join();

  const id = 'n_rock_9003';
  a.send({ t: 'harvest', id, bonus: 0 });
  await b.recv((m) => m.t === 'harvested' && m.id === id && m.hp === 1, 3000, 'hp 1');
  a.send({ t: 'harvest', id, bonus: 0 });
  await b.recv((m) => m.t === 'depleted' && m.id === id, 3000, 'depleted');

  // A client whose local timer regrew the node would harvest a depleted
  // node: it gets a private resync (hp 0, amount 0), nobody else takes
  // damage. The queue may still hold the earlier hp-1/hp-0 broadcasts,
  // so the predicate must match the resync shape specifically.
  a.send({ t: 'harvest', id, bonus: 0 });
  const resync = await a.recv((m) => m.t === 'harvested' && m.id === id && m.hp === 0 && m.amount === 0, 3000, 'resync');
  assert.equal(resync.hp, 0);
  assert.equal(resync.amount, 0);
  await b.expectNone((m) => m.t === 'harvested' && m.id === id && m.hp > 0, 300, 'extra damage');
  a.close();
  b.close();
});

test('place: bed accepted, x=280 accepted, x=400 and unknown kinds rejected (B2, B3)', async () => {
  const a = connectWs(port);
  await a.open();
  await a.join();

  // B3: bed was missing from the server whitelist while it is a full
  // client building type.
  a.send({ t: 'place', kind: 'bed', p: [10, 0, 10], rot: 1, id: 'b_bed_1' });
  const bed = await a.recv((m) => m.t === 'placed' && m.b.id === 'b_bed_1', 3000, 'placed bed');
  assert.equal(bed.b.kind, 'bed');
  assert.equal(bed.b.rot, 1);

  // B2: WORLD_HALF must be 320 (TERRAIN_SIZE 640 / 2), not 160.
  // NB: place payloads carry p as [x, z, y] (mp.ts sendPlace).
  a.send({ t: 'place', kind: 'campfire', p: [280, 240, 5], rot: 0, id: 'b_far_1' });
  const far = await a.recv((m) => m.t === 'placed' && m.b.id === 'b_far_1', 3000, 'placed far');
  assert.equal(far.b.x, 280);
  assert.equal(far.b.y, 5);

  // Outside the real world bounds.
  a.send({ t: 'place', kind: 'wall', p: [400, 0, 0], rot: 0, id: 'b_out' });
  await a.recv((m) => m.t === 'reject' && m.msg === 'Buiten de wereld', 3000, 'reject bounds');

  a.send({ t: 'place', kind: 'castle', p: [0, 0, 0], rot: 0, id: 'b_bad' });
  await a.recv((m) => m.t === 'reject' && m.msg === 'Onbekend bouwtype', 3000, 'reject kind');

  // Non-numeric coordinates (the client is never trusted).
  a.send({ t: 'place', kind: 'wall', p: ['x', 'y', 'z'], rot: 0, id: 'b_nan' });
  await a.recv((m) => m.t === 'reject' && m.msg === 'Ongeldige positie', 3000, 'reject nan');

  // Duplicate ids are refused, the shared list stays clean.
  a.send({ t: 'place', kind: 'bed', p: [10, 0, 10], rot: 1, id: 'b_bed_1' });
  await a.recv((m) => m.t === 'reject' && m.msg === 'Bestaat al', 3000, 'reject dup');
  a.close();
});

test('place: accepted buildings are broadcast to the other players', async () => {
  const a = connectWs(port);
  await a.open();
  await a.join();
  const b = connectWs(port);
  await b.open();
  await b.join();
  a.send({ t: 'place', kind: 'floor', p: [5, 0, 5], rot: 2, id: 'b_shared' });
  const shared = await b.recv((m) => m.t === 'placed' && m.b.id === 'b_shared', 3000, 'broadcast placed');
  assert.equal(shared.b.kind, 'floor');
  a.close();
  b.close();
});

test('bush regrowth is server-authoritative and announced with regrow', async () => {
  const a = connectWs(port);
  await a.open();
  await a.join();
  const b = connectWs(port);
  await b.open();
  await b.join();

  const id = 'n_bush_9004';
  a.send({ t: 'harvest', id, bonus: 0 });
  await b.recv((m) => m.t === 'harvested' && m.id === id && m.hp === 1, 3000, 'bush hp 1');
  a.send({ t: 'harvest', id, bonus: 0 });
  await b.recv((m) => m.t === 'depleted' && m.id === id, 3000, 'bush depleted');

  // BUSH_REGROW_MS=150 for the test server.
  const regrow = await b.recv((m) => m.t === 'regrow' && m.id === id, 3000, 'regrow');
  assert.equal(regrow.hp, 2, 'regrow restores the bush to full hp');
  // After regrowth harvesting works again.
  a.send({ t: 'harvest', id, bonus: 0 });
  await a.recv((m) => m.t === 'harvested' && m.id === id && m.hp === 1, 3000, 'harvest after regrow');
  a.close();
  b.close();
});

test('chat: blank/whitespace messages and unknown NPCs are rejected WITHOUT a gateway call', async () => {
  const a = connectWs(port);
  await a.open();
  await a.join();

  a.send({ t: 'chat', npc: { id: 'ghost' }, text: 'hallo' });
  await a.recv((m) => m.t === 'npc_error' && m.npcId === 'ghost', 3000, 'npc_error ghost');

  a.send({ t: 'chat', npc: { id: 'mara' }, text: '   \n  ' });
  const err = await a.recv((m) => m.t === 'npc_error' && m.npcId === 'mara', 3000, 'npc_error blank');
  assert.equal(err.npcId, 'mara', 'errors must echo npcId so the client can match its pending exchange');
  a.close();
});

test('transport: fragmented text frames are reassembled (B10)', async () => {
  const raw = await rawConnect(port);
  raw.sendText(JSON.stringify({ t: 'join', name: 'Raw' }));
  const hello = await raw.nextText();
  assert.equal(hello.t, 'hello');

  // A >127-byte message split across a start frame + continuation frame.
  const msg = JSON.stringify({
    t: 'place',
    kind: 'wall',
    p: [12, -34, 5], // [x, z, y]
    rot: 0,
    id: 'b_frag_' + 'x'.repeat(140), // push the payload past one-frame sizing
  });
  const cut = Math.floor(msg.length / 2);
  raw.sendFrame(0x1, msg.slice(0, cut), false); // opcode 1, FIN=0
  raw.sendFrame(0x0, msg.slice(cut), true); // continuation, FIN=1
  const placed = await raw.nextText();
  assert.equal(placed.t, 'placed', `expected placed, got ${JSON.stringify(placed)}`);
  // The server clamps client-provided ids to 40 chars (validation), so the
  // expected value is the SLICED id — reassembly of the full payload is
  // proven by the rest of the fields surviving the fragmentation round-trip.
  assert.equal(placed.b.id, ('b_frag_' + 'x'.repeat(140)).slice(0, 40));
  assert.equal(placed.b.x, 12);
  assert.equal(placed.b.z, -34);
  raw.destroy();
});

test('transport: oversized declared frame length closes the connection (B10)', async () => {
  const raw = await rawConnect(port);
  // Header claiming 100 KB, payload deliberately never completed.
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 0xff | 0x80; // 127 + mask bit
  header.writeBigUInt64BE(BigInt(100_000), 2);
  raw.sock.write(Buffer.concat([header, crypto.randomBytes(16)]));
  await raw.waitForClose();
});

test('transport: message flood is rate-limited, not relayed verbatim (B10)', async () => {
  const a = connectWs(port);
  await a.open();
  const ha = await a.join();
  const b = connectWs(port);
  await b.open();
  await b.join();
  b.queue.length = 0;

  for (let i = 0; i < 400; i++) {
    a.send({ t: 'pos', p: [i * 0.1, 1, 0], r: 0 });
  }
  await sleep(1500);
  const relays = b.queue.filter((m) => m.t === 'p' && m.id === ha.playerId);
  assert.ok(relays.length > 0, 'position relay must still work');
  assert.ok(
    relays.length <= 150,
    `400 messages/s flood must be rate limited (got ${relays.length} relays)`,
  );
  a.close();
  b.close();
});

test('reconnection: a freed playerId can be reclaimed by the returning client', async () => {
  const a1 = connectWs(port);
  await a1.open();
  a1.send({ t: 'join', name: 'Ada', playerId: 'ada-fixed' });
  const h1 = await a1.recv((m) => m.t === 'hello', 3000, 'hello 1');
  assert.equal(h1.playerId, 'ada-fixed');

  const witness = connectWs(port);
  await witness.open();
  await witness.join();

  a1.close();
  await witness.recv((m) => m.t === 'left' && m.id === 'ada-fixed', 3000, 'left');

  const a2 = connectWs(port);
  await a2.open();
  a2.send({ t: 'join', name: 'Ada', playerId: 'ada-fixed' });
  const h2 = await a2.recv((m) => m.t === 'hello', 3000, 'hello 2');
  assert.equal(h2.playerId, 'ada-fixed', 'reconnect must restore the same identity');
  witness.close();
  a2.close();
});

test('http: /health works and static assets get compression + cache headers (B13)', async () => {
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(typeof health.players, 'number');

  const res = await fetch(`http://127.0.0.1:${port}/index.html`, {
    headers: { 'Accept-Encoding': 'gzip' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-encoding'), 'gzip');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
});

test('harvest: ids the world does not contain are refused, not stored (B15)', async () => {
  const a = connectWs(port);
  await a.open();
  await a.join('Noob');
  // Real node ids are `n_<kind>_<number>` (flora.ts). Anything else would
  // live in memory, vanish on restart and desync the world from its own file.
  for (const id of ['n_tree_notanumber', 'n_notakind_5', 'tree_5', 'n_', 'n_bush_-1']) {
    a.send({ t: 'harvest', id, bonus: 0 });
  }
  await new Promise((r) => setTimeout(r, 350));
  assert.deepEqual(
    a.queue.filter((m) => m.t === 'harvested' || m.t === 'depleted'),
    [],
    'no harvest echo for ids that are not nodes',
  );
  a.close();
});
