import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Color3, Matrix, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import type { SpritePlacement } from './atmosphere';
import {
  Atmosphere,
  bakeSpriteLayer,
  CLOUD_ALTITUDE_MAX,
  CLOUD_ALTITUDE_MIN,
  CLOUD_COUNT,
  CLOUD_REACH,
  generateCloudAlpha,
  generateCloudLayout,
  generateMistAlpha,
  generateMistLayout,
  MIST_COUNT,
  MIST_HEIGHT,
} from './atmosphere';
import { SEA_LEVEL, terrainHeight } from './heightfield';

/**
 * Atmosphere tests.
 *
 * The pure parts (alpha maps, deterministic layouts, baked layer geometry)
 * run directly in Node. The Atmosphere class wiring (baked layer meshes,
 * fog mirroring, day/night tint, drift) runs on NullEngine with a minimal
 * canvas stub — the shader itself cannot execute without WebGL.
 */

// ---------------------------------------------------------------------------
// Canvas stub (same approach as textures.test.ts)
// ---------------------------------------------------------------------------

interface CapturedCanvas {
  width: number;
  height: number;
  last?: Uint8ClampedArray;
}

function installCanvasStub(): CapturedCanvas[] {
  const canvases: CapturedCanvas[] = [];
  const makeCtx = (canvas: CapturedCanvas) => ({
    createImageData(w: number, h: number) {
      return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
    },
    putImageData(img: { data: Uint8ClampedArray }) {
      canvas.last = img.data;
    },
    getImageData(_x: number, _y: number, w: number, h: number) {
      return { data: canvas.last ?? new Uint8ClampedArray(w * h * 4), width: w, height: h };
    },
  });
  (globalThis as Record<string, unknown>).document = {
    createElement(tag: string) {
      if (tag !== 'canvas') throw new Error('stub only creates canvases');
      const canvas: CapturedCanvas = { width: 0, height: 0 };
      (canvas as unknown as { getContext: (k: string) => unknown }).getContext = (k: string) =>
        k === '2d' ? makeCtx(canvas) : null;
      canvases.push(canvas);
      return canvas as unknown as HTMLCanvasElement;
    },
  };
  return canvases;
}

/** The v9 Observable API requires at least one notification argument. */
function fireOnBeforeRender(scene: Scene): void {
  scene.onBeforeRenderObservable.notifyObservers(scene);
}

function floatUniform(mat: Atmosphere['cloudMaterial'], name: string): number {
  return (mat as unknown as { _floats: Record<string, number> })._floats[name];
}
function vec3Uniform(
  mat: Atmosphere['cloudMaterial'],
  name: string,
): { x: number; y: number; z: number } {
  return (mat as unknown as { _vectors3: Record<string, { x: number; y: number; z: number }> })._vectors3[
    name
  ];
}

// ---------------------------------------------------------------------------
// Pure alpha maps
// ---------------------------------------------------------------------------

