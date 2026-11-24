/**
 * Tower climb regression — geometry + physics.
 *
 * The original switchback centred every flight in the room: the walk-on
 * edge sat 0.8 m from the wall and the walkable centre band (wall push-out
 * eats 0.42 m of it) started at ~1.2 m. Any approach a few degrees off
 * pinned the player in the corner before step one — the reported
 * "haperingen". The flights are now SHIFTED forward (top edge flush with
 * the inner wall, bottom edge with 1.6 m of open floor) and the band is
 * 2.0 m wide. This file pins that geometry down AND simulates a walk-up
 * with the real player controller.
 */
import { describe, expect, it } from 'vitest';
import {
  TOWER_INNER,
  TOWER_LEVEL_H,
  towerSite,
  towerSlabs,
  towerStairFlight,
  towerStairs,
  towerWalls,
} from './tower';
import { PlayerController } from '../player/controller';
import { groundHeight } from '../player/ground';

describe('tower stair geometry', () => {
  const site = towerSite();

  it('flights leave open floor below and meet the wall above', () => {
    for (let f = 0; f < 3; f++) {
      const fl = towerStairFlight(site, f);
      if (fl.dir === 1) {
        // Climbs +z: bottom edge with open floor in front, top edge flush.
        expect(fl.z0).toBeCloseTo(-TOWER_INNER + 1.2, 6);
        expect(fl.z1).toBeCloseTo(TOWER_INNER, 6);
      } else {
        expect(fl.z0).toBeCloseTo(-TOWER_INNER, 6);
        expect(fl.z1).toBeCloseTo(TOWER_INNER - 1.2, 6);
      }
      // Band wide enough that the 0.42 m wall push-out still leaves > 1.5 m.
      expect(fl.x1 - fl.x0).toBeGreaterThanOrEqual(2.0);
    }
  });

  it('no zero-area slab pieces', () => {
    for (const s of towerSlabs(site)) {
      expect(s.maxX - s.minX).toBeGreaterThan(0.01);
      expect(s.maxZ - s.minZ).toBeGreaterThan(0.01);
    }
  });

  it('every flight surface starts and ends exactly at its floor levels', () => {
    for (const st of towerStairs(site)) {
      // top = mid-height of the flight → flight index f = level below the top.
      const f = Math.round((st.top - site.baseY) / TOWER_LEVEL_H - 0.5);
      const fl = towerStairFlight(site, f);
      const lo = fl.dir === 1 ? st.minZ : st.maxZ;
      const surf = (z: number) => st.top + st.slopeZ * (z - st.refZ);
      expect(surf(lo)).toBeCloseTo(site.baseY + f * TOWER_LEVEL_H, 6);
      expect(surf(fl.dir === 1 ? st.maxZ : st.minZ)).toBeCloseTo(site.baseY + (f + 1) * TOWER_LEVEL_H, 6);
    }
  });
});

/**
 * Bot that walks like a player aiming at where it wants to go: yaw is
 * recomputed every frame toward the current waypoint. Returns the frame it
 * finished on (or -1) and whether it ever wall-pinned for > 1.5 s.
 */
function walkRoute(
  c: InstanceType<typeof PlayerController>,
  site: { x: number; z: number; baseY: number },
  wp: Array<{ x: number; z: number }>,
): { done: boolean; maxStuck: number; maxY: number } {
  const walls = towerWalls(site as never) as never[];
  const platforms = [...towerSlabs(site as never), ...towerStairs(site as never)] as never[];
  const input = { forward: 1, strafe: 0, sprint: false, jumpHeld: false };
  const dt = 1 / 60;
  let wi = 0;
  let stuck = 0;
  let maxStuck = 0;
  let maxY = 0;
  let last = { x: c.pos.x, z: c.pos.z };
  for (let f = 0; f < 60 * 120 && wi < wp.length; f++) {
    const target = { x: site.x + wp[wi].x, z: site.z + wp[wi].z };
    const dx = target.x - c.pos.x;
    const dz = target.z - c.pos.z;
    if (Math.hypot(dx, dz) < 0.3) {
      wi++;
      continue;
    }
    c.update(dt, input as never, Math.atan2(dx, dz), [], false, walls, platforms, true);
    if (Math.hypot(c.pos.x - last.x, c.pos.z - last.z) < 0.004 && c.speed > 1) stuck += dt;
    else stuck = Math.max(0, stuck - dt * 2);
    maxStuck = Math.max(maxStuck, stuck);
    maxY = Math.max(maxY, c.pos.y - site.baseY);
    last = { x: c.pos.x, z: c.pos.z };
  }
  return { done: wi >= wp.length, maxStuck, maxY };
}

describe('tower walk-up simulation', () => {
  const site = towerSite();

  it('a waypoint bot reaches the top floor without getting stuck', () => {
    const c = new PlayerController({ x: site.x, y: site.baseY, z: site.z - 1.2 });
    c.pos.y = groundHeight(c.pos.x, c.pos.z);
    const { done, maxStuck, maxY } = walkRoute(c, site, [
      { x: 2.0, z: -2.2 }, // foot of flight 0 (east, climbs +z)
      { x: 2.4, z: 2.6 }, // up to the top of the flight (wall's edge)
      { x: 0.4, z: 2.55 }, // step left onto floor 1's slab
      { x: -2.0, z: 1.3 }, // foot of flight 1 (west, climbs -z)
      { x: -2.4, z: -2.6 }, // top of flight 1
      { x: -0.4, z: -2.55 }, // onto floor 2's slab
      { x: 2.0, z: -1.3 }, // foot of flight 2
      { x: 2.4, z: 2.6 }, // top of flight 2
      { x: 0.4, z: 2.55 }, // onto the strongbox floor
    ]);
    expect(maxStuck).toBeLessThan(1.5);
    expect(done).toBe(true);
    expect(maxY).toBeGreaterThanOrEqual(3 * TOWER_LEVEL_H - 0.05); // top floor
  });

  it('a straight walk from the door reaches the stairs, not a corner', () => {
    // The classic user flow: enter through the west door, aim at the first
    // visible step, hold W. Before the fix this pinned at the wall corner.
    const c = new PlayerController({ x: site.x - 2.5, y: site.baseY, z: site.z - 0.2 });
    c.pos.y = groundHeight(c.pos.x, c.pos.z);
    const { done, maxStuck, maxY } = walkRoute(c, site, [
      { x: 2.0, z: -1.4 }, // first step, dead centre of the band
      { x: 2.4, z: 2.6 }, // straight up the flight
      { x: 0.4, z: 2.55 }, // onto floor 1
    ]);
    expect(maxStuck).toBeLessThan(1.5);
    expect(done).toBe(true);
    expect(maxY).toBeGreaterThanOrEqual(TOWER_LEVEL_H - 0.05); // reached floor 1
  });
});
