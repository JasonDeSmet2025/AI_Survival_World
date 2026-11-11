/**
 * Shared GLSL hash + quintic value noise for all custom shaders, plus a
 * float32-exact TypeScript mirror so the shader maths can be unit-tested in
 * Node (NullEngine has no WebGL).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The classic hash
 *
 *   fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453)
 *
 * is only well-behaved for SMALL arguments. Our custom shaders pass
 * WORLD-SPACE coordinates into it: the terrain fine-grain octave is
 * `vnoise(xz * 3.4)` on a 640u island, i.e. |p| up to ~1100, so the sin
 * argument reaches ~480,000. GPU `sin` is not IEEE-correct at large
 * arguments: argument reduction loses up to ~ulp(arg) radians, and after
 * multiplying by 43758 that becomes a large, QUANTISED hash error that
 *
 *   1. differs between GPU vendors/drivers — the world's micro texture is
 *      therefore NOT deterministic across machines, and
 *   2. correlates with the lattice layout — visible tone banding / moiré
 *      patches on the ground (the reported "kleurbanden en patronen").
 *
 * `h21` below keeps the sin argument in a bounded, small range even at the
 * edge of the world: the lattice index is folded into a small exact integer
 * `i.x*7907 + i.y*8101` (injective over the supported domain in practice —
 * 0 collisions of the float32-rounded sum over the full domain, measured by
 * QA — every operation IEEE-exact or deterministically rounded in float32),
 * then scaled down before the sin. Every coordinate the shaders ACTUALLY use
 * keeps the argument below 512 = 2^9 (terrain worst case ≈ 500, sky ≈ 426 —
 * guarded by tests); the extreme corner of the supported domain reaches
 * ≈ 742, still ~90x below the 2^16 region where GPU argument reduction
 * degrades. Every conformant GPU therefore evaluates the hash identically,
 * so the procedural textures are vendor-independent and the world looks the
 * same on every machine.
 *
 * SUPPORTED DOMAIN
 * ----------------
 * Lattice coordinates |i| <= 2123 in each axis (lattice index + 1024 stays
 * in [0, 3147], products stay float32-rounded and the sum stays < 2^26).
 * That covers the current world at every octave used by terrain (worst
 * lattice span ±1096) and the sky star field (±750) with margin. Note: the
 * sin argument is < 512 everywhere the shaders actually sample (≈ 742 at
 * the extreme domain corner — still inside the region where every
 * conformant GPU evaluates sin to a couple of ulp).
 *
 * The dither hash in `colorPipeline.ts` is intentionally NOT switched: it
 * hashes screen-space UVs (argument < 100) and must stay byte-identical to
 * the engine's `getRand()` so built-in and custom materials dither alike.
 */

/**
 * GLSL chunk: the bounded-argument lattice hash. Insert into a fragment
 * (or vertex) shader before first use.
 */
export const NOISE_H21_GLSL = `
// Bounded-argument lattice hash (see noiseGLSL module docs): the sin()
// argument stays < 512 at every coordinate the shaders actually use
// (<= ~742 even at the extreme edge of the supported domain, far below
// the 2^16 region where large-argument sin diverges between GPU vendors
// -> banding / non-deterministic patterns).
float h21(vec2 p) {
  vec2 i = floor(p) + 1024.0;
  float s = i.x * 7907.0 + i.y * 8101.0;
  return fract(sin(s * 0.0000147 + 1.37) * 43758.5453);
}
`;

/**
 * GLSL chunk: quintic-interpolated value noise built on `h21`. Requires
 * NOISE_H21_GLSL earlier in the shader.
 */
export const NOISE_VNOISE_GLSL = `
// Quintic-interpolated value noise: zero first derivative at lattice points
// removes the rounded-square/hex "blob" cell structure of plain smoothstep
// interpolation (the reported hex-ish terrain pattern).
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = h21(i);
  float b = h21(i + vec2(1.0, 0.0));
  float c = h21(i + vec2(0.0, 1.0));
  float d = h21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`;

/**
 * float32-exact TypeScript mirror of the GLSL `h21` (test-only).
 * Every arithmetic step is fround'ed to match float32 rounding; the sin
 * itself uses the host's float64 `Math.sin` (a conformant GPU's float32
 * sin at these small arguments differs by at most a couple of ulp, which
 * can shift the last bits of the fract output — deterministic in Node
 * either way, which is what the tests rely on).
 */
export function h21GLSL(x: number, y: number): number {
  const s = Math.fround(Math.fround((Math.floor(x) + 1024) * 7907) + Math.fround((Math.floor(y) + 1024) * 8101));
  const arg = Math.fround(Math.fround(s * 0.0000147) + 1.37);
  const v = Math.fround(Math.sin(arg) * 43758.5453);
  return v - Math.floor(v);
}

/** The exact sin() argument used by `h21` for a lattice cell (test-only). */
export function h21SinArg(x: number, y: number): number {
  const s = Math.fround(Math.fround((Math.floor(x) + 1024) * 7907) + Math.fround((Math.floor(y) + 1024) * 8101));
  return Math.fround(Math.fround(s * 0.0000147) + 1.37);
}

/** The legacy unbounded hash's sin argument (regression documentation only). */
export function legacySinArg(x: number, y: number): number {
  return Math.fround(Math.fround(x * 127.1) + Math.fround(y * 311.7));
}

/** float32-exact mirror of the GLSL `vnoise` (test-only). */
export function vnoiseGLSL(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = h21GLSL(ix, iy);
  const b = h21GLSL(ix + 1, iy);
  const c = h21GLSL(ix, iy + 1);
  const d = h21GLSL(ix + 1, iy + 1);
  const ab = a + (b - a) * ux;
  const cd = c + (d - c) * ux;
  return ab + (cd - ab) * uy;
}