describe('sprite alpha maps (pure)', () => {
  it('cloud alpha is deterministic and bounded', () => {
    const a = generateCloudAlpha(64, 42);
    const b = generateCloudAlpha(64, 42);
    expect(Array.from(a)).toEqual(Array.from(b));
    let max = 0;
    for (const v of a) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      if (v > max) max = v;
    }
    // The map must actually contain cloud body (some opaque-ish pixels).
    expect(max).toBeGreaterThan(0.5);
  });

  it('cloud alpha is fully transparent at the sprite border (no quad edges)', () => {
    const s = 64;
    const a = generateCloudAlpha(s, 7);
    for (const i of [0, s - 1]) {
      for (let j = 0; j < s; j++) {
        expect(a[i * s + j]).toBe(0); // top/bottom rows
        expect(a[j * s + i]).toBe(0); // left/right columns
      }
    }
  });

  it('cloud alpha has ragged but moderate coverage', () => {
    const s = 96;
    const a = generateCloudAlpha(s, 7);
    let covered = 0;
    for (const v of a) if (v > 0.1) covered++;
    const frac = covered / a.length;
    expect(frac).toBeGreaterThan(0.12);
    expect(frac).toBeLessThan(0.7);
  });

  it('mist alpha is deterministic, bounded and transparent at the border', () => {
    const s = 64;
    const a = generateMistAlpha(s, 3);
    const b = generateMistAlpha(s, 3);
    expect(Array.from(a)).toEqual(Array.from(b));
    let max = 0;
    for (const v of a) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      if (v > max) max = v;
    }
    expect(max).toBeGreaterThan(0.5);
    for (let j = 0; j < s; j++) {
      expect(a[j]).toBe(0);
      expect(a[(s - 1) * s + j]).toBe(0);
      expect(a[j * s]).toBe(0);
      expect(a[j * s + s - 1]).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Baked layer geometry (pure)
// ---------------------------------------------------------------------------

describe('bakeSpriteLayer (pure)', () => {
  const p: SpritePlacement = { x: 12, y: 55, z: -34, scale: 26, rotY: 0.7 };

  it('is deterministic and produces the exact per-sprite quad topology', () => {
    const layout = generateCloudLayout();
    const a = bakeSpriteLayer(layout);
    const b = bakeSpriteLayer(layout);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.uvs)).toEqual(Array.from(b.uvs));
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));

    const n = layout.length;
    expect(a.positions.length).toBe(n * 4 * 3);
    expect(a.uvs.length).toBe(n * 4 * 2);
    expect(a.indices.length).toBe(n * 6);
    for (let i = 0; i < n; i++) {
      const base = i * 4;
      expect(Array.from(a.indices.slice(i * 6, i * 6 + 6))).toEqual([
        base, base + 1, base + 2, base, base + 2, base + 3,
      ]);
    }
  });

  it('matches Babylon world transforms of the previous instanced model', () => {
    // Reference: what the old per-instance model produced —
    // inst.position = p, inst.rotation.y = p.rotY, inst.scaling = p.scale
    // (world matrix T * R_y * S, applied to unit-plane corners).
    const layout = [p];
    const baked = bakeSpriteLayer(layout);
    const corners: Array<[number, number]> = [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
    ];
    const rot = Matrix.RotationY(p.rotY);
    for (let k = 0; k < 4; k++) {
      const local = new Vector3(corners[k][0] * p.scale, corners[k][1] * p.scale, 0);
      const ref = Vector3.TransformCoordinates(local, rot).add(new Vector3(p.x, p.y, p.z));
      const i = k * 3;
      // Babylon matrices are Float32; compare at float32 precision.
      expect(baked.positions[i]).toBeCloseTo(ref.x, 5);
      expect(baked.positions[i + 1]).toBeCloseTo(ref.y, 5);
      expect(baked.positions[i + 2]).toBeCloseTo(ref.z, 5);
    }
  });

  it('keeps the CreatePlane UV orientation so sprites are not mirrored', () => {
    const baked = bakeSpriteLayer([p]);
    const expectedUVs = [0, 0, 1, 0, 1, 1, 0, 1]; // (u,v) per corner
    expect(Array.from(baked.uvs)).toEqual(expectedUVs);
  });

  it('with zero rotation the quad spans pos +/- scale/2 on x and y (XY plane)', () => {
    const baked = bakeSpriteLayer([{ x: 100, y: 260, z: 50, scale: 40, rotY: 0 }]);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < baked.positions.length; i += 3) {
      minX = Math.min(minX, baked.positions[i]);
      maxX = Math.max(maxX, baked.positions[i]);
      minY = Math.min(minY, baked.positions[i + 1]);
      maxY = Math.max(maxY, baked.positions[i + 1]);
      minZ = Math.min(minZ, baked.positions[i + 2]);
      maxZ = Math.max(maxZ, baked.positions[i + 2]);
    }
    expect(minX).toBeCloseTo(100 - 20, 9);
    expect(maxX).toBeCloseTo(100 + 20, 9);
    expect(minY).toBeCloseTo(260 - 20, 9);
    expect(maxY).toBeCloseTo(260 + 20, 9);
    expect(minZ).toBeCloseTo(50, 9);
    expect(maxZ).toBeCloseTo(50, 9);
  });
});

// ---------------------------------------------------------------------------
// Pure layouts
// ---------------------------------------------------------------------------

