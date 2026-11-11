/**
 * Mesh-exact terrain surface sampler (pure logic, no Babylon imports).
 *
 * The rendered terrain is a piecewise-linear triangle grid, not the analytic
 * `terrainHeight` curve. On sloped ground the two genuinely differ (up to
 * ~0.5–0.8 world units at the current grid spacing): sampling object
 * placement from the analytic curve made buildings, flora and NPCs float or
 * sink relative to the visible ground ("floating slabs/objects").
 *
 * This module precomputes the EXACT grid that `buildTerrainGrid` renders
 * (single source of truth in heightfield.ts) and interpolates the same
 * triangles, so `groundSurfaceHeight(x, z)` is the height of the surface the
 * player actually sees. Everything that must sit ON the world (flora
 * settling, building placement, NPC walking, player physics) samples here.
 */
import { TERRAIN_SIZE, terrainVertexHeights } from './heightfield';

interface SurfaceGrid {
  samples: number;
  step: number;
  heights: Float32Array;
}

let grid: SurfaceGrid | null = null;

/** The rendered terrain grid (lazy, built once, deterministic). */
function ensureGrid(): SurfaceGrid {
  grid ??= terrainVertexHeights();
  return grid;
}

/**
 * Height of the RENDERED terrain surface at (x, z) — the exact
 * piecewise-linear triangle interpolation of the mesh (same triangles and
 * winding as `buildTerrainGrid`).
 *
 * Coordinates outside the tile are clamped to the tile edge, mirroring the
 * physical ground sampler used by player physics.
 */
export function groundSurfaceHeight(x: number, z: number): number {
  const g = ensureGrid();
  const size = TERRAIN_SIZE;
  const u = Math.min(g.samples - 1, Math.max(0, (x + size / 2) / g.step));
  const v = Math.min(g.samples - 1, Math.max(0, (z + size / 2) / g.step));
  const ix = Math.floor(u);
  const iz = Math.floor(v);
  const fx = u - ix;
  const fz = v - iz;

  const ix2 = Math.min(ix + 1, g.samples - 1);
  const iz2 = Math.min(iz + 1, g.samples - 1);
  const h00 = g.heights[iz * g.samples + ix];
  const h10 = g.heights[iz * g.samples + ix2];
  const h01 = g.heights[iz2 * g.samples + ix];
  const h11 = g.heights[iz2 * g.samples + ix2];

  // Same triangles as buildTerrainGrid: (a,c,b) then (b,c,d).
  return fx + fz <= 1
    ? h00 * (1 - fx - fz) + h10 * fx + h01 * fz
    : h10 * (1 - fz) + h01 * (1 - fx) + h11 * (fx + fz - 1);
}

/**
 * Minimum rendered-surface height within a horizontal radius (8-point
 * lookaround plus the centre point — the same pattern as
 * `minTerrainHeightInRadius`, but evaluated on the mesh the player sees).
 * Used to seat objects on the lowest visible ground inside their footprint.
 */
export function minSurfaceHeightInRadius(x: number, z: number, r: number): number {
  let min = groundSurfaceHeight(x, z);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const h = groundSurfaceHeight(x + Math.cos(a) * r, z + Math.sin(a) * r);
    if (h < min) min = h;
  }
  return min;
}

/** Ground height with a small upward margin, for camera-style guards. */
export function surfaceHeightAbove(x: number, z: number, margin = 0.5): number {
  return groundSurfaceHeight(x, z) + margin;
}
