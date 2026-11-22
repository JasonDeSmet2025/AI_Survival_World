/**
 * Procedural SURFACE DETAIL maps for the terrain material.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Before this module the ground was shaded from two ingredients only: a
 * per-vertex 4-channel biome mask (2 u grid) and a handful of analytic
 * `vnoise` octaves in the fragment shader. Real browsers showed the result:
 *  - close up the ground is a single flat matte tone — no grain, no litter,
 *    no crevices: the "plastic / toy" look,
 *  - at grazing angles the analytic finite-difference normal perturbation
 *    (sub-pixel detail wavelength) aliased into strong view-aligned stripes
 *    ("corduroy") on every slope.
 *
 * Both problems have the same root cause: the detail was generated in
 * screen-incompatible ways instead of being baked into a MIP-MAPPED texture.
 * A texture fixes both at once, because the GPU mip chain + anisotropic
 * filtering automatically raises the detail wavelength as a pixel covers
 * more world area, so far ground shows coarse structure instead of noise
 * aliasing.
 *
 * WHAT IS GENERATED
 * -----------------
 * Three tileable 512x512 RGBA8 detail layers (grass / rock / sand), each
 * generated deterministically from WORLD_SEED with a pure, Babylon-free
 * noise pipeline (unit-testable in Node):
 *   R = d(height)/du   (0.5 neutral)   } consumed as a world-space gradient
 *   G = d(height)/dv   (0.5 neutral)   } to perturb the surface normal
 *   B = albedo detail  (0.5 neutral)     crevice/crest tonal variation
 *   A = specular mask  (0 = matte)       wet rock / damp sand glints
 *
 * Height generation is periodic in both axes by construction (every octave
 * uses an integer lattice count that divides the texture size, and the sand
 * ripples use an integer number of cycles), so the maps tile seamlessly at
 * any world-space repeat distance.
 *
 * Determinism: one seeded mulberry32 stream per layer/octave, no Math.random
 * and no time dependence — every client generates byte-identical maps, which
 * matters because multiplayer clients share a seed and must see the same
 * world.
 */
import { RawTexture, Scene, Texture, Constants } from '@babylonjs/core';
import { clamp, mulberry32 } from '../core/noise';
import { WORLD_SEED } from './heightfield';

/** Width/height of every detail layer in pixels (power of two => full mip chain). */
export const TERRAIN_DETAIL_SIZE = 512;

/** Which detail layer a request refers to. Snow reuses the rock layer. */
export type TerrainDetailLayer = 'grass' | 'rock' | 'sand';

/**
 * Per-layer texture parameters.
 *
 * `tile` is the world distance (in units) after which the layer repeats;
 * the shader divides world XZ by it, so detail density is independent of
 * the terrain mesh resolution. The values are deliberately different per
 * biome: repeating structure at three unrelated periods is much harder for
 * the eye to lock onto than one shared period.
 */
export interface TerrainDetailLayerSpec {
  layer: TerrainDetailLayer;
  /** World units per texture tile. */
  tile: number;
  /** Baked gradient gain: how strongly the height slope is encoded in RG. */
  gain: number;
  /** Albedo detail amplitude baked into B (0 = flat tone). */
  albedo: number;
  /** Specular strength baked into A (0 = fully matte). */
  spec: number;
}

export const DETAIL_LAYERS: Record<TerrainDetailLayer, TerrainDetailLayerSpec> = {
  // Forest floor: fine litter/tufts, low contrast, essentially matte.
  grass: { layer: 'grass', tile: 3.5, gain: 4.0, albedo: 0.55, spec: 0.03 },
  // Exposed stone: cracks + chiselled grain, strong relief, patchy wet sheen.
  rock: { layer: 'rock', tile: 8.0, gain: 3.2, albedo: 0.7, spec: 0.16 },
  // Beach: wind ripples + fine mineral grain, damp between the grains.
  sand: { layer: 'sand', tile: 2.4, gain: 2.6, albedo: 0.42, spec: 0.2 },
};

export const DETAIL_LAYER_NAMES: TerrainDetailLayer[] = ['grass', 'rock', 'sand'];

// ---------------------------------------------------------------------------
// Tileable noise
// ---------------------------------------------------------------------------

/**
 * Random lattice values for one octave, generated from a deterministic
 * stream. `cells` lattice points per axis, wrapping, so the octave is
 * periodic over the whole texture.
 */
function latticeValues(cells: number, rng: () => number): Float32Array {
  const t = new Float32Array(cells * cells);
  for (let i = 0; i < t.length; i++) t[i] = rng();
  return t;
}

