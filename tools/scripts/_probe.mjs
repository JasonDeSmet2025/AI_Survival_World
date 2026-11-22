import { chromium } from '@playwright/test';
const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const p = await b.newPage();
p.on('console', (m) => console.log('[page]', m.type(), m.text().slice(0, 200)));
p.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await p.goto('http://127.0.0.1:3199/?mp', { waitUntil: 'load' });
for (let i = 0; i < 12; i++) {
  await p.waitForTimeout(5000);
  const s = await p.evaluate(() => ({
    g: !!window.__game,
    mp: window.__game ? window.__game.mp?.status : null,
    url: window.__game ? String(window.__game.mpUrl) : null,
  })).catch((e) => ({ err: String(e).slice(0, 120) }));
  console.log(i, JSON.stringify(s));
  if (s.mp === 'connected') break;
}
await b.close();
