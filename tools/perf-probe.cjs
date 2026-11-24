/* eslint-disable no-console */
// Headless perf probe: start the game, measure fps + scene stats + a CPU profile sample.
const { chromium } = require('playwright');

(async () => {
  const b = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'] });
  const p = await b.newPage();
  p.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
  await p.goto('http://localhost:8080/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2000);

  // Click through the menu: find the start button.
  const btns = await p.$$eval('button', (els) => els.map((e) => e.textContent.trim()));
  console.log('buttons:', JSON.stringify(btns));
  const idx = btns.findIndex((t) => /spel|speel|eenzaam|single/i.test(t));
  if (idx >= 0) await p.click(`button:nth-of-type(${idx + 1})`).catch(() => {});
  // Fallback: dispatch the hud event directly.
  await p.evaluate(() => {
    const g = window.__game;
    if (g && typeof g.startSolo === 'function') g.startSolo();
  });
  await p.waitForTimeout(6000); // worldgen + shader compile

  const probe = async (label) => {
    const s = await p.evaluate(() => {
      const g = window.__game;
      if (!g || !g.engine) return { error: 'no game' };
      const sc = g.scene;
      const lights = sc.lights.length;
      const active = sc.getActiveMeshes().length;
      const total = sc.meshes.length;
      const parts = sc.particleSystems ? sc.particleSystems.length : 0;
      return {
        fps: Math.round(g.engine.getFps()),
        drawCalls: sc.getEngine() ? sc.drawCalls : -1,
        active,
        total,
        lights,
        particles: parts,
        frameMs: Math.round(g.engine.getDeltaTime()),
      };
    });
    console.log(label, JSON.stringify(s));
    return s;
  };

  await probe('t0 ');
  for (let i = 1; i <= 5; i++) {
    await p.waitForTimeout(2000);
    await probe('t' + i + ' ');
  }

  // CPU profile of the main thread for 3 s while idle-rendering.
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.start');
  await p.waitForTimeout(3000);
  const { profile } = await cdp.send('Profiler.stop');
  const self = new Map();
  const byNode = new Map(profile.nodes.map((n) => [n.id, n]));
  const total = profile.samples.length;
  for (const id of profile.samples) {
    const n = byNode.get(id);
    if (!n) continue;
    const key = `${n.callFrame.functionName || '(anon)'} @${(n.callFrame.url || '').split('/').pop()}:${n.callFrame.lineNumber}`;
    self.set(key, (self.get(key) || 0) + 1);
  }
  console.log('--- top CPU (of ' + total + ' samples) ---');
  [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .forEach(([k, v]) => console.log(`${((100 * v) / total).toFixed(1)}%  ${k}`));
  await b.close();
})().catch((e) => {
  console.error('ERR', e);
  process.exit(1);
});