/** Quintic smoothstep weight (zero 1st AND 2nd derivative at the lattice). */
function quintic(f: number): number {
  return f * f * f * (f * (f * 6 - 15) + 10);
}

/**
 * Tileable value noise. `u`, `v` are lattice coordinates in [0, cells);
 * indices wrap, so the pattern is periodic with period `cells`.
 */
function tileNoise(table: Float32Array, cells: number, u: number, v: number): number {
  const ix = Math.floor(u);
  const iy = Math.floor(v);
  const fx = quintic(u - ix);
  const fy = quintic(v - iy);
  const m = cells - 1;
  const x0 = ix & m;
  const x1 = (ix + 1) & m;
  const y0 = (iy & m) * cells;
  const y1 = ((iy + 1) & m) * cells;
  const a = table[y0 + x0];
  const b = table[y0 + x1];
  const c = table[y1 + x0];
  const d = table[y1 + x1];
  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return ab + (cd - ab) * fy;
}

/**
 * A reusable octaved noise field: one deterministic lattice per octave.
 * Octave lattice counts are powers of two, which is what makes the wrap
 * (`& (cells - 1)`) exact and the result exactly periodic over the texture.
 */
export interface TileableField {
  octaves: { cells: number; table: Float32Array }[];
}

export function makeTileableField(
  rng: () => number,
  baseCells: number,
  octaves: number,
  lacunarity = 2,
): TileableField {
  const list: TileableField['octaves'] = [];
  let cells = baseCells;
  for (let i = 0; i < octaves; i++) {
    const c = Math.min(TERRAIN_DETAIL_SIZE, Math.max(2, cells));
    list.push({ cells: c, table: latticeValues(c, rng) });
    cells = Math.min(TERRAIN_DETAIL_SIZE, cells * lacunarity);
  }
  return { octaves: list };
}

/** Weighted fbm sum of a TileableField, normalised to [0, 1]. */
export function fieldFbm(field: TileableField, u: number, v: number): number {
  let sum = 0;
  let amp = 0.5;
  let total = 0;
  for (const o of field.octaves) {
    sum += tileNoise(o.table, o.cells, u * (o.cells / TERRAIN_DETAIL_SIZE), v * (o.cells / TERRAIN_DETAIL_SIZE)) * amp;
    total += amp;
    amp *= 0.5;
  }
  return sum / total;
}

/** Ridged (crease) variant of fieldFbm — sharp cracks/crests instead of blobs. */
export function fieldRidged(field: TileableField, u: number, v: number): number {
  let sum = 0;
  let amp = 0.55;
  let total = 0;
  for (const o of field.octaves) {
    const n = tileNoise(o.table, o.cells, u * (o.cells / TERRAIN_DETAIL_SIZE), v * (o.cells / TERRAIN_DETAIL_SIZE));
    sum += (1 - Math.abs(n * 2 - 1)) * amp;
    total += amp;
    amp *= 0.5;
  }
  return sum / total;
}

// ---------------------------------------------------------------------------
// Height fields (pure; one per layer, periodic over the texture)
// ---------------------------------------------------------------------------

/**
 * Forest-floor height field: patchy humus mottling, leaf/litter speckle and
 * a few coarse root/stone bumps. Deliberately low relief (grass is a soft
 * surface, not a rocky one) with strong small-scale breakup, because that is
 * exactly what the eye reads as "ground" instead of "flat green sheet".
 */
