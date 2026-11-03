import { describe, expect, it } from 'vitest';
import { genPlacements } from './flora';
import {
  SEA_LEVEL,
  TERRAIN_SIZE,
  terrainHeight,
  minTerrainHeightInRadius,
} from './heightfield';

/**
 * Ground-contact radius per kind, as a multiple of the instance scale.
 * Must stay in sync with the footprint values in genPlacements().
 */
const FOOTPRINT: Record<string, number> = {
  tree: 0.35,
  pine: 0.3,
  rock: 0.55,
  bush: 0.55,
  grass: 0.15,
  flower: 0.12,
  plant: 0.15,
};

describe('flora grounding', () => {
  const placements = genPlacements();

  it('keeps every placement on the rendered terrain tile', () => {
    const half = TERRAIN_SIZE / 2 - 1;
    for (const p of placements) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(half);
      expect(Math.abs(p.z)).toBeLessThanOrEqual(half);
    }
  });

  it('seats every object base on or above the lowest ground within its footprint (no floating)', () => {
    for (const p of placements) {
      const lowest = minTerrainHeightInRadius(p.x, p.z, (FOOTPRINT[p.kind] ?? 0.2) * p.scale);
      expect(lowest).toBeGreaterThanOrEqual(p.y - p.sink - 1e-9);
    }
  });

  it('keeps every object base clear of the water', () => {
    for (const p of placements) {
      expect(p.y - p.sink).toBeGreaterThanOrEqual(SEA_LEVEL + 0.2);
    }
  });

  it('bounds the ground-settle depth (objects never vanish into the ground)', () => {
    for (const p of placements) {
      expect(p.sink).toBeGreaterThanOrEqual(0);
      // sink <= sinkCap + baseSink*maxScale per kind (see genPlacements).
      expect(p.sink).toBeLessThanOrEqual(1.3);
    }
  });
});

describe('shoreline quality', () => {
  it('has no vertical steps or slope kinks near the waterline', () => {
    // Wherever the ground is close to the visible waterline (shallow beach
    // band), the height field must be smooth: the local gradient (0.5 u
    // step) and a wider gradient (1.5 u step) must agree. The previous
    // hard-coded beach band produced a ~0.3 u step at the waterline and a
    // slope kink, which this catches. Steeper drops below -0.8 are the
    // natural ocean floor and are excluded.
    let checked = 0;
    let worst = 0;
    let worstPt: [number, number, number] = [0, 0, 0];
    for (let x = -300; x <= 300; x += 4) {
      for (let z = -300; z <= 300; z += 4) {
        const h = terrainHeight(x, z);
        if (h < -0.8 || h > 3.5) continue;
        checked++;
        const e = 0.5;
        const gLocal = Math.hypot(
          (terrainHeight(x, z - e) - terrainHeight(x, z + e)) / (2 * e),
          (terrainHeight(x + e, z) - terrainHeight(x - e, z)) / (2 * e),
        );
        const gWide = Math.hypot(
          (terrainHeight(x, z - 1.5) - terrainHeight(x, z + 1.5)) / 3,
          (terrainHeight(x + 1.5, z) - terrainHeight(x - 1.5, z)) / 3,
        );
        const d = Math.abs(gLocal - gWide);
        if (d > worst) {
          worst = d;
          worstPt = [x, z, h];
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
    if (worst >= 0.5) console.log('shore worst gradient-jump:', worst, 'at', worstPt);
    expect(worst).toBeLessThan(0.5);
  });

  it('stays continuous across close samples (no cliffs anywhere)', () => {
    for (let x = -300; x <= 300; x += 5) {
      for (let z = -300; z <= 300; z += 5) {
        const h = terrainHeight(x, z);
        if (h < 0) continue;
        for (const [dx, dz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const dh = terrainHeight(x + dx, z + dz) - h;
          expect(Math.abs(dh)).toBeLessThan(2.5);
        }
      }
    }
  });
});
