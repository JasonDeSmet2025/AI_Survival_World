/**
 * Browser verification for the server-authoritative multiplayer sync
 * (Multiplayer Agent). Boots the REAL game server (serves dist/ + /ws on
 * one port), opens two headless Chromium clients with ?mp and checks:
 *
 *  1. one harvest click = -1 hp on BOTH clients (B1 double-damage fix),
 *  2. the yield is granted ONLY to the harvester, same amount everywhere (B11),
 *  3. a remote player spawns at the joiner's reported position, not (0,0,0) (B9),
 *  4. a 'bed' placed over the wire is accepted by the server (B3) and the
 *     broadcast lands in both clients' world state,
 *  5. one chat message produces EXACTLY ONE WebSocket send and ZERO
 *     POST /api/chat calls (B4 double-LLM-call fix); with HOME=/tmp the
 *     server has no gateway key, so the reply settles as npc_error.
 *
 * Usage: node tools/scripts/mp-browser-check.mjs   (exit 0 = PASS)
 */
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;

function fail(msg) {
  console.error('FAIL:', msg);
  process.exitCode = 1;
  throw new Error(msg);
}

// The server process runs with HOME=/tmp so llmKey() finds no gateway key:
// chat must settle via npc_error WITHOUT any external LLM call.
const child = spawn(
  process.execPath,
  [new URL('../../server/server.mjs', import.meta.url).pathname],
  { env: { ...process.env, PORT: String(PORT), HOME: '/tmp', VIVES_LLM_KEY: '', BUSH_REGROW_MS: '5000' }, stdio: ['ignore', 'pipe', 'inherit'] },
);
child.stdout.on('data', (d) => {
  const m = /localhost:(\d+)/.exec(String(d));
  if (m) console.log(`server up on :${m[1]}`);
});

const shutdown = (code) => {
  child.kill('SIGTERM');
  process.exit(code);
};

try {
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server start timeout')), 8000);
    child.stdout.on('data', (d) => {
      if (/localhost:\d+/.test(String(d))) { clearTimeout(to); res(); }
    });
  });

  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  const ctxA = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const ctxB = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  const httpCalls = [];
  a.on('request', (r) => { if (r.url().includes('/api/chat')) httpCalls.push(r.url()); });
  b.on('request', (r) => { if (r.url().includes('/api/chat')) httpCalls.push(r.url()); });

  const pageErrors = [];
  for (const p of [a, b]) {
    p.on('pageerror', (e) => pageErrors.push(String(e)));
  }

  console.log('loading two MP clients (swiftshader — allow ~30s)...');
  await Promise.all([
    a.goto(`${BASE}/?mp`, { waitUntil: 'load' }),
    b.goto(`${BASE}/?mp`, { waitUntil: 'load' }),
  ]);
  for (const p of [a, b]) {
    await p.waitForFunction(() => window.__game && window.__game.mp && window.__game.mp.status === 'connected', null, { timeout: 120000 });
  }
  console.log('both clients connected (hello received, server-authoritative)');

  // Instrument A's raw WS traffic so we can count frames the client sends.
  await a.evaluate(() => {
    const g = window.__game;
    window.__sent = [];
    const ws = g.mp.ws;
    const orig = ws.send.bind(ws);
    ws.send = (d) => { window.__sent.push(String(d)); orig(d); };
  });

  // Wait until B is visible to A (joined broadcast).
  await a.waitForFunction(() => window.__game.remotes.size >= 1, null, { timeout: 15000 });

  // (3) B9: remote avatar at the server-reported spawn (0,5,0), NOT (0,0,0).
  const remotePos = await a.evaluate(() => {
    const r = [...window.__game.remotes.values()][0];
    return [r.mesh.position.x, r.mesh.position.y, r.mesh.position.z];
  });
  if (remotePos[1] !== 5) fail(`remote spawn y must be the joiner's y (5), got ${JSON.stringify(remotePos)} (B9)`);
  console.log('OK B9: remote joins at (0,5,0), not the world origin');

  // (1)+(2) harvest sync on a REAL world node.
  const nodeId = await a.evaluate(
    () => window.__game.world.nodes.find((n) => n.kind === 'tree' && !window.__game.world.isDepleted(n.id)).id,
  );
  const woodBefore = await Promise.all([
    a.evaluate((id) => window.__game.inventory.count(id), 'wood'),
    b.evaluate((id) => window.__game.inventory.count(id), 'wood'),
  ]);
  const hp = await a.evaluate(
    (id) => ({ max: window.__game.world.node(id).maxHp, hp: window.__game.world.hp[id] }),
    nodeId,
  );
  // Drive the same call updateGathering makes when MP is connected.
  await a.evaluate((id) => window.__game.mp.sendHarvest(id, 0), nodeId);
  await a.waitForTimeout(700);
  const afterHp = await Promise.all([
    a.evaluate((id) => window.__game.world.hp[id], nodeId),
    b.evaluate((id) => window.__game.world.hp[id], nodeId),
  ]);
  if (afterHp[0] !== hp.hp - 1 || afterHp[1] !== hp.hp - 1) {
    fail(`one harvest must cost exactly 1 hp on BOTH clients (B1), before=${hp.hp} after=${JSON.stringify(afterHp)}`);
  }
  const woodAfter = await Promise.all([
    a.evaluate((id) => window.__game.inventory.count(id), 'wood'),
    b.evaluate((id) => window.__game.inventory.count(id), 'wood'),
  ]);
  const gainedA = woodAfter[0] - woodBefore[0];
  const gainedB = woodAfter[1] - woodBefore[1];
  if (gainedA < 2 || gainedA > 3 || gainedB !== 0) {
    fail(`yield must go ONLY to the harvester in [2,3]: A +${gainedA}, B +${gainedB} (B11)`);
  }
  console.log(`OK B1/B11: hp ${hp.hp}->${afterHp[0]} on both, wood A +${gainedA}, B +${gainedB}`);

  // (4) bed over the wire (B3) lands in both world states.
  const bedId = 'b_browser_bed_1';
  await a.evaluate((id) => window.__game.mp.sendPlace('bed', 7, 3, 2, 0, id), bedId);
  for (const [name, p] of [['A', a], ['B', b]]) {
    await p.waitForFunction(
      (id) => !!window.__game.world.building(id),
      bedId,
      { timeout: 5000 },
    ).catch(() => fail(`bed ${bedId} missing in client ${name}`));
  }
  console.log('OK B3: server accepts a bed and broadcasts it to both clients');

  // (5) one chat message = one WS frame, zero HTTP /api/chat.
  await a.evaluate(() => {
    const g = window.__game;
    g.activeNpc = g.npcs[0];
    void g.sendChat('Hallo, alles goed?');
  });
  await a.waitForFunction(() => window.__game.pendingChat === null, null, { timeout: 15000 });
  const chatFrames = await a.evaluate(() => window.__sent.filter((s) => s.includes('"t":"chat"')).length);
  if (chatFrames !== 1) fail(`exactly one chat WS frame expected, got ${chatFrames} (B4)`);
  if (httpCalls.length !== 0) fail(`no POST /api/chat may fire while MP is connected, got ${httpCalls.length} (B4)`);
  console.log('OK B4: one chat message -> 1 WS frame, 0 HTTP /api/chat, pendingChat settled');

  if (pageErrors.length) fail(`page errors during verification: ${pageErrors.join(' | ')}`);

  await browser.close();
  console.log(process.exitCode ? 'MP BROWSER CHECK: FAIL' : 'MP BROWSER CHECK: PASS');
} catch (e) {
  console.error(e);
  shutdown(1);
}
shutdown(0);
