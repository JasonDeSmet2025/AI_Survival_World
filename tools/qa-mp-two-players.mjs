/**
 * Multiplayer QA: two real headless browsers in ONE world.
 *
 * Unit tests can prove the wire format; only two browsers can prove that a
 * second person is actually visible, moving, named and sharing the same sky.
 * Boots the real game server (with a temp state file) + the real Vite dev
 * server, opens two pages, and drives them through the same inputs a player
 * would use (keyboard).
 *
 * Usage:  node tools/qa-mp-two-players.mjs
 * Env:    BASE_URL=http://host:port  (reuse a running stack instead)
 *         HEADED=1 for a visible browser
 */
import { chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const stateFile = path.join(os.tmpdir(), `asw-qa-${process.pid}.json`);

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass, detail: String(detail).slice(0, 200) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

async function waitFor(check2, ms = 15000, label = 'condition') {
  const t0 = Date.now();
  for (;;) {
    if (await check2()) return true;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + label);
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function start(cmd, args, env, ready) {
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('start timeout')), 60000);
    const onData = (buf) => {
      const hit = ready(String(buf));
      if (hit) {
        clearTimeout(to);
        resolve(hit);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (c) => {
      clearTimeout(to);
      reject(new Error('exited early ' + c));
    });
  });
  return { child, url };
}

/**
 * Hold a movement key until the player has actually travelled `want` metres.
 * A fixed-time hold cannot work here: game dt is clamped to 0.05 s per frame,
 * so on a slow (software-GL) browser the same key hold covers less ground.
 */
async function walkBy(page, want, code = 'KeyW', budgetMs = 60000) {
  const pos = () => page.evaluate(() => window.__game.controller.pos.asArray());
  const start = await pos();
  await page.evaluate((c) => window.dispatchEvent(new KeyboardEvent('keydown', { code: c, bubbles: true })), code);
  let now = start;
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 350));
    now = await pos();
    const d = Math.hypot(now[0] - start[0], now[2] - start[2]);
    if (d >= want || Date.now() - t0 > budgetMs) break;
  }
  await page.evaluate((c) => window.dispatchEvent(new KeyboardEvent('keyup', { code: c, bubbles: true })), code);
  return { dist: Math.hypot(now[0] - start[0], now[2] - start[2]), at: now };
}

/** Click the canvas the way a player does to capture the mouse. */
async function grabPointerLock(page) {
  await page
    .locator('canvas')
    .first()
    .click({ position: { x: 300, y: 180 }, noWaitAfter: true, force: true })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 700));
  return page.evaluate(() => document.pointerLockElement?.tagName === 'CANVAS');
}

/** Look around with real mouse moves (input.ts ignores them without lock). */
async function turnWithMouse(page, pixels) {
  const box = await page.locator('canvas').first().boundingBox();
  const cx = Math.round(box.x + box.width / 2);
  const cy = Math.round(box.y + box.height / 2);
  for (let i = 0; i < 10; i++) {
    await page.mouse.move(cx + Math.round((pixels / 10) * (i + 1)), cy);
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 500));
}

/** Point A's camera at the other player so the nametag is in the frustum. */
async function lookAtRemote(page) {
  await page.evaluate(() => {
    const g = window.__game;
    const id = g.avatars.ids()[0];
    const pose = g.avatars.poseOf(id);
    if (!pose) return;
    const cam = g.scene.activeCamera;
    cam.rotation.y = Math.atan2(pose.x - cam.position.x, pose.z - cam.position.z);
    cam.rotation.x = -0.05;
  });
  await new Promise((r) => setTimeout(r, 900));
}

/** A free TCP port: hard-coding 3000 made a leftover server from an earlier
run answer /health and then starve this one. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/**
 * Pause / resume a page's render loop through PUBLIC Babylon APIs (the pattern
 * this project's QA hooks already use). In a software-GL browser a running
 * scene costs about a full CPU core, so a second page that boots while the
 * first is rendering takes minutes — and every timing assertion then fails
 * for reasons that have nothing to do with multiplayer. The WebSocket keeps
 * running while paused (the server sends the keepalive pings), so a paused
 * page is still a player in the world.
 */
const pausePage = (page) => page.evaluate(() => window.__game.engine.stopRenderLoop());
const resumePage = (page) =>
  page.evaluate(() => window.__game.engine.runRenderLoop(() => window.__game.scene.render()));

const T0 = Date.now();
const step = (m) => console.log(`  .. +${((Date.now() - T0) / 1000).toFixed(1)}s ${m}`);

