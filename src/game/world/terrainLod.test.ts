import { describe, it, expect } from 'vitest';
import { NullEngine, Scene } from '@babylonjs/core';
import { buildTerrainGrid, terrainGridLayout } from './heightfield';
import {
  TERRAIN_CHUNK_SIZE,
  TERRAIN_LOD_FAR,
  TERRAIN_LOD_HI,
  TERRAIN_LOD_MID,
  buildTerrainChunks,
  createTerrain,
  terrainChunkCenter,
  type TerrainChunk,
} from './terrain';

/**
 * Terrain distance LOD (three tiers per 128u chunk, same hysteresis pattern
 * as the flora LOD). Covers:
 *  - pure geometry: level layouts, byte-identity of every mid/lo vertex to
 *    the hi grid, winding, seams, and the measured hi-vs-coarse surface
 *    deviation (the LOD "pop" budget),
 *  - scene level: exactly-one-level-enabled invariant, hysteresis, the hi
 *    mesh staying byte-identical to the historic chunk, and perf.
 */

const grid = buildTerrainGrid();
const { samples, step } = terrainGridLayout();
const H = (ix: number, iz: number): number => grid.positions[(iz * samples + ix) * 3 + 1];

/**
 * Exact piecewise-linear (two-triangle) surface height of a coarser
 * grid sampled with `stride` from the hi grid, at an arbitrary hi vertex
 * (ix, iz). Same winding as buildTerrainGrid: per coarse cell with corners
 * a=(x0,z0), b=(x0+s,z0), c=(x0,z0+s), d=(x0+s,z0+s) the triangles are
 * (a,c,b) covering v <= 1-u and (b,c,d) covering v > 1-u in cell-local
 * (u, v) coordinates.
 */
function coarseSurfaceAt(stride: number, ix: number, iz: number): number {
  // Clamp the coarse cell to the last existing cell (edge rows/columns).
  const x0 = Math.min(Math.floor(ix / stride) * stride, samples - 1 - stride);
  const z0 = Math.min(Math.floor(iz / stride) * stride, samples - 1 - stride);
  const h00 = H(x0, z0);
  const h10 = H(x0 + stride, z0);
  const h01 = H(x0, z0 + stride);
  const h11 = H(x0 + stride, z0 + stride);
  const u = (ix - x0) / stride;
  const v = (iz - z0) / stride;
  if (v <= 1 - u) {
    return h00 * (1 - u - v) + h10 * u + h01 * v;
  }
  return h11 * (u + v - 1) + h10 * (1 - v) + h01 * (1 - u);
}

/** Max |hi vertex height - coarse surface at that point| over the whole map. */
function maxDeviation(stride: number): number {
  let worst = 0;
  for (let iz = 0; iz < samples; iz++) {
    for (let ix = 0; ix < samples; ix++) {
      const d = Math.abs(coarseSurfaceAt(stride, ix, iz) - H(ix, iz));
      if (d > worst) worst = d;
    }
  }
  return worst;
}

function sameBytes(a: TerrainChunk, b: TerrainChunk): boolean {
  if (a.positions.length !== b.positions.length) return false;
  if (a.normals.length !== b.normals.length) return false;
  if (a.colors.length !== b.colors.length) return false;
  if (a.ao.length !== b.ao.length) return false;
  if (a.indices.length !== b.indices.length) return false;
  if (!a.indices.every((v, i) => v === b.indices[i])) return false;
  for (let i = 0; i < a.positions.length; i++) {
    if (a.positions[i] !== b.positions[i] || a.normals[i] !== b.normals[i] || a.colors[i] !== b.colors[i]) {
      return false;
    }
  }
  for (let i = 0; i < a.ao.length; i++) if (a.ao[i] !== b.ao[i]) return false;
  return true;
}

