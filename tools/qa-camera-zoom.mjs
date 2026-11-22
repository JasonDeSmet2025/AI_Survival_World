// QA: scrollwheel zoom (third person ↔ first person) + right-button cursor
// release. Drives the REAL build in a real browser: real wheel events on the
// canvas, a real pointer lock from a real click, a real right click.
//
// Usage: node tools/qa-camera-zoom.mjs   (expects `npm run preview` on 4173)
// Screenshots: tools/qa-out/cam-{third,first,chips}.png
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 760 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
// Chromium hands over pointer lock on a user activation (the click below) — no
// permission to grant, and Playwright does not even know the name.

await page.goto('http://localhost:4173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__game !== undefined, { timeout: 30000 });
await page.waitForTimeout(2500);

const shot = (n) => page.screenshot({ path: `tools/qa-out/cam-${n}.png` });

/**
 * Wait for a STATE, never for wall-clock time. This browser renders through
 * swiftshader at a few frames per second and the simulation clamps its step,
 * so `waitForTimeout(1200)` used to sample a camera that had barely moved and
 * report it as broken — the same "vals groen" trap as the raycast probe. Every
 * assertion below therefore waits for the condition it is about to test.
 */
const settle = (fn, arg, label) =>
  page
    .waitForFunction(fn, arg, { timeout: 40000, polling: 'raf' })
    .then(() => true)
    .catch(() => {
      console.log(`(time-out: ${label})`);
      return false;
    });
const rig = () =>
  page.evaluate(() => {
    const g = window.__game;
    const c = g.controller.pos;
    const k = g.camera.position;
    return {
      dist: +g.camDist.toFixed(3),
      target: +g.camDistTarget.toFixed(3),
      sep: +Math.hypot(k.x - c.x, k.y - c.y, k.z - c.z).toFixed(3),
      // Horizontal distance only: at full zoom the camera sits IN the player,
      // so the vertical eye offset is not "distance" — conflating the two made
      // this check fail on a camera that was perfectly correct.
      sepXZ: +Math.hypot(k.x - c.x, k.z - c.z).toFixed(4),
      eyeAboveFeet: +(k.y - c.y).toFixed(3),
      // Look angle of the RENDERED camera (its own forward ray), not the
      // stored pitch: the whole point of the per-view angles is that the
      // camera shows something else than the number in the field.
      look: +(Math.asin(g.camera.getForwardRay(1).direction.y) || 0).toFixed(3),
      bodyVisible: g.character.root.isEnabled(),
      locked: g.input.pointerLocked,
      fpPill: !document.querySelector('.cam-pill')?.hidden,
      pointerChip: !document.querySelector('.pointer-chip')?.hidden,
    };
  });

// The game starts unlocked (the browser only hands over the mouse after a
// click), so grab it the way a player does.
await page.click('canvas', { position: { x: 640, y: 300 } });
await settle(() => window.__game.input.pointerLocked, null, 'pointer lock na klik');
const fps = await page.evaluate(() => document.querySelector('#fps')?.textContent ?? '?');

const start = await rig();
await shot('third');

// --- Zoom all the way in: 20 notches up, one wheel event at a time.
const scroll = (notch, times) =>
  page.evaluate(({ notch, times }) => {
    const canvas = document.querySelector('canvas');
    for (let i = 0; i < times; i++) {
      canvas.dispatchEvent(
        new WheelEvent('wheel', { deltaY: notch, deltaMode: 0, bubbles: true, cancelable: true }),
      );
    }
  }, { notch, times });

await scroll(-100, 20);
await settle(() => window.__game.camDist < 0.02, null, 'camera bij de 0 m');
const first = await rig();
await shot('first');

// --- And back out again.
await scroll(100, 24);
await settle(() => window.__game.camDist > 6.9, null, 'camera terug op max');
const back = await rig();

// --- The wheel must not scroll the page under any circumstances.
const pageScroll = await page.evaluate(() => ({
  y: window.scrollY,
  body: document.scrollingElement ? document.scrollingElement.scrollTop : -1,
}));

// --- First person again, then the right button gives the cursor back.
await scroll(-100, 20);
await settle(() => window.__game.camDist < 0.02, null, 'terug naar 1e persoon');
await page.mouse.click(640, 300, { button: 'right' });
// The chip is drawn by the game loop, so wait for the loop to have seen it.
const chipUp = await settle(
  () => !document.querySelector('.pointer-chip')?.hidden,
  null,
  'pointer-chip verschijnt',
);
const released = await rig();
const lockAfterRmb = await page.evaluate(() => !!document.pointerLockElement);
const menuBlocked = await page.evaluate(() => {
  // Right-click must not raise the browser menu over the game.
  const canvas = document.querySelector('canvas');
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  canvas.dispatchEvent(ev);
  return ev.defaultPrevented;
});
await shot('chips');

// --- With the cursor free, a hotbar slot must actually be clickable.
const slotBox = await page.locator('.hotbar .slot').nth(2).boundingBox();
const beforeSlot = await page.evaluate(() => window.__game.inventory.selected);
if (slotBox) {
  await page.mouse.click(slotBox.x + slotBox.width / 2, slotBox.y + slotBox.height / 2);
}
await settle(() => window.__game.inventory.selected === 2, null, 'hotbar-slot 2 gekozen');
const afterSlot = await page.evaluate(() => window.__game.inventory.selected);

// --- Left click on the world takes the mouse back.
await page.mouse.click(640, 300, { button: 'left' });
const chipGone = await settle(
  () => !!document.querySelector('.pointer-chip')?.hidden,
  null,
  'pointer-chip verdwijnt',
);
const reGrabbed = await page.evaluate(() => !!document.pointerLockElement);

// --- The zoom survives a reload (it is a device preference).
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.__game !== undefined, { timeout: 30000 });
await settle(() => window.__game.character.root.isEnabled() === false, null, 'lichaam verborgen na reload');
const reloaded = await rig();