export function buildDetailHeight(layer: TerrainDetailLayer, seed = WORLD_SEED): Float32Array {
  const S = TERRAIN_DETAIL_SIZE;
  const h = new Float32Array(S * S);
  // One independent deterministic stream per layer AND per octave family, so
  // changing one layer never shifts another (keeps earlier art direction
  // stable when a layer is tuned).
  const base = seed >>> 0;
  const seedFor = (n: number) => (base ^ Math.imul(n + 1, 0x9e3779b1)) >>> 0;

  if (layer === 'grass') {
    const humus = makeTileableField(mulberry32(seedFor(1)), 4, 4);
    const patch = makeTileableField(mulberry32(seedFor(2)), 2, 3);
    const litter = makeTileableField(mulberry32(seedFor(3)), 128, 3);
    const bump = makeTileableField(mulberry32(seedFor(4)), 8, 2);
    for (let py = 0; py < S; py++) {
      for (let px = 0; px < S; px++) {
        const u = (px / S) * TERRAIN_DETAIL_SIZE;
        const v = (py / S) * TERRAIN_DETAIL_SIZE;
        const mottling = fieldFbm(humus, u, v); // 128u-ish patches (texture scale)
        const dry = fieldFbm(patch, u, v); // coarse rough/plain zones
        const speck = fieldFbm(litter, u, v); // twigs, leaves, soil grain
        const roots = fieldRidged(bump, u, v); // root/stone creases
        const sp = Math.pow(speck, 2.6); // sharpen: sparse bright litter tips
        const v01 =
          0.34 +
          (mottling - 0.5) * 0.42 +
          (dry - 0.5) * 0.2 +
          (sp - 0.18) * 0.5 +
          (roots - 0.5) * 0.26;
        h[py * S + px] = clamp(v01, 0, 1);
      }
    }
    return h;
  }

  if (layer === 'rock') {
    const blocks = makeTileableField(mulberry32(seedFor(5)), 4, 3);
    const cracks = makeTileableField(mulberry32(seedFor(6)), 16, 4);
    const grain = makeTileableField(mulberry32(seedFor(7)), 256, 2);
    const warp = makeTileableField(mulberry32(seedFor(8)), 8, 2);
    for (let py = 0; py < S; py++) {
      for (let px = 0; px < S; px++) {
        const u = (px / S) * TERRAIN_DETAIL_SIZE;
        const v = (py / S) * TERRAIN_DETAIL_SIZE;
        // Domain-warped crack network: ridged creases bent by a slow field,
        // which is what stops the fracture pattern looking like a grid.
        const wx = (fieldFbm(warp, u, v) - 0.5) * 26;
        const wy = (fieldFbm(warp, u + 91.3, v + 17.9) - 0.5) * 26;
        const crease = fieldRidged(cracks, u + wx, v + wy);
        const slab = fieldFbm(blocks, u, v);
        const grit = fieldFbm(grain, u, v);
        const v01 =
          0.42 +
          (crease - 0.55) * 0.95 +
          (slab - 0.5) * 0.3 +
          (grit - 0.5) * 0.22;
        h[py * S + px] = clamp(v01, 0, 1);
      }
    }
    return h;
  }

  // sand: aeolian ripples (integer cycle count => tileable) whose amplitude
  // and phase drift with slow noise, plus fine mineral grain.
  const rippleWarp = makeTileableField(mulberry32(seedFor(9)), 4, 3);
  const dune = makeTileableField(mulberry32(seedFor(10)), 2, 2);
  const grain = makeTileableField(mulberry32(seedFor(11)), 128, 3);
  const RIPPLES = 46; // whole cycles across the tile
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const u = (px / S) * TERRAIN_DETAIL_SIZE;
      const v = (py / S) * TERRAIN_DETAIL_SIZE;
      const drift = fieldFbm(rippleWarp, u, v);
      const duneShape = fieldFbm(dune, u, v);
      const grit = fieldFbm(grain, u, v);
      const phase = ((px / S) * RIPPLES + drift * 3.2 + (py / S) * 3.0) * Math.PI * 2;
      const ripple = Math.sin(phase) * 0.5 + Math.sin(phase * 2.0 + 1.7) * 0.18;
      const amp = 0.42 + 0.58 * duneShape; // ripples fade in and out
      const v01 = 0.45 + ripple * 0.34 * amp + (duneShape - 0.5) * 0.16 + (grit - 0.5) * 0.3;
      h[py * S + px] = clamp(v01, 0, 1);
    }
  }
  return h;
}

// ---------------------------------------------------------------------------
// Encoding: height -> RGBA detail texel
// ---------------------------------------------------------------------------

/**
 * Soft-saturating map: keeps every finite slope inside (-1, 1) instead of
 * clamping it. Hard clamping turns a normal map into binary blocks (the
 * shading reads as painted tiles), while a soft knee preserves the ORDER of
 * slopes, so the finest detail still varies the shading even where the
 * amplitude saturates.
 */
function softKnee(s: number): number {
  return s / (1 + Math.abs(s));
}

/**
 * Convert a height field to the packed RGBA8 detail texel format.
 *
 * The gradient is a wrapped central difference (periodic => no seam
 * artefacts), normalised by the layer `gain` and centred on 0.5. B holds the
 * tonal detail (crevices darker, crests lighter) and A a specular mask
 * derived from the same height: low ground reads as damp/sheltered, crests
 * as dry/matte.
 */
