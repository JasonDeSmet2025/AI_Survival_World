/**
 * Mesh-exact terrain raycast (pure logic, no Babylon imports).
 *
 * The rendered terrain is a piecewise-linear triangle grid. This module
 * ray-marches that EXACT grid (single source of truth: `terrainVertexHeights`
 * in heightfield.ts — the same triangles and winding as `buildTerrainGrid`
 * and `groundSurfaceHeight`) using Amanatides & Woo grid DDA plus an exact
 * analytic intersection test against each visited cell's two triangles.
 *
 * Uses:
 *  - Third-person camera occlusion (the camera must never end up inside, or
 *    look through, a hill — the look ray is the ground truth).
 *  - Future line-of-sight / placement queries.
 *
 * The ray is tested against the height field only, NOT the water surface, so
 * a lake does not block the camera (water is a separate visual mesh).
 */
import { TERRAIN_SIZE, terrainVertexHeights } from './heightfield';

/** A hit on the rendered terrain surface. */
export interface TerrainRayHit {
  /** Euclidean distance from the origin along the (unit) direction. */
  t: number;
  /** World-space hit point on the surface. */
  x: number;
  y: number;
  z: number;
  /** Surface normal of the triangle that was hit (unit vector). */
  nx: number;
  ny: number;
  nz: number;
}

/**
 * Cast a ray against the rendered terrain grid and return the NEAREST hit
 * within `maxDist`, or null when the ray misses the surface.
 *
 * @param ox,oy,oz  ray origin (world space)
 * @param dx,dy,dz  ray direction (any scale; it is normalised internally so
 *                  `t` is a real world distance)
 * @param maxDist   maximum distance to test (world units, >= 0)
 */
export function terrainRayHit(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
): TerrainRayHit | null {
  if (maxDist <= 0) return null;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-9) return null;
  const ux = dx / len;
  const uy = dy / len;
  const uz = dz / len;

  const g = terrainVertexHeights();
  const size = TERRAIN_SIZE;
  const step = g.step;
  const half = size / 2;
  const n = g.samples;
  const H = g.heights;
  const min = -half;

  // Grid-space origin cell.
  let ix = Math.floor((ox - min) / step);
  let iz = Math.floor((oz - min) / step);

  // World distance to advance one grid cell along each axis.
  const tDeltaX = ux !== 0 ? step / Math.abs(ux) : Infinity;
  const tDeltaZ = uz !== 0 ? step / Math.abs(uz) : Infinity;
  const stepX = ux >= 0 ? 1 : -1;
  const stepZ = uz >= 0 ? 1 : -1;

  // tMax: world distance at which the ray crosses the NEXT grid line on each
  // axis, measured from the origin (stays exact across steps).
  let tMaxX: number;
  if (ux > 0) tMaxX = (min + (ix + 1) * step - ox) / ux;
  else if (ux < 0) tMaxX = (min + ix * step - ox) / ux;
  else tMaxX = Infinity;
  let tMaxZ: number;
  if (uz > 0) tMaxZ = (min + (iz + 1) * step - oz) / uz;
  else if (uz < 0) tMaxZ = (min + iz * step - oz) / uz;
  else tMaxZ = Infinity;

  // Snap a behind-origin (negative) tMax to 0 so we still test the start cell.
  if (tMaxX < 0) tMaxX = 0;
  if (tMaxZ < 0) tMaxZ = 0;

  let best: TerrainRayHit | null = null;

  // Hard cap on visited cells (defensive; camera rays visit a handful).
  for (let iter = 0; iter < n + 8; iter++) {
    if (ix >= 0 && ix <= n - 2 && iz >= 0 && iz <= n - 2) {
      const hit = testCell(ix, iz, ox, oy, oz, ux, uy, uz, maxDist, H, n, step, min);
      if (hit && (!best || hit.t < best.t)) best = hit;
    }

    // Stop once we have marched past the far side of the tile in BOTH axes.
    const beyondX = (stepX > 0 && ix > n - 2) || (stepX < 0 && ix < 0);
    const beyondZ = (stepZ > 0 && iz > n - 2) || (stepZ < 0 && iz < 0);
    if ((beyondX || tMaxX > maxDist) && (beyondZ || tMaxZ > maxDist)) break;

    if (tMaxX < tMaxZ) {
      ix += stepX;
      tMaxX += tDeltaX;
    } else {
      iz += stepZ;
      tMaxZ += tDeltaZ;
    }
  }

  return best;
}

