import { describe, expect, it } from 'vitest';
import {
  DirectionalLight,
  Engine,
  FreeCamera,
  MeshBuilder,
  NullEngine,
  PointLight,
  Scene,
  ShaderMaterial,
  ShaderStore,
  ShadowGenerator,
  Vector3,
} from '@babylonjs/core';
import {
  SHADOW_FRAG_DECL,
  SHADOW_SAMPLE,
  SHADOW_UNIFORMS,
  SHADOW_VERT_DECL,
  SHADOW_VERT_MAIN,
  ShadowReceiver,
  findShadowGenerator,
  shadowReceiveDefines,
} from './shadowReceiver';

/** Read a ShaderMaterial float uniform (cached before the GPU effect exists). */
function floatUniform(mat: ShaderMaterial, name: string): number {
  return (mat as unknown as { _floats: Record<string, number> })._floats[name];
}
function matrixUniform(
  mat: ShaderMaterial,
  name: string,
): { m: number[] } {
  return (mat as unknown as { _matrices: Record<string, { m: number[] }> })._matrices[name];
}
function vector2Uniform(
  mat: ShaderMaterial,
  name: string,
): { x: number; y: number } {
  return (mat as unknown as { _vectors2: Record<string, { x: number; y: number }> })._vectors2[name];
}
function textureUniform(
  mat: ShaderMaterial,
  name: string,
): unknown {
  return (mat as unknown as { _textures: Record<string, unknown> })._textures[name];
}

/** Minimal shadow-receiving ShaderMaterial that uses the shared snippets. */
function makeShadowMaterial(
  scene: Scene,
  engine: Engine,
): ShaderMaterial {
  const vert = `
precision highp float;
attribute vec3 position;
uniform mat4 world;
uniform mat4 viewProjection;
${SHADOW_VERT_DECL}
void main() {
  vec4 wp = world * vec4(position, 1.0);
${SHADOW_VERT_MAIN('wp')}
  gl_Position = viewProjection * wp;
}
`;
  const frag = `
precision highp float;
${SHADOW_FRAG_DECL}
void main() {
  float s = ${SHADOW_SAMPLE};
  gl_FragColor = vec4(vec3(s), 1.0);
}
`;
  return new ShaderMaterial(
    'shadowMat',
    scene,
    { vertexSource: vert, fragmentSource: frag },
    {
      attributes: ['position'],
      uniforms: ['world', 'viewProjection', ...SHADOW_UNIFORMS],
      defines: shadowReceiveDefines(engine),
    },
  );
}

/** Fire the scene's per-frame observer (v9 requires a notification argument). */
function fireOnBeforeRender(scene: Scene): void {
  scene.onBeforeRenderObservable.notifyObservers(scene);
}

