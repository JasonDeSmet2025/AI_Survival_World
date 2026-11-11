/**
 * Shadow-receiving support for custom ShaderMaterial systems
 * (terrain, water, ...) — Visual Agent.
 *
 * Babylon 9.33's ShaderMaterial no longer binds lights or shadows
 * automatically (that machinery moved into the built-in materials' light
 * uniform buffers). This module wires a single directional-light
 * ShadowGenerator into any custom shader manually, using ONLY the public
 * ShadowGenerator API, so the custom shaders receive the same BSM
 * shadow map the standard materials use:
 *
 *   shadowLightMatrix   = generator.getTransformMatrix()
 *                         (light view x projection; refreshes per frame)
 *   shadowSampler       = generator.getShadowMapForRendering()
 *   shadowDarkness      = generator.darkness
 *   shadowDepthScale    = generator.depthScale
 *   shadowFalloff       = generator.frustumEdgeFalloff
 *   shadowDepthValues   = (minZ, minZ + maxZ) from the light
 *
 * The GLSL side reuses the engine's own `shadowsFragmentFunctions` include
 * and `computeShadowWithESM(...)`, so sampling semantics (ESM/BSM depth
 * encoding, depthMetric normalisation, frustum-edge falloff) match the
 * engine exactly.
 *
 * Safe default: until a shadow generator exists, `shadowDarkness` stays 1,
 * which makes `computeShadowWithESM` return exactly 1.0 regardless of the
 * (possibly unbound) sampler — i.e. the shadow term is a no-op, never a
 * fully-black screen.
 */
// Side-effect imports: guarantee the fragment includes below are registered
// with the engine's shader store even if tree-shaking drops every other
// module that registers them (registration is idempotent).
//
// CRITICAL DEPENDENCY: `shadowsFragmentFunctions` is NOT self-contained.
// Its `computeShadowWithPCF` / `computeShadowWithPCSS` (compiled in whenever
// `SHADOWS` is defined, which it always is for a shadow-receiving material)
// call `getRand(...)`, which is defined ONLY in the engine's `helperFunctions`
// include. The built-in materials pull both includes in (in that order);
// a custom shader that includes only `shadowsFragmentFunctions` fails to
// compile with `getRand : no matching overloaded function found`.
// `helperFunctions` therefore ships with `SHADOW_FRAG_DECL` below.
import '@babylonjs/core/Shaders/ShadersInclude/helperFunctions';
import '@babylonjs/core/Shaders/ShadersInclude/shadowsFragmentFunctions';
import {
  AbstractEngine,
  DirectionalLight,
  Matrix,
  Scene,
  ShaderMaterial,
  ShadowGenerator,
  Vector2,
} from '@babylonjs/core';

/** Uniform names the shadow receiver binds (extend the material's list). */
export const SHADOW_UNIFORMS: readonly string[] = [
  'shadowLightMatrix',
  'shadowDepthValues',
  'shadowSampler',
  'shadowDarkness',
  'shadowDepthScale',
  'shadowFalloff',
];

/**
 * Vertex-shader declarations (insert at top level). The `main()` must then
 * add the snippet from `SHADOW_VERT_MAIN(worldPosExpr)`.
 */
export const SHADOW_VERT_DECL = `
uniform mat4 shadowLightMatrix;
uniform vec2 shadowDepthValues;
varying vec4 vShadowPos;
varying float vShadowDepthMetric;
`;

/**
 * Snippet for the vertex `main()`: projects the world-space position into
 * the sun's shadow-camera space. `worldPosExpr` must evaluate to the
 * world-space vec4 of the fragment's surface position (e.g. `wp`, or the
 * post-displacement position for an animated water surface).
 */
export function SHADOW_VERT_MAIN(worldPosExpr: string): string {
  return `
  // Shadow receive: project into the sun shadow-camera space.
  vShadowPos = shadowLightMatrix * ${worldPosExpr};
  vShadowDepthMetric = (vShadowPos.z + shadowDepthValues.x) / shadowDepthValues.y;
`;
}

/**
 * Fragment-shader declarations (insert at top level, BEFORE main()).
 * Uses the engine's own shadow include so ESM sampling is bit-exact.
 */
export const SHADOW_FRAG_DECL = `
#include <helperFunctions>
#include <shadowsFragmentFunctions>
uniform sampler2D shadowSampler;
uniform float shadowDarkness;
uniform float shadowDepthScale;
uniform float shadowFalloff;
varying vec4 vShadowPos;
varying float vShadowDepthMetric;
`;