/**
 * Exact analytic ray vs the two triangles of grid cell (ix, iz).
 * Both triangles share the cell's four corner heights, so each plane is
 * derived in O(1) from the height grid (no cross products).
 */
function testCell(
  ix: number,
  iz: number,
  ox: number,
  oy: number,
  oz: number,
  ux: number,
  uy: number,
  uz: number,
  maxDist: number,
  H: Float32Array,
  n: number,
  step: number,
  min: number,
): TerrainRayHit | null {
  const x0 = min + ix * step;
  const z0 = min + iz * step;
  const x1 = x0 + step;
  const z1 = z0 + step;
  const h00 = H[iz * n + ix];
  const h10 = H[iz * n + ix + 1];
  const h01 = H[(iz + 1) * n + ix];
  const h11 = H[(iz + 1) * n + ix + 1];

  // Triangle (a, c, b): corners h00 (x0,z0), h01 (x0,z1), h10 (x1,z0).
  const a = (h10 - h00) / step; // d(height)/dx
  const b = (h01 - h00) / step; // d(height)/dz
  const c = h00 - a * x0 - b * z0;
  const r1 = intersectTriangle(ox, oy, oz, ux, uy, uz, maxDist, a, b, c, x0, z0, x1, z1, true);
  if (r1) return r1;

  // Triangle (b, c, d): corners h10 (x1,z0), h01 (x0,z1), h11 (x1,z1).
  // Slopes must be taken from vertex pairs sharing one axis:
  //  x-slope from c(x0,z1) -> d(x1,z1); z-slope from b(x1,z0) -> d(x1,z1).
  const a2 = (h11 - h01) / step;
  const b2 = (h11 - h10) / step;
  const c2 = h10 - a2 * x1 - b2 * z0;
  return intersectTriangle(ox, oy, oz, ux, uy, uz, maxDist, a2, b2, c2, x0, z0, x1, z1, false);
}

/**
 * Solve the ray against the heightfield plane y = a*x + b*z + c, restricted
 * to one of the two triangles of the cell. `which` picks the triangle:
 *  true  -> (x0,z0),(x0,z1),(x1,z0)
 *  false -> (x1,z0),(x0,z1),(x1,z1)
 */
function intersectTriangle(
  ox: number,
  oy: number,
  oz: number,
  ux: number,
  uy: number,
  uz: number,
  maxDist: number,
  a: number,
  b: number,
  c: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  which: boolean,
): TerrainRayHit | null {
  // oy + uy*t = a*(ox + ux*t) + b*(oz + uz*t) + c
  const denom = uy - a * ux - b * uz;
  if (Math.abs(denom) < 1e-9) return null; // parallel to the plane
  const t = (a * ox + b * oz + c - oy) / denom;
  if (t <= 1e-6 || t > maxDist) return null;

  const hx = ox + ux * t;
  const hz = oz + uz * t;
  if (!inTriangleXZ(hx, hz, x0, z0, x1, z1, which)) return null;

  const hy = oy + uy * t;
  // Surface normal of the plane (up-facing, unit).
  const nl = Math.hypot(a, 1, b);
  return {
    t,
    x: hx,
    y: hy,
    z: hz,
    nx: -a / nl,
    ny: 1 / nl,
    nz: -b / nl,
  };
}

/** 2D point-in-triangle test for the two canonical heightfield triangles. */
function inTriangleXZ(
  px: number,
  pz: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  which: boolean,
): boolean {
  const eps = 1e-7;
  if (which) {
    // Triangle (x0,z0),(x0,z1),(x1,z0).
    if (px < x0 - eps || pz < z0 - eps) return false;
    const u = (px - x0) / (x1 - x0);
    const v = (pz - z0) / (z1 - z0);
    return u >= -eps && v >= -eps && u + v <= 1 + eps;
  }
  // Triangle (x1,z0),(x0,z1),(x1,z1).
  if (px > x1 + eps || pz > z1 + eps) return false;
  const u = (px - x1) / (x0 - x1);
  const v = (pz - z1) / (z0 - z1);
  return u >= -eps && v >= -eps && u + v <= 1 + eps;
}
