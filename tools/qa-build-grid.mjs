/**
 * QA: the construction grid and solid buildings, in a REAL browser.
 *
 * Unit tests prove the maths; only a running game proves that what the player
 * sees is what their feet feel. This boots the real server (own state file) and
 * the real build, then drives the game's own code paths:
 *
 *   placementFor()/tryPlaceBuilding()  -> the same placement a player triggers
 *   one scene.render()                 -> exactly one physics frame
 *   real keyboard events               -> walking
 *
 * The headless render loop is stopped and the engine clock pinned to 60 Hz, so
 * "two seconds of falling" is 120 deterministic steps instead of whatever a
 * throttled headless requestAnimationFrame delivers. Aiming uses
 * updateCamera() (a raycast) rather than a render, which is ~1000x cheaper.
 *
 * Usage:  node tools/qa-build-grid.mjs
 * Env:    BASE_URL=http://host:port   reuse a running stack instead of booting one
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const stateFile = path.join(os.tmpdir(), `asw-grid-${process.pid}.json`);
const buildingSrc = fs.readFileSync(path.join(ROOT, 'src', 'game', 'systems', 'building.ts'), 'utf8');
/** The roof rule's message, read from the source so QA never drifts from it. */
const ROOF_ERROR = buildingSrc.match(/return '(roof needs[^']*)';/)?.[1] ?? 'roof needs a wall below it';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass, detail: String(detail).slice(0, 240) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

let server = null;
let baseUrl = process.env.BASE_URL;
if (!baseUrl) {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  fs.rmSync(stateFile, { force: true });
  server = spawn(process.execPath, ['server/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), MP_STATE_FILE: stateFile },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${baseUrl}/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
}

/** Injected once into the page. */
const HELPERS = `
  const g = () => window.__game;
  window.__qa = {
    /**
     * Advance game time without touching the GPU: one frame(dt) call is one
     * physics step, exactly what the render loop runs per drawn frame.
     */
    step(frames) { for (let i = 0; i < frames; i++) g().frame(1 / 60); },
    /** Actually draw frames (only used for the final screenshot). */
    render(frames) { for (let i = 0; i < frames; i++) g().scene.render(); },
    /**
     * Point the camera until the game's own placement helper targets this cell.
     * Returns that placement (error included when tolerateError), or null.
     */
    aim(kind, cellX, cellZ, tolerateError) {
      const game = g();
      for (let p = -0.08; p >= -1.25; p -= 0.02) {
        for (let y = -1.3; y <= 1.3; y += 0.05) {
          game.camPitch = p; game.camYaw = y;
          game.updateCamera();
          const pl = game.placementFor(kind);
          if (pl && Math.abs(pl.x - cellX) < 0.01 && Math.abs(pl.z - cellZ) < 0.01 && (tolerateError || !pl.error)) {
            return { x: pl.x, z: pl.z, y: pl.baseY, rot: pl.rot, error: pl.error };
          }
        }
      }
      return null;
    },
    /** Stand the player somewhere and let the camera settle. */
    park(x, y, z) { g().controller.respawn(x, y, z); this.step(2); },
    find(kind, cell) {
      return g().world.buildings.find(
        (b) => b.kind === kind && Math.abs(b.x - cell.x) < 0.01 && Math.abs(b.z - cell.z) < 0.01,
      ) || null;
    },
  };
  g().engine.stopRenderLoop();
  g().engine.getDeltaTime = () => 1000 / 60;
`;

/** Hold real keyboard keys, then run N physics steps. */
async function walk(page, keys, frames) {
  for (const k of keys) await page.keyboard.down(k);
  await page.evaluate((n) => window.__qa.step(n), frames);
  for (const k of keys) await page.keyboard.up(k);
}

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 576 } });
page.on('pageerror', (e) => check('no page errors', false, e.message));
page.on('crash', () => check('page did not crash', false, 'renderer crashed'));

