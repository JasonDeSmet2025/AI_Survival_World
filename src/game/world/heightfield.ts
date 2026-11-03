/**
 * Pure procedural world height field (no Babylon imports) so the terrain
 * maths are unit-testable in Node.
 *
 * The island is a single deterministic function of (x, z): a large-scale
 * landform, rolling hills, a mountain ridge region, an inland lake basin
 * and a coastal/beach transition, all masked by a radial island fade so
 * the map fades into a deep ocean floor at its edges.
 */
import { clamp, fbm, lerp, ridged, smoothstep } from '../core/noise';

/** Width/depth of the square terrain tile in world units. */
export const TERRAIN_SIZE = 640;
/** World Y level of the sea surface. */
export const SEA_LEVEL = 0;
/** Default deterministic world seed. */
export const WORLD_SEED = 0x5eed2024;

/**
 * Inland lake basin (deterministic world feature). It is a depression in
 * the height field; the shared ocean water plane (y = SEA_LEVEL) fills it,
 * so it only reads as a lake where the surrounding rim stays above sea
 * level.
 */
export const LAKE = { x: 20, z: 110, radius: 32, depth: 9 };

/**
 * Deterministic island height field.
 *
 * A guaranteed central landmass (the `dome`) keeps the island interior dry,
 * while large-scale relief, rolling hills and ridged mountains are masked
 * into it. The radial mask fades the whole thing to zero at an irregular
 * coastline (wobbled by low-frequency noise for bays and peninsulas) and the
 * floor drops to a deep ocean bed beyond. Layers:
 *  - dome:  broad interior elevation so the core is always above sea level.
 *  - base:  large-scale relief (a few hundred unit features).
 *  - hills: rolling mid-frequency relief.
 *  - mtn:   ridged mountain peaks, only where the mountain mask is high.
 *  - ocean: deep floor outside the coast.
 *  - lake:  inland basin.
 * A shallow beach-flattening band softens the waterline on dry land only.
 */
export function terrainHeight(x: number, z: number): number {
  const half = TERRAIN_SIZE / 2;
  const nx = x / half;
  const nz = z / half;
  const r = Math.hypot(nx, nz);

  // Irregular coastline: wobble the effective radius for bays & peninsulas.
  const coastNoise = fbm(x * 0.006 + 3.3, z * 0.006 + 7.7, 3);
  const rEff = r * (0.8 + 0.36 * coastNoise);

  const fade = smoothstep((rEff - 0.38) / 0.48); // 0 centre -> 1 coast -> 1 beyond
  const mask = Math.max(0, 1 - fade); // 1 interior -> 0 at/after the coast

  const base = (fbm(x * 0.005 + 5.2, z * 0.005 + 8.1, 4) - 0.5) * 2; // large relief
  const hills = (fbm(x * 0.016 + 21.7, z * 0.016 + 13.9, 4) - 0.5) * 2; // rolling
  const mMask = clamp((fbm(x * 0.004 + 11.3, z * 0.004 + 7.7, 4) - 0.5) * 3.2, 0, 1);
  const mtn = (ridged(x * 0.007 + 3.1, z * 0.007 + 9.4, 4) - 0.3) * 2; // peaks

  const dl = Math.hypot(x - LAKE.x, z - LAKE.z) / LAKE.radius;
  const lake = -LAKE.depth * (1 - smoothstep((dl - 0.25) / 0.5));

  let h =
    12 * mask + // interior landmass dome (keeps the core dry)
    base * 16 * mask + // large-scale relief
    hills * 7 * mask + // rolling hills
    mtn * 30 * mMask * mask + // mountains
    -34 * fade + // deep ocean floor outside the coast
    lake * mask;

  // Beach flattening: on dry coastal ground only (not deep water, not the
  // lake basin) so the shoreline reads as a soft sandy beach.
  if (h >= 0 && h < 2.6 && mask > 0.3 && !isNearLake(x, z, 4)) {
    const t = clamp((h + 2) / 4.6, 0, 1);
    h = lerp(0.35, h, 0.15 + 0.85 * t * t);
  }
  return h;
}