describe('sprite layouts (pure)', () => {
  it('cloud layout is deterministic, full-count and within bounds', () => {
    const a = generateCloudLayout();
    const b = generateCloudLayout();
    expect(a.length).toBe(CLOUD_COUNT);
    for (let i = 0; i < a.length; i++) {
      expect(a[i].x).toBe(b[i].x);
      expect(a[i].y).toBe(b[i].y);
      expect(a[i].z).toBe(b[i].z);
      expect(a[i].scale).toBe(b[i].scale);
      expect(a[i].rotY).toBe(b[i].rotY);
    }
    for (const p of a) {
      expect(p.y).toBeGreaterThanOrEqual(CLOUD_ALTITUDE_MIN);
      expect(p.y).toBeLessThanOrEqual(CLOUD_ALTITUDE_MAX);
      expect(Math.hypot(p.x, p.z)).toBeLessThanOrEqual(CLOUD_REACH + 1e-9);
      expect(p.scale).toBeGreaterThan(100);
      expect(p.scale).toBeLessThan(400);
    }
  });

  it('mist layout fills exactly MIST_COUNT sprites on low, gentle terrain', () => {
    const layout = generateMistLayout();
    expect(layout.length).toBe(MIST_COUNT);
    for (const p of layout) {
      const h = terrainHeight(p.x, p.z);
      // Mist hovers a fixed height above the exact local terrain.
      expect(p.y - (h + MIST_HEIGHT)).toBeCloseTo(0, 6);
      // It only pools in low, gentle ground — never on cliffs or peaks.
      expect(h).toBeLessThanOrEqual(3.0);
      expect(h).toBeGreaterThanOrEqual(SEA_LEVEL - 4.5);
      expect(p.scale).toBeGreaterThan(60);
      expect(p.scale).toBeLessThan(160);
    }
    const again = generateMistLayout();
    for (let i = 0; i < layout.length; i++) {
      expect(layout[i].x).toBe(again[i].x);
      expect(layout[i].y).toBe(again[i].y);
      expect(layout[i].z).toBe(again[i].z);
    }
  });
});

// ---------------------------------------------------------------------------
// Atmosphere class wiring (NullEngine)
// ---------------------------------------------------------------------------

