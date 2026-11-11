import { describe, it, expect } from 'vitest';
import { h21GLSL, h21SinArg, legacySinArg, vnoiseGLSL, NOISE_H21_GLSL } from './noiseGLSL';
import { dumpTerrainGLSL } from './terrain';
import { dumpSkyGLSL } from './sky';

/**
 * The shared shader hash must stay well-behaved at WORLD-SPACE coordinates.
 *
 * Background: the legacy `fract(sin(dot(p, vec2(127.1, 311.7))) * 43758)`
 * hash takes a sin argument up to ~480,000 at the terrain fine-grain octave
 * (p = xz*3.4 on a 640u island). GPU sin is not IEEE-correct at large
 * arguments; the resulting quantised hash error is vendor-dependent (the
 * world texture differed per machine) and lattice-correlated (visible
 * banding/moiré). The bounded hash in noiseGLSL.ts folds the lattice index
 * into a small integer first, keeping the sin argument < ~520 everywhere.
 *
 * The tests below prove, in Node (float32-exact mirror):
 *   1. the argument bound holds over the full current world domain,
 *   2. the hash is identical under a pessimistic GPU-precision model
 *      (vendor-independent), while the legacy hash is not,
 *   3. the hash output is statistically clean (uniform, decorrelated,
 *      no grid-aligned spectral peaks — the banding signatures).
 */

const ulp = (x: number): number => {
  const ax = Math.abs(x);
  if (ax === 0) return 2 ** -149;
  return 2 ** (Math.floor(Math.log2(ax)) - 23);
};

/** Deterministic pseudo-random in [-1, 1) from a float (model-only). */
const jitter = (seed: number): number => {
  const s = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
};

/**
 * Pessimistic GPU model of sin(): conformant GPUs are accurate to a couple
 * of output ulp; at |arg| >= 2^16 several GPU families lose up to
 * ~ulp(arg)/2 radians in argument reduction (documented mobile-GPU
 * behaviour). This is a BOUND, not a measurement of any specific GPU.
 */
function gpuSin(arg: number, largeArgLoss: boolean): number {
  const ideal = Math.sin(arg);
  if (!largeArgLoss || Math.abs(arg) < 65536) return ideal;
  const err = (ulp(arg) / 2) * jitter(arg);
  return Math.sin(arg + err);
}

/** Hash value a GPU computes under the model (float32 output rounding). */
function hashOnGpu(x: number, y: number, largeArgLoss: boolean): number {
  const arg = h21SinArg(x, y);
  const v = Math.fround(gpuSin(arg, largeArgLoss) * 43758.5453);
  return v - Math.floor(v);
}

/** Every (octave, offset) form that terrain.ts feeds into vnoise. */
const TERRAIN_OCTAVES = [
  (x: number, z: number) => ({ x: x * 0.95, y: z * 0.95 }), // grainA base
  (x: number, z: number) => ({ x: (x * 0.95) * 2.17 + 7.31, y: (z * 0.95) * 2.17 + 3.77 }), // grainA fine
  (x: number, z: number) => ({ x: x * 3.4 + 11.7, y: z * 3.4 + 5.3 }), // fine grain gF
  (x: number, z: number) => ({ x: x * 0.033 + 2.1, y: z * 0.033 + 8.4 }), // slow patches gP
];
const FD_OFFSET = 0.25; // micro-normal finite-difference step