/** True when a point lies in (or near) the lake basin. */
export function isNearLake(x: number, z: number, pad = 0): boolean {
  return Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.radius + pad;
}

/** Estimate terrain slope (rise over run) at a point. */
export function terrainSlope(x: number, z: number): number {
  const e = 1.5;
  const dx = terrainHeight(x + e, z) - terrainHeight(x - e, z);
  const dz = terrainHeight(x, z + e) - terrainHeight(x - e, z);
  return Math.hypot(dx, dz) / (2 * e);
}

/** Terrain surface normal as a plain unit vector (approximate). */
export function terrainNormal3(x: number, z: number): { x: number; y: number; z: number } {
  const e = 1.2;
  const hx = terrainHeight(x + e, z) - terrainHeight(x - e, z);
  const hz = terrainHeight(x, z + e) - terrainHeight(x - e, z);
  const vx = -hx / (2 * e);
  const vz = -hz / (2 * e);
  const len = Math.hypot(vx, 1, vz);
  return { x: vx / len, y: 1 / len, z: vz / len };
}

/**
 * Biome weights per vertex: sand / grass / rock / snow (each 0..1, sum ~1).
 * Computed on the CPU so the fragment shader stays cheap.
 */
export function terrainMask(
  x: number,
  z: number,
  h: number,
): { sand: number; grass: number; rock: number; snow: number } {
  const slope = terrainSlope(x, z);

  // Sand: low elevation up to the dune/grass line.
  const sand = 1 - smoothstep((h - 0.3) / 1.9);

  // Rock: high altitude, or steep ground above the beach line.
  let rock = smoothstep((h - 15) / 9);
  rock = Math.max(rock, smoothstep((slope - 1.15) / 0.55) * smoothstep((h - 3) / 6));

  // Snow: only on the highest peaks.
  const snow = smoothstep((h - 25) / 9);

  // Grass fills the remainder.
  const grass = clamp(1 - sand - rock - snow, 0, 1);

  const sum = sand + grass + rock + snow + 1e-6;
  return { sand: sand / sum, grass: grass / sum, rock: rock / sum, snow: snow / sum };
}

/**
 * Finds a comfortable, deterministic spawn point: flat grass, dry, on the
 * island and away from the lake. Scans a coarse grid for the best candidate
 * and always returns a valid dry point (with a safe fallback).
 */
export function findSpawnPoint(): { x: number; z: number; y: number } {
  const half = TERRAIN_SIZE / 2;
  const scan = Math.floor(half * 0.5); // search the inner half of the island
  let best = { x: 0, z: 0, score: -Infinity };
  for (let z = -scan; z <= scan; z += 5) {
    for (let x = -scan; x <= scan; x += 5) {
      const h = terrainHeight(x, z);
      if (h < 1.5 || h > 10) continue;
      if (terrainSlope(x, z) > 0.32) continue;
      if (isNearLake(x, z, 8)) continue;
      const centerDist = Math.hypot(x, z);
      const score = 2000 - centerDist - Math.abs(h - 3) * 10;
      if (score > best.score) best = { x, z, score };
    }
  }
  if (!isFinite(best.score)) {
    // Guaranteed dry fallback: the map centre is inside the island body.
    const fx = 0;
    const fz = 0;
    best = { x: fx, z: fz, score: 0 };
  }
  return { x: best.x, z: best.z, y: terrainHeight(best.x, best.z) };
}

/**
 * Finds a flat spot near spawn for the NPC camp (deterministic ring scan),
 * kept dry and clear of the lake.
 */
export function findCampPoint(spawn: { x: number; z: number }): { x: number; z: number; y: number } {
  for (let radius = 20; radius <= 70; radius += 4) {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 28) {
      const x = spawn.x + Math.cos(a) * radius;
      const z = spawn.z + Math.sin(a) * radius;
      const h = terrainHeight(x, z);
      if (h < 1.2 || h > 9) continue;
      if (terrainSlope(x, z) > 0.3) continue;
      if (isNearLake(x, z, 8)) continue;
      return { x, z, y: h };
    }
  }
  // Fallback: reuse the (valid) spawn location.
  return { x: spawn.x, z: spawn.z, y: terrainHeight(spawn.x, spawn.z) };
}

