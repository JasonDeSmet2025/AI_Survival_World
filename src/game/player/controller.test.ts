import { describe, expect, it } from 'vitest';
import type { InputController } from '../input';
import {
  LAKE,
  SEA_LEVEL,
  TERRAIN_SIZE,
  findSpawnPoint,
} from '../world/heightfield';
import { groundHeight } from './ground';
import { PlayerController } from './controller';

const DT = 1 / 60;
const SPAWN = findSpawnPoint();

function input(
  over: {
    forward?: number;
    strafe?: number;
    jumpHeld?: boolean;
    sprint?: boolean;
    crouch?: boolean;
  } = {},
): InputController {
  return {
    forward: 0,
    strafe: 0,
    jumpHeld: false,
    sprint: false,
    crouch: false,
    ...over,
  } as unknown as InputController;
}

function tick(c: PlayerController, n: number, inp: InputController, yaw = 0): void {
  for (let i = 0; i < n; i++) c.update(DT, inp, yaw, [], true, []);
}

/**
 * Scan for a deterministic steep drop in +x (a few metres down within 4 m)
 * used to verify ground-following and airborne/landing physics.
 */
function findCliff(): { x: number; z: number } {
  for (let z = -280; z <= 280; z += 8) {
    for (let x = -280; x <= 280; x += 8) {
      const h0 = groundHeight(x, z);
      const h1 = groundHeight(x + 4, z);
      if (h0 > 3 && h0 - h1 > 1.5) return { x, z };
    }
  }
  throw new Error('no cliff found in terrain');
}

/** Scan for a climbable but non-trivial uphill ramp in +x. */
function findRamp(): { x: number; z: number } {
  for (let z = -280; z <= 280; z += 4) {
    for (let x = -280; x <= 280; x += 4) {
      const h0 = groundHeight(x, z);
      const h1 = groundHeight(x + 4, z);
      if (h0 > 1 && h1 > h0 && (h1 - h0) / 4 >= 0.3 && (h1 - h0) / 4 <= 0.8) {
        return { x, z };
      }
    }
  }
  throw new Error('no climbable ramp found in terrain');
}

/** Scan for a deterministic steep uphill wall facing +x. */
function findSteepWall(): { x: number; z: number } {
  for (let z = -280; z <= 280; z += 6) {
    for (let x = -280; x <= 280; x += 6) {
      const h0 = groundHeight(x, z);
      const h1 = groundHeight(x + 1.5, z);
      if (h0 > 1 && (h1 - h0) / 1.5 > 1.25) return { x, z };
    }
  }
  throw new Error('no steep wall found in terrain');
}

