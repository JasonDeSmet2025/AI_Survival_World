/**
 * Multiplayer WORLD-state integration tests: shared identity, persistence,
 * the shared clock and the fire everyone depends on.
 *
 * Same approach as server.test.mjs: boot the real server as a child process
 * and talk real WebSockets to it, but with STATE_FILE pointed at a temp file
 * so the restart case can be tested for real.
 *
 * Run with: node --test server/mp-world.test.mjs
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const SERVER_FILE = new URL('./server.mjs', import.meta.url);

let stateFile = '';
let child = null;
let port = 0;

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
    send: (obj) => ws.send(JSON.stringify(obj)),
    async recv(pred = () => true, timeout = 4000, label = 'message') {
      const hit = queue.findIndex(pred);
      if (hit >= 0) return queue.splice(hit, 1)[0];
      return new Promise((resolve, reject) => {
        const finish = (msg) => {
          clearTimeout(to);
          emitter.removeListener('msg', onMsg);
          resolve(msg);
        };
        const onMsg = () => {
          const i = queue.findIndex(pred);
          if (i >= 0) finish(queue.splice(i, 1)[0]);
        };
        const to = setTimeout(() => {
          emitter.removeListener('msg', onMsg);
          reject(new Error(`timeout waiting for ${label}; saw ${JSON.stringify(queue.map((q) => q.t))}`));
        }, timeout);
        emitter.on('msg', onMsg);
      });
    },
    close() {
      ws.close();
    },
  };
  return api;
}

async function boot(env = {}) {
  const c = spawn(process.execPath, [SERVER_FILE.pathname], {
    env: {
      ...process.env,
      PORT: '0',
      MP_STATE_FILE: stateFile,
      NAME_SECRET: 'test-secret',
      BUSH_REGROW_MS: '60000',
      ...env,
    },
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
    c.once('exit', (code) => reject(new Error('server exited early: ' + code)));
  });
  return { child: c, port: p };
}

/** join + hello handshake. */
async function join(p, opts = {}) {
  const a = connectWs(p);
  await a.open();
  a.send({ t: 'join', name: opts.name ?? 'Tester', token: opts.token, p: opts.p ?? [0, 0, 0] });
  const hello = await a.recv((m) => m.t === 'hello', 4000, 'hello');
  return { ...a, hello, id: hello.playerId };
}

const profile = (over = {}) => ({
  name: 'Tester',
  stats: { health: 77, hunger: 51, thirst: 62, stamina: 88, temperature: 16, exhausted: false, dead: false },
  inventory: [['wood', 14], ['berry', 1], null, ['stone_axe', 1, 42]],
  selected: 0,
  pos: { x: 11.25, y: 8, z: -22.5 },
  yaw: 0.75,
  progress: { level: 4, xp: 210 },
  ...over,
});

before(async () => {
  stateFile = path.join(os.tmpdir(), `asw-mp-test-${process.pid}.json`);
  try {
    fs.unlinkSync(stateFile);
  } catch {}
  ({ child, port } = await boot());
});

after(async () => {
  if (child) child.kill('SIGKILL');
  try {
    fs.unlinkSync(stateFile);
  } catch {}
});

test('world: join reports the shared clock and a spawn slot', async () => {
  const a = await join(port, { name: 'Klok' });
  assert.equal(typeof a.hello.time, 'number');
  assert.ok(a.hello.time >= 0 && a.hello.time < 1, 'time is a fraction of a day');
  assert.equal(a.hello.spawnIndex, 0, 'first player gets slot 0');

  const b = await join(port, { name: 'Tweede' });
  assert.equal(b.hello.spawnIndex, 1, 'second player gets the next slot');
  assert.equal(b.hello.players.length, 1, 'the roster lists the OTHER player, never yourself');
  assert.equal(b.hello.players.find((x) => x.id === a.id).name, 'Klok', 'names travel with the roster');
  a.close();
  b.close();
});

test('world: sleep moves the clock for EVERYONE in the world', async () => {
  const a = await join(port, { name: 'Slaper' });
  const b = await join(port, { name: 'Getuige' });

  // Drain the periodic time broadcasts so the sleep jump is unambiguous.
  a.send({ t: 'sleep' });
  const jump = await b.recv((m) => m.t === 'time' && m.jump === true, 4000, 'sleep time jump');
  assert.equal(jump.time, 0.25, 'everyone wakes at 06:00 world time');
  const echoed = await a.recv((m) => m.t === 'time' && m.jump === true, 200, 'echo to the sleeper').catch(() => null);
  assert.ok(!echoed || echoed.time === 0.25, 'the sleeper sees the same morning');
  a.close();
  b.close();
});