/** Target terrain vertex spacing in world units (controls mesh resolution). */
export const TARGET_SPACING = 2.0;

export interface TerrainGrid {
  samples: number;
  /** xyz per vertex. */
  positions: Float32Array;
  /** xyz unit normal per vertex. */
  normals: Float32Array;
  /** rgba biome mask per vertex (sand/grass/rock/snow). */
  colors: Float32Array;
  /** triangle index buffer. */
  indices: Uint32Array;
}

/**
 * Builds the island terrain grid (pure geometry, no Babylon): a square
 * heightfield mesh with per-vertex normals and 4-channel biome masks. Kept
 * separate from the rendering code so it is unit-testable in Node.
 */
export function buildTerrainGrid(size = TERRAIN_SIZE, spacing = TARGET_SPACING): TerrainGrid {
  const SAMPLES = Math.min(513, Math.max(129, Math.round(size / spacing) + 1));
  const step = size / (SAMPLES - 1);

  const H = new Float32Array(SAMPLES * SAMPLES);
  for (let iz = 0; iz < SAMPLES; iz++) {
    for (let ix = 0; ix < SAMPLES; ix++) {
      const x = (ix / (SAMPLES - 1) - 0.5) * size;
      const z = (iz / (SAMPLES - 1) - 0.5) * size;
      H[iz * SAMPLES + ix] = terrainHeight(x, z);
    }
  }

  const count = SAMPLES * SAMPLES;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 4);

  for (let iz = 0; iz < SAMPLES; iz++) {
    for (let ix = 0; ix < SAMPLES; ix++) {
      const idx = iz * SAMPLES + ix;
      const x = (ix / (SAMPLES - 1) - 0.5) * size;
      const z = (iz / (SAMPLES - 1) - 0.5) * size;
      const h = H[idx];
      positions[idx * 3] = x;
      positions[idx * 3 + 1] = h;
      positions[idx * 3 + 2] = z;

      // Smooth normal from neighbouring grid heights (central difference).
      const idxL = iz * SAMPLES + Math.max(0, ix - 1);
      const idxR = iz * SAMPLES + Math.min(SAMPLES - 1, ix + 1);
      const idxD = Math.max(0, iz - 1) * SAMPLES + ix;
      const idxU = Math.min(SAMPLES - 1, iz + 1) * SAMPLES + ix;
      const dhdx = (H[idxR] - H[idxL]) / (2 * step);
      const dhdz = (H[idxU] - H[idxD]) / (2 * step);
      let nx = -dhdx;
      let ny = 1;
      let nz = -dhdz;
      const len = Math.hypot(nx, ny, nz);
      normals[idx * 3] = nx / len;
      normals[idx * 3 + 1] = ny / len;
      normals[idx * 3 + 2] = nz / len;

      const m = terrainMask(x, z, h);
      colors[idx * 4] = m.sand;
      colors[idx * 4 + 1] = m.grass;
      colors[idx * 4 + 2] = m.rock;
      colors[idx * 4 + 3] = m.snow;
    }
  }

  const indices = new Uint32Array((SAMPLES - 1) * (SAMPLES - 1) * 6);
  let p = 0;
  for (let iz = 0; iz < SAMPLES - 1; iz++) {
    for (let ix = 0; ix < SAMPLES - 1; ix++) {
      const a = iz * SAMPLES + ix;
      const b = a + 1;
      const c = a + SAMPLES;
      const d2 = c + 1;
      indices[p++] = a;
      indices[p++] = c;
      indices[p++] = b;
      indices[p++] = b;
      indices[p++] = c;
      indices[p++] = d2;
    }
  }

  return { samples: SAMPLES, positions, normals, colors, indices };
}
