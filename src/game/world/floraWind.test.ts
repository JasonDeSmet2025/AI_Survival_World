import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Color3, Mesh, NullEngine, PBRMaterial, Scene, VertexBuffer } from '@babylonjs/core';
import { FLORA_WIND, dumpFloraGLSL, populateFlora, type FloraHandle } from './flora';
import { SharedWorldState } from './worldState';
import type { Collider } from './types';
import type { SharedMaterials } from '../visual/materials';

/** Read a ShaderMaterial float uniform (cached in _floats before the GPU). */
const floatOf = (mat: unknown, name: string): number =>
  (mat as unknown as { _floats: Record<string, number> })._floats[name];
/** Read a ShaderMaterial vec2 uniform (cached in _vectors2 before the GPU). */
const vec2Of = (mat: unknown, name: string) =>
  (mat as unknown as { _vectors2: Record<string, { x: number; y: number }> })._vectors2[name];

const swayOf = (m: Mesh): Float32Array => {
  const s = m.getVerticesData('sway');
  expect(s, `mesh ${m.name} must own a sway buffer`).toBeInstanceOf(Float32Array);
  return s as Float32Array;
};
const vertsOf = (m: Mesh): number =>
  ((m.getVerticesData(VertexBuffer.PositionKind) as Float32Array) ?? new Float32Array(0)).length / 3;

function buildWorld() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const material = new PBRMaterial('m', scene);
  material.roughness = 0.9;
  material.metallic = 0;
  const mats = Object.fromEntries(
    ['bark', 'leaf', 'pineLeaf', 'rock', 'bushLeaf', 'berry', 'grass', 'flower'].map((k) => [
      k,
      { albedoColor: new Color3(0.4, 0.45, 0.3), roughness: 0.9, metallic: 0, isReady: () => true, dispose: () => undefined },
    ]),
  ) as unknown as SharedMaterials;
  const state = new SharedWorldState();
  const colliders: Collider[] = [];
  const handle = populateFlora(scene, mats, state, colliders, []);
  return { engine, scene, state, handle };
}

describe('flora wind-sway (baked per-vertex weights)', () => {
  let engine: NullEngine;
  let state: SharedWorldState;
  let handle: FloraHandle;

  beforeAll(() => {
    const built = buildWorld();
    engine = built.engine;
    state = built.state;
    handle = built.handle;
  }, 30000);
  afterAll(() => engine.dispose());

  it('every chunk mesh carries a sway buffer matching its vertex count, in [0,1]', () => {
    const chunks = handle.chunkMeshes();
    expect(chunks.length).toBeGreaterThan(0);
    for (const m of chunks) {
      const sway = swayOf(m);
      expect(sway.length).toBe(vertsOf(m));
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < sway.length; i++) {
        expect(Number.isFinite(sway[i]), `sway[${i}] of ${m.name} is finite`).toBe(true);
        if (sway[i] < 0 || sway[i] > 1) throw new Error(`sway out of range in ${m.name}: ${sway[i]}`);
        if (sway[i] < min) min = sway[i];
        if (sway[i] > max) max = sway[i];
      }
      void min;
      void max;
    }
  }, 30000);

  it('rocks are fully rigid (zero sway on every rock detail level)', () => {
    const rocks = handle.chunkMeshes().filter((m) => m.name.startsWith('flora_rock_'));
    expect(rocks.length).toBeGreaterThan(0);
    for (const m of rocks) {
      const sway = swayOf(m);
      for (let i = 0; i < sway.length; i++) expect(sway[i]).toBe(0);
    }
  }, 30000);

  it('grass blades are rigid at the base and fully weighted at the tip', () => {
    const grass = handle.chunkMeshes().filter((m) => m.name.startsWith('flora_grass_'));
    expect(grass.length).toBeGreaterThan(0);
    for (const m of grass) {
      const sway = swayOf(m);
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < sway.length; i++) {
        if (sway[i] < min) min = sway[i];
        if (sway[i] > max) max = sway[i];
      }
      expect(min).toBeLessThanOrEqual(0.01); // bases pinned to the ground
      expect(max).toBeGreaterThanOrEqual(0.999); // tips fully flexible
    }
  }, 30000);

  it('trees: trunks barely flex, canopies wave strongly', () => {
    const trees = handle.chunkMeshes().filter((m) => m.name.startsWith('flora_tree_'));
    expect(trees.length).toBeGreaterThan(0);
    for (const m of trees) {
      const sway = swayOf(m);
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < sway.length; i++) {
        if (sway[i] < min) min = sway[i];
        if (sway[i] > max) max = sway[i];
      }
      expect(min).toBeLessThanOrEqual(0.05); // trunk base ~rigid
      expect(max).toBeGreaterThanOrEqual(0.8); // canopy blobs wave
    }
  }, 30000);

  it('is deterministic: byte-identical sway buffers across fresh worlds', () => {
    const a = buildWorld();
    try {
      const mapA = new Map<string, number[]>();
      for (const m of handle.chunkMeshes()) mapA.set(m.name, Array.from(swayOf(m)));
      const mapB = new Map<string, number[]>();
      for (const m of a.handle.chunkMeshes()) mapB.set(m.name, Array.from(swayOf(m)));
      expect(mapB.size).toBe(mapA.size);
      for (const [name, arr] of mapA) expect(mapB.get(name), name).toEqual(arr);
    } finally {
      a.engine.dispose();
    }
  }, 40000);

  it('re-bakes (harvest state changes) keep the sway buffer intact', () => {
    const tree = state.nodes.find((n) => n.kind === 'tree');
    expect(tree).toBeDefined();
    // Re-bake one tree chunk by damaging its node.
    state.damageNode(tree!.id, 1);
    handle.applyState();
    const chunks = handle.chunkMeshes();
    for (const m of chunks) expect(swayOf(m).length).toBe(vertsOf(m));
    expect(chunks.length).toBeGreaterThan(0);
  }, 30000);
});

