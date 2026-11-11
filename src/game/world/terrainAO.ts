/**
 * Baked per-vertex ambient occlusion for the terrain height field
 * (pure TypeScript, no Babylon imports — unit-testable in Node).
 *
 * The rendered terrain is a smooth, piecewise-linear heightfield mesh. With
 * plain Lambert/hemisphere shading it reads as "plastic": nothing darkens
 * the insides of valleys, the bases of cliffs or the inside of slopes, so
 * large landforms lose their sense of depth (the core reason the reported
 * "unnatural terrain" look survived the palette + noise fixes).
 *
 * `bakeTerrainAO` precomputes one occlusion factor per grid vertex, ONCE,
 * from the SAME height data the mesh renders. At runtime the factor is
 * just a vertex attribute that the terrain shader multiplies into the
 * surface colour — zero per-frame CPU cost, one multiply in the fragment
 * shader.
 *
 * Method (hemisphere sampling, the classic vertex-AO approach):
 *   For each vertex, look around the local normal in `rays` directions,
 *   bilinearly sample the height field at each of `radii` distances and
 *   treat terrain that rises MORE than a tolerated slope as occluding
 *   overhead. Near radii dominate (weight 1/r); occlusion ramps in
 *   smoothly instead of switching on/off (soft "how much higher than
 *   expected" factor). Uniform slopes of `slopeTol` or less never
 *   occlude, so open hillsides stay bright and only genuine concavity
 *   (valleys, bowls, cliff bases, the foot of a slope backed by a rise)
 *   darkens.
 *
 * Determinism: every input is a deterministic function of the
 * deterministic height grid; the per-vertex ray fan gets a fixed
 * integer-hash angle offset (same family as the bounded shader hash in
 * noiseGLSL.ts) purely to decorrelate neighbouring vertices — no
 * randomness, identical output across runs and machines.
 *
 * Geometry is NEVER modified: positions, normals, indices, biome masks,
 * the shared `terrainVertexHeights` grid, ground sampling (groundSurface)
 * and terrain raycasts all keep using the untouched height field. AO is a
 * purely additive shading attribute.
 */

export interface TerrainAOConfig {
  /** Azimuth rays around each vertex normal (decorrelated per vertex). */
  rays: number;
  /** Sample radii in world units, near first. */
  radii: number[];
  /**
   * Tolerated rise-per-run: terrain at radius r may be up to
   * `slopeTol * r` higher than the vertex without occluding it. Keeps
   * uniform slopes fully lit.
   */
  slopeTol: number;
  /** Readability floor: occlusion never darkens a vertex below this. */
  minAO: number;
}

/** Default bake settings (tuned for a 2 u grid step, 640 u island). */
export const DEFAULT_TERRAIN_AO: TerrainAOConfig = {
  rays: 10,
  radii: [1.4, 3.2, 6.4],
  slopeTol: 0.45,
  minAO: 0.38,
};

/**
 * Bilinear height lookup with edge clamping (samples stay inside the
 * grid; the last cell is extrapolated at most by one cell past the edge,
 * which is negligible for AO on border vertices).
 *
 * NOTE: `Math.trunc`, not `Math.floor` — floor is wrong for negative
 * fractional grid coordinates (floor(-0.3) = -1) and would sample a cell
 * further away than the true position, silently killing occlusion for
 * rays aimed toward -x/-z.
 */
function sampleHeight(
  heights: ArrayLike<number>,
  samples: number,
  step: number,
  half: number,
  x: number,
  z: number,
): number {
  let gx = (x + half) / step;
  let gz = (z + half) / step;
  if (gx < 0) gx = 0;
  else if (gx > samples - 2) gx = samples - 2;
  if (gz < 0) gz = 0;
  else if (gz > samples - 2) gz = samples - 2;
  const ix = Math.trunc(gx);
  const iz = Math.trunc(gz);
  const fx = gx - ix;
  const fz = gz - iz;
  const a = heights[iz * samples + ix];
  const b = heights[iz * samples + ix + 1];
  const c = heights[(iz + 1) * samples + ix];
  const d = heights[(iz + 1) * samples + ix + 1];
  const top = a + (b - a) * fx;
  const bot = c + (d - c) * fx;
  return top + (bot - top) * fz;
}

/**
 * Bake the per-vertex AO map (row-major, one float per grid vertex,
 * 1 = fully lit, `minAO` = fully occluded). Pure: identical input grids
 * always produce byte-identical output. Output is double precision; the
 * caller converts to Float32Array for the GPU vertex buffer.
 */
