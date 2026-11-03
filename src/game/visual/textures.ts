import {
  AbstractEngine,
  Color3,
  CubeTexture,
  DynamicTexture,
  Scene,
  Texture,
} from '@babylonjs/core';

/**
 * Procedural texture kit (Visual Agent scope).
 *
 * All textures are generated on canvases at startup — no downloads, no
 * external assets. Provides PBR-friendly albedo/normal pairs for the
 * natural material set (wood planks, bark, rock, stone masonry, fabric,
 * polished tool wood) plus three environment (IBL) cube presets that the
 * lighting system cross-fades over the day cycle.
 *
 * Everything is deterministic so reloads look identical.
 */

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function hash2i(x: number, y: number, seed: number): number {
  let h = seed + x * 374761393 + y * 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [0,1]. */
function valueNoise(x: number, y: number, cell: number, seed: number): number {
  const gx = Math.floor(x / cell);
  const gy = Math.floor(y / cell);
  const fx = x / cell - gx;
  const fy = y / cell - gy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2i(gx, gy, seed);
  const b = hash2i(gx + 1, gy, seed);
  const c = hash2i(gx, gy + 1, seed);
  const d = hash2i(gx + 1, gy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Fractal (fBm) noise in roughly [0,1]. */
function fbm(x: number, y: number, cell: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x, y, cell, seed + o * 101);
    total += amp;
    amp *= 0.5;
    cell *= 0.5;
  }
  return sum / total;
}

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  return [c, ctx];
}

// ---------------------------------------------------------------------------
// Albedo painters (natural, muted palettes)
// ---------------------------------------------------------------------------

/** Horizontal wooden planks with grain streaks, seams and subtle knots. */
function paintPlanks(ctx: CanvasRenderingContext2D, size: number, base: [number, number, number], seed: number): void {
  const rand = rng(seed);
  // base wash
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // vertical grain streaks stretched along the plank
      const grain = fbm(x * 1.4, y * 0.22, 22, seed, 3);
      const blotch = fbm(x, y, 26, seed + 7, 3);
      const plankRow = Math.floor(y / (size / 4));
      const plankBias = 0.92 + 0.16 * hash2i(plankRow, 3, seed + 5);
      const i = (y * size + x) * 4;
      d[i] = base[0] * (0.72 + grain * 0.5 + blotch * 0.14) * plankBias;
      d[i + 1] = base[1] * (0.72 + grain * 0.52 + blotch * 0.14) * plankBias;
      d[i + 2] = base[2] * (0.74 + grain * 0.5 + blotch * 0.12) * plankBias;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // plank seams (horizontal grooves)
  const plankH = size / 4;
  for (let p = 1; p < 4; p++) {
    const y = Math.round(p * plankH);
    ctx.fillStyle = 'rgba(20,12,6,0.55)';
    ctx.fillRect(0, y - 1, size, 1);
    ctx.fillStyle = 'rgba(255,230,190,0.10)';
    ctx.fillRect(0, y, size, 1);
    // staggered vertical end joints
    const joints = 1 + Math.floor(rand() * 2);
    for (let j = 0; j < joints; j++) {
      const x = Math.floor(rand() * size);
      ctx.fillStyle = 'rgba(20,12,6,0.4)';
      ctx.fillRect(x, y - plankH, 1, plankH);
    }
  }
  // knots
  for (let k = 0; k < 5; k++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 2 + rand() * 3;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2);
    g.addColorStop(0, 'rgba(40,24,10,0.85)');
    g.addColorStop(0.6, 'rgba(70,45,22,0.35)');
    g.addColorStop(1, 'rgba(70,45,22,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r * 2, y - r * 2, r * 4, r * 4);
  }
}

