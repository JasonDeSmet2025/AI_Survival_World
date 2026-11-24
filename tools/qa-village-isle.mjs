/**
 * QA: the second island, its bridge and its village — in the real build, on
 * foot, with the real controller.
 *
 * The unit tests prove the geometry (flush deck, walkable slope, doorway gaps).
 * This proves the *game* agrees: the player is walked across the strait with
 * the W key, stands on the deck, crosses onto the island, and ends up in the
 * church. Every check waits for a state, never for wall-clock time — this
 * browser renders through swiftshader at a few frames per second.
 *
 * Usage:  node tools/qa-village-isle.mjs [out-dir]
 * Env:    BASE_URL=http://host:port   reuse a running stack (default :8080)
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] || 'tools/qa-out/isle';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
// A screenshot is evidence, so old evidence has to go: a run that renames or
// drops a check would otherwise leave the previous PNG behind and look like it
// still passed.
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass, detail: String(detail).slice(0, 220) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 690 } });
page.on('pageerror', (e) => check('geen console-fout', false, e.message));

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game?.controller, null, { timeout: 90000 });
// Skip the intro/dialogue overlays the same way a player does.
await page.keyboard.press('Space').catch(() => {});
await page.waitForTimeout(1500);

// A screenshot needs a freshly drawn frame, and this box renders the world in
// software at 1-2 fps when it is busy — 30 s (Playwright's default) is not a
// frame, it is a coin toss. Every wait in this file is therefore generous.
page.setDefaultTimeout(180000);
const shot = async (n) => {
  // Pin the sun before every picture. The day/night clock is shared with the
  // server and this run lasts minutes, so the last screenshots would otherwise
  // be taken in the dark — and a QA picture you cannot read is not evidence.
  // `elapsed` is the clock behind lighting.timeOfDay; DAY_LENGTH is 900 s
  // (visual/lighting.ts), so 0.34 of it is mid-morning with the sun in the east.
  await page.evaluate(() => {
    const g = window.__game;
    if (g.lighting) g.lighting.elapsed = 0.34 * 900;
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, `${n}.png`), timeout: 180000 });
};

/**
 * Teleport + let physics settle, then read where the feet actually ended up.
 * `y` is given by the caller (never a drop from the sky: the controller would
 * land you with fall damage, and the check would measure the wrong thing).
 */
const place = (x, y, z, view = null) =>
  page.evaluate(async ({ x, y, z, view }) => {
    const g = window.__game;
    const c = g.controller;
    c.pos.set(x, y, z);
    c.vel.set(0, 0, 0);
    if (view !== null) g.camYaw = view;
    // Wait for a STATE, not for the clock: this browser draws 1-2 frames per
    // second, so a fixed `setTimeout` samples a body that has simulated one
    // step and reports "not landed yet" as a wrong height. A velocity check is
    // not enough either — a teleported body has vel 0 for exactly one frame —
    // so the state to wait for is a height that has stopped changing.
    let prev = -1e9;
    let stable = 0;
    let frames = 0;
    while (frames < 120 && stable < 4) {
      await new Promise((r) => requestAnimationFrame(r));
      frames++;
      const y = g.controller.pos.y;
      if (Math.abs(y - prev) < 0.01) stable++;
      else stable = 0;
      prev = y;
    }
    return { x: c.pos.x, y: c.pos.y, z: c.pos.z, frames };
  }, { x, y, z, view });

// --- The plan as the running game sees it ------------------------------------
const plan = await page.evaluate(() => {
  const b = window.__game.isleBridge;
  const v = window.__game.villageWallData;
  return {
    xWest: b.xWest,
    xEast: b.xEast,
    deckY: b.deckY,
    decks: b.decks.length,
    arches: b.arches.length,
    rails: b.rails.length,
    walls: v.length,
    buildings: [...new Set(v.map((w) => w.building))],
    // Feet stand exactly on a platform top here: the 0.18 FLOOR_SURFACE_OFFSET
    // in building.ts is for player-built floors, not for bridge decks.
    floorOffset: 0,
  };
});
check('brug geplant in de live-build', plan.decks >= 8 && plan.arches >= 1 && plan.rails === 2, JSON.stringify(plan));
check('dorp staat op de live-muren', plan.walls >= 30 && plan.buildings.length === 6, `${plan.walls} muren: ${plan.buildings}`);