test('world: campfire fuel is shared, clamped and echoed to others', async () => {
  const a = await join(port, { name: 'Houtkapper' });
  const b = await join(port, { name: 'Kijker' });
  a.send({ t: 'place', kind: 'campfire', p: [6, 6, 0], rot: 0, id: 'b_fire_test' });
  await b.recv((m) => m.t === 'placed' && m.b.id === 'b_fire_test', 4000, 'campfire placed');

  a.send({ t: 'fuel', id: 'b_fire_test', fuel: 240 });
  const fuel = await b.recv((m) => m.t === 'fuel' && m.id === 'b_fire_test', 4000, 'fuel update');
  assert.equal(fuel.fuel, 240);
  assert.equal(fuel.by, a.id, 'who fed the fire travels too');

  // Garbage fuel cannot create an immortal fire.
  a.send({ t: 'fuel', id: 'b_fire_test', fuel: 1e9 });
  const capped = await b.recv((m) => m.t === 'fuel' && m.fuel === 3600, 4000, 'clamped fuel');
  assert.equal(capped.by, a.id);

  // A fire that does not exist is ignored, and so is a non-numeric amount:
  // no further fuel messages may reach anyone.
  const before = a.queue.filter((m) => m.t === 'fuel').length;
  a.send({ t: 'fuel', id: 'b_nope', fuel: 100 });
  a.send({ t: 'fuel', id: 'b_fire_test', fuel: 'nonsense' });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(a.queue.filter((m) => m.t === 'fuel').length, before, 'garbage fuel changed nothing');

  // Rejoining (the reload case) must see the fire WITH its fuel.
  a.close();
  b.close();
  const c = await join(port, { name: 'Terug' });
  const fire = c.hello.buildings.find((x) => x.id === 'b_fire_test');
  assert.equal(fire.kind, 'campfire');
  assert.equal(fire.fuel, 3600, 'fuel survives a reconnect');
  c.close();
});

test('identity: a token brings your own progress back, not someone else\'s', async () => {
  const token = 'tok-' + 'a'.repeat(20);
  const a = await join(port, { name: 'Robin', token });
  assert.equal(a.hello.me, null, 'a brand new identity has no saved progress');

  a.send({ t: 'save', profile: profile() });
  const saved = await a.recv((m) => m.t === 'saved' && m.ok === true, 4000, 'save ack');
  assert.ok(saved);

  // The client sends its position on every move; the stored profile must
  // carry the last one it reported.
  a.send({ t: 'pos', p: [3.5, 5, -4.25], r: 1.5 });
  await new Promise((r) => setTimeout(r, 120));
  a.close();

  const back = await join(port, { name: 'Robin', token });
  assert.notEqual(back.hello.me, null, 'progress came back for the same token');
  assert.equal(back.hello.me.stats.health, 77, 'stats round-tripped');
  assert.equal(back.hello.me.pos.x, 3.5, 'position round-tripped');
  assert.equal(back.hello.me.progress.level, 4, 'quest/level progress round-tripped');
  assert.equal(back.hello.me.inventory.some((s) => s && s[0] === 'wood' && s[1] === 14), true);
  back.close();

  // A DIFFERENT token must not inherit it.
  const other = await join(port, { name: 'Ander', token: 'tok-' + 'b'.repeat(20) });
  assert.equal(other.hello.me, null, 'progress is per identity, not global');
  other.close();
});

