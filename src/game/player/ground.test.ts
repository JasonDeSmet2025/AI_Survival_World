import { describe, expect, it } from 'vitest';
import {
  TERRAIN_SIZE,
  TARGET_SPACING,
  buildTerrainGrid,
  terrainHeight,
} from '../world/heightfield';
import { groundHeight, groundHeightAbove } from './ground';

const SIZE = TERRAIN_SIZE;
// Must mirror buildTerrainGrid's grid construction.
const SAMPLES = Math.min(513, Math.max(129, Math.round(SIZE / TARGET_SPACING) + 1));
const STEP = SIZE / (SAMPLES - 1);

/**
 * Independent re-evaluation of the rendered mesh surface from the actual
 * mesh position buffer (what the GPU draws), used to verify that
 * `groundHeight` samples the same surface the player sees.
 */
function meshSurface(
  grid: ReturnType<typeof buildTerrainGrid>,
  x: number,
  z: number,
): number {
  const u = Math.max(0, Math.min(SAMPLES - 1, (x + SIZE / 2) / STEP));
  const v = Math.max(0, Math.min(SAMPLES - 1, (z + SIZE / 2) / STEP));
  const ix = Math.floor(u);
  const iz = Math.floor(v);
  const fx = u - ix;
  const fz = v - iz;
  const x0 = Math.min(ix, SAMPLES - 1);
  const x1 = Math.min(ix + 1, SAMPLES - 1);
  const z0 = Math.min(iz, SAMPLES - 1);
  const z1 = Math.min(iz + 1, SAMPLES - 1);
  const py = (a: number, b: number) => grid.positions[(b * SAMPLES + a) * 3 + 1];
  const h00 = py(x0, z0);
  const h10 = py(x1, z0);
  const h01 = py(x0, z1);
  const h11 = py(x1, z1);
  return fx + fz <= 1
    ? h00 * (1 - fx - fz) + h10 * fx + h01 * fz
    : h10 * (1 - fz) + h01 * (1 - fx) + h11 * (fx + fz - 1);
}

/** Deterministic pseudo-random in [0, 1). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const grid = buildTerrainGrid();

describe('groundHeight (mesh-exact ground sampler)', () => {
  it('matches the rendered mesh at grid vertices', () => {
    for (let iz = 0; iz < SAMPLES; iz += 7) {
      for (let ix = 0; ix < SAMPLES; ix += 7) {
        const x = -SIZE / 2 + ix * STEP;
        const z = -SIZE / 2 + iz * STEP;
        // Float32 mesh buffer vs float64 sampler: allow tiny rounding.
        expect(Math.abs(groundHeight(x, z) - meshSurface(grid, x, z))).toBeLessThan(2e-4);
      }
    }
  });

  it('matches the rendered mesh triangle interpolation at random points', () => {
    const rand = rng(1234);
    let maxErr = 0;
    for (let i = 0; i < 3000; i++) {
      const x = (rand() - 0.5) * SIZE;
      const z = (rand() - 0.5) * SIZE;
      const err = Math.abs(groundHeight(x, z) - meshSurface(grid, x, z));
      maxErr = Math.max(maxErr, err);
    }
    expect(maxErr).toBeLessThan(2e-4);
  });

  it('is continuous across triangle and cell boundaries', () => {
    const rand = rng(777);
    for (let i = 0; i < 200; i++) {
      // Points straddling a cell corner: the surface must not jump.
      const cx = Math.floor(rand() * (SAMPLES - 2) + 1) * STEP - SIZE / 2;
      const cz = Math.floor(rand() * (SAMPLES - 2) + 1) * STEP - SIZE / 2;
      const d = 1e-4;
      const hs = [
        groundHeight(cx - d, cz - d),
        groundHeight(cx + d, cz - d),
        groundHeight(cx - d, cz + d),
        groundHeight(cx + d, cz + d),
      ];
      const spread = Math.max(...hs) - Math.min(...hs);
      expect(spread).toBeLessThan(1e-3);
    }
  });

  it('documents the mesh-vs-analytic deviation the physics used to ignore', () => {
    // The coarse mesh genuinely deviates from the analytic curve somewhere
    // (that is what made players sink before), but never wildly.
    const rand = rng(4242);
    let maxDev = 0;
    for (let i = 0; i < 6000; i++) {
      const x = (rand() - 0.5) * SIZE * 0.95;
      const z = (rand() - 0.5) * SIZE * 0.95;
      maxDev = Math.max(maxDev, Math.abs(groundHeight(x, z) - terrainHeight(x, z)));
    }
    expect(maxDev).toBeGreaterThan(0.05); // mesh really is coarser than the curve
    expect(maxDev).toBeLessThan(5); // ...but stays in a sane range
  });

  it('is fast enough for per-frame physics queries', () => {
    const rand = rng(99);
    const t0 = performance.now();
    for (let i = 0; i < 20000; i++) {
      // Clustered queries (a walking player) exercise the cache path.
      const x = 100 + (rand() - 0.5) * 30;
      const z = -50 + (rand() - 0.5) * 30;
      groundHeight(x, z);
    }
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it('clamps outside the island without errors', () => {
    expect(groundHeight(0, 0)).toBeCloseTo(meshSurface(grid, 0, 0), 3);
    expect(Number.isFinite(groundHeight(SIZE, SIZE))).toBe(true);
    expect(Number.isFinite(groundHeight(-SIZE, SIZE))).toBe(true);
    expect(groundHeightAbove(0, 0, 0.5)).toBeCloseTo(groundHeight(0, 0) + 0.5, 9);
  });
});