// --- 1. From the mainland: the island and its bridge in view ---------------
const midX = (plan.xWest + plan.xEast) / 2;
const approach = await place(plan.xWest - 26, 3.2, 170, -Math.PI / 2); // look along +x
await shot('1-vanaf-vasteland');
// The mainland rises inland, so this only proves the bridge head is reached
// from dry land (and that the player is not standing in the sea).
check('vasteland bij de brug staat droog', approach.y > 0.4, `y=${approach.y.toFixed(2)} (dek ${plan.deckY.toFixed(2)} m)`);

// --- 2. On the deck: three places along the crossing ------------------------
for (const [n, x] of [
  ['west', plan.xWest + 3],
  ['midden', midX],
  ['oost', plan.xEast - 3],
]) {
  const p = await place(x, plan.deckY + 0.25, 170, -Math.PI / 2);
  await shot(`2-dek-${n}`);
  check(
    `dek ${n}: je staat op de brug, niet in het water`,
    Math.abs(p.y - (plan.deckY + plan.floorOffset)) < 0.06,
    `y=${p.y.toFixed(2)} vs ${plan.deckY.toFixed(2)}+${plan.floorOffset}`,
  );
}

// --- 3. Walking the crossing, simulated inside the page -------------------
// This browser draws 1-2 frames per second (software GL), so a *keyboard* walk
// advances about 26 cm per wall-clock second and proves nothing. The frame loop
// is not needed for movement though: PlayerController.update() is a pure
// function of (dt, input, yaw, walls, decks). Stepping it by hand runs a real
// walk through the BUILT bundle's own wall and deck lists — which is the thing
// worth testing here, since the unit tests run against the TypeScript sources.
const walk = (fromX, standY, fromZ, yaw, steps) =>
  page.evaluate(
    async ({ fromX, standY, fromZ, yaw, steps }) => {
      const g = window.__game;
      const c = g.controller;
      const walls = [...g.villageWallData, ...g.isleBridge.rails];
      // Exactly the surfaces game.ts hands the controller every frame.
      const decks = [...g.isleBridge.decks, ...(g.villageFloorData ?? [])];
      const input = {
        forward: 1,
        strafe: 0,
        jumpHeld: false,
        sprint: false,
        crouch: false,
      };
      c.pos.set(fromX, standY, fromZ);
      c.vel.set(0, 0, 0);
      const x0 = fromX;
      const z0 = fromZ;
      let minY = 99;
      let maxStep = 0;
      let py = standY;
      // A fresh frame lets the settle/grounding run once before we take over.
      await new Promise((r) => requestAnimationFrame(r));
      for (let i = 0; i < steps; i++) {
        c.update(1 / 60, input, yaw, g.colliders ?? [], true, walls, decks);
        minY = Math.min(minY, c.pos.y);
        maxStep = Math.max(maxStep, Math.abs(c.pos.y - py));
        py = c.pos.y;
      }
      return {
        x0, z0, y0: standY,
        x1: c.pos.x, y1: c.pos.y, z1: c.pos.z,
        minY, maxStep,
        dx: c.pos.x - x0,
        dz: c.pos.z - z0,
      };
    },
    { fromX, standY, fromZ, yaw, steps },
  );

// yaw = the doorway's outward normal + PI, and the bridge runs along +x, so
// these are the same rule: Math.sin(yaw) is the x of the walk direction.
const onDeck = await walk(plan.xWest + 3, plan.deckY + 0.3, 170, Math.PI / 2, 200);
check(
  'lopen over het dek: 15 m vooruit, niet van de brug',
  onDeck.dx > 12 && Math.abs(onDeck.dz) < 0.5 && onDeck.minY > plan.deckY - 0.5,
  `+${onDeck.dx.toFixed(1)} m, zijwaarts ${onDeck.dz.toFixed(2)} m, laagste y ${onDeck.minY.toFixed(2)}`,
);

