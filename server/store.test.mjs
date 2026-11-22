/**
 * Persistent world store unit tests.
 * Run with: node --test server/store.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createWorldStore, sanitizeName } from './store.mjs';

const memFs = () => {
  const files = new Map();
  return {
    files,
    mkdirSync: () => {},
    writeFileSync: (p, data) => files.set(p, data),
    renameSync: (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    },
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error('ENOENT ' + p);
      return files.get(p);
    },
  };
};

const profile = (over = {}) => ({
  name: 'Loki',
  stats: { health: 80, hunger: 55, thirst: 60, stamina: 90, temperature: 17, exhausted: false, dead: false },
  inventory: [['wood', 12], ['stone', 3], null, ['stone_axe', 1, 40]],
  selected: 0,
  pos: { x: 12.5, y: 8, z: -30 },
  yaw: 1.2,
  progress: { level: 3, xp: 120 },
  ...over,
});

test('store: a player profile round-trips through a restart', () => {
  const f = memFs();
  const file = '/tmp/asw-store-test.json';
  const store = createWorldStore({ file, fsImpl: f, setTimer: () => 0 });
  store.addBuilding({ id: 'b_1', kind: 'wall', x: 4, z: -5, y: 3, rot: 2, ownerId: 'p1' });
  store.addHarvest('n_tree_7');
  store.deplete('n_bush_3');
  store.putProfile('tokentokentoken1', profile());
  store.flush();

  const restored = createWorldStore({ file, fsImpl: f, setTimer: () => 0 });
  assert.equal(restored.load(), 0, 'nothing rejected');
  assert.equal(restored.world.buildings.length, 1);
  assert.equal(restored.world.buildings[0].rot, 2);
  assert.equal(restored.harvestCount('n_tree_7'), 1);
  assert.equal(restored.isDepleted('n_bush_3'), true);
  assert.deepEqual(restored.profile('tokentokentoken1').inventory, [['wood', 12], ['stone', 3], null, ['stone_axe', 1, 40]]);
  assert.equal(restored.profile('tokentokentoken1').progress.level, 3);
});

test('store: empty/missing file boots a fresh world instead of throwing', () => {
  const f = memFs();  const store = createWorldStore({ file: '/tmp/nope.json', fsImpl: f });
  assert.equal(store.load(), 0);
  assert.equal(store.world.buildings.length, 0);
  assert.equal(store.playerCount(), 0);
  // No file at all: flush still creates one.
  store.addBuilding({ id: 'b_2', kind: 'floor', x: 1, z: 2, y: 3, rot: 0, ownerId: 'p2' });
  store.flush();
  assert.ok(f.files.has('/tmp/nope.json'));
});

test('store: corrupt JSON falls back to a fresh world', () => {
  const f = memFs();
  f.files.set('/tmp/x.json', '{ this is not json');
  const store = createWorldStore({ file: '/tmp/x.json', fsImpl: f });
  assert.equal(store.load(), 0);
  assert.equal(store.world.buildings.length, 0);
});

test('store: hand-edited progress can never invent items, hp or levels', () => {
  const f = memFs();
  const store = createWorldStore({ file: '/tmp/y.json', fsImpl: f, setTimer: () => 0 });
  const token = 'legit-token-1';
  const forged = store.putProfile(token, profile({ inventory: [['wood', 12], ['diamond_sword', 9]] }));
  assert.equal(forged.inventory[1], null, 'an item that does not exist is dropped');
  assert.equal(forged.droppedItems, 1, 'and the client is told about it');
  assert.deepEqual(forged.inventory[0], ['wood', 12], 'the rest of the bag survives');
  const inflatedStack = store.putProfile(token, profile({ inventory: [['wood', 999999]] }));
  assert.deepEqual(inflatedStack.inventory[0], ['wood', 60], 'count clamped to the real stack size');
  // Out-of-range NUMBERS are clamped rather than rejected: a client that
  // sends health 5000 gains nothing (it lands on 100) and a slightly
  // different build never loses its save over a rounding difference.
  const inflated = store.putProfile(token, profile({ stats: { health: 5000, hunger: 1, thirst: 1, stamina: 1, temperature: 900 } }));
  assert.equal(inflated.stats.health, 100);
  assert.equal(inflated.stats.temperature, 60);
  assert.equal(store.putProfile(token, profile({ inventory: 'not-an-array' })), null);
  assert.equal(store.putProfile('short', profile()), null, 'token too short is not an identity');
  assert.equal(store.profile(token) !== null, true, 'the valid upload above did get stored');

  // The same payload, valid, is stored AND clamped.
  const ok = store.putProfile(token, {
    ...profile(),
    stats: { health: 140, hunger: 55, thirst: 60, stamina: 90, temperature: 17 },
    progress: { level: 900, xp: 5 },
  });
  assert.equal(ok.stats.health, 100, 'hp clamped to the game maximum');
  assert.equal(ok.progress.level, 99, 'level clamped');
});

test('store: buildings are validated, deduplicated and fuel-clamped', () => {
  const store = createWorldStore({ file: null });
  assert.equal(store.addBuilding({ id: 'b_a', kind: 'hut', x: 0, z: 0, y: 0, rot: 0, ownerId: 'p' }), null);
  assert.equal(store.addBuilding({ id: 'b_b', kind: 'wall', x: NaN, z: 0, y: 0, rot: 0, ownerId: 'p' }), null);
  assert.ok(store.addBuilding({ id: 'b_c', kind: 'campfire', x: 1, z: 2, y: 3, rot: 9, ownerId: 'p', fuel: 99999 }));
  assert.equal(store.world.buildings[0].rot, 3, 'rotation clamped to the 4 placements');
  assert.equal(store.world.buildings[0].fuel, 3600, 'fuel clamped to maxFuel');
  assert.equal(store.addBuilding({ id: 'b_c', kind: 'wall', x: 5, z: 5, y: 0, rot: 0, ownerId: 'p' }), null, 'id unique');
  assert.equal(store.setFuel('b_c', 50), 50);
  assert.equal(store.findBuilding('b_c').fuel, 50);
  assert.equal(store.setFuel('b_dom', 50), null, 'only campfires hold fuel');
});

test('store: garbage in the world file is dropped, not trusted', () => {
  const f = memFs();
  f.files.set(
    '/tmp/z.json',
    JSON.stringify({
      v: 1,
      buildings: [
        { id: 'b_ok', kind: 'bed', x: 1, z: 2, y: 3, rot: 1, ownerId: 'p' },
        { id: 'b_bad', kind: 'castle', x: 0, z: 0, y: 0, rot: 0, ownerId: 'p' },
        { id: '', kind: 'wall', x: 0, z: 0, y: 0, rot: 0, ownerId: 'p' },
        'not even an object',
      ],
      harvests: [['n_tree_1', 2], ['n_mystery_1', 1], ['n_tree_2', -5], ['nope', 3]],
      depleted: ['n_rock_4', 'n_rock_\\\\`', 42],
      players: [
        ['good-token-abc', profile()],
        ['bad token!', profile()],
        ['good2-token-abc', { nonsense: true }],
        'broken row',
      ],
    }),
  );
  const store = createWorldStore({ file: '/tmp/z.json', fsImpl: f, setTimer: () => 0 });
  const rejected = store.load();
  assert.equal(store.world.buildings.length, 1, 'only the valid building survived');
  assert.equal(store.harvestCount('n_tree_1'), 2);
  assert.equal(store.world.harvests.size, 1);
  assert.deepEqual([...store.world.depleted], ['n_rock_4']);
  assert.equal(store.playerCount(), 1);
  assert.ok(rejected >= 8, `garbage counted as rejected (${rejected})`);
});

test('store: clock offset persists with the world', () => {
  const f = memFs();
  const file = '/tmp/clock.json';
  const a = createWorldStore({ file, fsImpl: f, setTimer: () => 0 });
  assert.equal(a.clockOffset(), null, 'fresh world has no anchor');
  a.setClockOffset(424);
  a.flush();
  const b = createWorldStore({ file, fsImpl: f, setTimer: () => 0 });
  b.load();
  assert.equal(b.clockOffset(), 424);
});

test('store: writes are debounced and the file is replaced atomically', () => {
  const f = memFs();
  let timer = null;
  const store = createWorldStore({
    file: '/tmp/deb.json',
    fsImpl: f,
    setTimer: (_ms, fn) => {
      timer = fn;
      return 0;
    },
    debounceMs: 500,
  });
  store.addBuilding({ id: 'b_x', kind: 'wall', x: 0, z: 0, y: 0, rot: 0, ownerId: 'p' });
  store.addBuilding({ id: 'b_y', kind: 'wall', x: 1, z: 0, y: 0, rot: 0, ownerId: 'p' });
  assert.equal(f.files.has('/tmp/deb.json'), false, 'no write per message');
  assert.equal(store.pendingWrite, true);
  timer();
  assert.equal(f.files.has('/tmp/deb.json'), true);
  assert.equal(f.files.has('/tmp/deb.json.tmp'), false, 'temp file renamed away');
  assert.equal(store.pendingWrite, false);
});

test('store: no file means memory-only, never a crash', () => {
  const store = createWorldStore({ file: null });
  store.addBuilding({ id: 'b_m', kind: 'roof', x: 0, z: 0, y: 0, rot: 0, ownerId: 'p' });
  store.flush();
  assert.equal(store.world.buildings.length, 1);
});

test('sanitizeName: printable names only, no control characters', () => {
  assert.equal(sanitizeName('  Loki  '), 'Loki');
  assert.equal(sanitizeName('a\u0000b\u0007c'), 'abc', 'control characters stripped');
  assert.equal(sanitizeName('   '), null, 'blank is not a name');
  assert.equal(sanitizeName('x'.repeat(60)).length, 24, 'length capped like the client');
  assert.equal(sanitizeName(null), null);
  assert.equal(sanitizeName('Rúri Ñoño · ³'), 'Rúri Ñoño · ³');
});
