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

describe('PlayerController sprint', () => {
  it('sprints at 9.2 m/s when the gate is open and reports sprinting', () => {
    const c = new PlayerController({ x: SPAWN.x, y: SPAWN.y, z: SPAWN.z });
    tick(c, 300, input({ forward: 1, sprint: true }));
    expect(c.sprinting).toBe(true);
    expect(c.speed).toBeCloseTo(9.2, 1);
    expect(c.pos.y).toBeGreaterThanOrEqual(groundHeight(c.pos.x, c.pos.z) - 1e-9);
  });

  it('does not sprint when the canSprint gate is closed (walks instead)', () => {
    const c = new PlayerController({ x: SPAWN.x, y: SPAWN.y, z: SPAWN.z });
    // canSprint=false (last update arg): the sprint request is ignored and
    // the sprinting flag stays false, so no stamina drain can occur.
    for (let i = 0; i < 300; i++) c.update(DT, input({ forward: 1, sprint: true }), 0, [], false, []);
    expect(c.sprinting).toBe(false);
    expect(c.speed).toBeCloseTo(5.2, 1); // walking, not sprinting
  });

  it('does not sprint while crouching or in water', () => {
    const c = new PlayerController({ x: SPAWN.x, y: SPAWN.y, z: SPAWN.z });
    c.crouching = true;
    tick(c, 300, input({ forward: 1, sprint: true }));
    expect(c.sprinting).toBe(false);
    expect(c.speed).toBeCloseTo(2.2, 1);

    const swim = new PlayerController({ x: LAKE.x, y: SEA_LEVEL, z: LAKE.z });
    tick(swim, 120, input({ forward: 0.5, sprint: true }));
    expect(swim.inWater).toBe(true);
    expect(swim.sprinting).toBe(false);
    expect(swim.speed).toBeCloseTo(3.0, 1);
  });

  it('ramps sprint speed up gradually instead of switching instantly', () => {
    const c = new PlayerController({ x: SPAWN.x, y: SPAWN.y, z: SPAWN.z });
    tick(c, 20, input({ forward: 1, sprint: true })); // ~0.33 s of sprinting
    expect(c.sprinting).toBe(true);
    // A third of a second in: well above walk speed but not yet full sprint.
    expect(c.speed).toBeGreaterThan(6.5);
    expect(c.speed).toBeLessThan(9.0);
    tick(c, 300, input({ forward: 1, sprint: true }));
    expect(c.speed).toBeCloseTo(9.2, 1); // steady state
  });

  it('drops back to walk speed when sprint is released', () => {
    const c = new PlayerController({ x: SPAWN.x, y: SPAWN.y, z: SPAWN.z });
    tick(c, 300, input({ forward: 1, sprint: true }));
    expect(c.speed).toBeCloseTo(9.2, 1);
    tick(c, 240, input({ forward: 1 }));
    expect(c.sprinting).toBe(false);
    expect(c.speed).toBeCloseTo(5.2, 1);
  });

  it('no sprinting while idle (holding shift standing still)', () => {
    const c = new PlayerController({ x: SPAWN.x, y: SPAWN.y, z: SPAWN.z });
    tick(c, 60, input({ sprint: true }));
    expect(c.sprinting).toBe(false);
    expect(c.speed).toBe(0);
  });
});

describe('PlayerController movement lock (timed crafting)', () => {
  it('does not move horizontally while locked, even with full input', () => {
    const c = new PlayerController({ x: SPAWN.x, y: SPAWN.y, z: SPAWN.z });
    tick(c, 60, input({ forward: 1 })); // build up walk speed first
    expect(c.speed).toBeGreaterThan(4);
    const x0 = c.pos.x;
    const z0 = c.pos.z;
    for (let i = 0; i < 120; i++) c.update(DT, input({ forward: 1, strafe: 1 }), 0, [], true, [], false);
    expect(c.pos.x).toBeCloseTo(x0, 5);
    expect(c.pos.z).toBeCloseTo(z0, 5);
    expect(c.speed).toBe(0); // input is fully ignored
  });

  it('cannot jump while locked but still snaps to the ground', () => {
    const c = new PlayerController({ x: SPAWN.x, y: SPAWN.y, z: SPAWN.z });
    for (let i = 0; i < 60; i++) c.update(DT, input({ jumpHeld: true }), 0, [], true, [], false);
    const g = groundHeight(c.pos.x, c.pos.z);
    expect(c.onGround).toBe(true);
    expect(c.pos.y).toBeCloseTo(g, 4);
  });

  it('vertical physics keep running: a locked player in the air still falls and lands', () => {
    const c = new PlayerController({ x: SPAWN.x, y: SPAWN.y + 6, z: SPAWN.z });
    c.vel.y = 0;
    for (let i = 0; i < 300; i++) c.update(DT, input(), 0, [], true, [], false);
    const g = groundHeight(c.pos.x, c.pos.z);
    expect(c.onGround).toBe(true);
    expect(c.pos.y).toBeCloseTo(g, 3);
  });
});