try {
  console.log(`# loading ${baseUrl}`);
  await page.goto(`${baseUrl}/?solo=1`, { waitUntil: 'load' });
  await page.waitForFunction('window.__game !== undefined', null, { timeout: 45000 });
  await page.evaluate(HELPERS);
  await page.evaluate(() => window.__qa.render(3));

  const home = await page.evaluate(() => {
    const g = window.__game;
    g.inventory.add('floor', 20);
    g.inventory.add('wall', 20);
    g.inventory.add('roof', 10);
    return { x: g.controller.pos.x, y: g.controller.pos.y, z: g.controller.pos.z };
  });
  // Build on a flat spot 4 m from the player, on grid, above sea level.
  const base = { x: Math.round(home.x / 2) * 2, z: Math.round((home.z - 6) / 2) * 2 };

  // --- 1. A 2x2 deck: every cell snaps, edges shared, no duplicates -------
  const block = await page.evaluate(
    ({ base }) => {
      const g = window.__game;
      window.__qa.park(base.x, 0, base.z - 6);
      const cells = [];
      const placed = [];
      for (const [ox, oz] of [[0, 0], [2, 0], [0, 2], [2, 2]]) {
        const cell = { x: base.x + ox, z: base.z + oz };
        const pl = window.__qa.aim('floor', cell.x, cell.z);
        if (!pl) { cells.push({ cell, aim: null }); continue; }
        cells.push({ cell, aim: pl });
        g.tryPlaceBuilding('floor');
        const built = window.__qa.find('floor', cell);
        placed.push(built ? { x: built.x, z: built.z, y: built.y } : null);
        // The same cell a second time must be refused, not stacked.
        if (pl) { const before = g.world.buildings.length; g.tryPlaceBuilding('floor'); if (g.world.buildings.length !== before) placed.push('DUPLICATE'); }
      }
      return { cells, placed };
    },
    { base },
  );
  check(
    'four aims build four decks on the 2 m grid',
    block.placed.filter((p) => p && p.x !== undefined).length === 4,
    JSON.stringify(block),
  );
  check('a cell never accepts a second building', !block.placed.includes('DUPLICATE'), JSON.stringify(block.placed));
  const ys = block.placed.filter(Boolean).map((p) => p.y);
  check('every deck sits on the terrain of its own cell', ys.every((y) => Number.isFinite(y)) && Math.max(...ys) - Math.min(...ys) < 1.2, JSON.stringify(ys));

  // --- 2. Walls rise out of decks, one plank higher ----------------------
  const stacking = await page.evaluate(({ base }) => {
    const g = window.__game;
    const deck = window.__qa.find('floor', base);
    window.__qa.park(base.x, 0, base.z - 5);
    const pl = window.__qa.aim('wall', base.x, base.z);
    if (!pl || pl.error) return { error: 'cannot aim a wall at the deck cell', pl };
    g.tryPlaceBuilding('wall');
    const wall = window.__qa.find('wall', base);
    return { deck: { x: deck.x, z: deck.z, y: deck.y }, wall: wall ? { x: wall.x, z: wall.z, y: wall.y } : null };
  }, { base });
  check(
    'a wall inside a deck cell stands on the planks (+0.18)',
    stacking.wall && Math.abs(stacking.wall.y - (stacking.deck.y + 0.18)) < 0.02,
    JSON.stringify(stacking),
  );
  const secondStorey = await page.evaluate(({ base }) => {
    const g = window.__game;
    window.__qa.park(base.x, 0, base.z - 5);
    const pl = window.__qa.aim('wall', base.x, base.z); // the wall is already there
    const first = window.__qa.find('wall', base);
    return { pl: pl ? { y: pl.y, error: pl.error } : null, firstY: first ? first.y : null };
  }, { base });
  check(
    'a wall on top of a wall reaches one storey higher (+2.4)',
    secondStorey.pl && Math.abs(secondStorey.pl.y - (secondStorey.firstY + 2.4)) < 0.02,
    JSON.stringify(secondStorey),
  );

  // --- 3. Roofs need walls, and land on top of them ----------------------
  const roofTest = await page.evaluate(({ base }) => {
    const g = window.__game;
    // An empty cell (no floor, no wall) must refuse a roof.
    window.__qa.park(base.x, 0, base.z - 3);
    const empty = window.__qa.aim('roof', base.x + 6, base.z + 2, true);
    const overWall = window.__qa.aim('roof', base.x, base.z);
    if (!overWall || overWall.error) return { error: 'cannot aim a roof over the wall', overWall, empty };
    g.tryPlaceBuilding('roof');
    const roof = window.__qa.find('roof', base);
    const wall = window.__qa.find('wall', base);
    return {
      emptyError: empty ? empty.error : 'no aim',
      wallTop: wall ? wall.y + 2.4 : null,
      roof: roof ? { x: roof.x, z: roof.z, y: roof.y } : null,
    };
  }, { base });
  check(
    'a roof over an empty cell is refused',
    roofTest.emptyError === ROOF_ERROR,
    JSON.stringify(roofTest).slice(0, 160),
  );
  check(
    'a roof over a wall rests on the wall tops (+2.4)',
    roofTest.roof && Math.abs(roofTest.roof.y - roofTest.wallTop) < 0.02,
    JSON.stringify(roofTest),
  );

  // --- 4. Feet on planks: fall onto a deck, never through it -------------
  const fall = await page.evaluate(({ base }) => {
    const g = window.__game;
    // A deck with nothing on top: the 2x2 block's far corner.
    const deck = window.__qa.find('floor', { x: base.x + 2, z: base.z + 2 });
    const deckTop = deck.y + 0.18;
    g.controller.respawn(deck.x, deckTop + 5, deck.z);
    window.__qa.step(120); // two seconds of falling
    return { y: g.controller.pos.y, deckTop, onGround: g.controller.onGround };
  }, { base });
  check(
    'falling onto a deck stops the player on the planks',
    fall.onGround && Math.abs(fall.y - fall.deckTop) < 0.02,
    JSON.stringify(fall),
  );

  // --- 5. Walking up onto a deck lip (real keyboard events) --------------
  await page.evaluate(({ base }) => {
    const g = window.__game;
    const deck = window.__qa.find('floor', base);
    g.camYaw = 0; // camera looks along +z, so W walks +z: into the deck lip
    g.camPitch = -0.4;
    window.__qa.park(deck.x, 0, deck.z - 3.4); // 3 m short of the deck
    window.__qa.step(2);
  }, { base });
  await walk(page, ['KeyW'], 120);
  const stepUp = await page.evaluate(({ base }) => {
    const g = window.__game;
    const deck = window.__qa.find('floor', base);
    return { y: g.controller.pos.y, z: g.controller.pos.z, deckTop: deck.y + 0.18, deckZ: deck.z };
  }, { base });
  check(
    'walking forward steps up onto the deck',
    stepUp.z > stepUp.deckZ - 1 && Math.abs(stepUp.y - stepUp.deckTop) < 0.05,
    JSON.stringify(stepUp),
  );

  // --- 6. Walking into a wall stops you -----------------------------------
  await page.evaluate(({ base }) => {
    const g = window.__game;
    const wall = window.__qa.find('wall', base);
    g.camYaw = 0; // W walks +z, straight at the wall
    window.__qa.park(wall.x, 0, wall.z - 5);
    window.__qa.step(2);
  }, { base });
  await walk(page, ['KeyW'], 180);
  const blocked = await page.evaluate(({ base }) => {
    const g = window.__game;
    const wall = window.__qa.find('wall', base);
    return { wallZ: wall ? wall.z : null, z: g.controller.pos.z, x: g.controller.pos.x };
  }, { base });
  check(
    'walking into a wall stops in front of it',
    blocked.wallZ !== null && blocked.z < blocked.wallZ - 0.5,
    JSON.stringify(blocked),
  );

  // --- 7. Roofs are walkable ---------------------------------------------
  const roofWalk = await page.evaluate(({ base }) => {
    const g = window.__game;
    const roof = window.__qa.find('roof', base);
    if (!roof) return { error: 'no roof was built' };
    g.controller.respawn(roof.x, roof.y + 4, roof.z + 0.4); // above the south slope
    window.__qa.step(140);
    return {
      y: g.controller.pos.y,
      expected: roof.y + 0.45 - 0.4 * Math.tan(0.36),
      onGround: g.controller.onGround,
    };
  }, { base });
  check(
    'a roof catches the player at the height of its slabs',
    roofWalk.onGround && Math.abs(roofWalk.y - roofWalk.expected) < 0.09,
    JSON.stringify(roofWalk),
  );

  await page.evaluate(() => {
    const g = window.__game;
    g.camPitch = -0.5;
    g.camYaw = 0;
    g.updateCamera();
    window.__qa.render(4);
  });
  await page.screenshot({ path: '/tmp/qa-build-grid.png' });
} finally {
  await browser.close();
  server?.kill();
  fs.rmSync(stateFile, { force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} QA checks passed`);
process.exit(failed.length ? 1 : 0);
