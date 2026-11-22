// QA helper: screenshot the HUD in its three busy states (field, craft menu
// off-station, craft menu at the table) and report which HUD boxes overlap.
// Usage: node tools/qa-hud-layout.mjs   (expects `npm run preview` on 4173)
// Screenshots land in tools/qa-out/.
import { chromium } from '@playwright/test';

const URL = process.env.ASW_URL ?? 'http://localhost:4173/';

const overlaps = (a, b) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game !== undefined, { timeout: 30000 });
await page.waitForTimeout(3000);

const shot = (name) => page.screenshot({ path: `tools/qa-out/${name}.png` });

// 1. Field: menu closed, fresh world (level 1).
await shot('1-field');

// 2. Craft menu open with everything level-unlocked but NO table anywhere,
//    so the station gate alone decides what is clickable.
await page.evaluate(() => {
  const g = window.__game;
  g.progress.level = 9;
});
await page.keyboard.press('KeyB');
await page.waitForTimeout(1500);
const offStation = await page.evaluate(() => {
  const items = [...document.querySelectorAll('.craft-item')];
  return {
    station: document.querySelector('.craft-station')?.textContent,
    heads: [...document.querySelectorAll('.craft-station-head, .craft-group-head')].map((e) => e.textContent),
    enabled: items.filter((e) => !e.disabled).map((e) => e.textContent.split('·')[0].trim()),
    offStation: items.filter((e) => e.classList.contains('off-station')).length,
    total: items.length,
  };
});
await shot('2-craft-field');

// 3. Spawn a table right under the player and stand at it.
await page.evaluate(() => {
  const g = window.__game;
  const p = g.controller.pos; // {x, y, z} feet position
  g.world.addBuilding({
    id: 'qa-bench',
    kind: 'workbench',
    x: p.x,
    z: p.z,
    y: p.y,
    rot: 0,
    ownerId: g.localId,
  });
  g.renderer.sync(g.world.buildings);
});
// Long enough for several throttled HUD refreshes (the loop runs at a few fps
// under swiftshader, and refreshHud is called from the render loop).
await page.waitForTimeout(2000);
const atTable = await page.evaluate(() => {
  const items = [...document.querySelectorAll('.craft-item')];
  const g = window.__game;
  const pos = g.controller.pos;
  return {
    benches: g.world.buildings
      .filter((x) => x.kind === 'workbench')
      .map((x) => ({ id: x.id, owner: x.ownerId, mine: x.ownerId === g.localId, d: +Math.hypot(x.x - pos.x, x.z - pos.z).toFixed(2) })),
    station: document.querySelector('.craft-station')?.textContent,
    enabled: items.filter((e) => !e.disabled).length,
    offStation: items.filter((e) => e.classList.contains('off-station')).length,
    total: items.length,
  };
});
await shot('3-craft-table');

// 4. Control sheet expanded (H).
await page.keyboard.press('KeyB');
await page.keyboard.press('KeyH');
await page.waitForTimeout(1200);
await shot('4-hints');

// Overlap audit: no two informational boxes may share screen space.
const boxes = await page.evaluate(() => {
  const pick = ['.hud-title', '.mp-panel', '.fps', '.bars-box', '.quests:not([hidden])', '.hud-hints', '.toast', '.hotbar', '.hud-left', '.hud-right'];
  const out = {};
  for (const s of pick) {
    const e = document.querySelector(s);
    if (!e) continue;
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    out[s] = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }
  return out;
});
const collisions = [];
const keys = Object.keys(boxes);
for (let i = 0; i < keys.length; i++) {
  for (let j = i + 1; j < keys.length; j++) {
    const a = boxes[keys[i]];
    const b = boxes[keys[j]];
    // The columns CONTAIN their children by design; only siblings of the same
    // generation matter, so a box fully inside another one is fine.
    const inside = (x, y) => x.left >= y.left - 1 && x.right <= y.right + 1 && x.top >= y.top - 1 && x.bottom <= y.bottom + 1;
    if (overlaps(a, b) && !inside(a, b) && !inside(b, a)) {
      collisions.push(`${keys[i]} × ${keys[j]}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }
  }
}

console.log('off station:', JSON.stringify(offStation, null, 2));
console.log('at table    :', JSON.stringify(atTable, null, 2));
console.log('collisions  :', collisions.length ? collisions : 'geen');
console.log('page errors :', errors.length ? errors : 'geen');
await browser.close();