describe('shadow receive GLSL snippets', () => {
  it('share identical varying declarations between vertex and fragment', () => {
    for (const decl of ['varying vec4 vShadowPos;', 'varying float vShadowDepthMetric;']) {
      expect(SHADOW_VERT_DECL).toContain(decl);
      expect(SHADOW_FRAG_DECL).toContain(decl);
    }
  });

  it('fragment declaration pulls in the engine shadow functions', () => {
    expect(SHADOW_FRAG_DECL).toContain('#include <shadowsFragmentFunctions>');
    for (const u of ['shadowSampler', 'shadowDarkness', 'shadowDepthScale', 'shadowFalloff']) {
      expect(SHADOW_FRAG_DECL).toContain(u);
    }
  });

  it('fragment declaration pulls in helperFunctions BEFORE the shadow functions (getRand)', () => {
    // Regression (#26): the engine's `shadowsFragmentFunctions` include
    // calls `getRand(...)` inside its PCF/PCSS paths (active whenever
    // SHADOWS is defined), but `getRand` is defined ONLY in the engine's
    // `helperFunctions` include. Without `#include <helperFunctions>` the
    // terrain/water/vegetation shaders fail with
    //   `getRand : no matching overloaded function found`
    // and the whole world renders as sky + sea.
    const helperIdx = SHADOW_FRAG_DECL.indexOf('#include <helperFunctions>');
    const shadowIdx = SHADOW_FRAG_DECL.indexOf('#include <shadowsFragmentFunctions>');
    expect(helperIdx).toBeGreaterThanOrEqual(0);
    expect(shadowIdx).toBeGreaterThan(helperIdx);
    // The fix is a shared include, not a local duplicate of getRand().
    expect(SHADOW_FRAG_DECL).not.toMatch(/\bfloat\s+getRand\s*\(/);
  });

  it('both fragment includes resolve in the engine include store (getRand dependency)', () => {
    // The side-effect imports at the top of this module must have
    // registered BOTH includes with the engine; the shadow include must
    // actually depend on getRand and helperFunctions must provide it.
    const store = ShaderStore.GetIncludesShadersStore();
    const helper = store['helperFunctions'];
    const shadow = store['shadowsFragmentFunctions'];
    expect(typeof helper).toBe('string');
    expect(typeof shadow).toBe('string');
    expect(helper).toMatch(/float\s+getRand\s*\(vec2\s+seed\)/);
    expect(shadow).toContain('getRand(');
    expect(helper).not.toContain('#include <');
  });

  it('the sample expression is the engine-matched BSM accessor', () => {
    expect(SHADOW_SAMPLE).toContain('computeShadowWithESM(');
    expect(SHADOW_SAMPLE).toContain('vShadowPos');
    expect(SHADOW_SAMPLE).toContain('vShadowDepthMetric');
    expect(SHADOW_SAMPLE).toContain('shadowSampler');
  });

  it('uniform list covers every bound uniform exactly', () => {
    expect(SHADOW_UNIFORMS).toEqual(
      expect.arrayContaining([
        'shadowLightMatrix',
        'shadowDepthValues',
        'shadowSampler',
        'shadowDarkness',
        'shadowDepthScale',
        'shadowFalloff',
      ]),
    );
    expect(new Set(SHADOW_UNIFORMS).size).toBe(SHADOW_UNIFORMS.length);
  });

  it('defines are SHADOWS-only on NullEngine (no float-shadow caps)', () => {
    const engine = new NullEngine();
    const defs = shadowReceiveDefines(engine);
    expect(defs[0]).toBe('SHADOWS');
    // NullEngine reports no half-float render+filter caps -> no SHADOWFLOAT.
    expect(defs).not.toContain('SHADOWFLOAT');
    engine.dispose();
  });
});

describe('ShadowReceiver (scene-state wiring)', () => {
  it('stays a safe no-op when the scene has no shadow generator', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.addMesh(MeshBuilder.CreateSphere('s', { diameter: 1 }, scene));
    const mat = makeShadowMaterial(scene, engine);
    new ShadowReceiver(scene, mat);
    fireOnBeforeRender(scene);

    // darkness=1 => computeShadowWithESM returns exactly 1.0 no matter what
    // (1 - clamp(x, 0, 1 - darkness) with darkness=1), so the material can
    // never render fully black without a real shadow generator.
    expect(floatUniform(mat, 'shadowDarkness')).toBe(1);
    expect(textureUniform(mat, 'shadowSampler')).toBeUndefined();

    expect(findShadowGenerator(scene)).toBeNull();
    mat.dispose();
    scene.dispose();
    engine.dispose();
  });

  it('mirrors the ShadowGenerator state into the material every frame', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.addMesh(MeshBuilder.CreateSphere('camHolder', { diameter: 0.1 }, scene));
    const cam = new FreeCamera('cam', new Vector3(0, 1, 0), scene);
    cam.ellipsoid = new Vector3(0.5, 0.5, 0.5);
    scene.activeCamera = cam;

    const sun = new DirectionalLight('sun', new Vector3(-1, -2, 0.5), scene);
    const gen = new ShadowGenerator(2048, sun);
    gen.useBlurExponentialShadowMap = true;
    gen.darkness = 0.42;
    // A caster so the generator actually owns a render target in the scene.
    const block = MeshBuilder.CreateBox('block', { size: 1 }, scene);
    gen.addShadowCaster(block);

    const mat = makeShadowMaterial(scene, engine);
    const receiver = new ShadowReceiver(scene, mat);

    // Simulate frame 1 (the engine bumps the render id per frame; the
    // generator caches its transform matrix per render id).
    scene.incrementRenderId();
    fireOnBeforeRender(scene);

    const expected = gen.getTransformMatrix().clone(); // copy: Babylon reuses the matrix in place
    const bound = matrixUniform(mat, 'shadowLightMatrix');
    for (let i = 0; i < 16; i++) expect(bound.m[i]).toBeCloseTo(expected.m[i], 8);
    expect(gen.getShadowMapForRendering()).toBeDefined();
    expect(textureUniform(mat, 'shadowSampler')).toBe(gen.getShadowMapForRendering());
    expect(floatUniform(mat, 'shadowDarkness')).toBeCloseTo(0.42, 6);
    // Directional light: depthValues = (minZ, minZ + maxZ) = (1, 2).
    const dv = vector2Uniform(mat, 'shadowDepthValues');
    expect(dv.x).toBeCloseTo(sun.getDepthMinZ(cam), 6);
    expect(dv.y).toBeCloseTo(sun.getDepthMinZ(cam) + sun.getDepthMaxZ(cam), 6);

    // Moving the sun must change the bound light matrix on the next frame.
    sun.direction.set(1, -2, -0.5).normalize();
    scene.incrementRenderId();
    fireOnBeforeRender(scene);
    const moved = matrixUniform(mat, 'shadowLightMatrix');
    expect(moved.m).not.toEqual(expected.m);

    receiver.dispose();
    mat.dispose();
    scene.dispose();
    engine.dispose();
  });

  it('dispose removes the per-frame observer', async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.addMesh(MeshBuilder.CreateSphere('s', { diameter: 0.1 }, scene));
    const mat = makeShadowMaterial(scene, engine);
    const before = scene.onBeforeRenderObservable.observers.length;
    const receiver = new ShadowReceiver(scene, mat);
    expect(scene.onBeforeRenderObservable.observers.length).toBe(before + 1);
    receiver.dispose();
    // v9 observables finalise removal asynchronously (setTimeout 0).
    await new Promise((r) => setTimeout(r, 5));
    expect(scene.onBeforeRenderObservable.observers.length).toBe(before);
    mat.dispose();
    scene.dispose();
    engine.dispose();
  });

  it('findShadowGenerator returns only directional lights with a generator', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.addMesh(MeshBuilder.CreateSphere('s', { diameter: 0.1 }, scene));
    const point = new PointLight('p', new Vector3(0, 0, 0), scene);
    expect(findShadowGenerator(scene)).toBeNull();

    const sun = new DirectionalLight('sun', new Vector3(0, -1, 0), scene);
    expect(findShadowGenerator(scene)).toBeNull(); // no generator yet
    const gen = new ShadowGenerator(1024, sun);
    const found = findShadowGenerator(scene);
    expect(found?.light).toBe(sun);
    expect(found?.generator).toBe(gen);
    // The point light (even with a generator) is ignored.
    const gen2 = new ShadowGenerator(512, point);
    expect(findShadowGenerator(scene)?.light).toBe(sun);
    expect(gen2).toBeDefined();

    scene.dispose();
    engine.dispose();
  });
});