const results = {
  fps,
  start,
  firstPerson: first,
  backOut: back,
  pageScroll,
  released,
  lockAfterRmb,
  menuBlocked,
  slotClick: { beforeSlot, afterSlot },
  reGrabbed,
  chipGone,
  reloaded,
};
console.log(JSON.stringify(results, null, 2));

const checks = {
  'muis gegrepen bij klik': start.locked === true,
  'start in derde persoon (~5.5 m)': Math.abs(start.sep - 5.5) < 0.9 && start.bodyVisible,
  // The smoother approaches 0 exponentially and the eye keeps 5 cm of
  // backlash from its own target, so judge the RESULT (the camera stands in
  // the player's head) instead of an exact 0.
  'ingezoomd: camera staat in het hoofd': first.dist < 0.05 && first.sepXZ < 0.1,
  'ooghoogte ~1.62 m boven de voeten': Math.abs(first.eyeAboveFeet - 1.62) < 0.05,
  'eigen lichaam onzichtbaar in 1e persoon': first.bodyVisible === false,
  'pill laat de modus zien': first.fpPill,
  'terug uit zoomen werkt': back.dist > 6.9 && back.bodyVisible === true && back.sepXZ > 2,
  'wheel scrollt de pagina niet': pageScroll.y === 0 && pageScroll.body <= 0,
  'RMK geeft de muis vrij': lockAfterRmb === false && released.locked === false,
  'RMK opent geen browsermenu': menuBlocked === true,
  'chip verschijnt als de muis vrij is': chipUp && released.pointerChip,
  'hotbar klikbaar met vrije muis': afterSlot === 2 && afterSlot !== beforeSlot,
  'klik in de wereld pakt de muis weer': reGrabbed === true,
  'chip verdwijnt weer': chipGone === true,
  'zoom onthouden na reload': Math.abs(reloaded.dist) < 0.05,
  // -0.65 is the shoulder-cam's 37° down-angle; keeping it in first person
  // means staring at the player's own boots.
  'derde persoon kijkt naar beneden (wie het kent)': Math.abs(start.look + 0.65) < 0.12,
  'eerste persoon kijkt naar de horizon': Math.abs(first.look) < 0.15,
  'uitzoomen geeft de oude hoek terug': Math.abs(back.look + 0.65) < 0.12,
};
let ok = true;
for (const [name, pass] of Object.entries(checks)) {
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}`);
  if (!pass) ok = false;
}
console.log('page errors:', errors.length ? errors : 'geen');
await browser.close();
process.exit(ok && errors.length === 0 ? 0 : 1);