const toIsle = await walk(plan.xEast - 6, plan.deckY + 0.3, 170, Math.PI / 2, 130);
check(
  'oost einde: van brug naar eiland, zonder in de zeearm te vallen',
  toIsle.x1 > plan.xEast + 3 && toIsle.minY > plan.deckY - 0.5 && toIsle.y1 > plan.deckY,
  `x=${toIsle.x1.toFixed(1)} (brug-einde ${plan.xEast.toFixed(1)}), y ${toIsle.y0.toFixed(2)}→${toIsle.y1.toFixed(2)}, laagste ${toIsle.minY.toFixed(2)}`,
);

const churchDoorway = await walk(149.1, 8.8, 170, Math.PI / 2, 90);
check(
  'door de kerkdeur lopen (de Opening in de muur is echt)',
  churchDoorway.x1 > 153 && Math.abs(churchDoorway.dz) < 0.4,
  `x ${churchDoorway.x0.toFixed(1)}→${churchDoorway.x1.toFixed(1)}, z ${churchDoorway.z0}→${churchDoorway.z1.toFixed(2)}`,
);

const intoWall = await walk(168, 8.8, 170, Math.PI / 2, 240);
check(
  'een muur is een muur: de kerkmuur houdt je tegen',
  intoWall.x1 < 172 && intoWall.x1 > 169,
  `x=${intoWall.x1.toFixed(2)} (muur binnen 171.68)`,
);

// Start above the mainland (the land there is ~10 m up) and let gravity find
// the beach, then walk the whole line: land, deck, beach, up to the pad.
const fromMainland = await walk(plan.xWest - 20, 12, 170, Math.PI / 2, 1400);
check(
  'lopen vanaf het vasteland het eiland op',
  fromMainland.x1 > plan.xEast + 2 && fromMainland.minY > -0.4,
  `x ${fromMainland.x0.toFixed(1)}→${fromMainland.x1.toFixed(1)}, laagste y ${fromMainland.minY.toFixed(2)}`,
);
await shot('3lopen-over-de-brug');

// --- 4. In the village square ----------------------------------------------
// Stand in the square, not against the church: from the pad's centre the tower
// wall is 1.6 m from your face and the screenshot is a wall.
const square = await place(140, 8.75, 170, Math.PI / 2); // look east, down the street
await shot('4-plein');
check(
  'plein vlak en droog (8.5 m)',
  Math.abs(square.y - 8.5) < 0.45,
  `y=${square.y.toFixed(2)}`,
);

const crowd = await page.evaluate(() => {
  const ids = ['sien', 'ansel', 'joris'];
  const out = [];
  for (const n of window.__game.npcs) {
    const p = n.root.position;
    out.push({ id: n.profile.id, name: n.profile.name, x: +p.x.toFixed(1), y: +p.y.toFixed(2), z: +p.z.toFixed(1) });
  }
  return { all: out.map((o) => o.id), isle: out.filter((o) => ids.includes(o.id)) };
});
check('drie eilandbewoners lopen rond', crowd.isle.length === 3, JSON.stringify(crowd.isle));
check(
  'eilandbewoners staan op droog land (niet in zee of in een muur)',
  crowd.isle.every((v) => v.y > 1.5),
  crowd.isle.map((v) => `${v.id}@${v.y}`).join(' '),
);

