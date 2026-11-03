/**
 * Deterministic noise and RNG utilities shared by world generation,
 * terrain, flora placement and the multiplayer server.
 * Everything here is pure (no Babylon) so it is unit-testable in Node.
 */

/** Deterministic hash in [0, 1) for integer lattice points. */
export function hash2(x: number, z: number): number {
  const n = Math.sin(x * 127.1 + z * 311.7 + 13.37) * 43758.5453123;
  return n - Math.floor(n);
}

export function smoothstep(t: number): number {
  const t0 = Math.max(0, Math.min(1, t));
  return t0 * t0 * (3 - 2 * t0);
}

/** 2D value noise in [0, 1]. */
export function valueNoise(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const a = hash2(xi, zi);
  const b = hash2(xi + 1, zi);
  const c = hash2(xi, zi + 1);
  const d = hash2(xi + 1, zi + 1);
  const u = smoothstep(xf);
  const v = smoothstep(zf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal Brownian motion, n octaves, output in [0, 1]. */
export function fbm(x: number, z: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let total = 0;
  let seed = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq + seed, z * freq + seed * 0.71) * amp;
    total += amp;
    amp *= 0.5;
    freq *= 2.02;
    seed += 19.17;
  }
  return sum / total;
}

/** Ridged multifractal in [0, 1] — good for mountain crests. */
export function ridged(x: number, z: number, octaves = 3): number {
  let sum = 0;
  let amp = 0.55;
  let freq = 1;
  let seed = 0;
  let total = 0;
  for (let i = 0; i < octaves; i++) {
    const n = valueNoise(x * freq + seed, z * freq + seed);
    sum += (1 - Math.abs(n * 2 - 1)) * amp; // 1 - |2n - 1|
    total += amp;
    amp *= 0.5;
    freq *= 2.07;
    seed += 31.7;
  }
  return sum / total;
}

/** Deterministic fast RNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