/**
 * The shadow sample expression (0..1, 1 = fully lit). In v9.33 the BSM
 * pipeline is the only non-PCF/PCSS filter used here, so the ESM function
 * is the correct (and engine-matched) accessor.
 */
export const SHADOW_SAMPLE =
  'computeShadowWithESM(vShadowPos, vShadowDepthMetric, shadowSampler, shadowDarkness, shadowDepthScale, shadowFalloff)';

/**
 * Compile-time defines a shadow-receiving material needs.
 * `SHADOWFLOAT` must match the format the engine actually uses for the
 * shadow map: it is defined exactly when the engine's shadow map is a
 * float/half-float texture (identical caps check to the engine's own).
 */
export function shadowReceiveDefines(engine: AbstractEngine): string[] {
  const caps = engine.getCaps();
  const floatShadows =
    (caps.textureHalfFloatRender && caps.textureHalfFloatLinearFiltering) ||
    (caps.textureFloatRender && caps.textureFloatLinearFiltering);
  return floatShadows ? ['SHADOWS', 'SHADOWFLOAT'] : ['SHADOWS'];
}

/** Find the first directional light in the scene that owns a shadow generator. */
export function findShadowGenerator(
  scene: Scene,
): { generator: ShadowGenerator; light: DirectionalLight } | null {
  for (const light of scene.lights) {
    if (!(light instanceof DirectionalLight)) continue;
    const generator = light.getShadowGenerator();
    if (generator) return { generator: generator as ShadowGenerator, light };
  }
  return null;
}

/** Per-material wiring of the directional-light shadow map. */
export class ShadowReceiver {
  readonly material: ShaderMaterial;
  private scene: Scene;
  private observer: ReturnType<Scene['onBeforeRenderObservable']['add']>;
  /** Allocation-free scratch. */
  private matScratch = new Matrix();
  private transA = new Matrix();
  private transB = new Matrix();
  private depthValues = new Vector2();

  constructor(scene: Scene, material: ShaderMaterial, syncOnConstruct = true) {
    this.scene = scene;
    this.material = material;
    // Safe defaults: darkness=1 makes computeShadowWithESM an exact no-op
    // (1 - clamp(x, 0, 1 - 1) = 1) even with an unbound sampler, so a
    // missing shadow generator can never black out the material.
    material.setFloat('shadowDarkness', 1);
    material.setFloat('shadowDepthScale', 50);
    material.setFloat('shadowFalloff', 0);
    material.setVector2('shadowDepthValues', this.depthValues.set(1, 2));
    this.observer = scene.onBeforeRenderObservable.add(() => this.sync());
    if (syncOnConstruct) this.sync();
  }

  /** Mirror the shadow generator state into the material (allocation-free). */
  sync(): void {
    const found = findShadowGenerator(this.scene);
    if (!found) return;
    const { generator, light } = found;
    const shadowMap = generator.getShadowMapForRendering();
    if (!shadowMap) return; // generator still initialising / disposed
    this.material.setTexture('shadowSampler', shadowMap);

    // Light view x projection. With floating origin enabled the engine
    // sandwiches the transform with the floating translations — replicate
    // that exactly (T(-o) * VP * T(o)).
    const transform = generator.getTransformMatrix();
    if (this.scene.floatingOriginMode) {
      const o = this.scene.floatingOriginOffset;
      Matrix.TranslationToRef(-o.x, -o.y, -o.z, this.transA);
      this.transA.multiplyToRef(transform, this.matScratch);
      Matrix.TranslationToRef(o.x, o.y, o.z, this.transB);
      this.matScratch.multiplyToRef(this.transB, this.matScratch);
      this.material.setMatrix('shadowLightMatrix', this.matScratch);
    } else {
      this.material.setMatrix('shadowLightMatrix', transform);
    }

    this.material.setFloat('shadowDarkness', generator.darkness);
    this.material.setFloat('shadowDepthScale', generator.depthScale);
    this.material.setFloat('shadowFalloff', generator.frustumEdgeFalloff);
    const camera = this.scene.activeCamera ?? null;
    const minZ = light.getDepthMinZ(camera);
    this.depthValues.set(minZ, minZ + light.getDepthMaxZ(camera));
    this.material.setVector2('shadowDepthValues', this.depthValues);
  }

  dispose(): void {
    this.scene.onBeforeRenderObservable.remove(this.observer);
  }
}
