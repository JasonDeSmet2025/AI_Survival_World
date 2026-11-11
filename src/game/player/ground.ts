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
 * The implementation lives in world/groundSurface.ts — the shared,
 * mesh-exact surface sampler used by player physics, flora settling,
 * building placement and NPC movement, so every system agrees on the
 * ground the player actually sees. `ground.test.ts` guards the contract
 * against the real mesh geometry.
 */
import { groundSurfaceHeight as surfaceHeight } from '../world/groundSurface';

/**
 * Height of the rendered terrain surface at (x, z).
 *
 * Exact triangle interpolation on the same grid as `buildTerrainGrid`,
 * using the same winding (triangles a-c-b and b-c-d).
 */
export function groundHeight(x: number, z: number): number {
  return surfaceHeight(x, z);
}

/** Ground height with a small upward margin, for camera-style guards. */
export function groundHeightAbove(x: number, z: number, margin = 0.5): number {
  return surfaceHeight(x, z) + margin;
}
