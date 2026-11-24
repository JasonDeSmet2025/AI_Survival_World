const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--no-sandbox','--use-gl=angle','--use-angle=swiftshader'] });
  const p = await b.newPage({ viewport: { width: 900, height: 560 } });
  await p.goto('http://localhost:8080/', { waitUntil: 'networkidle' });
  await p.evaluate(() => { const g=window.__game; if (g && typeof g.startSolo==='function') g.startSolo(); });
  await p.waitForTimeout(6000);
  await p.evaluate(() => { const g=window.__game; g.inventory.add('stone_axe',1); g.inventory.add('stone_pick',1);
    // show the axe in hand via the game's own equip path
    const idx = g.inventory.slots.findIndex(s=>s&&s.id==='stone_axe');
    g.inventory.selected = idx;
    try { g.cameraRadius = 2.6; } catch{}
  });
  await p.waitForTimeout(5000);
  await p.screenshot({ path: '/tmp/held_axe.png', timeout: 120000 });
  await p.evaluate(() => { const g=window.__game; const idx=g.inventory.slots.findIndex(s=>s&&s.id==='stone_pick'); g.inventory.selected = idx; });
  await p.waitForTimeout(4000);
  await p.screenshot({ path: '/tmp/held_pick.png', timeout: 120000 });
  console.log('shots ok');
  await b.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