describe('flora wind shader + uniforms', () => {
  let engine: NullEngine;
  let scene: Scene;
  let handle: FloraHandle;

  beforeAll(() => {
    const built = buildWorld();
    engine = built.engine;
    scene = built.scene;
    handle = built.handle;
  }, 30000);
  afterAll(() => engine.dispose());

  it('exposes the shared material with the sway attribute and wind uniforms', () => {
    const mat = handle.material as unknown as {
      _options: { attributes: string[]; uniforms: string[] };
    };
    expect(mat._options.attributes).toContain('sway');
    expect(mat._options.attributes).toContain('position');
    for (const u of ['uWindTime', 'uWindDir', 'uWindAmp', 'fogColor', 'fogDensity', 'shadowSampler'])
      expect(mat._options.uniforms, u).toContain(u);
  });

  it('updateWind accumulates time, keeps a unit wind direction and drifts it', () => {
    const mat = handle.material;
    handle.updateWind(0.5);
    handle.updateWind(0.5);
    handle.updateWind(0.5);
    expect(Math.abs(floatOf(mat, 'uWindTime') - 1.5)).toBeLessThan(1e-5);
    const d = vec2Of(mat, 'uWindDir');
    expect(Math.hypot(d.x, d.y)).toBeCloseTo(1, 4);
    // Direction must drift between updates (no static-forest look).
    const before = { x: vec2Of(mat, 'uWindDir').x, y: vec2Of(mat, 'uWindDir').y };
    handle.updateWind(3.0);
    const after = vec2Of(mat, 'uWindDir');
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(1e-4);
  });

  it('ignores zero and negative dt (paused game = still air)', () => {
    const mat = handle.material;
    handle.updateWind(0.25);
    const t = floatOf(mat, 'uWindTime');
    handle.updateWind(0);
    handle.updateWind(-2);
    expect(Math.abs(floatOf(mat, 'uWindTime') - t)).toBeLessThan(1e-9);
  });

  it('honours the displacement budget: maxSway * amp <= FLORA_WIND.maxOffset', () => {
    let maxSway = 0;
    for (const m of handle.chunkMeshes()) {
      const sway = swayOf(m);
      for (let i = 0; i < sway.length; i++) if (sway[i] > maxSway) maxSway = sway[i];
    }
    // Worst case: gust = 0.7+0.3 = 1.0 and |dirTerms| = 0.65+0.35 = 1.0.
    expect(maxSway * FLORA_WIND.amp).toBeLessThanOrEqual(FLORA_WIND.maxOffset + 1e-6);
    expect(FLORA_WIND.amp).toBeGreaterThanOrEqual(0.05); // visible on ~1 u grass
    expect(FLORA_WIND.amp).toBeLessThan(0.25); // ...but never comical
  }, 30000);

  it('GLSL guards: wind block wired, no hash checkers, fog+grade+shadow present', () => {
    const [vert, frag] = dumpFloraGLSL().split('----------------');
    // Vertex stage
    expect(vert).toContain('attribute float sway;');
    expect(vert).toContain('uniform float uWindTime;');
    expect(vert).toContain('uniform vec2 uWindDir;');
    expect(vert).toContain('uniform float uWindAmp;');
    expect(vert).toContain('position + windOffset(position)');
    expect(vert).not.toContain('h21(');
    expect(vert).not.toContain('checker');
    // Fragment stage
    expect(frag).toContain('colorGrade(c)');
    expect(frag).toContain('mix(c, fogColor, clamp(f, 0.0, 1.0))');
    expect(frag).toContain('computeShadowWithESM');
    // Every varying is declared on both sides.
    for (const v of ['vNormal', 'vPos', 'vColor', 'vShadowPos', 'vShadowDepthMetric']) {
      expect(vert, `${v} in vertex`).toContain(v);
      expect(frag, `${v} in fragment`).toContain(v);
    }
    // Sway only affects the vertex stage.
    expect(frag).not.toContain('sway');
  });

  it('fog + colour pipeline mirroring runs from the frame observer', () => {
    const mat = handle.material as unknown as { _floats: Record<string, number> };
    scene.fogDensity = 0.0033;
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(Math.abs(mat._floats.fogDensity - 0.0033)).toBeLessThan(1e-6);
    expect(Number.isFinite(mat._floats.exposureLinear)).toBe(true);
  });
});