describe('Atmosphere class (NullEngine)', () => {
  const engine = new NullEngine();
  let scene: Scene;
  let canvases: CapturedCanvas[];

  beforeEach(() => {
    canvases = installCanvasStub();
    scene = new Scene(engine);
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogDensity = 0.0022;
    scene.fogColor = new Color3(0.62, 0.75, 0.85);
  });

  afterEach(() => {
    scene?.dispose();
    delete (globalThis as Record<string, unknown>).document;
  });

  it('builds one baked layer mesh per layer holding every sprite', () => {
    const atmo = new Atmosphere(scene);
    const clouds = atmo.cloudRoot.getChildMeshes();
    const mists = atmo.mistRoot.getChildMeshes();
    // One static world-space mesh per layer (all sprites baked in).
    expect(clouds.length).toBe(1);
    expect(mists.length).toBe(1);
    expect(atmo.spriteCount).toBe(CLOUD_COUNT + MIST_COUNT);
    // The baked meshes keep the full sprite counts as vertex data.
    const cloudVerts = clouds[0].getVerticesData('position')!;
    const mistVerts = mists[0].getVerticesData('position')!;
    expect(cloudVerts.length / 3).toBe(CLOUD_COUNT * 4);
    expect(mistVerts.length / 3).toBe(MIST_COUNT * 4);
    // Meshes are visible children of their (rotatable) layer roots.
    expect(clouds[0].parent).toBe(atmo.cloudRoot);
    expect(mists[0].parent).toBe(atmo.mistRoot);
    expect(clouds[0].isEnabled()).toBe(true);
    expect(mists[0].isEnabled()).toBe(true);
    expect(clouds[0].isPickable).toBe(false);
    atmo.dispose();
  });

  it('layer drift rotates the whole baked mesh around the island origin', () => {
    const atmo = new Atmosphere(scene);
    const cloud = atmo.cloudRoot.getChildMeshes()[0];
    // Capture a baked (pre-drift) cloud corner in local/world space at t=0.
    const verts0 = Float32Array.from(cloud.getVerticesData('position')!);
    const c0 = new Vector3(verts0[0], verts0[1], verts0[2]);

    atmo.update(20, 1); // advance the drift
    const rotY = atmo.cloudRoot.rotation.y;
    cloud.computeWorldMatrix(true);
    const world = Vector3.TransformCoordinates(c0, cloud.getWorldMatrix());

    // Expected: same corner rotated about the world Y axis by the drift.
    const ref = Vector3.TransformCoordinates(c0, Matrix.RotationY(rotY));
    expect(world.x).toBeCloseTo(ref.x, 6);
    expect(world.y).toBeCloseTo(ref.y, 6);
    expect(world.z).toBeCloseTo(ref.z, 6);
    atmo.dispose();
  });

  it('paints the two alpha textures onto canvases with real coverage', () => {
    new Atmosphere(scene);
    const painted = canvases.filter((c) => c.last !== undefined);
    expect(painted.length).toBe(2); // cloud + mist alpha canvases
    for (const c of painted) {
      const d = c.last!;
      let alphaSum = 0;
      for (let i = 3; i < d.length; i += 4) alphaSum += d[i];
      // The sprite body must be visible (not an all-zero texture).
      expect(alphaSum / (d.length / 4)).toBeGreaterThan(35);
    }
  });

  it('mirrors scene fog (colour + EXP2 density) into both layers each frame', () => {
    const atmo = new Atmosphere(scene);

    scene.fogDensity = 0.0038;
    scene.fogColor = new Color3(0.035, 0.055, 0.1);
    fireOnBeforeRender(scene);
    expect(floatUniform(atmo.cloudMaterial, 'fogDensity')).toBeCloseTo(0.0038, 6);
    expect(floatUniform(atmo.mistMaterial, 'fogDensity')).toBeCloseTo(0.0038, 6);
    const fc = vec3Uniform(atmo.mistMaterial, 'fogColor');
    expect(fc.x).toBeCloseTo(0.035, 6);
    expect(fc.z).toBeCloseTo(0.1, 6);

    atmo.dispose();
  });

  it('attenuates fog for clouds (above the haze layer) but not for mist', () => {
    const atmo = new Atmosphere(scene);
    expect(floatUniform(atmo.cloudMaterial, 'fogScale')).toBeCloseTo(0.45, 6);
    expect(floatUniform(atmo.mistMaterial, 'fogScale')).toBeCloseTo(1.0, 6);
    atmo.dispose();
  });

  it('drifts the layers and follows day/night tint and opacity', () => {
    const atmo = new Atmosphere(scene);
    const startCloudRot = atmo.cloudRoot.rotation.y;
    atmo.update(10, 1);
    expect(atmo.cloudRoot.rotation.y - startCloudRot).toBeGreaterThan(0);
    const startMistRot = atmo.mistRoot.rotation.y;
    atmo.update(10, 1);
    expect(atmo.mistRoot.rotation.y - startMistRot).toBeLessThan(0); // opposite drift

    // NOTE: ShaderMaterial.setVector3 keeps the passed Vector3 by reference,
    // so capture plain numbers before mutating the uniforms.
    const dayTint = vec3Uniform(atmo.cloudMaterial, 'tint');
    const dayTintX = dayTint.x;
    atmo.update(0, 0); // deep night
    const nightTintX = vec3Uniform(atmo.cloudMaterial, 'tint').x;
    expect(dayTintX).toBeGreaterThan(nightTintX + 0.5);
    expect(floatUniform(atmo.cloudMaterial, 'opacity')).toBeLessThan(0.6); // faded at night

    atmo.update(0, 1); // back to day
    expect(vec3Uniform(atmo.cloudMaterial, 'tint').x).toBeCloseTo(dayTintX, 6);
    expect(floatUniform(atmo.cloudMaterial, 'opacity')).toBeGreaterThan(0.8);

    atmo.dispose();
  });

  it('dispose removes the fog observer and disposes sprites + materials', async () => {
    const atmo = new Atmosphere(scene);
    const before = scene.onBeforeRenderObservable.observers.length;
    atmo.dispose();
    // Instances are gone from their (disposed) roots and the scene.
    expect(atmo.cloudRoot.getChildMeshes().length).toBe(0);
    expect(scene.meshes.filter((m) => m.name.startsWith('atmo_')).length).toBe(0);
    // v9 observables finalise removal asynchronously (setTimeout 0).
    await new Promise((r) => setTimeout(r, 5));
    expect(scene.onBeforeRenderObservable.observers.length).toBe(before - 1);
  });
});
