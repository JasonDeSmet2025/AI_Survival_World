/**
 * QA: build a whole hut out of grid modules and look at it.
 *
 * Complements tools/qa-build-grid.mjs (which checks the rules): this one is
 * about the shape of the result — do walls and roofs tile a real, gap-free,
 * walkable structure? It boots the real server + build, places a 3x2 hut of
 * wall + roof cells, verifies the modules line up, and writes a screenshot.
 *
 * Usage:  node tools/qa-build-house.mjs [out.png]
 * Env:    BASE_URL=http://host:port   reuse a running stack instead of booting one
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const out = process.argv[2] || '/tmp/qa-build-house.png';
const stateFile = path.join(os.tmpdir(), `asw-house-${process.pid}.json`);
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
      if ((await fetch(`${baseUrl}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
}

const HELPERS = `
  const g = () => window.__game;
  window.__qa = {
    step(frames) { for (let i = 0; i < frames; i++) g().frame(1 / 60); },
    render(frames) { for (let i = 0; i < frames; i++) g().scene.render(); },
    aim(kind, cellX, cellZ, tolerateError) {
      const game = g();
      for (let p = -0.08; p >= -1.25; p -= 0.02) {
        for (let y = -1.3; y <= 1.3; y += 0.05) {
          game.camPitch = p; game.camYaw = y;
          game.updateCamera();
          const pl = game.placementFor(kind);
          if (pl && Math.abs(pl.x - cellX) < 0.01 && Math.abs(pl.z - cellZ) < 0.01 && (tolerateError || !pl.error)) {
            return { x: pl.x, z: pl.z, y: pl.baseY, rot: pl.rot };
          }
        }
      }
      return null;
    },
    park(x, y, z) { g().controller.respawn(x, y, z); this.step(2); },
    build(kind, cell) {
      const pl = this.aim(kind, cell.x, cell.z);
      if (!pl) return { cell, error: 'no aim' };
      g().tryPlaceBuilding(kind);
      const b = g().world.buildings.find(
        (x) => x.kind === kind && Math.abs(x.x - cell.x) < 0.01 && Math.abs(x.z - cell.z) < 0.01,
      );
      return b ? { x: b.x, z: b.z, y: b.y, rot: b.rot } : { cell, error: 'refused' };
    },
  };
  g().engine.stopRenderLoop();
  g().engine.getDeltaTime = () => 1000 / 60;
`;

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 620 } });
page.on('pageerror', (e) => check('no page errors', false, e.message));
page.on('crash', () => check('page did not crash', false, 'renderer crashed'));

try {
  console.log(`# loading ${baseUrl}`);
  await page.goto(`${baseUrl}/?solo=1`, { waitUntil: 'load' });
  await page.waitForFunction('window.__game !== undefined', null, { timeout: 45000 });
  await page.evaluate(HELPERS);
  await page.evaluate(() => window.__qa.render(3));

  const hut = await page.evaluate(() => {
    const g = window.__game;
    g.inventory.add('wall', 40);
    g.inventory.add('roof', 20);
    g.inventory.add('floor', 20);
    const base = { x: Math.round(g.controller.pos.x / 2) * 2, z: Math.round((g.controller.pos.z - 8) / 2) * 2 };
    const cells = [];
    for (const ox of [-4, -2, 0, 2, 4]) for (const oz of [0, 2]) cells.push({ x: base.x + ox, z: base.z + oz });

    // Stand 5 m south of each cell while building it: the aim ray comes from a
    // camera 5.5 m behind the player, so a fixed spot puts the far row out of range.
    const walls = [];
    const roofs = [];
    for (const c of cells) {
      window.__qa.park(c.x, 0, c.z - 5);
      walls.push(window.__qa.build('wall', c));
    }
    for (const c of cells) {
      window.__qa.park(c.x, 0, c.z - 5);
      roofs.push(window.__qa.build('roof', c));
    }
    return { base, walls, roofs };
  });

  const builtWalls = hut.walls.filter((w) => w.x !== undefined);
  const builtRoofs = hut.roofs.filter((r) => r.x !== undefined);
  check('every wall cell of the hut was built', builtWalls.length === hut.walls.length, JSON.stringify(hut.walls));
  check('every roof cell was built on top of its wall', builtRoofs.length === hut.roofs.length, JSON.stringify(hut.roofs));
  check(
    'walls all share one floor line and one cell pitch',
    builtWalls.every((w) => Math.abs(w.y - builtWalls[0].y) < 0.6) &&
      new Set(builtWalls.map((w) => `${w.x}|${w.z}`)).size === builtWalls.length,
    JSON.stringify(builtWalls.map((w) => [w.x, w.z, +w.y.toFixed(2)])),
  );
  check(
    'the roof panels form one continuous plane (one storey above the walls)',
    builtRoofs.length > 0 &&
      builtRoofs.every((r) => Math.abs(r.y - (builtWalls[0].y + 2.4)) < 0.6) &&
      new Set(builtRoofs.map((r) => `${r.x}|${r.z}`)).size === builtRoofs.length,
    JSON.stringify(builtRoofs.map((r) => [r.x, r.z, +r.y.toFixed(2)])),
  );

  // Drop onto the SEAM between two roof panels: the plane must be continuous.
  const seam = await page.evaluate(() => {
    const g = window.__game;
    const a = g.world.buildings.find((b) => b.kind === 'roof');
    const b = g.world.buildings.find((r) => r.kind === 'roof' && Math.abs(r.x - a.x) < 0.01 && Math.abs(r.z - a.z - 2) < 0.01);
    if (!b) return { error: 'no neighbouring roof panel' };
    const seamZ = (a.z + b.z) / 2; // exactly on the shared edge
    g.controller.respawn(a.x, Math.max(a.y, b.y) + 6, seamZ);
    window.__qa.step(150); // two and a half seconds of falling
    return {
      y: +g.controller.pos.y.toFixed(2),
      seamZ,
      panelY: +a.y.toFixed(2),
      onRoof: g.controller.pos.y > a.y, // above the wall tops => caught by the panels
      onGround: g.controller.onGround,
    };
  });
  check('the roof plane is continuous across a panel seam', seam.onRoof && seam.onGround, JSON.stringify(seam));

  // Frame the hut from outside for the screenshot.
  await page.evaluate(() => {
    const g = window.__game;
    const near = g.world.buildings.filter((b) => b.kind === 'wall').sort((a, b) => a.z - b.z)[0];
    const middle = { x: near.x, z: near.z };
    g.controller.respawn(middle.x, 0, middle.z - 12); // on the ground, looking at the hut
    g.camYaw = 0;
    g.camPitch = -0.18;
    window.__qa.step(90); // let the player settle on their feet
    g.camPitch = -0.16;
    g.updateCamera();
    window.__qa.render(8);
    // The control-hint panel covers the bottom half of a 16:9 shot; it is not
    // part of what this QA is about, so drop it before the screenshot.
    document.querySelector('.hud-hints')?.remove();
  });
  await page.screenshot({ path: out });
  console.log(`# screenshot: ${out}`);
} finally {
  await browser.close();
  server?.kill();
  fs.rmSync(stateFile, { force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} QA checks passed`);
process.exit(failed.length ? 1 : 0);
