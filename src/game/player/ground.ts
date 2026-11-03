/**
 * Ground sampler that matches the RENDERED terrain mesh exactly.
 *
 * Physics code must never query the analytic `terrainHeight` function
 * directly for surface contact: the visible terrain is a coarse triangle
 * grid (see `buildTerrainGrid` in world/heightfield.ts) and on steep
 * mountain ground the linear triangles deviate from the analytic curve.
 * Standing on the analytic curve makes the player sink into the rendered
 * mesh (legs/torso end up hidden under the ground) and lets the camera
 * dip below the visible surface (ground seen from underneath).
 *
 * `groundHeight` performs the same piecewise-linear triangle
 * interpolation the mesh actually renders, so the physical feet always
 * rest exactly on the visible ground.
 *
 * IMPORTANT: the grid constants below must stay in sync with
 * `buildTerrainGrid` (SIZE / spacing / SAMPLES formula and the vertex
 * height values). `ground.test.ts` guards this contract by comparing
 * against the real mesh geometry.
 */
import { clamp } from '../core/noise';
import { TERRAIN_SIZE, TARGET_SPACING, terrainHeight } from '../world/heightfield';

/** Grid size — identical to buildTerrainGrid(size). */
const SIZE = TERRAIN_SIZE;
/** Identical formula to buildTerrainGrid. */
const SAMPLES = Math.min(513, Math.max(129, Math.round(SIZE / TARGET_SPACING) + 1));
const STEP = SIZE / (SAMPLES - 1);

/**
 * Grid vertex heights are memoized: a moving player only reuses a handful
 * of corner cells per frame, so this turns ~4 fbm evaluations per query
 * into 0 in the common case.
 */
const cornerCache = new Map<number, number>();
const CACHE_LIMIT = 4096;

function cornerHeight(ix: number, iz: number): number {
  const key = ix * SAMPLES + iz;
  const hit = cornerCache.get(key);
  if (hit !== undefined) return hit;
  const h = terrainHeight(-SIZE / 2 + ix * STEP, -SIZE / 2 + iz * STEP);
  if (cornerCache.size >= CACHE_LIMIT) cornerCache.clear();
  cornerCache.set(key, h);
  return h;
}

/**
 * Height of the rendered terrain surface at (x, z).
 *
 * Exact triangle interpolation on the same grid as `buildTerrainGrid`,
 * using the same winding (triangles a-c-b and b-c-d).
 */
export function groundHeight(x: number, z: number): number {
  const u = clamp((x + SIZE / 2) / STEP, 0, SAMPLES - 1);
  const v = clamp((z + SIZE / 2) / STEP, 0, SAMPLES - 1);
  const ix = Math.floor(u);
  const iz = Math.floor(v);
  const fx = u - ix;
  const fz = v - iz;

  const x0 = Math.min(ix, SAMPLES - 1);
  const x1 = Math.min(ix + 1, SAMPLES - 1);
  const z0 = Math.min(iz, SAMPLES - 1);
  const z1 = Math.min(iz + 1, SAMPLES - 1);

  const h00 = cornerHeight(x0, z0);
  const h10 = cornerHeight(x1, z0);
  const h01 = cornerHeight(x0, z1);
  const h11 = cornerHeight(x1, z1);

  // Lower-left triangle (a, c, b) vs upper-right triangle (b, c, d).
  return fx + fz <= 1
    ? h00 * (1 - fx - fz) + h10 * fx + h01 * fz
    : h10 * (1 - fz) + h01 * (1 - fx) + h11 * (fx + fz - 1);
}

/** Ground height with a small upward margin, for camera-style guards. */
export function groundHeightAbove(x: number, z: number, margin = 0.5): number {
  return groundHeight(x, z) + margin;
}
