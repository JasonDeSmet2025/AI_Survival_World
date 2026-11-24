/**
 * The volcano must obey the island-wide height-field contracts and its own
 * fittings must actually fit: no cliffs anywhere near the cone, a real
 * summit depression that holds its lava, a sunk lava disc whose rim buries
 * under the scanned floor everywhere, a walkable trench from flank to bowl,
 * and a den roster (spiders/chests) standing on den ground — never in the
 * lava, never in the vent.
 */
import { describe, expect, it } from 'vitest';
import {
  SEA_LEVEL,
  terrainHeight,
} from './heightfield';
import {
  BASE_H,
  BOWL_FLOOR,
  CONE_R,
  TRENCH_DIR,
  TRENCH_LEN,
  TRENCH_W,
  VENT,
  VOLCANO_HOME,
  inCraterLava,
  volcanoChests,
  volcanoDelta,
  volcanoLake,
  volcanoSpiders,
} from './volcano';

const HOME = VOLCANO_HOME;
/** Point `along` metres from the centre along the trench axis. */
function trenchPoint(along: number, side = 0): { x: number; z: number } {
  return {
    x: HOME.x + TRENCH_DIR.x * along - TRENCH_DIR.z * side,
    z: HOME.z + TRENCH_DIR.z * along + TRENCH_DIR.x * side,
  };
}

describe('volcano height field', () => {
  it('is zero far off-site', () => {
    expect(volcanoDelta(HOME.x + CONE_R + 30, HOME.z, 10)).toBe(0);
    expect(volcanoDelta(0, 0, 10)).toBe(0);
  });

  it('adds no vertical cliffs (1 m steps stay under 2.5 u)', () => {
    let worst = 0;
    for (let z = HOME.z - 70; z <= HOME.z + 70; z += 1) {
      for (let x = HOME.x - 70; x <= HOME.x + 70; x += 1) {
        worst = Math.max(
          worst,
          Math.abs(terrainHeight(x + 1, z) - terrainHeight(x, z)),
          Math.abs(terrainHeight(x, z + 1) - terrainHeight(x, z)),
        );
      }
    }
    expect(worst).toBeLessThan(2.5);
  });

  it('rises out of the plain as a crater-topped cone', () => {
    expect(terrainHeight(HOME.x, HOME.z)).toBeGreaterThan(BASE_H + 15);
    expect(terrainHeight(HOME.x + 60, HOME.z)).toBeLessThan(BASE_H + 8);
  });

  it('the summit is a real depression: the crater floor is the lowest ground around', () => {
    const floor = terrainHeight(HOME.x, HOME.z);
    // The crater wall stands above the floor in every direction (except the
    // deliberate trench spillway, which is pinned above the lava surface).
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      const x = HOME.x + Math.cos(a) * 27;
      const z = HOME.z + Math.sin(a) * 27;
      const along = (x - HOME.x) * TRENCH_DIR.x + (z - HOME.z) * TRENCH_DIR.z;
      const perp = Math.hypot(x - HOME.x - TRENCH_DIR.x * along, z - HOME.z - TRENCH_DIR.z * along);
      if (perp < TRENCH_W * 1.5) continue; // the ravine crosses the wall here
      const wall = terrainHeight(x, z);
      expect(wall, `wall a=${a.toFixed(2)}`).toBeGreaterThan(floor + 2);
    }
    // The bowl floor is near its nominal level everywhere (it holds lava).
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const h = terrainHeight(HOME.x + Math.cos(a) * 10, HOME.z + Math.sin(a) * 10);
      expect(Math.abs(h - BOWL_FLOOR), `floor a=${a.toFixed(2)}`).toBeLessThan(1.6);
    }
  });

  it('lava disc sinks into the floor: its rim buries at every angle', () => {
    const lake = volcanoLake();
    expect(lake.hazardR).toBeLessThan(lake.r);
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const ground = terrainHeight(lake.x + Math.cos(a) * (lake.r + 0.4), lake.z + Math.sin(a) * (lake.r + 0.4));
      expect(ground, `rim a=${a.toFixed(2)}`).toBeGreaterThan(lake.y);
    }
    // The centre floor is above the disc: the lake reads as sunken molten rock.
    expect(terrainHeight(lake.x + lake.hazardR + 2.5, lake.z)).toBeGreaterThan(lake.y);
  });

  it('lava burns in the crater only', () => {
    const lake = volcanoLake();
    expect(inCraterLava(lake.x, lake.z)).toBe(true);
    expect(inCraterLava(lake.x + lake.hazardR + 3, lake.z)).toBe(false);
    // Halfway up the flank is not lava.
    expect(inCraterLava(HOME.x + 40, HOME.z)).toBe(false);
  });

  it('the trench is one walkable ramp from bowl to flank, open at the mouth', () => {
    let prev: number | null = null;
    let worstStep = 0;
    for (let a = 14; a <= 14 + TRENCH_LEN; a += 1) {
      const p = trenchPoint(a);
      const h = terrainHeight(p.x, p.z);
      if (prev !== null) worstStep = Math.max(worstStep, Math.abs(h - prev));
      prev = h;
    }
    expect(worstStep).toBeLessThan(1.8);
    // It descends from the bowl toward the flank...
    const near = terrainHeight(trenchPoint(16).x, trenchPoint(16).z);
    const far = terrainHeight(trenchPoint(14 + TRENCH_LEN).x, trenchPoint(14 + TRENCH_LEN).z);
    expect(far).toBeLessThan(near - 5);
    // ...and the mouth is flush with the surrounding flank, not a hanging lip:
    // ground 2 m beside the axis at the end matches ground on the axis.
    const p = trenchPoint(14 + TRENCH_LEN + 4);
    const onAxis = terrainHeight(p.x, p.z);
    const off = terrainHeight(p.x - TRENCH_DIR.z * 12, p.z + TRENCH_DIR.x * 12);
    expect(Math.abs(onAxis - off)).toBeLessThan(1.8);
  });

  it('the trench floor stays dry and never drains the lava', () => {
    const lake = volcanoLake();
    for (let a = 14; a <= 14 + TRENCH_LEN; a += 2) {
      const p = trenchPoint(a);
      const h = terrainHeight(p.x, p.z);
      expect(h, `along=${a}`).toBeGreaterThan(SEA_LEVEL + 0.2);
      // Spillway rule: wherever the corridor exists its floor stays above
      // the lava surface — molten rock can never flow out of the crater.
      // (Below the mouth the axis is ordinary flank ground, no corridor.)
      const sideL = terrainHeight(p.x - TRENCH_DIR.z * 9, p.z + TRENCH_DIR.x * 9);
      const sideR = terrainHeight(p.x + TRENCH_DIR.z * 9, p.z - TRENCH_DIR.x * 9);
      const corridor = sideL - h > 1.5 && sideR - h > 1.5;
      if (corridor) expect(h, `spillway pin along=${a}`).toBeGreaterThan(lake.y + 0.4);
    }
    // The ravine floor is well above the waterline all the way down.
    for (let a = 14; a <= 60; a += 2) {
      const p = trenchPoint(a);
      expect(terrainHeight(p.x, p.z), `dry along=${a}`).toBeGreaterThan(6);
    }
  });
});