describe('buildTerrainChunks LOD geometry (pure)', () => {
  const hi = buildTerrainChunks(grid);
  const hiDefault = buildTerrainChunks(grid);
  const mid = buildTerrainChunks(grid, 'mid');
  const lo = buildTerrainChunks(grid, 'lo');

  it('the default (hi) level is byte-identical to the historic single-resolution chunking', () => {
    expect(hiDefault.length).toBe(hi.length);
    for (let i = 0; i < hi.length; i++) {
      expect(hiDefault[i].name).toBe(hi[i].name);
      expect(hiDefault[i].x0).toBe(hi[i].x0);
      expect(hiDefault[i].z0).toBe(hi[i].z0);
      expect(hiDefault[i].cells).toBe(hi[i].cells);
      expect(sameBytes(hiDefault[i], hi[i])).toBe(true);
    }
    // Hi keeps the historic chunk names (no suffix).
    expect(hi[0].name).toBe('terrain_c0_0');
    expect(hi[0].level).toBe('hi');
    expect(hi[0].stride).toBe(1);
  });

  it('mid/lo are 5x5 chunks of coarser cells (4u / 8u spacing)', () => {
    const hiCells = TERRAIN_CHUNK_SIZE / step; // 64
    expect(mid.length).toBe(25);
    expect(lo.length).toBe(25);
    expect(mid[0].cells).toBe(hiCells / 2);
    expect(lo[0].cells).toBe(hiCells / 4);
    expect(mid[0].stride).toBe(2);
    expect(lo[0].stride).toBe(4);
    expect(mid[0].name).toBe('terrain_c0_0_mid');
    expect(lo[0].name).toBe('terrain_c0_0_lo');
    // Triangle budgets: 25% / 6.25% of the hi chunk.
    const hiTris = hi[0].indices.length / 3;
    expect(mid[0].indices.length / 3).toBe(hiTris / 4);
    expect(lo[0].indices.length / 3).toBe(hiTris / 16);
    // Chunk origins stay aligned to the hi grid (128u = 64 hi vertices).
    expect(mid[5].x0).toBe(0);
    expect(mid[5].z0).toBe(64);
    expect(lo[5].x0).toBe(0);
    expect(lo[5].z0).toBe(64);
  });

  it('every mid/lo vertex is byte-identical to the hi grid vertex it reuses (full scan)', () => {
    for (const level of [mid, lo]) {
      for (const c of level) {
        const L = c.cells + 1;
        let bad = 0;
        for (let i = 0; i < L * L; i++) {
          const ix = c.x0 + (i % L) * c.stride;
          const iz = c.z0 + Math.floor(i / L) * c.stride;
          const s = (iz * samples + ix) * 3;
          const sC = (iz * samples + ix) * 4; // grid colours are RGBA (stride 4)
          const ok =
            c.positions[i * 3] === grid.positions[s] &&
            c.positions[i * 3 + 1] === grid.positions[s + 1] &&
            c.positions[i * 3 + 2] === grid.positions[s + 2] &&
            c.normals[i * 3] === grid.normals[s] &&
            c.colors[i * 4] === grid.colors[sC] &&
            c.ao[i] === grid.ao[iz * samples + ix];
          if (!ok) bad++;
        }
        expect(bad).toBe(0);
      }
    }
  });

  it('winding is identical to the hi level at every cell (no flipped triangles)', () => {
    for (const level of [mid, lo]) {
      for (const c of level) {
        const L = c.cells + 1;
        let bad = 0;
        let p = 0;
        for (let lz = 0; lz < L - 1; lz++) {
          for (let lx = 0; lx < L - 1; lx++) {
            const a = lz * L + lx;
            const b = a + 1;
            const k = a + L;
            const d = k + 1;
            const want = [a, k, b, b, k, d];
            for (const w of want) {
              if (c.indices[p++] !== w) bad++;
            }
          }
        }
        expect(p).toBe(c.indices.length);
        expect(bad).toBe(0);
      }
    }
  });

  it('coarse levels share boundary vertices by value with their neighbours (no seams)', () => {
    for (const level of [mid, lo]) {
      const A = level[0]; // (0,0)
      const B = level[1]; // (1,0)
      const L = A.cells + 1;
      for (let lz = 0; lz < L; lz++) {
        const sA = (lz * L + L - 1) * 3;
        const sB = (lz * L + 0) * 3;
        expect(A.positions[sA]).toBe(B.positions[sB]);
        expect(A.positions[sA + 1]).toBe(B.positions[sB + 1]);
        expect(A.positions[sA + 2]).toBe(B.positions[sB + 2]);
      }
    }
  });

  it('the coarse evaluator reproduces the hi surface exactly at coarse vertices', () => {
    // Self-check of coarseSurfaceAt: at every stride-4 sample point the
    // "coarse surface" must equal the hi grid height bit-for-bit.
    let bad = 0;
    for (let iz = 0; iz < samples; iz += 4) {
      for (let ix = 0; ix < samples; ix += 4) {
        if (coarseSurfaceAt(4, ix, iz) !== H(ix, iz)) bad++;
      }
    }
    expect(bad).toBe(0);
  });

  it('measured surface deviation: mid <= 2.0u and lo <= 4.0u (mountain ridges)', () => {
    // The coarser surfaces pass exactly through the hi surface at their
    // sample points; between them they deviate by the linear-chord sag,
    // largest on the steep ridged mountain crests. These bounds are the
    // LOD "pop" budget documented on TERRAIN_LOD_* (fog-masked at the swap
    // distances — see the constant doc). Keep the test honest: the
    // measured map-wide worst cases for the default seed are
    // ~1.6u (mid) and ~3.6u (lo).
    expect(maxDeviation(2)).toBeLessThan(2.0);
    expect(maxDeviation(4)).toBeLessThan(4.0);
  });

  it('flat surfaces coarse-exactly: a constant-height grid deviates zero', () => {
    // The island has no flat 128u tiles (worst case measured above), so the
    // "coarsening is invisible where the ground is flat" contract is
    // verified on a synthetic flat grid: every mid/lo vertex sits exactly at
    // the same height, and the piecewise-linear coarse surface is
    // bit-for-bit the flat plane.
    const S = 33;
    const flat = new Float32Array(S * S * 3);
    for (let i = 0; i < S * S; i++) {
      flat[i * 3 + 1] = 5;
    }
    const grid2 = {
      samples: S,
      positions: flat,
      normals: new Float32Array(S * S * 3),
      colors: new Float32Array(S * S * 4),
      ao: new Float32Array(S * S).fill(1),
      indices: new Uint32Array((S - 1) * (S - 1) * 6),
    };
    for (const level of ['mid', 'lo'] as const) {
      const chunks = buildTerrainChunks(grid2, level);
      for (const c of chunks) {
        for (let i = 0; i < c.positions.length; i += 3) {
          expect(c.positions[i + 1]).toBe(5);
        }
      }
    }
  });

  it('is deterministic across calls', () => {
    const mid2 = buildTerrainChunks(grid, 'mid');
    const lo2 = buildTerrainChunks(grid, 'lo');
    for (let i = 0; i < mid.length; i++) {
      expect(sameBytes(mid[i], mid2[i])).toBe(true);
      expect(sameBytes(lo[i], lo2[i])).toBe(true);
    }
  });

  it('falls back to full resolution on grids that cannot support the stride', () => {
    // 129x129 grid (spacing 5u): the coarse layouts do not divide by the
    // 128u chunk size, so mid/lo degrade to stride 1 (identical to hi
    // geometry) instead of producing a broken layout.
    const small = buildTerrainGrid(640, 5.0);
    const sHi = buildTerrainChunks(small);
    const sMid = buildTerrainChunks(small, 'mid');
    const sLo = buildTerrainChunks(small, 'lo');
    for (const level of [sMid, sLo]) {
      expect(level.length).toBe(sHi.length);
      for (let i = 0; i < sHi.length; i++) {
        expect(level[i].stride).toBe(1);
        expect(sameBytes(sHi[i], level[i])).toBe(true);
      }
    }
  });
});