const hold = async (page, code, ms) => {
  await page.evaluate((c) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: c, bubbles: true }));
  }, code);
  await new Promise((r) => setTimeout(r, ms));
  await page.evaluate((c) => {
    window.dispatchEvent(new KeyboardEvent('keyup', { code: c, bubbles: true }));
  }, code);
};

async function main() {
  let game = null;
  let base = process.env.BASE_URL;
  try {
    if (!base) {
      // The game server serves dist/ AND /ws on one port — the same thing a
      // user gets from `npm start`, so this run tests that setup rather than
      // a dev proxy.
      // Always rebuild: QA reading a stale dist is how a green run lies about
      // the code you just changed. Set SKIP_BUILD=1 to reuse what is there.
      if (process.env.SKIP_BUILD !== '1') {
        const b = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', encoding: 'utf8' });
        if (b.status !== 0) throw new Error('npm run build failed\n' + (b.stderr || b.stdout || '').slice(-2000));
      }
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      step(`booting game server on free port ${port}`);
      game = await start(
        'node',
        ['server/server.mjs'],
        { PORT: String(port), MP_STATE_FILE: stateFile, NAME_SECRET: 'qa-secret', BUSH_REGROW_MS: '900000' },
        () => base,
      );
      // Prove the HTTP side is alive before blaming the browser for a slow load.
      const ping = await fetch(base + '/health').then((r) => r.text()).catch((e) => 'HEALTH FAIL ' + e.message);
      step('server answered /health: ' + ping.slice(0, 80));
    }

    // 640x400 + swiftshader: at 1100x720 on the host GL driver this game runs
    // at ~1 fps, and a 1 fps page makes EVERY timing-based assertion below
    // wrong (dt is clamped to 0.05 s, so one second of held keys moves the
    // player centimetres). Keep the browser cheap so we test the multiplayer,
    // not the software rasteriser.
    step('launching browser');
    let browser = await chromium.launch({
      headless: !process.env.HEADED,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
    });
    const ctxA = await browser.newContext({ viewport: { width: 640, height: 400 } });
    const ctxB = await browser.newContext({ viewport: { width: 640, height: 400 } });
    const A = await ctxA.newPage();
    const B = await ctxB.newPage();
    for (const [name, p] of [['A', A], ['B', B]]) {
      p.on('pageerror', (e) => console.log(`[pageerror ${name}]`, e.message));
      p.on('console', (m) => {
        if (m.type() === 'error') console.log(`[console ${name}]`, m.text().slice(0, 200));
      });
    }

    // Two separate browser profiles = two people who never met before.
    step('goto A');
    await A.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await A.waitForFunction(() => window.__game?.mp?.status === 'connected', null, { timeout: 60000 });
    step('A connected — freezing it so B can boot without CPU starvation');
    await pausePage(A);
    step('goto B');
    await B.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await B.waitForFunction(() => window.__game?.mp?.status === 'connected', null, { timeout: 60000 });
    step('B connected — resuming A');
    await resumePage(A);
    await new Promise((r) => setTimeout(r, 1500));
    step('both pages live');
    await waitFor(async () => (await A.evaluate(() => !!window.__game)) && (await B.evaluate(() => !!window.__game)), 40000, 'game boot');

    // 1) Multiplayer must be ON without the player knowing a secret flag.
    const connected = await Promise.all([
      A.waitForFunction(() => window.__game.mp?.status === 'connected', null, { timeout: 30000 }).then(() => true).catch(() => false),
      B.waitForFunction(() => window.__game.mp?.status === 'connected', null, { timeout: 30000 }).then(() => true).catch(() => false),
    ]);
    check('MP connects by default (no ?mp flag knowledge needed)', connected[0] && connected[1], JSON.stringify(connected));

    // 2) Durable identity: a token exists and survives a reload.
    const tokA = await A.evaluate(() => window.__game.mp.identityToken);
    check('persistent player token issued', typeof tokA === 'string' && tokA.length >= 8, tokA?.slice(0, 12) + '…');

    // 3) Each sees the other in the roster.
    await waitFor(async () => (await A.evaluate(() => window.__game.avatars.size)) === 1 && (await B.evaluate(() => window.__game.avatars.size)) === 1, 15000, 'both players appear in each other roster');
    const roster = await A.evaluate(() => {
      const g = window.__game;
      const id = g.avatars.ids()[0];
      const pose = g.avatars.poseOf(id);
      return {
        ids: g.avatars.ids(),
        names: g.avatars.roster().map((r) => r.name),
        players: document.querySelector('.mp-players')?.textContent || '',
        status: document.querySelector('.mp-status')?.textContent || '',
        meshes: pose ? pose.meshes : -1,
      };
    });
    check(
      'roster shows the other player by name (HUD)',
      roster.names.length === 1 && roster.players.includes(roster.names[0]),
      JSON.stringify({ players: roster.players, names: roster.names }),
    );
    check('HUD status counts everyone in the world', /2 spelers/.test(roster.status), roster.status);
    check(
      'remote player has a real body (not a grey capsule)',
      roster.meshes >= 10,
      `child meshes: ${roster.meshes}`,
    );

    // 4) The remote avatar is NAMED above its head.
    await lookAtRemote(A);
    const tag = await A.evaluate(() => {
      const el = document.querySelector('.mp-tags .mp-tag');
      return el ? { text: el.textContent, display: el.style.display, transform: el.style.transform } : null;
    });
    check(
      'nametag is projected onto the screen above the remote player',
      !!tag && !!tag.text && tag.display === 'block' && /translate\(.*px,.*px\)/.test(tag.transform || ''),
      JSON.stringify(tag),
    );

    // 5) Walking actually moves the other person's view (with rotation).
    const otherOnB = await B.evaluate(() => window.__game.avatars.ids()[0]);
    const before = await B.evaluate((id) => window.__game.avatars.poseOf(id), otherOnB);
    const walked = await walkBy(A, 3.5);
    await new Promise((r) => setTimeout(r, 1200));
    const after = await B.evaluate((id) => window.__game.avatars.poseOf(id), otherOnB);
    check('walking moves the local player', walked.dist > 3, `${walked.dist.toFixed(2)} m walked`);
    // Now turn with the MOUSE (the real look controls need pointer lock) and
    // walk again: the avatar must face the new direction instead of sliding
    // sideways forever, which is what "multiplayer looks broken" usually is.
    const yawBefore = await A.evaluate(() => window.__game.charYaw);
    const locked = await grabPointerLock(A);
    await turnWithMouse(A, 260); // ~a quarter turn, depends on sensitivity
    const yawAfter = await A.evaluate(() => window.__game.charYaw);
    check('mouse look turns the local player', locked && Math.abs(yawAfter - yawBefore) > 0.4, `lock=${locked} yaw ${yawBefore.toFixed(2)} -> ${yawAfter.toFixed(2)}`);
    const turned = await walkBy(A, 2.5);
    await new Promise((r) => setTimeout(r, 1800));
    const turnedPose = await B.evaluate((id) => window.__game.avatars.poseOf(id), otherOnB);
    check(
      'remote avatar turns to face where its player walked',
      turned.dist > 2 && Math.abs(turnedPose.target.r - before.target.r) > 0.4 && Math.abs(turnedPose.yaw - turnedPose.target.r) < 0.6,
      `walked ${turned.dist.toFixed(2)} m, facing ${turnedPose.target.r.toFixed(2)}, rendered yaw ${turnedPose.yaw.toFixed(2)}`,
    );
    const travelled = Math.hypot(after.target.x - before.target.x, after.target.z - before.target.z);
    check(
      'position streams to the other player',
      travelled > 2.5,
      `server-side travel ${travelled.toFixed(2)} m (A is at ${walked.at[0].toFixed(1)},${walked.at[2].toFixed(1)})`,
    );
    const gap = Math.hypot(after.x - after.target.x, after.z - after.target.z);
    check('rendered avatar follows the stream instead of staying put', gap < 3, `gap ${gap.toFixed(2)} m`);
    check('remote avatar plays its walk animation', after.speed > 0.2, `speed=${after.speed.toFixed(2)} m/s`);

    // 6) Building in one world appears in the other.
    await A.evaluate(() => window.__game.mp.sendPlace('wall', 14, -22, 3, 1, 'b_qa_wall'));
    await waitFor(async () => await B.evaluate(() => window.__game.world.buildings.some((b) => b.id === 'b_qa_wall')), 10000, 'wall replicated');
    // BuildingRenderer names meshes by kind (`building_wall_root`), not by
    // building id, so match on the position the mesh was built at.
    const wallMesh = await B.evaluate(() =>
      window.__game.scene.meshes.filter((m) => {
        const p = m.getAbsolutePosition();
        return m.name.startsWith('building_wall') && Math.hypot(p.x - 14, p.z - -22) < 2.5;
      }).length,
    );
    check('a built wall appears in the other world (mesh too)', wallMesh > 0, `${wallMesh} meshes at (14,-22)`);

    // 7) Harvesting is shared and yields once.
    const nodeId = await A.evaluate(() => {
      const g = window.__game;
      const n = g.world.nodes.find((x) => x.kind === 'tree' && !g.world.depleted.has(x.id));
      return n ? n.id : null;
    });
    const hpBefore = await B.evaluate((id) => window.__game.world.hp[id], nodeId);
    const bWoodBefore = await B.evaluate(() => window.__game.inventory.count('wood'));
    await A.evaluate((id) => window.__game.mp.sendHarvest(id, 0), nodeId);
    await waitFor(async () => (await B.evaluate((id) => window.__game.world.hp[id], nodeId)) < hpBefore, 8000, 'harvest replicated');
    const bYielded = await B.evaluate(() => window.__game.inventory.count('wood'));
    check(
      'harvest damage replicates without giving the other player items',
      bYielded === bWoodBefore,
      `B wood ${bWoodBefore} -> ${bYielded}`,
    );

    // 8) The campfire belongs to the world, not to the person poking it.
    await A.evaluate(() => {
      window.__game.inventory.add('wood', 20);
      window.__game.mp.sendPlace('campfire', 6, 6, 0, 0, 'b_qa_fire');
    });
    await waitFor(async () => await B.evaluate(() => window.__game.world.buildings.some((b) => b.id === 'b_qa_fire')), 8000, 'campfire replicated');
    await A.evaluate(() => {
      const g = window.__game;
      const b = g.world.buildings.find((x) => x.id === 'b_qa_fire');
      b.fuel = 300;
      g.mp.sendFuel('b_qa_fire', 300);
    });
    await waitFor(async () => (await B.evaluate(() => window.__game.world.buildings.find((b) => b.id === 'b_qa_fire')?.fuel)) === 300, 8000, 'fuel replicated');
    check('feeding the shared campfire feeds everyone', true, 'B sees fuel=300');

    // 9) One person sleeping moves EVERYONE's sky.
    const tBefore = await B.evaluate(() => window.__game.lighting.timeOfDay);
    await A.evaluate(() => window.__game.mp.sendSleep());
    await waitFor(async () => Math.abs((await B.evaluate(() => window.__game.lighting.timeOfDay)) - 0.25) < 0.02, 12000, 'shared morning');
    const tAfter = await B.evaluate(() => window.__game.lighting.timeOfDay);
    check('sleeping moves the shared day/night clock', Math.abs(tAfter - 0.25) < 0.02 && tBefore !== tAfter, `${tBefore.toFixed(3)} -> ${tAfter.toFixed(3)}`);

    // 10) Names: rename in A, B sees it in roster and nametag.
    await A.fill('.mp-name', 'QA-Robin');
    await A.press('.mp-name', 'Enter');
    await waitFor(async () => (await A.evaluate(() => window.__game.mp.name)) === 'QA-Robin', 6000, 'rename sent');
    await waitFor(async () => (await B.evaluate((id) => window.__game.avatars.nameOf(id), otherOnB)) === 'QA-Robin', 30000, 'rename broadcast');
    const tagAfter = await B.evaluate(() => document.querySelector('.mp-tags .mp-tag')?.textContent);
    check('renaming updates every other player (roster + nametag)', tagAfter === 'QA-Robin', tagAfter);

    // 11) Chat in multiplayer goes through the server and shows the asker.
    await A.evaluate(() => {
      window.__game.mp.sendChat({ id: 'npc_qa', name: 'QA-Gast', personality: 'gast' }, 'hallo iedereen');
    });
    let chatLines = [];
    try {
      await waitFor(async () => {
        chatLines = await A.evaluate(() => [...document.querySelectorAll('.chat-log .chat-line')].map((l) => l.textContent));
        return chatLines.length > 0;
      }, 25000, 'an NPC answer');
    } catch {
      /* no gateway configured in this run: the line below reports it */
    }
    // No LLM gateway in a CI run: the server still answers with npc_error,
    // which proves the message travelled the multiplayer route (the only route
    // while connected) and landed in the HUD. The cross-player byline
    // ("tegen <naam>") is asserted on B only when a real reply came back.
    const bChatLines = await B.evaluate(() => [...document.querySelectorAll('.chat-log .chat-line')].map((l) => l.textContent));
    check(
      'multiplayer chat reaches the NPC layer and lands in the HUD',
      chatLines.length > 0,
      chatLines.slice(-1).join(' | ') || 'no line at all',
    );
    check(
      'an NPC answer is shared with the other player and says who asked',
      bChatLines.some((l) => /tegen /.test(l)) || !process.env.LLM_API_KEY,
      bChatLines.slice(-1).join(' | ') || 'no broadcast line (no gateway configured — skipped)',
    );

    // 12) Reload with the same identity: progress must come back.
    await A.evaluate(() => {
      const g = window.__game;
      g.inventory.add('stone_axe', 1);
      g.stats.hunger = 44;
      g.persist();
    });
    await new Promise((r) => setTimeout(r, 1200));
    const tokBefore = await A.evaluate(() => window.__game.mp.identityToken);
    await pausePage(B); // B's scene would eat the CPU A needs to boot again
    await A.reload({ waitUntil: 'domcontentloaded', timeout: 150000 });
    await waitFor(async () => await A.evaluate(() => !!window.__game && window.__game.mp?.status === 'connected'), 60000, 'reconnect after reload');
    // 'connected' is the socket, not the world: hello (buildings + your bag)
    // lands a little later, and on a slow browser "a second" is several frames.
    await waitFor(async () => await A.evaluate(() => window.__game.world.buildings.some((b) => b.id === 'b_qa_wall')), 40000, 'shared world restored');
    const afterReload = await A.evaluate(() => ({
      axe: window.__game.inventory.count('stone_axe'),
      hunger: Math.round(window.__game.stats.hunger),
      fire: window.__game.world.buildings.find((b) => b.id === 'b_qa_fire')?.fuel,
      wall: window.__game.world.buildings.some((b) => b.id === 'b_qa_wall'),
      status: document.querySelector('.mp-status')?.textContent,
      token: window.__game.mp.identityToken,
    }));
    check('reload keeps your progress in multiplayer', afterReload.axe >= 1 && afterReload.hunger === 44, JSON.stringify(afterReload));
    check('reload keeps the shared world (buildings + fire)', afterReload.wall && afterReload.fire > 0, JSON.stringify(afterReload));
    check('reload reclaims the same identity', afterReload.token === tokBefore, `${tokBefore.slice(0, 8)}…`);
    await resumePage(B);

    // Freeze both render loops before opening more pages. Software WebGL in
    // this environment costs ~1 CPU core per running scene; without this the
    // third and fourth pages starve and time out for reasons that have
    // nothing to do with multiplayer. Their WebSocket stays open (the server
    // keeps them alive with its own pings), so they are still "in the world".
    await A.evaluate(() => window.__game.engine.stopRenderLoop());
    await B.evaluate(() => window.__game.engine.stopRenderLoop());
    step('A and B render loops frozen (still connected)');

    // 13) ?solo=1 must still be a working single-player game (the opt-out
    // that exists so a broken server can never lock people out of the game).
    const soloCtx = await browser.newContext({ viewport: { width: 640, height: 400 } });
    const S = await soloCtx.newPage();
    await S.goto(`${base}/?solo=1`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await waitFor(async () => await S.evaluate(() => !!window.__game), 120000, 'solo boot');
    const solo = await S.evaluate(() => ({
      status: document.querySelector('.mp-status')?.textContent || '',
      mp: window.__game.mp ? window.__game.mp.status : 'none',
      daylight: window.__game.lighting.timeOfDay,
    }));
    await new Promise((r) => setTimeout(r, 3000));
    const soloLater = await S.evaluate(() => window.__game.lighting.timeOfDay);
    check(
      'solo mode still plays (mp off, sun still moves)',
      solo.mp !== 'connected' && /solo/i.test(solo.status) && Math.abs(soloLater - solo.daylight) > 1e-6,
      JSON.stringify({ ...solo, later: +soloLater.toFixed(6) }),
    );

    await A.screenshot({ path: '/tmp/qa-mp-A.png' });
    await B.screenshot({ path: '/tmp/qa-mp-B.png' });

    // 14) A third person joining must see the two already there.
    const ctxC = await browser.newContext({ viewport: { width: 640, height: 400 } });
    const C = await ctxC.newPage();
    await resumePage(A); // the third player must see two LIVE players
    await resumePage(B);
    await C.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitFor(async () => await C.evaluate(() => window.__game?.avatars.ids().length === 2), 90000, 'third player sees both');
    const cRoster = await C.evaluate(() => window.__game.avatars.roster().map((r) => r.name));
    check('a third player sees everyone already in the world', cRoster.length === 2, cRoster.join(', '));

    await browser.close();
    browser = null;
  } catch (err) {
    check('QA script completed', false, err?.message || String(err));
  } finally {
    // A leaked browser is how the next run finds its port taken and its pages
    // starved by a stranger's render loop.
    try {
      await browser?.close();
    } catch {}
    game?.child.kill('SIGKILL');
    try {
      fs.unlinkSync(stateFile);
    } catch {}
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} QA checks passed`);
  console.log(JSON.stringify({ checks: results, failed: failed.length }, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main();