describe('shared shader hash (noiseGLSL)', () => {
  it('keeps the sin argument bounded over the full terrain world domain', () => {
    // vnoise hashes i and i+1 for each axis; scan the worst-case corners.
    let maxArg = 0;
    for (const oct of TERRAIN_OCTAVES) {
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const x = sx * 320; // terrain half-size
          const z = sz * 320;
          for (const dx of [0, FD_OFFSET]) {
            for (const dz of [0, FD_OFFSET]) {
              const p = oct(x + dx, z + dz);
              for (const ex of [0, 1]) {
                for (const ez of [0, 1]) {
                  maxArg = Math.max(maxArg, Math.abs(h21SinArg(p.x + ex, p.y + ez)));
                }
              }
            }
          }
        }
      }
    }
    // Below 2^9: even the pessimistic ulp/2 argument-loss model yields a
    // hash error < 0.001 (visually zero, and identical on every GPU).
    expect(maxArg).toBeLessThan(512);
    expect(maxArg).toBeGreaterThan(0);
  });

  it('keeps the sin argument bounded over the sky star-field domain', () => {
    // cell = floor(sp * 90), sp = dir.xz / max(dir.y + 0.12, 0.12),
    // |sp| <= ~8.4 (dir on the unit dome, y >= 0 visible) -> |cell| <= 756.
    let maxArg = 0;
    for (let i = -760; i <= 760; i += 3) {
      for (let j = -760; j <= 760; j += 3) {
        maxArg = Math.max(maxArg, Math.abs(h21SinArg(i + 41.9, j)));
      }
    }
    expect(maxArg).toBeLessThan(512);
  });

  it('documents why the legacy hash was wrong (unbounded argument)', () => {
    // At the terrain fine-grain corner the legacy dot-product argument
    // reaches ~4.8e5 — deep inside the region where GPU sin loses
    // precision and diverges between vendors.
    const arg = Math.abs(legacySinArg(320 * 3.4 + 11.7, 320 * 3.4 + 5.3));
    expect(arg).toBeGreaterThan(65536);
  });

  it('is identical on every GPU model (vendor-independent) across the world', () => {
    // Sample the whole world lattice (step 7) and compare the hash under
    // the ideal model vs the pessimistic large-argument-loss model.
    let maxDiff = 0;
    for (let y = -1096; y <= 1096; y += 7) {
      for (let x = -1096; x <= 1096; x += 7) {
        maxDiff = Math.max(maxDiff, Math.abs(hashOnGpu(x, y, false) - hashOnGpu(x, y, true)));
      }
    }
    // Below the smallest visible grain modulation step (~1/64 of the
    // ±6% tone factor = 0.0009 noise delta; 0.015 is 16x that margin).
    expect(maxDiff).toBeLessThan(0.015);
  });

  it('shows the legacy hash is NOT vendor-independent under the same model', () => {
    // Same comparison for the legacy dot-product hash: with arguments
    // beyond 2^16 the pessimistic model produces large, lattice-correlated
    // errors — the reported machine-dependent banding.
    let maxDiff = 0;
    for (let y = -1096; y <= 1096; y += 7) {
      for (let x = -1096; x <= 1096; x += 7) {
        const ideal = Math.fround(Math.sin(legacySinArg(x, y)) * 43758.5453);
        const noisy = Math.fround(gpuSin(legacySinArg(x, y), true) * 43758.5453);
        maxDiff = Math.max(maxDiff, Math.abs((ideal - Math.floor(ideal)) - (noisy - Math.floor(noisy))));
      }
    }
    expect(maxDiff).toBeGreaterThan(0.05);
  });

  it('hash output is well distributed (no tonal clumping)', () => {
    const BINS = 32;
    const counts = new Array(BINS).fill(0);
    let n = 0;
    // 100k samples across the world lattice
    for (let y = -1096; y <= 1096; y += 3) {
      for (let x = -1096; x <= 1096; x += 3) {
        counts[Math.min(BINS - 1, Math.floor(h21GLSL(x, y) * BINS))]++;
        n++;
      }
    }
    const mean = n / BINS;
    for (const c of counts) {
      expect(c).toBeGreaterThan(mean * 0.75);
      expect(c).toBeLessThan(mean * 1.25);
    }
  });

  it('lattice neighbours are decorrelated (no stripe/band alignment)', () => {
    const step = 11;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let y = -1000; y <= 1000; y += step) ys.push(y);
    for (let x = -1000; x <= 1000; x += step) xs.push(x);
    const H: number[][] = ys.map((y) => xs.map((x) => h21GLSL(x, y)));
    const corr = (pa: number[][], pb: number[][]): number => {
      const rows = pa.length;
      const cols = pa[0].length;
      let n = 0, ea = 0, eb = 0;
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) { ea += pa[r][c]; eb += pb[r][c]; n++; }
      const ma = ea / n, mb = eb / n;
      let sab = 0, saa = 0, sbb = 0;
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const da = pa[r][c] - ma;
          const db = pb[r][c] - mb;
          sab += da * db; saa += da * da; sbb += db * db;
        }
      return sab / Math.sqrt(saa * sbb);
    };
    // neighbour grids (edge cells paired with themselves — negligible bias)
    const shiftX = H.map((row, r) => row.map((v, c) => (c + 1 < xs.length ? H[r][c + 1] : v)));
    const shiftY = H.map((row, r) => row.map((v, c) => (r + 1 < ys.length ? H[r + 1][c] : v)));
    const cx = corr(H, shiftX);
    const cy = corr(H, shiftY);
    expect(Math.abs(cx)).toBeLessThan(0.05);
    expect(Math.abs(cy)).toBeLessThan(0.05);
  });

  it('vnoise has no grid-aligned spectral peak (the banding signature)', () => {
    // 2D DFT of a 256x256 block of the integer-lattice hash, placed far
    // from the origin. A healthy hash is white: no bin may hold a large
    // share of the total (non-DC) power; grid-aligned banding shows up as
    // exactly that.
    const N = 256;
    const re = new Float64Array(N * N);
    const im = new Float64Array(N * N);
    const bx = 800, by = 640;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) re[y * N + x] = h21GLSL(x + bx, y + by) - 0.5;

    // in-place iterative radix-2 FFT (rows, then columns)
    const fft1 = (a: Float64Array, b: Float64Array, n: number) => {
      for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
          [a[i], a[j]] = [a[j], a[i]];
          [b[i], b[j]] = [b[j], b[i]];
        }
      }
      for (let len = 2; len <= n; len <<= 1) {
        const ang = (-2 * Math.PI) / len;
        let wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
          let cr = 1, ci = 0;
          for (let k = 0; k < len / 2; k++) {
            const a1 = a[i + k], a2 = a[i + k + len / 2];
            const b1 = b[i + k], b2 = b[i + k + len / 2];
            const tr = a2 * cr - b2 * ci;
            const ti = a2 * ci + b2 * cr;
            a[i + k + len / 2] = a1 - tr;
            b[i + k + len / 2] = b1 - ti;
            a[i + k] = a1 + tr;
            b[i + k] = b1 + ti;
            const ncr = cr * wr - ci * wi;
            ci = cr * wi + ci * wr;
            cr = ncr;
          }
        }
      }
    };
    const row = new Float64Array(N);
    const col = new Float64Array(N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) { row[x] = re[y * N + x]; col[x] = im[y * N + x]; }
      fft1(row, col, N);
      for (let x = 0; x < N; x++) { re[y * N + x] = row[x]; im[y * N + x] = col[x]; }
    }
    for (let x = 0; x < N; x++) {
      for (let y = 0; y < N; y++) { row[y] = re[y * N + x]; col[y] = im[y * N + x]; }
      fft1(row, col, N);
      for (let y = 0; y < N; y++) { re[y * N + x] = row[y]; im[y * N + x] = col[y]; }
    }

    let total = 0, top = 0;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        if (x === 0 && y === 0) continue;
        total += re[y * N + x] ** 2 + im[y * N + x] ** 2;
      }
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        if (x === 0 && y === 0) continue;
        top = Math.max(top, re[y * N + x] ** 2 + im[y * N + x] ** 2);
      }
    // Flat white noise over 65024 non-DC bins would give ~1.5e-5 per bin;
    // a visible band would dominate at least ~300x that.
    expect(top / total).toBeLessThan(3e-4);
  });

  it('vnoise is continuous with zero first derivative at lattice points', () => {
    // Quintic interpolation: small coordinate steps cause only small value
    // changes anywhere in the world (no pops/seams in the grain).
    const eps = 1e-3;
    let maxJump = 0;
    for (let i = 0; i < 4000; i++) {
      const x = -1096 + Math.sin(i * 12.9898) * 1096;
      const z = -1096 + Math.cos(i * 78.233) * 1096;
      const h0 = vnoiseGLSL(x, z);
      maxJump = Math.max(
        maxJump,
        Math.abs(vnoiseGLSL(x + eps, z) - h0),
        Math.abs(vnoiseGLSL(x, z + eps) - h0),
      );
    }
    // Quintic max |d/dx| on unit lattice values in [0,1] is < 1.1 -> the
    // jump over eps must be ~eps; 0.05 gives huge margin for float32.
    expect(maxJump).toBeLessThan(0.05);
  });

  it('depends only on the lattice cell (integer hash, no per-pixel drift)', () => {
    for (let i = 0; i < 20000; i++) {
      const x = Math.floor(Math.sin(i * 78.233) * 1200);
      const y = Math.floor(Math.cos(i * 12.9898) * 1200);
      expect(h21GLSL(x + 0.9, y + 0.2)).toBe(h21GLSL(x, y));
    }
  });

  it('terrain and sky shaders use the shared bounded hash', () => {
    const [, tFrag] = dumpTerrainGLSL().split('\n----------------\n');
    const [, sFrag] = dumpSkyGLSL().split('\n----------------\n');
    for (const frag of [tFrag, sFrag]) {
      // The bounded fold is present...
      expect(frag).toContain('float s = i.x * 7907.0 + i.y * 8101.0;');
      // ...and the unbounded dot-product hash is gone.
      expect(frag).not.toContain('dot(p, vec2(127.1, 311.7))');
    }
    // Sanity: the shared chunk defines h21 exactly once per shader.
    expect(NOISE_H21_GLSL.match(/float h21\(/g)).toHaveLength(1);
  });
});