test('identity: bad saves are refused with an ack instead of half-appearing', async () => {
  const token = 'tok-' + 'c'.repeat(20);
  const a = await join(port, { name: 'Tamper', token });
  // An invented item never reaches the save: the stack is dropped and the
  // ack reports it, instead of the player silently getting a magic sword.
  a.send({ t: 'save', profile: profile({ inventory: [['wood', 14], ['diamond', 5]] }) });
  const ack = await a.recv((m) => m.t === 'saved', 4000, 'save ack');
  assert.equal(ack.dropped, 1, 'the server counted the invented item');
  a.send({ t: 'save', profile: profile() });
  await a.recv((m) => m.t === 'saved' && m.ok === true, 4000, 'good save');
  const back = await join(port, { name: 'Tamper', token });
  assert.deepEqual(
    back.hello.me.inventory.filter((s) => s && s[0] === 'diamond'),
    [],
    'no diamond in the stored bag',
  );
  // (Note: joining again with the SAME token replaced this socket — that is
  // the reconnect rule — so the tampering checks continue on `back`.)
  assert.equal(a.hello.playerId, back.hello.playerId, 'a reload reclaims the same player id');
  back.send({ t: 'save', profile: 'not a profile' });
  await back.recv((m) => m.t === 'saved' && m.ok === false, 4000, 'rejected garbage save');
  back.send({ t: 'save' });
  await back.recv((m) => m.t === 'saved' && m.ok === false, 4000, 'rejected empty save');
  back.send({ t: 'save', profile: profile({ stats: 'no stats' }) });
  await back.recv((m) => m.t === 'saved' && m.ok === false, 4000, 'rejected stats-less save');
  back.close();
});

test('identity: renaming tells the other players too', async () => {
  const a = await join(port, { name: 'Oudnaam' });
  const b = await join(port, { name: 'Buurt' });
  a.send({ t: 'name', name: 'Nieuwe Naam' });
  const ren = await b.recv((m) => m.t === 'renamed' && m.id === a.id, 4000, 'rename broadcast');
  assert.equal(ren.name, 'Nieuwe Naam');

  // A name that is only control characters never reaches anyone: the server
  // drops it, so players can never be renamed into an empty string.
  a.send({ t: 'name', name: '\u0000\u0001' });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(
    a.queue.filter((m) => m.t === 'renamed' && m.id === a.id).length,
    1,
    'the blank rename produced no second broadcast',
  );
  const derde = await join(port, { name: 'Derde' });
  assert.equal(
    derde.hello.players.find((pl) => pl.id === a.id)?.name,
    'Nieuwe Naam',
    'the roster still shows the last good name',
  );
  derde.close();
  a.close();
  b.close();
});

test('persistence: a server restart keeps buildings, harvests, depletion and players', async () => {
  const token = 'tok-' + 'd'.repeat(20);
  const a = await join(port, { name: 'Bouwer', token });
  a.send({ t: 'place', kind: 'wall', p: [12, -18, 3], rot: 2, id: 'b_restart' });
  await a.recv((m) => m.t === 'placed' && m.b.id === 'b_restart', 4000, 'wall placed');
  a.send({ t: 'harvest', id: 'n_tree_4242', by: a.id });
  await a.recv((m) => m.t === 'harvested' && m.id === 'n_tree_4242', 4000, 'first harvest');
  a.send({ t: 'save', profile: profile({ name: 'Bouwer' }) });
  await a.recv((m) => m.t === 'saved' && m.ok === true, 4000, 'save ack');
  a.close();

  // Force the debounce write to complete before killing the process.
  child.kill('SIGINT');
  await new Promise((resolve) => {
    child.once('exit', resolve);
    setTimeout(resolve, 2500);
  });

  // The written file is plain JSON — inspectable, and the point of the task.
  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(raw.buildings.some((b) => b.id === 'b_restart'), 'building on disk');
  assert.ok(raw.harvests.some(([k]) => k === 'n_tree_4242'), 'harvest count on disk');
  assert.ok(raw.players.some(([k]) => k === token), 'player profile on disk');
  assert.equal(typeof raw.clockOffsetS, 'number', 'the world clock survives too');

  ({ child, port } = await boot());
  const b = await join(port, { name: 'Bouwer', token });
  assert.equal(b.hello.buildings.some((x) => x.id === 'b_restart'), true, 'building back after restart');
  assert.equal(b.hello.buildings.find((x) => x.id === 'b_restart').rot, 2);
  assert.equal(b.hello.me.inventory.some((s) => s && s[0] === 'wood' && s[1] === 14), true, 'profile back after restart');
  // The tree is one harvest away from its second cut (2 cuts = depleted).
  b.send({ t: 'harvest', id: 'n_tree_4242', by: b.id });
  const second = await b.recv((m) => m.t === 'harvested' && m.id === 'n_tree_4242', 4000, 'second harvest');
  assert.equal(second.hp, 1, 'harvest count continued across the restart (3 - 2 cuts)');
  b.send({ t: 'harvest', id: 'n_tree_4242', by: b.id });
  const gone = await b.recv((m) => m.t === 'depleted' && m.id === 'n_tree_4242', 4000, 'depletion');
  assert.ok(gone);
  b.close();
});
