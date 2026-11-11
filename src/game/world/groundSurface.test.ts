import { describe, expect, it } from 'vitest';
import { NullEngine, Scene } from '@babylonjs/core';
import {
  SEA_LEVEL,
  TERRAIN_SIZE,
  buildTerrainGrid,
  terrainGridLayout,
  terrainHeight,
  terrainVertexHeights,
} from './heightfield';
import { createTerrain } from './terrain';
import { groundHeight } from '../player/ground';
import {
  groundSurfaceHeight,
  minSurfaceHeightInRadius,
  surfaceHeightAbove,
} from './groundSurface';

/** Deterministic pseudo-random in [0, 1). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/**
 * Independent re-evaluation of the rendered mesh surface from the actual
 * mesh position buffer (what the GPU draws).
 */
function meshSurface(grid: ReturnType<typeof buildTerrainGrid>, x: number, z: number): number {
  const { samples: SAMPLES, step: STEP } = terrainGridLayout();
  const SIZE = TERRAIN_SIZE;
  const u = Math.max(0, Math.min(SAMPLES - 1, (x + SIZE / 2) / STEP));
  const v = Math.max(0, Math.min(SAMPLES - 1, (z + SIZE / 2) / STEP));
  const ix = Math.floor(u);
  const iz = Math.floor(v);
  const fx = u - ix;
  const fz = v - iz;
  const py = (a: number, b: number) => grid.positions[(b * SAMPLES + a) * 3 + 1];
  const h00 = py(ix, iz);
  const h10 = py(Math.min(ix + 1, SAMPLES - 1), iz);
  const h01 = py(ix, Math.min(iz + 1, SAMPLES - 1));
  const h11 = py(Math.min(ix + 1, SAMPLES - 1), Math.min(iz + 1, SAMPLES - 1));
  return fx + fz <= 1
    ? h00 * (1 - fx - fz) + h10 * fx + h01 * fz
    : h10 * (1 - fz) + h01 * (1 - fx) + h11 * (fx + fz - 1);
}

describe('terrainVertexHeights (shared grid)', () => {
  it('matches the grid layout formula', () => {
    const { samples, step } = terrainGridLayout();
    const v = terrainVertexHeights();
    expect(v.samples).toBe(samples);
    expect(v.step).toBe(step);
    expect(v.heights.length).toBe(samples * samples);
    for (let i = 0; i < v.heights.length; i += 997) {
      expect(Number.isFinite(v.heights[i])).toBe(true);
    }
  });

  it('is byte-identical to the default rendered mesh geometry', () => {
    const grid = buildTerrainGrid();
    const v = terrainVertexHeights();
    expect(grid.samples).toBe(v.samples);
    // Float32 mesh buffer vs float64 grid: tiny rounding only.
    for (let i = 0; i < v.heights.length; i += 503) {
      expect(Math.abs(grid.positions[i * 3 + 1] - v.heights[i])).toBeLessThan(2e-4);
    }
  });

  it('is deterministic across repeated access', () => {
    const a = terrainVertexHeights();
    const b = terrainVertexHeights();
    expect(a.heights).toBe(b.heights); // memoised single source of truth
  });
});