export function bakeTerrainAO(
  heights: ArrayLike<number>,
  samples: number,
  step: number,
  config: Partial<TerrainAOConfig> = {},
): Float64Array {
  const rays = config.rays ?? DEFAULT_TERRAIN_AO.rays;
  const radii = config.radii ?? DEFAULT_TERRAIN_AO.radii;
  const slopeTol = config.slopeTol ?? DEFAULT_TERRAIN_AO.slopeTol;
  const minAO = config.minAO ?? DEFAULT_TERRAIN_AO.minAO;

  const S = samples;
  const out = new Float64Array(S * S);
  const size = (S - 1) * step;
  const half = size / 2;

  // Near samples dominate: weight 1/r, normalised over the radii set.
  const wSum = radii.reduce((s, r) => s + 1 / r, 0);
  const wR = radii.map((r) => 1 / (r * wSum));

  for (let iz = 0; iz < S; iz++) {
    for (let ix = 0; ix < S; ix++) {
      const x = ix * step - half;
      const z = iz * step - half;
      const h = heights[iz * S + ix];

      // Smooth normal — the same central difference the rendered grid
      // bakes (clamped at the edges), so the AO fan follows the visible
      // surface orientation exactly.
      const hL = heights[iz * S + Math.max(0, ix - 1)];
      const hR = heights[iz * S + Math.min(S - 1, ix + 1)];
      const hD = heights[Math.max(0, iz - 1) * S + ix];
      const hU = heights[Math.min(S - 1, iz + 1) * S + ix];
      let nx = -(hR - hL) / (2 * step);
      let nz = -(hU - hD) / (2 * step);
      const nl = Math.hypot(nx, 1, nz);
      nx /= nl;
      const ny = 1 / nl;
      nz /= nl;

      // Tangent basis: t1 = horizontal component of the normal (or +X on a
      // perfectly flat vertex), t2 = t1 rotated 90 deg in the XZ plane.
      let t1x: number;
      let t1z: number;
      if (1 - ny * ny < 1e-8) {
        t1x = 1;
        t1z = 0;
      } else {
        const tl = Math.hypot(nx, nz);
        t1x = nx / tl;
        t1z = nz / tl;
      }
      const t2x = t1z;
      const t2z = -t1x;

      // Fixed per-vertex angle offset: decorrelates the ray fans of
      // neighbouring vertices without any randomness.
      const off = ((((ix * 7907 + iz * 8101) % 1009) + 1009) % 1009) * 0.00623328664595576; // /1009 * 2π

      let occl = 0;
      for (let r = 0; r < rays; r++) {
        const a = off + (r / rays) * 6.283185307179586;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const dx = ca * t1x + sa * t2x;
        const dz = ca * t1z + sa * t2z;
        let rayOcc = 0;
        for (let k = 0; k < radii.length; k++) {
          const rad = radii[k];
          const sh = sampleHeight(heights, S, step, half, x + dx * rad, z + dz * rad);
          const over = sh - (h + slopeTol * rad);
          if (over > 0) {
            // Soft ramp: "how much higher than the tolerated slope",
            // scaled so modest rises fade in over roughly one world unit.
            const f = over / (0.6 + 0.22 * rad);
            rayOcc += wR[k] * (f < 1 ? f : 1);
          }
        }
        occl += rayOcc;
      }

      let ao = 1 - occl / rays;
      if (ao < minAO) ao = minAO;
      else if (ao > 1) ao = 1;
      out[iz * S + ix] = ao;
    }
  }
  return out;
}

/**
 * Production path: bake AO on a strided subgrid (every `factor`-th
 * vertex; the world extent is unchanged) and bilinearly upsample to the
 * full grid.
 *
 * AO is a low-frequency signal (it varies over metres; the grid step is
 * ~2 u), so a half-resolution bake is visually indistinguishable from
 * full resolution while being `factor^2` faster (~2.2 s -> ~0.6 s for the
 * default 321x321 grid on CI-class hardware — worldgen must stay well
 * under the ~5 s startup budget). Pure and deterministic: even-indexed
 * output vertices equal the coarse bake exactly, odd vertices are the
 * bilinear interpolation between them.
 */
export function bakeTerrainAOSubsampled(
  heights: ArrayLike<number>,
  samples: number,
  step: number,
  factor: number,
  config: Partial<TerrainAOConfig> = {},
): Float64Array {
  const S = samples;
  const cSamples = Math.floor((S - 1) / factor) + 1;
  const cStep = step * factor;

  // Coarse grid: keep vertices 0, f, 2f, ... (same min/max world extent).
  const coarse = new Float64Array(cSamples * cSamples);
  for (let cz = 0; cz < cSamples; cz++) {
    for (let cx = 0; cx < cSamples; cx++) {
      coarse[cz * cSamples + cx] = heights[cz * factor * S + cx * factor];
    }
  }
  const coarseAO = bakeTerrainAO(coarse, cSamples, cStep, config);

  // Bilinear upsampling of the coarse AO back onto the full grid.
  const out = new Float64Array(S * S);
  for (let iz = 0; iz < S; iz++) {
    const v = iz / factor;
    const iz0 = Math.min(cSamples - 2, Math.trunc(v));
    const fz = v - iz0;
    const rowBase = iz * S;
    const cRow0 = iz0 * cSamples;
    const cRow1 = (iz0 + 1) * cSamples;
    for (let ix = 0; ix < S; ix++) {
      const u = ix / factor;
      const ix0 = Math.min(cSamples - 2, Math.trunc(u));
      const fx = u - ix0;
      const top = coarseAO[cRow0 + ix0] + (coarseAO[cRow0 + ix0 + 1] - coarseAO[cRow0 + ix0]) * fx;
      const bot = coarseAO[cRow1 + ix0] + (coarseAO[cRow1 + ix0 + 1] - coarseAO[cRow1 + ix0]) * fx;
      out[rowBase + ix] = top + (bot - top) * fz;
    }
  }
  return out;
}