/** Smooth turned handle wood: soft grain, warm sheen, no seams. */
function paintToolWood(ctx: CanvasRenderingContext2D, size: number, base: [number, number, number], seed: number): void {
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const grain = fbm(x * 2.2, y * 0.25, 16, seed, 3);
      const fine = fbm(x * 4, y * 0.12, 8, seed + 3, 2) * 0.12;
      const i = (y * size + x) * 4;
      d[i] = base[0] * (0.8 + grain * 0.45 + fine);
      d[i + 1] = base[1] * (0.8 + grain * 0.45 + fine);
      d[i + 2] = base[2] * (0.82 + grain * 0.4 + fine);
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Rough tree bark: vertical fissures. */
function paintBark(ctx: CanvasRenderingContext2D, size: number, base: [number, number, number], seed: number): void {
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ridge = valueNoise(x, y * 0.35, 7, seed); // stretched vertically
      const macro = fbm(x, y, 30, seed + 11, 3);
      const crack = ridge < 0.34 ? 0.45 : 1.0;
      const i = (y * size + x) * 4;
      d[i] = base[0] * (0.55 + macro * 0.6) * crack;
      d[i + 1] = base[1] * (0.55 + macro * 0.6) * crack;
      d[i + 2] = base[2] * (0.55 + macro * 0.55) * crack;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Weathered rock: mottled grey with darker veins. */
function paintRock(ctx: CanvasRenderingContext2D, size: number, base: [number, number, number], seed: number): void {
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x, y, 18, seed, 5);
      const vein = valueNoise(x * 2.5, y * 1.2, 10, seed + 21);
      const veinDark = vein < 0.28 ? 0.62 : 1.0;
      const speck = hash2i(x, y, seed + 31) < 0.06 ? 1.12 : 1.0;
      const i = (y * size + x) * 4;
      const v = (0.6 + n * 0.75) * veinDark * speck;
      d[i] = base[0] * v;
      d[i + 1] = base[1] * v;
      d[i + 2] = base[2] * v;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Laid stone blocks with mortar joints (for stone buildings). */
function paintStoneMasonry(ctx: CanvasRenderingContext2D, size: number, base: [number, number, number], seed: number): void {
  const rand = rng(seed);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const rows = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x, y, 14, seed, 4);
      const row = Math.floor(y / (size / rows));
      const blockBias = 0.88 + 0.2 * hash2i(row, Math.floor(x / (size / 2)), seed + 3);
      const i = (y * size + x) * 4;
      d[i] = base[0] * (0.72 + n * 0.5) * blockBias;
      d[i + 1] = base[1] * (0.72 + n * 0.5) * blockBias;
      d[i + 2] = base[2] * (0.72 + n * 0.48) * blockBias;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // mortar lines
  ctx.fillStyle = 'rgba(24,22,20,0.55)';
  const rh = size / rows;
  for (let r = 1; r < rows; r++) ctx.fillRect(0, Math.round(r * rh), size, 1);
  for (let r = 0; r < rows; r++) {
    const offset = (r % 2) * (size / 4);
    for (let b = 0; b < 2; b++) {
      const x = Math.round(offset + b * (size / 2) + rand() * 8 - 4);
      if (x > 0 && x < size) ctx.fillRect(x, r * rh, 1, rh);
    }
  }
}

/** Woven fabric: subtle cross-hatch, used for clothing. */
function paintFabric(ctx: CanvasRenderingContext2D, size: number, base: [number, number, number], seed: number): void {
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const warp = 0.94 + 0.06 * Math.sin((x / size) * Math.PI * 2 * 64);
      const weft = 0.94 + 0.06 * Math.sin((y / size) * Math.PI * 2 * 64);
      const n = fbm(x, y, 20, seed, 2) * 0.12;
      const i = (y * size + x) * 4;
      const v = (0.86 + n) * warp * weft;
      d[i] = base[0] * v;
      d[i + 1] = base[1] * v;
      d[i + 2] = base[2] * v;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Rough chipped tool stone (axe / pickaxe heads). */
function paintToolStone(ctx: CanvasRenderingContext2D, size: number, base: [number, number, number], seed: number): void {
  paintRock(ctx, size, base, seed);
  const rand = rng(seed + 1);
  // flake highlights: a few bright chipped facets
  for (let f = 0; f < 26; f++) {
    const x = rand() * size;
    const y = rand() * size;
    const w = 2 + rand() * 6;
    const h = 1 + rand() * 3;
    ctx.fillStyle = `rgba(255,255,245,${0.04 + rand() * 0.05})`;
    ctx.fillRect(x, y, w, h);
  }
}

// ---------------------------------------------------------------------------
// Normal maps from height (Sobel)
// ---------------------------------------------------------------------------

/**
 * Convert a luminance height map (any canvas) into a tangent-space normal
 * map. Returns a canvas the caller can hand to DynamicTexture.
 */
export function heightToNormal(source: HTMLCanvasElement, strength = 1.5): HTMLCanvasElement {
  const size = source.width;
  const sctx = source.getContext('2d')!;
  const h = sctx.getImageData(0, 0, size, size).data;
  const [out, octx] = makeCanvas(size);
  const img = octx.createImageData(size, size);
  const d = img.data;
  const hgt = (x: number, y: number): number => {
    x = (x + size) % size;
    y = (y + size) % size;
    const i = (y * size + x) * 4;
    return (0.2126 * h[i] + 0.7152 * h[i + 1] + 0.0722 * h[i + 2]) / 255;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (hgt(x - 1, y) - hgt(x + 1, y)) * strength;
      const dy = (hgt(x, y - 1) - hgt(x, y + 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      d[i] = ((dx / len) * 0.5 + 0.5) * 255;
      d[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      d[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Texture kit
// ---------------------------------------------------------------------------

export interface PbrTextureSet {
  albedo: DynamicTexture;
  normal: DynamicTexture | null;
}

/**
 * All procedural textures the game needs. Create once at startup.
 * Albedos are sRGB (they hold color); normals are linear.
 */
export interface TextureKit {
  planks: PbrTextureSet;
  toolWood: PbrTextureSet;
  bark: PbrTextureSet;
  rock: PbrTextureSet;
  stone: PbrTextureSet;
  toolStone: PbrTextureSet;
  fabricShirt: PbrTextureSet;
  fabricPants: PbrTextureSet;
  fabricBoots: PbrTextureSet;
}

export function createTextureKit(scene: Scene): TextureKit {
  const S = 256;

  const tex = (name: string, canvas: HTMLCanvasElement, srgb: boolean, repeat = 1): DynamicTexture => {
    const t = new DynamicTexture(name, canvas, scene, false);
    t.wrapU = Texture.WRAP_ADDRESSMODE;
    t.wrapV = Texture.WRAP_ADDRESSMODE;
    t.anisotropicFilteringLevel = 4;
    t.uScale = repeat;
    t.vScale = repeat;
    if (srgb) t.gammaSpace = true;
    return t;
  };

  const set = (name: string, paint: (ctx: CanvasRenderingContext2D, size: number) => void, strength = 1.2, repeat = 1): PbrTextureSet => {
    const [a, actx] = makeCanvas(S);
    paint(actx, S);
    const nCanvas = strength > 0 ? heightToNormal(a, strength) : null;
    return {
      albedo: tex(name + '_albedo', a, true, repeat),
      normal: nCanvas ? tex(name + '_normal', nCanvas, false, repeat) : null,
    };
  };

  return {
    planks: set(
      'plank',
      (c, s) => paintPlanks(c, s, [0.52, 0.37, 0.21], 101),
      1.4,
      1,
    ),
    toolWood: set(
      'toolwood',
      (c, s) => paintToolWood(c, s, [0.48, 0.34, 0.19], 202),
      0.8,
      1,
    ),
    bark: set(
      'bark',
      (c, s) => paintBark(c, s, [0.32, 0.23, 0.15], 303),
      1.6,
      1,
    ),
    rock: set(
      'rock',
      (c, s) => paintRock(c, s, [0.52, 0.51, 0.49], 404),
      1.6,
      1,
    ),
    stone: set(
      'stone',
      (c, s) => paintStoneMasonry(c, s, [0.52, 0.51, 0.47], 505),
      1.2,
      1,
    ),
    toolStone: set(
      'toolstone',
      (c, s) => paintToolStone(c, s, [0.55, 0.54, 0.53], 606),
      1.5,
      1,
    ),
    fabricShirt: set(
      'fabricshirt',
      (c, s) => paintFabric(c, s, [0.34, 0.4, 0.36], 707),
      0.7,
      2,
    ),
    fabricPants: set(
      'fabricpants',
      (c, s) => paintFabric(c, s, [0.22, 0.22, 0.24], 808),
      0.7,
      2,
    ),
    fabricBoots: set(
      'fabricboots',
      (c, s) => paintFabric(c, s, [0.16, 0.12, 0.09], 909),
      0.9,
      2,
    ),
  };
}

export type TextureKitSet = TextureKit[keyof TextureKit];

// ---------------------------------------------------------------------------
// Environment (IBL) cube presets
// ---------------------------------------------------------------------------

interface EnvPreset {
  zenith: Color3;
  horizon: Color3;
  ground: Color3;
  /** Sun glow color + strength baked into the east face. */
  sun: Color3;
  sunStrength: number;
}

const ENV_DAY: EnvPreset = {
  zenith: new Color3(0.22, 0.45, 0.75),
  horizon: new Color3(0.62, 0.75, 0.85),
  ground: new Color3(0.24, 0.22, 0.17),
  sun: new Color3(1.0, 0.95, 0.85),
  sunStrength: 1.6,
};
const ENV_DUSK: EnvPreset = {
  zenith: new Color3(0.12, 0.16, 0.3),
  horizon: new Color3(0.8, 0.45, 0.28),
  ground: new Color3(0.12, 0.09, 0.07),
  sun: new Color3(1.0, 0.55, 0.3),
  sunStrength: 1.9,
};
const ENV_NIGHT: EnvPreset = {
  zenith: new Color3(0.015, 0.03, 0.07),
  horizon: new Color3(0.05, 0.08, 0.14),
  ground: new Color3(0.015, 0.02, 0.03),
  sun: new Color3(0.75, 0.85, 1.0),
  sunStrength: 0.35,
};

const ENV_SIZE = 128;

function paintEnvFace(preset: EnvPreset, kind: 'top' | 'bottom' | 'side', sunOnFace: boolean): HTMLCanvasElement {
  const [c, ctx] = makeCanvas(ENV_SIZE);
  if (kind === 'top') {
    ctx.fillStyle = rgb(preset.zenith);
    ctx.fillRect(0, 0, ENV_SIZE, ENV_SIZE);
  } else if (kind === 'bottom') {
    ctx.fillStyle = rgb(preset.ground);
    ctx.fillRect(0, 0, ENV_SIZE, ENV_SIZE);
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, ENV_SIZE);
    g.addColorStop(0, rgb(preset.zenith));
    g.addColorStop(0.55, rgb(preset.horizon));
    g.addColorStop(1, rgb(mixC(preset.horizon, preset.ground, 0.45)));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, ENV_SIZE, ENV_SIZE);
  }
  // Bake the sun/moon glow into one side face so IBL highlights match the
  // actual sky disc direction (east face of the cube).
  if (kind === 'side' && sunOnFace) {
    const cx = ENV_SIZE * 0.5;
    const cy = ENV_SIZE * 0.42;
    const r = ENV_SIZE * 0.55;
    const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, r);
    const s = preset.sun;
    const k = preset.sunStrength;
    g.addColorStop(0, rgba(clampC(s.r * k), clampC(s.g * k), clampC(s.b * k), 1));
    g.addColorStop(0.12, rgba(clampC(s.r * k * 0.7), clampC(s.g * k * 0.7), clampC(s.b * k * 0.7), 0.55));
    g.addColorStop(0.45, rgba(clampC(s.r * 0.3), clampC(s.g * 0.3), clampC(s.b * 0.3), 0.16));
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, ENV_SIZE, ENV_SIZE);
  }
  return c;
}

function rgb(c: Color3): string {
  return rgba(clampC(c.r), clampC(c.g), clampC(c.b), 1);
}
function rgba(r: number, g: number, b: number, a: number): string {
  return `rgba(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0},${a})`;
}
function clampC(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function mixC(a: Color3, b: Color3, t: number): Color3 {
  return new Color3(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t);
}

/** Cube face order for Babylon: +X, -X, +Y, -Y, +Z, -Z. */
function envFaceUrls(preset: EnvPreset): string[] {
  return [
    paintEnvFace(preset, 'side', true).toDataURL(), // +X  (east, sun)
    paintEnvFace(preset, 'side', false).toDataURL(), // -X
    paintEnvFace(preset, 'top', false).toDataURL(), // +Y
    paintEnvFace(preset, 'bottom', false).toDataURL(), // -Y
    paintEnvFace(preset, 'side', false).toDataURL(), // +Z
    paintEnvFace(preset, 'side', false).toDataURL(), // -Z
  ];
}

export type EnvironmentPreset = 'day' | 'dusk' | 'night';

/**
 * Build the three IBL cube presets (async — textures load from in-memory
 * data URLs). Returns a map; entries resolve as they load.
 */
export function createEnvironmentPresets(engine: AbstractEngine): Record<EnvironmentPreset, CubeTexture> {
  const presets: Record<EnvironmentPreset, EnvPreset> = {
    day: ENV_DAY,
    dusk: ENV_DUSK,
    night: ENV_NIGHT,
  };
  const out = {} as Record<EnvironmentPreset, CubeTexture>;
  for (const key of Object.keys(presets) as EnvironmentPreset[]) {
    out[key] = new CubeTexture(`env_${key}`, engine, null, false, envFaceUrls(presets[key]));
  }
  return out;
}