describe('PlayerController landing impact (fall damage events)', () => {
  it('reports a jump landing at the jump-arc distance, consumed exactly once', () => {
    const c = new PlayerController({ x: SPAWN.x, y: SPAWN.y, z: SPAWN.z });
    tick(c, 10, input());
    tick(c, 20, input({ jumpHeld: true }));
    expect(c.onGround).toBe(false);
    tick(c, 240, input());
    expect(c.onGround).toBe(true);
    const impact = c.consumeImpact();
    // Theoretical arc is v²/2g = 7.4²/44 ≈ 1.244 m; frame quantisation
    // allows a margin, and it must stay inside the "no damage" band.
    expect(impact).not.toBeNull();
    expect(impact!.distance).toBeGreaterThan(0.9);
    expect(impact!.distance).toBeLessThan(1.6);
    expect(impact!.crouching).toBe(false);
    expect(Math.abs(impact!.y - groundHeight(c.pos.x, c.pos.z))).toBeLessThan(1e-9);
    // Consumed: the next frame reports nothing (the player is grounded).
    expect(c.consumeImpact()).toBeNull();
    tick(c, 30, input());
    expect(c.consumeImpact()).toBeNull();
  });

  it('does not report any impact while walking downhill on the surface', () => {
    const cliff = findCliff();
    const c = new PlayerController({ x: cliff.x, y: groundHeight(cliff.x, cliff.z), z: cliff.z });
    for (let i = 0; i < 120; i++) {
      c.update(DT, input({ forward: 1 }), -Math.PI / 2, [], true, []);
      // Slope-stick keeps the player grounded: no fall event may fire.
      expect(c.consumeImpact()).toBeNull();
    }
  });

  it('reports the full drop distance for an airborne fall', () => {
    const cliff = findCliff();
    const edgeY = groundHeight(cliff.x, cliff.z);
    const c = new PlayerController({ x: cliff.x, y: edgeY + 3, z: cliff.z });
    tick(c, 1, input());
    expect(c.onGround).toBe(false);
    for (let i = 0; i < 120 && c.onGround === false; i++) c.update(DT, input(), 0, [], true, []);
    const impact = c.consumeImpact();
    expect(impact).not.toBeNull();
    // Dropped 3 m (starting at rest, so the peak is the start height).
    expect(impact!.distance).toBeGreaterThan(2.7);
    expect(impact!.distance).toBeLessThan(3.25);
  });

  it('records the crouch state at the moment of impact', () => {
    const cliff = findCliff();
    const c = new PlayerController({ x: cliff.x, y: groundHeight(cliff.x, cliff.z) + 3, z: cliff.z });
    c.crouching = true; // player hits C while falling
    c.update(DT, input(), 0, [], true, []); // first step leaves the ground
    expect(c.onGround).toBe(false);
    for (let i = 0; i < 120 && c.onGround === false; i++) c.update(DT, input(), 0, [], true, []);
    const impact = c.consumeImpact();
    expect(impact).not.toBeNull();
    expect(impact!.crouching).toBe(true);
    // Releasing crouch after landing does not retro-change the record.
    c.crouching = false;
    expect(impact!.crouching).toBe(true);
  });

  it('does not report an impact when the fall ends in water', () => {
    const c = new PlayerController({ x: LAKE.x, y: SEA_LEVEL + 6, z: LAKE.z });
    for (let i = 0; i < 300; i++) c.update(DT, input(), 0, [], true, []);
    expect(c.inWater).toBe(true);
    expect(c.consumeImpact()).toBeNull();
    // The buoyant settle is not a fall either.
    tick(c, 120, input());
    expect(c.consumeImpact()).toBeNull();
  });

  it('respawn clears any pending impact and fall tracking', () => {
    const cliff = findCliff();
    const c = new PlayerController({ x: cliff.x, y: groundHeight(cliff.x, cliff.z) + 4, z: cliff.z });
    c.update(DT, input(), 0, [], true, []);
    expect(c.onGround).toBe(false);
    c.respawn(cliff.x, groundHeight(cliff.x, cliff.z), cliff.z);
    expect(c.consumeImpact()).toBeNull();
    tick(c, 60, input());
    expect(c.consumeImpact()).toBeNull();
  });

  it('reports impacts even when movement is locked (fall physics keep running)', () => {
    const c = new PlayerController({ x: SPAWN.x, y: SPAWN.y + 6, z: SPAWN.z });
    c.vel.y = 0;
    for (let i = 0; i < 300; i++) c.update(DT, input(), 0, [], true, [], false);
    const impact = c.consumeImpact();
    expect(impact).not.toBeNull();
    expect(impact!.distance).toBeGreaterThan(5.5);
    expect(impact!.distance).toBeLessThan(6.4);
  });
});