export function encodeDetailLayer(
  layer: TerrainDetailLayer,
  height: Float32Array,
  spec: TerrainDetailLayerSpec = DETAIL_LAYERS[layer],
): Uint8Array {
  const S = TERRAIN_DETAIL_SIZE;
  const out = new Uint8Array(S * S * 4);
  const wrap = (i: number) => (i + S) % S;
  for (let py = 0; py < S; py++) {
    const ym = wrap(py - 1) * S;
    const yp = wrap(py + 1) * S;
    const y0 = py * S;
    for (let px = 0; px < S; px++) {
      const xm = wrap(px - 1);
      const xp = wrap(px + 1);
      const hC = height[y0 + px];
      const dhdu = (height[y0 + xp] - height[y0 + xm]) * 0.5;
      const dhdv = (height[yp + px] - height[ym + px]) * 0.5;
      // Curvature (negative = concave crevice): drives cavity darkening and
      // the damp/wet specular mask.
      const lap =
        height[y0 + xm] + height[y0 + xp] + height[ym + px] + height[yp + px] - 4 * hC;

      const gx = 0.5 + 0.5 * softKnee(dhdu * spec.gain);
      const gy = 0.5 + 0.5 * softKnee(dhdv * spec.gain);
      // Tonal detail: height itself, plus extra darkening in concave pixels
      // (cheap baked cavity AO — the single strongest "this is a real
      // surface" cue at close range).
      const cavity = clamp(-lap * 1.9, 0, 1);
      const alb = clamp(
        0.5 + (hC - 0.5) * spec.albedo - cavity * 0.26 * spec.albedo,
        0,
        1,
      );
      const specV = clamp(spec.spec * (0.35 + 0.9 * cavity + 0.35 * (1 - hC)), 0, 1);

      const o = (py * S + px) * 4;
      out[o] = Math.round(gx * 255);
      out[o + 1] = Math.round(gy * 255);
      out[o + 2] = Math.round(alb * 255);
      out[o + 3] = Math.round(specV * 255);
    }
  }
  return out;
}

/** All three detail layers as raw RGBA8 data (pure, deterministic). */
export interface TerrainDetailMaps {
  size: number;
  layers: Record<TerrainDetailLayer, Uint8Array>;
}

export function buildTerrainDetailMaps(seed = WORLD_SEED): TerrainDetailMaps {
  const layers = {} as Record<TerrainDetailLayer, Uint8Array>;
  for (const name of DETAIL_LAYER_NAMES) {
    layers[name] = encodeDetailLayer(name, buildDetailHeight(name, seed));
  }
  return { size: TERRAIN_DETAIL_SIZE, layers };
}

// ---------------------------------------------------------------------------
// Babylon side: mip-mapped repeating textures
// ---------------------------------------------------------------------------

export interface TerrainDetailTextures {
  grass: RawTexture;
  rock: RawTexture;
  sand: RawTexture;
  /** Uniform-friendly tile sizes (world units per repeat). */
  tiles: Record<TerrainDetailLayer, number>;
  dispose(): void;
}

/**
 * Upload the generated detail maps as repeating, mip-mapped, anisotropically
 * filtered textures.
 *
 * Mip + anisotropic filtering are the point of this module: they raise the
 * visible detail wavelength exactly when a pixel covers more world area,
 * which is what removes the striped aliasing the analytic shader detail
 * produced at grazing angles.
 */
export function createTerrainDetailTextures(scene: Scene, seed = WORLD_SEED): TerrainDetailTextures {
  const maps = buildTerrainDetailMaps(seed);
  const make = (name: TerrainDetailLayer) => {
    const tex = new RawTexture(
      maps.layers[name],
      maps.size,
      maps.size,
      Constants.TEXTUREFORMAT_RGBA,
      scene,
      true, // mip chain: mandatory (see module docs)
      false,
      Texture.TRILINEAR_SAMPLINGMODE,
    );
    tex.name = `terrainDetail_${name}`;
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
    tex.anisotropicFilteringLevel = 8; // ignored where unsupported
    tex.gammaSpace = false; // gradient/linear data, not colour
    return tex;
  };
  const grass = make('grass');
  const rock = make('rock');
  const sand = make('sand');
  return {
    grass,
    rock,
    sand,
    tiles: {
      grass: DETAIL_LAYERS.grass.tile,
      rock: DETAIL_LAYERS.rock.tile,
      sand: DETAIL_LAYERS.sand.tile,
    },
    dispose() {
      grass.dispose();
      rock.dispose();
      sand.dispose();
    },
  };
}
