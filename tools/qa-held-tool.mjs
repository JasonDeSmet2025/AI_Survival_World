// Visual QA: close-up of the right arm with each held tool.
// Usage: node tools/qa-held-tool.mjs   (expects the vite dev server on 5173)
import { chromium } from 'playwright';

const URL = process.env.GAME_URL ?? 'http://localhost:5173/';
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction('window.__game !== undefined', null, { timeout: 60000 });
await page.waitForTimeout(3000);

await page.evaluate(() => {
  const g = window.__game;
  // The game re-equips the selected hotbar item every frame, so the item to
  // show has to be forced at the selection hook, not via character.setTool.
  g.updateCamera = () => {};
  window.__aim = (kind, view) => {
    g.selectedItemId = () => kind;
    const offset =
      view === 'front' ? [1.05, 1.15, 1.35] : view === 'back' ? [1.2, 1.3, -1.1] : [1.5, 1.15, 0.25];
    const p = g.controller.pos;
    g.camera.position.set(p.x + offset[0], p.y + offset[1], p.z + offset[2]);
    g.camera.setTarget(g.scene.getTransformNodeByName('playerWristR').getAbsolutePosition());
  };
});

for (const kind of ['stone_axe', 'stone_pick', 'sword']) {
  for (const view of ['side', 'front']) {
    await page.evaluate(([k, v]) => window.__aim(k, v), [kind, view]);
    await page.waitForTimeout(450);
    await page.screenshot({ path: `/tmp/held-${kind}-${view}.png` });
  }
}
await browser.close();
console.log('wrote /tmp/held-*.png');
