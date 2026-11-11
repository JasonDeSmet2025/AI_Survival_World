import { describe, it, expect } from 'vitest';
import { NullEngine, Scene } from '@babylonjs/core';
import { Sky, dumpSkyGLSL } from './sky';
import { h21GLSL as h21 } from './noiseGLSL';

describe('Sky module', () => {
  it('exports a class with the expected day/scene API', () => {
    expect(typeof Sky).toBe('function');
    for (const method of ['setDay', 'centerOn', 'dispose']) {
      expect(typeof (Sky.prototype as unknown as Record<string, unknown>)[method]).toBe('function');
    }
  });

  it('mirrors the image-processing pipeline into the sky shader and disposes cleanly', async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);

    const sky = new Sky(scene);
    const before = scene.onBeforeRenderObservable.observers.length;
    expect(before).toBe(1); // exactly the pipeline sync

    const mat = (sky as unknown as { material: { _floats: Record<string, number> } }).material;
    scene.imageProcessingConfiguration.exposure = 1.05;
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(mat._floats.exposureLinear).toBeCloseTo(1.05, 6);

    sky.dispose();
    // v9 observables finalise removal asynchronously (setTimeout 0).
    await new Promise((r) => setTimeout(r, 5));
    expect(scene.onBeforeRenderObservable.observers.length).toBe(before - 1);

    scene.dispose();
    engine.dispose();
  });

  describe('generated sky GLSL (point star field, regression guards)', () => {
    const glsl = dumpSkyGLSL();
    const [vert, frag] = glsl.split('\n----------------\n');

    it('passes the vDir varying from vertex to fragment', () => {
      expect(vert).toContain('varying vec3 vDir;');
      expect(frag).toContain('varying vec3 vDir;');
    });

    it('renders stars as per-pixel points with a random in-cell centre', () => {
      // Each star is placed at a RANDOM spot inside its cell with its own
      // radius, via the radial falloff `1 - smoothstep(r*0.15, r, dist)`.
      expect(frag).toContain('float star = step(0.992, s) * (1.0 - smoothstep(starR * 0.15, starR, length(fc - starC)));');
      expect(frag).toContain('vec2 starC = 0.18 + 0.64 * vec2(h21(cell + vec2(13.7, 0.0)), h21(cell + vec2(7.31, 0.0)));');
      // Per-star brightness (mostly dim, few bright) and colour temperature.
      expect(frag).toContain('float starB = 0.25 + 0.75 * pow(h21(cell + vec2(41.9, 0.0)), 2.0);');
      expect(frag).toContain('vec3 starTint = mix(vec3(0.82, 0.88, 1.0), vec3(1.0, 0.94, 0.82), h21(cell + vec2(3.17, 0.0)));');
    });

    it('the old uniform per-cell star grid is gone (no blocky pattern)', () => {
      // The old code lit the WHOLE cell at once: `step(0.992, s) * smoothstep(...)
      // * nightStars` fed directly into a `col += vec3(star * twinkle ...)`.
      // Neither the per-cell uniform term nor the twinkle variable may return.
      expect(frag).not.toMatch(/step\(0\.992, s\) \* smoothstep/);
      expect(frag).not.toContain('twinkle');
      expect(frag).not.toMatch(/col \+= vec3\(star/);
    });

    it('stars remain gated by night visibility and the horizon fade', () => {
      expect(frag).toContain('smoothstep(0.08, 0.3, y) * nightStars)');
    });

    it('no reversed smoothstep (undefined in GLSL: edge0 > edge1)', () => {
      // The star falloff must use the small edge first.
      expect(frag).toContain('smoothstep(starR * 0.15, starR,');
      expect(frag).not.toContain('smoothstep(starR, starR * 0.15');
    });
  });

  describe('star field contract (simulated on the CPU)', () => {
    it('every star fits strictly inside its cell (no seams on cell edges)', () => {
      // GLSL: starC in [0.18, 0.82] per axis, starR in [0.02, 0.075).
      // Max distance from the star centre to the nearest cell edge is
      // >= 0.18, so the falloff (max 0.075) is always zero at the border:
      // neighbouring cells can never clip each other's stars.
      const maxRadius = 0.02 + 0.055; // h21 in [0, 1)
      expect(maxRadius).toBeLessThan(0.18);
      // Fuzz the actual hash outputs to confirm the ranges hold in practice.
      let minMargin = 1, maxR = 0;
      for (let i = 0; i < 400; i++) {
        for (let j = 0; j < 400; j++) {
          const cx = 0.18 + 0.64 * h21(i + 13.7, j);
          const cy = 0.18 + 0.64 * h21(i + 7.31, j);
          const r = 0.02 + 0.055 * h21(i + 29.3, j);
          minMargin = Math.min(minMargin, Math.min(cx, 1 - cx, cy, 1 - cy));
          maxR = Math.max(maxR, r);
        }
      }
      expect(minMargin).toBeGreaterThan(0.17); // centre stays in [0.18, 0.82] within hash noise
      expect(maxR).toBeLessThan(minMargin);    // falloff never reaches a cell edge
    });

    it('keeps a natural star density (~0.8% of cells, not a dense grid)', () => {
      // `step(0.992, s)` occupancy of the hash — must stay near 0.8% so the
      // night sky is sparse like a real sky, not a dense dot matrix.
      let lit = 0;
      const N = 2000;
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          if (h21(i * 0.61 + 3.7, j * 0.49 + 9.1) > 0.992) lit++;
        }
      }
      const occ = lit / (N * N);
      expect(occ).toBeGreaterThan(0.001);
      expect(occ).toBeLessThan(0.02);
    });
  });
});