describe('volcano den roster', () => {
  it('spiders and chests stand on den ground, off the lava and off the vent', () => {
    for (const s of volcanoSpiders()) {
      const d = Math.hypot(s.x - HOME.x, s.z - HOME.z);
      const along = (s.x - HOME.x) * TRENCH_DIR.x + (s.z - HOME.z) * TRENCH_DIR.z;
      const perp = Math.hypot(s.x - HOME.x - TRENCH_DIR.x * along, s.z - HOME.z - TRENCH_DIR.z * along);
      const inBowl = d <= 14.5;
      const inTrench = along >= 14 && along <= 14 + TRENCH_LEN - 4 && perp <= TRENCH_W * 0.4 + 1;
      expect(inBowl || inTrench, `${s.id} in the den`).toBe(true);
      expect(inCraterLava(s.x, s.z), `${s.id} out of lava`).toBe(false);
      expect(Math.hypot(s.x - VENT.x, s.z - VENT.z), `${s.id} off vent`).toBeGreaterThan(VENT.r + 0.8);
      expect(terrainHeight(s.x, s.z), `${s.id} above sea`).toBeGreaterThan(6);
    }
    for (const c of volcanoChests()) {
      expect(Math.hypot(c.x - HOME.x, c.z - HOME.z), `${c.id} in bowl`).toBeLessThanOrEqual(14.5);
      expect(inCraterLava(c.x, c.z), `${c.id} out of lava`).toBe(false);
      expect(Math.hypot(c.x - VENT.x, c.z - VENT.z), `${c.id} off vent`).toBeGreaterThan(VENT.r + 0.8);
    }
  });

  it('the great chest is behind the lava, guarded by the ring', () => {
    const lake = volcanoLake();
    const great = volcanoChests().find((c) => c.tier === 'great')!;
    const dGreat = Math.hypot(great.x - lake.x, great.z - lake.z);
    expect(dGreat).toBeGreaterThan(lake.hazardR + 1.5);
    // The trench mouth side of the bowl is the approach: at least one
    // spider guards between it and the chests.
    const mouth = trenchPoint(20);
    const guards = volcanoSpiders().filter((s) => Math.hypot(s.x - mouth.x, s.z - mouth.z) < 14);
    expect(guards.length).toBeGreaterThan(0);
  });
});
