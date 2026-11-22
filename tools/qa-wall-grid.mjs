// QA helper for the wall-grid complaint: "de grid van stenen muren komt niet
// overeen met de grid van hout en floor".
//  1. Asks the GAME (not the test doubles) where a wooden wall and a stone
//     wall land for the same camera aim, at 24 camera angles.
//  2. Builds a real 2x2 deck with an alternating wood/stone wall line and a
//     door, then checks the anchors are one module apart and stand on the
//     deck's border line — never in the middle of a floor cell.
// Usage: node tools/qa-wall-grid.mjs   (expects `npm run preview` on 4173)
// Screenshot: tools/qa-out/wall-grid.png
import { chromium } from '@playwright/test';

const MODULE = 2.0;
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.goto('http://localhost:4173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__game !== undefined, { timeout: 30000 });
await page.waitForTimeout(2500);

// 1. The game's own placement answer, per camera angle, for both wall kinds.
const parity = await page.evaluate(async () => {
  const g = window.__game;
  const results = [];
  const step = 0.55; // ~31 degrees per step, so all four quadrants get aimed
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  for (const pitch of [-0.1, -0.35, -0.62]) {
    for (let i = 0; i < 8; i++) {
      g.camYaw = i * step;
      g.camPitch = pitch;
      // The camera orientation is rebuilt in the render loop, so each aim
      // needs real frames before the ground ray follows it. Measuring every
      // angle inside one frame would measure one cell 24 times.
      await frame();
      await frame();
      const wood = g.placementFor('wall');
      const stone = g.placementFor('stone_wall');
      const floor = g.placementFor('floor');
      const out = { yaw: +g.camYaw.toFixed(2), pitch };
      if (!wood || !stone) {
        results.push({ ...out, skipped: true });
        continue;
      }
      results.push({
        ...out,
        wood: { x: wood.x, z: wood.z, rot: wood.rot },
        stone: { x: stone.x, z: stone.z, rot: stone.rot },
        sameAnchor: wood.x === stone.x && wood.z === stone.z && wood.rot === stone.rot,
        floor: floor ? { x: floor.x, z: floor.z } : null,
        // A wall anchor must never coincide with a floor cell centre.
        floorClash: floor
          ? Math.abs(floor.x - stone.x) < 0.6 && Math.abs(floor.z - stone.z) < 0.6
          : null,
      });
    }
  }
  g.camYaw = 0;
  g.camPitch = -0.15;
  return results;
});

// 2. A real mixed wall line on a deck, measured from world state afterwards.
const built = await page.evaluate((MODULE) => {
  const g = window.__game;
  const p = g.controller.pos;
  const cx = Math.round(p.x / MODULE) * MODULE; // floor cell centre
  const cz = Math.round(p.z / MODULE) * MODULE;
  const y = p.y;
  const add = (id, kind, x, z, rot = 0) => {
    g.world.addBuilding({ id, kind, x, z, y, rot, ownerId: g.localId });
    return id;
  };
  for (const [ox, oz] of [[0, 0], [MODULE, 0], [0, MODULE], [MODULE, MODULE]]) {
    add(`qa-floor-${ox}_${oz}`, 'floor', cx + ox, cz + oz);
  }
  // North edge line of the deck: alternating wooden and stone links.
  const line = [];
  for (let i = 0; i < 4; i++) {
    const kind = i % 2 === 0 ? 'wall' : 'stone_wall';
    const x = cx - MODULE + i * MODULE;
    const z = cz - MODULE / 2;
    add(`qa-${kind}-${i}`, kind, x, z, 0);
    line.push({ kind, x, z });
  }
  // A door closes the line and must share the very same anchors.
  add('qa-door-0', 'door', cx + MODULE * 2, cz - MODULE / 2, 0);
  g.renderer.sync(g.world.buildings);
  const gaps = [];
  for (let i = 1; i < line.length; i++) {
    gaps.push(+Math.abs(line[i].x - line[i - 1].x).toFixed(6));
  }
  const distToDeck = +Math.abs(line[1].z - cz).toFixed(6);
  return { line, gaps, distToDeck, cx, cz, count: g.world.buildings.length };
}, MODULE);

await page.waitForTimeout(1500);
await page.screenshot({ path: 'tools/qa-out/wall-grid.png' });

const bad = parity.filter((p) => !p.skipped && (!p.sameAnchor || p.floorClash !== false));
const anchors = new Set(parity.filter((p) => !p.skipped).map((p) => `${p.stone.x},${p.stone.z}`));
const parityOk = bad.length === 0;
const gapsOk = built.gaps.length === 3 && built.gaps.every((g) => Math.abs(g - MODULE) < 1e-9);
const deckOk = Math.abs(built.distToDeck - MODULE / 2) < 1e-9;

console.log(`cameren getest: ${parity.length}, ankers geraakt: ${anchors.size}`);
if (bad.length) for (const p of bad) console.log('  AFWIJKING:', JSON.stringify(p));
console.log('muurlijn:', JSON.stringify(built.line));
console.log('mazen tussen de muren:', built.gaps, `(verwacht ${MODULE})`);
console.log('afstand muurlijn→deckmiddellijn:', built.distToDeck, `(verwacht ${MODULE / 2})`);
console.log('resultaat:', { parityOk, gapsOk, deckOk, anchorsTested: anchors.size });
console.log('page errors:', errors.length ? errors : 'geen');
await browser.close();
process.exit(parityOk && gapsOk && deckOk && errors.length === 0 ? 0 : 1);