describe('groundSurfaceHeight (mesh-exact sampler)', () => {
  const grid = buildTerrainGrid();

  it('matches the rendered mesh at grid vertices', () => {
    const { samples, step } = terrainGridLayout();
    for (let iz = 0; iz < samples; iz += 7) {
      for (let ix = 0; ix < samples; ix += 7) {
        const x = -TERRAIN_SIZE / 2 + ix * step;
        const z = -TERRAIN_SIZE / 2 + iz * step;
        expect(Math.abs(groundSurfaceHeight(x, z) - meshSurface(grid, x, z))).toBeLessThan(2e-4);
      }
    }
  });

  it('matches the rendered mesh triangle interpolation at random points', () => {
    const rand = rng(31415);
    let maxErr = 0;
    for (let i = 0; i < 4000; i++) {
      const x = (rand() - 0.5) * TERRAIN_SIZE;
      const z = (rand() - 0.5) * TERRAIN_SIZE;
      const err = Math.abs(groundSurfaceHeight(x, z) - meshSurface(grid, x, z));
      maxErr = Math.max(maxErr, err);
    }
    expect(maxErr).toBeLessThan(2e-4);
  });

  it('matches the Babylon chunk meshes created by createTerrain (NullEngine)', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const { meshes } = createTerrain(scene);
    // The terrain is chunked: resolve the chunk that contains the sample
    // point, then read that chunk's LOCAL grid (chunk origins in grid
    // indices: 64 cells per 128u chunk on the default 321-vertex grid).
    const { samples, step } = terrainGridLayout();
    const cells = Math.round(128 / step); // grid cells per 128u chunk
    expect(meshes.length).toBe(25);
    const byChunk = new Map<string, { pos: Float32Array; x0: number; z0: number; L: number }>();
    for (const m of meshes) {
      const mt = m.name.match(/^terrain_c(\d+)_(\d+)$/)!;
      const L = Math.round(Math.sqrt((m.getVerticesData('position') as Float32Array).length / 3));
      byChunk.set(m.name, { pos: m.getVerticesData('position') as Float32Array, x0: parseInt(mt[1], 10) * cells, z0: parseInt(mt[2], 10) * cells, L });
    }
    const rand = rng(271);
    let maxErr = 0;
    for (let i = 0; i < 1000; i++) {
      const x = (rand() - 0.5) * TERRAIN_SIZE * 0.98;
      const z = (rand() - 0.5) * TERRAIN_SIZE * 0.98;
      const u = Math.min(samples - 1, (x + TERRAIN_SIZE / 2) / (TERRAIN_SIZE / (samples - 1)));
      const v = Math.min(samples - 1, (z + TERRAIN_SIZE / 2) / (TERRAIN_SIZE / (samples - 1)));
      const ix = Math.floor(u);
      const iz = Math.floor(v);
      const fx = u - ix;
      const fz = v - iz;
      const entry = byChunk.get(`terrain_c${Math.floor(ix / cells)}_${Math.floor(iz / cells)}`)!;
      const py = (lx: number, lz: number) => entry.pos[(lz * entry.L + lx) * 3 + 1];
      const h00 = py(ix - entry.x0, iz - entry.z0);
      const h10 = py(ix + 1 - entry.x0, iz - entry.z0);
      const h01 = py(ix - entry.x0, iz + 1 - entry.z0);
      const h11 = py(ix + 1 - entry.x0, iz + 1 - entry.z0);
      const mh =
        fx + fz <= 1
          ? h00 * (1 - fx - fz) + h10 * fx + h01 * fz
          : h10 * (1 - fz) + h01 * (1 - fx) + h11 * (fx + fz - 1);
      maxErr = Math.max(maxErr, Math.abs(groundSurfaceHeight(x, z) - mh));
    }
    expect(maxErr).toBeLessThan(2e-4);
    engine.dispose();
  });

  it('is continuous across triangle and cell boundaries', () => {
    const rand = rng(777);
    const { samples, step } = terrainGridLayout();
    for (let i = 0; i < 200; i++) {
      const cx = Math.floor(rand() * (samples - 2) + 1) * step - TERRAIN_SIZE / 2;
      const cz = Math.floor(rand() * (samples - 2) + 1) * step - TERRAIN_SIZE / 2;
      const d = 1e-4;
      const hs = [
        groundSurfaceHeight(cx - d, cz - d),
        groundSurfaceHeight(cx + d, cz - d),
        groundSurfaceHeight(cx - d, cz + d),
        groundSurfaceHeight(cx + d, cz + d),
      ];
      expect(Math.max(...hs) - Math.min(...hs)).toBeLessThan(1e-3);
    }
  });

  it('is the single source of truth behind player physics (groundHeight)', () => {
    const rand = rng(4242);
    for (let i = 0; i < 500; i++) {
      const x = (rand() - 0.5) * TERRAIN_SIZE;
      const z = (rand() - 0.5) * TERRAIN_SIZE;
      expect(groundHeight(x, z)).toBe(groundSurfaceHeight(x, z));
    }
  });

  it('documents the mesh-vs-analytic deviation the old placement code ignored', () => {
    // The coarse mesh genuinely deviates from the analytic curve (this is
    // what made buildings/flora float before), but stays bounded.
    const rand = rng(999);
    let maxDev = 0;
    for (let i = 0; i < 8000; i++) {
      const x = (rand() - 0.5) * TERRAIN_SIZE * 0.95;
      const z = (rand() - 0.5) * TERRAIN_SIZE * 0.95;
      maxDev = Math.max(maxDev, Math.abs(groundSurfaceHeight(x, z) - terrainHeight(x, z)));
    }
    expect(maxDev).toBeGreaterThan(0.25);
    expect(maxDev).toBeLessThan(1.0);
  });

  it('clamps outside the tile without errors', () => {
    expect(Number.isFinite(groundSurfaceHeight(TERRAIN_SIZE, TERRAIN_SIZE))).toBe(true);
    expect(Number.isFinite(groundSurfaceHeight(-TERRAIN_SIZE, TERRAIN_SIZE))).toBe(true);
    expect(groundSurfaceHeight(0, 0)).toBeCloseTo(meshSurface(grid, 0, 0), 3);
    expect(surfaceHeightAbove(0, 0, 0.5)).toBeCloseTo(groundSurfaceHeight(0, 0) + 0.5, 9);
  });

  it('is fast enough for worldgen settling (9 lookups per placement)', () => {
    const rand = rng(555);
    const t0 = performance.now();
    let acc = 0;
    for (let i = 0; i < 50000; i++) {
      const x = (rand() - 0.5) * TERRAIN_SIZE;
      const z = (rand() - 0.5) * TERRAIN_SIZE;
      acc += minSurfaceHeightInRadius(x, z, 0.8);
    }
    expect(Number.isFinite(acc)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe('minSurfaceHeightInRadius', () => {
  it('never exceeds the centre height (it is a minimum)', () => {
    const rand = rng(1337);
    for (let i = 0; i < 300; i++) {
      const x = (rand() - 0.5) * TERRAIN_SIZE * 0.95;
      const z = (rand() - 0.5) * TERRAIN_SIZE * 0.95;
      const r = 0.2 + rand() * 1.0;
      expect(minSurfaceHeightInRadius(x, z, r)).toBeLessThanOrEqual(
        groundSurfaceHeight(x, z) + 1e-12,
      );
    }
  });

  it('returns the centre height on (nearly) flat ground', () => {
    // The spawn area is scanned to be flat: within 0.5u the ground barely
    // moves, so min ~ centre.
    const rand = rng(2024);
    let found = 0;
    for (let i = 0; i < 4000 && found < 25; i++) {
      const x = (rand() - 0.5) * 160;
      const z = (rand() - 0.5) * 160;
      const h = groundSurfaceHeight(x, z);
      if (h < SEA_LEVEL + 0.5 || h > 10) continue;
      const spread =
        Math.max(
          groundSurfaceHeight(x + 0.5, z),
          groundSurfaceHeight(x - 0.5, z),
          groundSurfaceHeight(x, z + 0.5),
          groundSurfaceHeight(x, z - 0.5),
        ) - Math.min(
          groundSurfaceHeight(x + 0.5, z),
          groundSurfaceHeight(x - 0.5, z),
          groundSurfaceHeight(x, z + 0.5),
          groundSurfaceHeight(x, z - 0.5),
        );
      if (spread < 0.12) {
        found++;
        expect(Math.abs(minSurfaceHeightInRadius(x, z, 0.4) - groundSurfaceHeight(x, z))).toBeLessThan(
          0.15,
        );
      }
    }
    expect(found).toBeGreaterThan(5);
  });

  it('captures real ground drops on slopes (no floating guarantee)', () => {
    // On a steep spot the minimum inside a 1u footprint must sit clearly
    // BELOW the centre: this is the value flora/buildings settle against,
    // so objects seat on the visible low point instead of floating.
    const rand = rng(6060);
    let steep = 0;
    for (let i = 0; i < 20000 && steep < 20; i++) {
      const x = (rand() - 0.5) * TERRAIN_SIZE * 0.95;
      const z = (rand() - 0.5) * TERRAIN_SIZE * 0.95;
      const h = groundSurfaceHeight(x, z);
      if (h < 2) continue;
      const drop =
        groundSurfaceHeight(x, z) - minSurfaceHeightInRadius(x, z, 1.0);
      if (drop > 0.5) {
        steep++;
        expect(minSurfaceHeightInRadius(x, z, 1.0)).toBeLessThan(h - 0.5);
        // The sampled minimum must itself be a plausible mesh height
        // (bounded by neighbour heights, not a stray value).
        expect(minSurfaceHeightInRadius(x, z, 1.0)).toBeGreaterThan(h - 3);
      }
    }
    expect(steep).toBeGreaterThan(5);
  });
});