describe('PlayerController ground interaction', () => {
  it('rests exactly on the rendered ground when idle', () => {
    const c = new PlayerController({ x: SPAWN.x, y: SPAWN.y, z: SPAWN.z });
    const startX = c.pos.x;
    const startZ = c.pos.z;
    tick(c, 60, input());
    expect(c.onGround).toBe(true);
    expect(Math.abs(c.pos.y - groundHeight(c.pos.x, c.pos.z))).toBeLessThan(1e-9);
    expect(c.pos.x).toBe(startX);
    expect(c.pos.z).toBe(startZ);
  });

  it('never sinks below the rendered ground while walking', () => {
    const c = new PlayerController({ x: SPAWN.x, y: SPAWN.y, z: SPAWN.z });
    const inp = input({ forward: 1 });
    for (let i = 0; i < 300; i++) {
      c.update(DT, inp, 0, [], true, []);
      const g = groundHeight(c.pos.x, c.pos.z);
      // Never below the surface (was the "sinking player" bug), and
      // never floating more than a step height above it either.
      expect(c.pos.y).toBeGreaterThanOrEqual(g - 1e-9);
      expect(Math.abs(c.pos.y - g)).toBeLessThan(0.05);
    }
    // Walk speed is intact.
    expect(c.speed).toBeCloseTo(5.2, 1);
  });

  it('walks uphill on a real ramp and stays glued to the surface', () => {
    const ramp = findRamp();
    const startY = groundHeight(ramp.x, ramp.z);
    const c = new PlayerController({ x: ramp.x, y: startY, z: ramp.z });
    // Yaw so that "forward" means +x.
    const yaw = -Math.PI / 2;
    for (let i = 0; i < 120; i++) {
      c.update(DT, input({ forward: 1 }), yaw, [], true, []);
      const g = groundHeight(c.pos.x, c.pos.z);
      // Never below the rendered surface (the old "sinking" bug), never
      // floating more than a step above it either.
      expect(c.pos.y).toBeGreaterThanOrEqual(g - 1e-9);
      expect(Math.abs(c.pos.y - g)).toBeLessThan(0.05);
    }
    // The ramp was actually climbed: physics follows the surface uphill.
    expect(c.pos.y - startY).toBeGreaterThan(0.3);
  });

  it('steep walls block uphill walking (slope gate)', () => {
    const wall = findSteepWall();
    const c = new PlayerController({
      x: wall.x,
      y: groundHeight(wall.x, wall.z),
      z: wall.z,
    });
    tick(c, 120, input({ forward: 1 }), -Math.PI / 2);
    // Two seconds of pushing into a >1.25 slope: almost no forward progress.
    expect(c.pos.x - wall.x).toBeLessThan(1.0);
    expect(c.pos.y).toBeGreaterThanOrEqual(groundHeight(c.pos.x, c.pos.z) - 1e-9);
  });

  it('jump arcs up and lands back exactly on the ground', () => {
    const c = new PlayerController({ x: SPAWN.x, y: SPAWN.y, z: SPAWN.z });
    tick(c, 10, input());
    tick(c, 20, input({ jumpHeld: true }));
    expect(c.onGround).toBe(false);
    expect(c.pos.y).toBeGreaterThan(groundHeight(c.pos.x, c.pos.z) + 0.5);
    tick(c, 240, input());
    expect(c.onGround).toBe(true);
    expect(Math.abs(c.pos.y - groundHeight(c.pos.x, c.pos.z))).toBeLessThan(1e-9);
  });

  it('follows the surface down a steep drop without floating or bouncing', () => {
    // NOTE: the island terrain has no walk-offable cliffs — the steepest
    // per-frame drop is below the ground-follow allowance — so a walking
    // player must stick to the surface the whole way down.
    const cliff = findCliff();
    const edgeY = groundHeight(cliff.x, cliff.z);
    const c = new PlayerController({ x: cliff.x, y: edgeY, z: cliff.z });
    for (let i = 0; i < 60; i++) {
      c.update(DT, input({ forward: 1 }), -Math.PI / 2, [], true, []);
      expect(c.onGround, 'must stay grounded while walking downhill').toBe(true);
      const g = groundHeight(c.pos.x, c.pos.z);
      expect(Math.abs(c.pos.y - g)).toBeLessThan(0.05);
    }
    // Actually descended the drop instead of floating at the edge height.
    expect(c.pos.y).toBeLessThan(edgeY - 0.5);
  });

  it('airborne fall lands exactly on the rendered ground', () => {
    const cliff = findCliff();
    const edgeY = groundHeight(cliff.x, cliff.z);
    // Player suspended 3 m above the cliff edge (as right after a jump
    // over a ledge): must be airborne, fall ballistically, and land on
    // the exact rendered surface.
    const c = new PlayerController({ x: cliff.x, y: edgeY + 3, z: cliff.z });
    tick(c, 1, input());
    expect(c.onGround).toBe(false);
    for (let i = 0; i < 120; i++) {
      c.update(DT, input(), 0, [], true, []);
      // Never below the ground under the player.
      expect(c.pos.y).toBeGreaterThanOrEqual(groundHeight(c.pos.x, c.pos.z) - 1e-9);
    }
    expect(c.onGround).toBe(true);
    expect(Math.abs(c.pos.y - groundHeight(c.pos.x, c.pos.z))).toBeLessThan(1e-9);
  });

  it('swimming stays between the lake floor and the water cap', () => {
    const c = new PlayerController({ x: LAKE.x, y: SEA_LEVEL, z: LAKE.z });
    tick(c, 120, input({ forward: 0.5 }));
    expect(c.inWater).toBe(true);
    const g = groundHeight(c.pos.x, c.pos.z);
    expect(c.pos.y).toBeGreaterThanOrEqual(g - 1e-9);
    expect(c.pos.y).toBeLessThanOrEqual(SEA_LEVEL + 0.9 + 1e-9);
  });

  it('keeps the player inside the island bounds', () => {
    const x = TERRAIN_SIZE / 2 - 6;
    const z = 0;
    const c = new PlayerController({ x, y: groundHeight(x, z), z });
    tick(c, 300, input({ forward: 1 }), -Math.PI / 2);
    expect(c.pos.x).toBeLessThanOrEqual(TERRAIN_SIZE / 2 - 2 + 1e-9);
    expect(c.pos.y).toBeGreaterThanOrEqual(groundHeight(c.pos.x, c.pos.z) - 1e-9);
  });

  it('crouch slows movement without leaving the ground', () => {
    const c = new PlayerController({ x: SPAWN.x, y: SPAWN.y, z: SPAWN.z });
    // The game shell drives the crouch state onto the controller each frame.
    c.crouching = true;
    tick(c, 120, input({ forward: 1 }), 0);
    expect(c.speed).toBeCloseTo(2.2, 1);
    expect(c.pos.y).toBeGreaterThanOrEqual(groundHeight(c.pos.x, c.pos.z) - 1e-9);
  });
});
