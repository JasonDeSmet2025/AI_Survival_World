import { describe, it, expect } from 'vitest';
import { bakeTerrainAO, bakeTerrainAOSubsampled, DEFAULT_TERRAIN_AO, type TerrainAOConfig } from './terrainAO';
import { buildTerrainGrid } from './heightfield';

/** Helper: build a row-major grid from an analytic height function. */
function makeGrid(fn: (x: number, z: number) => number, samples: number, step: number): Float32Array {
  const out = new Float32Array(samples * samples);
  const half = ((samples - 1) * step) / 2;
  for (let iz = 0; iz < samples; iz++) {
    for (let ix = 0; ix < samples; ix++) {
      out[iz * samples + ix] = fn(ix * step - half, iz * step - half);
    }
  }
  return out;
}

/** Smooth bowl: depth 6 at the centre, flat beyond ~25 u. */
function bowl(x: number, z: number): number {
  const r2 = x * x + z * z;
  return 6 * (1 - Math.exp(-r2 / 16));
}

describe('bakeTerrainAO (pure)', () => {
  it('flat ground is fully lit (ao = 1 everywhere)', () => {
    const S = 33;
    const flat = makeGrid(() => 5, S, 2);
    const ao = bakeTerrainAO(flat, S, 2);
    expect(ao.length).toBe(S * S);
    for (const v of ao) expect(v).toBeCloseTo(1, 10);
  });

  it('the bowl bottom is occluded while distant flat ground is not', () => {
    const S = 81; // 160 u wide; the bowl is flat beyond ~25 u
    const g = makeGrid(bowl, S, 2);
    const ao = bakeTerrainAO(g, S, 2);
    const c = S >> 1;
    const center = ao[c * S + c];
    const far = ao[c * S + c + 38]; // 76 u out: flat, slope ~0
    // A 6 u-deep bowl on a 2 u grid renders as a steep funnel: the bottom
    // is genuinely occluded (down to the readability floor), while open
    // ground stays fully lit.
    expect(center).toBeLessThan(0.9);
    expect(far).toBeGreaterThan(0.97);
  });

  it('uniform slopes below the tolerance stay fully lit', () => {
    // Plane rising at slope 0.3 everywhere (< slopeTol 0.45): no occlusion.
    const S = 49;
    const plane = makeGrid((x) => 0.3 * x, S, 2);
    const ao = bakeTerrainAO(plane, S, 2);
    for (const v of ao) expect(v).toBeGreaterThan(0.99);
  });

  it('slopes steeper than the tolerance read as concavity (documented contract)', () => {
    // Slope 0.9 > tol 0.45: rays aimed uphill run into terrain higher than
    // tolerated and occlude partially — a steeper wall's base reads darker.
    // The value must land strictly between flat (1) and the floor.
    const S = 49;
    const steep = makeGrid((x) => 0.9 * x, S, 2);
    const ao = bakeTerrainAO(steep, S, 2);
    const c = S >> 1;
    const mid = ao[c * S + c];
    expect(mid).toBeLessThan(0.999);
    expect(mid).toBeGreaterThanOrEqual(DEFAULT_TERRAIN_AO.minAO);
  });

  it('respects the minAO readability floor and never exceeds 1', () => {
    const S = 25;
    // A narrow tall spike: its base ring is heavily occluded.
    const g = makeGrid((x, z) => (Math.hypot(x, z) < 3 ? 30 : 0), S, 2);
    const ao = bakeTerrainAO(g, S, 2, { minAO: 0.5 });
    for (const v of ao) {
      expect(v).toBeGreaterThanOrEqual(0.5);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('is byte-identical across two fresh bakes (deterministic)', () => {
    const S = 65;
    const g = makeGrid((x, z) => 3 * Math.sin(x * 0.07) * Math.cos(z * 0.05) + Math.hypot(x, z) * 0.02, S, 2);
    const a = bakeTerrainAO(g, S, 2);
    const b = bakeTerrainAO(g, S, 2);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('is byte-identical across two fresh grid builds (shared deterministic grid)', () => {
    const g1 = buildTerrainGrid(96);
    const g2 = buildTerrainGrid(96);
    expect(Array.from(g1.ao)).toEqual(Array.from(g2.ao));
  });

  it('edge vertices stay finite and in range (clamped sampling)', () => {
    const S = 41;
    const g = makeGrid((x, z) => 2 * Math.sin(x * 0.11) * Math.sin(z * 0.13) + 4, S, 2);
    const ao = bakeTerrainAO(g, S, 2);
    for (const i of [0, S - 1, (S - 1) * S, S * S - 1]) {
      expect(Number.isFinite(ao[i])).toBe(true);
      expect(ao[i]).toBeGreaterThanOrEqual(DEFAULT_TERRAIN_AO.minAO);
      expect(ao[i]).toBeLessThanOrEqual(1);
    }
  });

  it('a close blocker occludes more than open ground (near radii dominate)', () => {
    const S = 101;
    const half = ((S - 1) * 2) / 2;
    const g = makeGrid(() => 0, S, 2);
    const c = S >> 1;
    // Half-plane cliff wall 4 u high on the west side (x <= -28).
    for (let iz = 0; iz < S; iz++) {
      for (let ix = 0; ix < S; ix++) {
        const x = ix * 2 - half;
        if (x <= -28) g[iz * S + ix] = 4;
      }
    }
    const ao = bakeTerrainAO(g, S, 2);
    // The near vertex sits one grid cell in front of the wall face; its
    // hash-decorrelated ray fan (offset 139 deg) puts two rays into the
    // wall. The far vertex sees open ground.
    const near = ao[c * S + 37]; // x = -26
    const far = ao[c * S + Math.round((20 + half) / 2)];
    expect(near).toBeLessThan(far);
    expect(near).toBeLessThan(0.9);
    expect(far).toBeGreaterThan(0.99);
  });

  it('subsampled bake: deterministic and in range on every vertex', () => {
    const S = 64;
    const g = makeGrid((x, z) => 4 * Math.sin(x * 0.05) * Math.cos(z * 0.06) + 2, S, 2);
    const f = bakeTerrainAOSubsampled(g, S, 2, 2);
    const f2 = bakeTerrainAOSubsampled(g, S, 2, 2);
    expect(Array.from(f)).toEqual(Array.from(f2));
    expect(f.length).toBe(S * S);
    for (const v of f) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(DEFAULT_TERRAIN_AO.minAO);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('subsampled even vertices equal the coarse bake exactly', () => {
    const S = 64;
    const g = makeGrid((x, z) => 4 * Math.sin(x * 0.05) * Math.cos(z * 0.06) + 2, S, 2);
    const sub = bakeTerrainAOSubsampled(g, S, 2, 2);
    // Coarse grid = every other vertex, step doubled, same extent.
    const cSamples = S / 2;
    const coarse = new Float64Array(cSamples * cSamples);
    for (let cz = 0; cz < cSamples; cz++)
      for (let cx = 0; cx < cSamples; cx++)
        coarse[cz * cSamples + cx] = g[cz * 2 * S + cx * 2];
    const coarseAO = bakeTerrainAO(coarse, cSamples, 4);
    for (let cz = 0; cz < cSamples; cz++)
      for (let cx = 0; cx < cSamples; cx++)
        expect(sub[cz * 2 * S + cx * 2]).toBe(coarseAO[cz * cSamples + cx]);
  });

  it('config overrides are honoured (fewer rays still produce valid AO)', () => {
    const S = 33;
    const g = makeGrid(bowl, S, 2);
    const cfg: Partial<TerrainAOConfig> = { rays: 4, radii: [2, 6] };
    const ao = bakeTerrainAO(g, S, 2, cfg);
    for (const v of ao) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(DEFAULT_TERRAIN_AO.minAO);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('default-size bake fits a time budget (one-time worldgen cost)', () => {
    // Full 321x321 default grid: the bake must stay comfortably below the
    // ~5 s worldgen budget (measured on this CI-class hardware).
    const t0 = performance.now();
    const grid = buildTerrainGrid();
    const t1 = performance.now();
    expect(t1 - t0).toBeLessThan(3000);
    expect(grid.ao.length).toBe(grid.samples * grid.samples);
    let min = Infinity;
    let max = -Infinity;
    for (const v of grid.ao) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    // Real world: genuine variation exists (valleys < 0.8) while the
    // fully-lit ceiling (1.0) is reached on open ground.
    expect(min).toBeLessThan(0.8);
    expect(max).toBe(1);
  }, 30000);
});