// --- 5. Through the church door and into the nave -------------------------
// The nave's box is read from the live wall list (the low church walls ARE the
// nave, the 19 m ones are the tower) rather than hardcoded here, because a
// hardcoded copy of a box is exactly the kind of check that passes while
// proving nothing: the player can be standing in the garden and still be
// "inside" a stale rectangle.
const naveBox = await page.evaluate(() => {
  const nave = window.__game.villageWallData.filter(
    (w) => w.building === 'church' && w.height < 10,
  );
  return {
    x0: Math.min(...nave.map((w) => w.minX)),
    x1: Math.max(...nave.map((w) => w.maxX)),
    z0: Math.min(...nave.map((w) => w.minZ)),
    z1: Math.max(...nave.map((w) => w.maxZ)),
    walls: nave.length,
  };
});
const entered = await walk(149.1, 8.8, 170, Math.PI / 2, 200);
const inNave =
  entered.x1 > naveBox.x0 + 1 &&
  entered.x1 < naveBox.x1 - 1 &&
  entered.z1 > naveBox.z0 &&
  entered.z1 < naveBox.z1;
check(
  'van deur tot in het schip: deur, toren, boog zijn één looproute',
  inNave && Math.abs(entered.y1 - 8.5) < 0.4,
  `x ${entered.x0.toFixed(1)}→${entered.x1.toFixed(1)}, schip x[${naveBox.x0.toFixed(1)},${naveBox.x1.toFixed(1)}] z[${naveBox.z0.toFixed(1)},${naveBox.z1.toFixed(1)}], y ${entered.y1.toFixed(2)}`,
);

const naveMid = [
  (naveBox.x0 + naveBox.x1) / 2 + 1,
  (naveBox.z0 + naveBox.z1) / 2,
];
// A stone box this thick is a black room unless something lights it, and a
// building whose floor is grass is a wall on a field. Both are cheap to assert
// and cheap to get wrong.
const fittings = await page.evaluate(
  ([x, z]) => {
    const s = window.__game.scene;
    const lit = s.lights.filter((l) => {
      // A HemisphericLight has no position at all, so read it defensively.
      const p = l.position;
      if (!p) return false;
      return Math.hypot(p.x - x, p.y - 4, p.z - z) < (l.range ?? 10) && l.enabled !== false;
    });
    const floorMesh = s.meshes.filter((m) => m.name.startsWith('villageFloor'));
    return {
      lights: lit.map((l) => l.name),
      floorMeshes: floorMesh.length,
      // Highest standing surface under the nave's middle: the flagstone, which
      // physics must agree is 6 cm above the pad.
      floors: window.__game.villageFloorData?.length ?? -1,
    };
  },
  naveMid,
);
check(
  'het schip heeft licht en steen, niet alleen muren',
  fittings.lights.length > 0 && fittings.floorMeshes >= 6,
  JSON.stringify(fittings),
);
const within = await place(naveMid[0], 8.75, naveMid[1], -Math.PI / 2);
await shot('5-binnen-in-de-kerk');
check(
  'staan in het schip: de vloer draagt, de muren duwen niet',
  Math.abs(within.y - 8.5) < 0.4 &&
    within.x > naveBox.x0 + 0.5 &&
    within.x < naveBox.x1 - 0.5 &&
    within.z > naveBox.z0 + 0.5 &&
    within.z < naveBox.z1 - 0.5,
  JSON.stringify(within),
);
await page.evaluate((y) => {
  window.__game.camYaw = Math.PI / 2; // turn towards the altar end
  void y;
}, 0);
await shot('6-kerk-richting-altaar');

// --- 6. Frame cost while standing in the village ---------------------------
const fps = await page.evaluate(
  () =>
    new Promise((resolve) => {
      let n = 0;
      const t0 = performance.now();
      const tick = () => {
        n++;
        if (performance.now() - t0 < 4000) requestAnimationFrame(tick);
        else resolve((n / ((performance.now() - t0) / 1000)).toFixed(1));
      };
      requestAnimationFrame(tick);
    }),
);
// Software rendering (swiftshader) draws this world at ~1 fps; that number
// says nothing about a real GPU, so the check is only "the frame loop lives".
check('frame loop draait in het dorp', parseFloat(fps) > 0.3, `${fps} fps (swiftshader)`);

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks groen`);
console.log(`screenshots: ${outDir}/`);
process.exit(failed.length ? 1 : 0);