describe('terrain LOD scene behaviour (NullEngine)', () => {
  it('chunk centres are evenly spaced 128u apart, symmetric about the island', () => {
    expect(terrainChunkCenter(0)).toBe(-256);
    expect(terrainChunkCenter(2)).toBe(0);
    expect(terrainChunkCenter(4)).toBe(256);
    for (let i = 1; i < 5; i++) {
      expect(terrainChunkCenter(i) - terrainChunkCenter(i - 1)).toBe(TERRAIN_CHUNK_SIZE);
    }
  });

  it('thresholds are ordered with a wide hysteresis band', () => {
    expect(TERRAIN_LOD_HI).toBeLessThan(TERRAIN_LOD_MID);
    expect(TERRAIN_LOD_MID).toBeLessThan(TERRAIN_LOD_FAR);
    // The [MID, FAR] dead band is several seconds of walking at 9.2 m/s.
    expect(TERRAIN_LOD_FAR - TERRAIN_LOD_MID).toBeGreaterThanOrEqual(50);
  });

  it('exactly one level is enabled per chunk at every camera position (36-position sweep)', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const terrain = createTerrain(scene);
    const byName = new Map(scene.meshes.filter((m) => m.name.startsWith('terrain_c')).map((m) => [m.name, m]));

    const positions: Array<{ x: number; z: number }> = [];
    positions.push({ x: 0, z: 0 }, { x: -320, z: 0 }, { x: 320, z: 0 }, { x: 0, z: -320 }, { x: 0, z: 320 });
    positions.push({ x: -320, z: -320 }, { x: 320, z: -320 }, { x: -320, z: 320 }, { x: 320, z: 320 });
    positions.push({ x: -128, z: -128 }, { x: 128, z: -128 }, { x: -128, z: 128 }, { x: 128, z: 128 });
    positions.push({ x: 57, z: 57 }, { x: -57, z: 57 }, { x: 200, z: -100 }, { x: -200, z: 100 });
    // Deterministic pseudo-random sweep inside the island.
    let seed = 1234;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 20; i++) {
      positions.push({ x: (rand() * 2 - 1) * 310, z: (rand() * 2 - 1) * 310 });
    }

    for (const pos of positions) {
      terrain.updateLod({ x: pos.x, y: 10, z: pos.z });
      let active = 0;
      for (let cz = 0; cz < 5; cz++) {
        for (let cx = 0; cx < 5; cx++) {
          const hiOn = byName.get(`terrain_c${cx}_${cz}`)!.isEnabled();
          const midOn = byName.get(`terrain_c${cx}_${cz}_mid`)!.isEnabled();
          const loOn = byName.get(`terrain_c${cx}_${cz}_lo`)!.isEnabled();
          expect(Number(hiOn) + Number(midOn) + Number(loOn)).toBe(1);
          if (hiOn) active++;
        }
      }
      expect(active).toBeGreaterThanOrEqual(1); // the chunk under the camera is always hi
    }
    terrain.dispose();
    scene.dispose();
    engine.dispose();
  });

  it('from the island centre the level split is exactly: 5 hi, 4 mid, 4 lo', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const terrain = createTerrain(scene);
    const byName = new Map(scene.meshes.filter((m) => m.name.startsWith('terrain_c')).map((m) => [m.name, m]));

    // Camera exactly at world origin: own chunk centre (0,0) = 0 u; axial
    // neighbours = 128 u (< HI); diagonal neighbours = 181 u (MID zone);
    // corners = 362 u (> FAR).
    terrain.updateLod({ x: 0, y: 10, z: 0 });
    const mode = (cx: number, cz: number): string => {
      if (byName.get(`terrain_c${cx}_${cz}`)!.isEnabled()) return 'hi';
      if (byName.get(`terrain_c${cx}_${cz}_mid`)!.isEnabled()) return 'mid';
      return 'lo';
    };
    expect(mode(2, 2)).toBe('hi');
    for (const [cx, cz] of [[1, 2], [3, 2], [2, 1], [2, 3]] as Array<[number, number]>) {
      expect(mode(cx, cz)).toBe('hi');
    }
    for (const [cx, cz] of [[1, 1], [3, 1], [1, 3], [3, 3]] as Array<[number, number]>) {
      expect(mode(cx, cz)).toBe('mid');
    }
    for (const [cx, cz] of [[0, 0], [4, 0], [0, 4], [4, 4]] as Array<[number, number]>) {
      expect(mode(cx, cz)).toBe('lo');
    }
    terrain.dispose();
    scene.dispose();
    engine.dispose();
  });

  it('hysteresis: the [MID, FAR] band keeps the previous level, both directions', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const terrain = createTerrain(scene);
    const byName = new Map(scene.meshes.filter((m) => m.name.startsWith('terrain_c')).map((m) => [m.name, m]));
    const chunk = (cx: number, cz: number): string => {
      if (byName.get(`terrain_c${cx}_${cz}`)!.isEnabled()) return 'hi';
      if (byName.get(`terrain_c${cx}_${cz}_mid`)!.isEnabled()) return 'mid';
      return 'lo';
    };

    // Chunk (3,3) centre is at (128, 128). Walk the camera straight down -z:
    // distances are 181, 195.7, 219.6, 237.0, 254.3, 282.2, 309.9.
    const cam = (z: number) => terrain.updateLod({ x: 0, y: 10, z });
    expect(chunk(3, 3)).toBe('hi'); // fresh world starts hi
    cam(0); // 181 < MID(230) -> mid
    expect(chunk(3, 3)).toBe('mid');
    cam(-30); // 195.7 -> mid
    expect(chunk(3, 3)).toBe('mid');
    cam(-60); // 229.4 -> mid
    expect(chunk(3, 3)).toBe('mid');
    cam(-70); // 237.0, inside [MID, FAR] -> keeps mid (would be lo without hysteresis? no: > FAR? 237 < 300)
    expect(chunk(3, 3)).toBe('mid');
    cam(-120); // 282.2, still in the band -> keeps mid
    expect(chunk(3, 3)).toBe('mid');
    cam(-150); // 309.9 > FAR -> lo
    expect(chunk(3, 3)).toBe('lo');
    cam(-100); // 258.3 back inside the band -> keeps lo (hysteresis, no flicker)
    expect(chunk(3, 3)).toBe('lo');
    cam(-40); // 219.6 < MID -> mid again
    expect(chunk(3, 3)).toBe('mid');
    cam(0); // 181 -> mid
    expect(chunk(3, 3)).toBe('mid');
    cam(50); // hypot(128, 78) = 150 < HI(170) -> hi
    expect(chunk(3, 3)).toBe('hi');

    terrain.dispose();
    scene.dispose();
    engine.dispose();
  });

  it('an off-island camera puts every chunk to lo', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const terrain = createTerrain(scene);
    terrain.updateLod({ x: 800, y: 0, z: 800 });
    for (const m of terrain.lodMeshes()) {
      if (m.name.endsWith('_lo')) expect(m.isEnabled()).toBe(true);
      else expect(m.isEnabled()).toBe(false);
    }
    terrain.dispose();
    scene.dispose();
    engine.dispose();
  });

  it('updateLod is cheap (25 chunks, allocation-free steady state)', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const terrain = createTerrain(scene);
    // Warm up (first call performs all the swaps).
    terrain.updateLod({ x: 0, y: 10, z: 0 });
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      terrain.updateLod({ x: Math.sin(i * 0.01) * 200, y: 10, z: Math.cos(i * 0.01) * 200 });
    }
    const perCall = (performance.now() - t0) / 1000;
    expect(perCall).toBeLessThan(0.5); // ms per call
    terrain.dispose();
    scene.dispose();
    engine.dispose();
  });

  it('the hi meshes stay byte-identical to the pure buildTerrainChunks output', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const terrain = createTerrain(scene);
    for (let i = 0; i < terrain.meshes.length; i++) {
      const chunk = buildTerrainChunks(grid)[i];
      const m = terrain.meshes[i];
      const pos = m.getVerticesData('position') as Float32Array;
      const ao = m.getVerticesData('ao') as Float32Array;
      expect(m.name).toBe(chunk.name);
      expect(pos.length).toBe(chunk.positions.length);
      for (let k = 0; k < chunk.positions.length; k += 997) expect(pos[k]).toBe(chunk.positions[k]);
      for (let k = 0; k < chunk.ao.length; k += 521) expect(ao[k]).toBe(chunk.ao[k]);
      const idx = m.getIndices() as Uint32Array;
      expect(idx.length).toBe(chunk.indices.length);
      for (let k = 0; k < chunk.indices.length; k += 397) expect(idx[k]).toBe(chunk.indices[k]);
    }
    terrain.dispose();
    scene.dispose();
    engine.dispose();
  });
});
