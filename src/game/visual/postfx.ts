/**
 * Camera post-processing (Visual Agent scope).
 *
 * Owns the scene's single PostProcessRenderPipeline with two effects,
 * in render order:
 *
 *  1. Bloom          – glow for campfires and other bright emissive sources.
 *  2. Underwater tint – blue depth attenuation while the player is submerged.
 *
 * IMPORTANT (Babylon 9.33): a standalone `new BloomEffect(scene, ...)` does
 * NOTHING unless the effect is added to a PostProcessRenderPipeline that is
 * registered on `scene.postProcessRenderPipelineManager` and its camera is
 * attached to it. This class wires that up; the pipeline manager's scene
 * component drives the chain during `scene.render()`, and the classic
 * camera post-process chain (camera._postProcesses) does the actual passes.
 */
import {
  BloomEffect,
  Camera,
  Effect,
  PostProcess,
  PostProcessRenderEffect,
  PostProcessRenderPipeline,
  Scene,
  ShaderStore,
  Texture,
} from '@babylonjs/core';

export const PIPELINE_NAME = 'survival-postfx';
export const BLOOM_EFFECT_ID = 'bloom';
export const UNDERWATER_EFFECT_ID = 'underwaterTint';

/** Feet depth (m) below the water surface at which the tint is fully "deep". */
export const UNDERWATER_MAX_DEPTH = 10;

/**
 * Full-screen underwater attenuation.
 *
 * Written in NATIVE GLSL ES 3.00 (the engine compiles custom post-process
 * shaders as `#version 300 es` on WebGL2, where `varying`/`attribute`/
 * `gl_FragColor` and `texture2D` are NOT valid — `varying` is a reserved
 * word):
 *  - `in` instead of `varying` (matches the built-in `postprocess` vertex
 *    stage's `out vec2 vUV` after its automatic GLSL1→3 conversion),
 *  - `texture()` instead of `texture2D()`,
 *  - an explicitly declared fragment output instead of `gl_FragColor`
 *    (its `layout(location = 0) out` also tells the engine's WebGL2
 *    processor NOT to inject its own `glFragColor` output).
 */
const UNDERWATER_FRAGMENT = /* glsl */ `
precision highp float;
in vec2 vUV;
uniform sampler2D textureSampler;
uniform float uStrength; // smoothed 0..1
uniform float uDepth;    // normalised feet depth 0..1
layout(location = 0) out vec4 fragColor;
void main() {
    vec4 c = texture(textureSampler, vUV);
    // Believable ocean water: turquoise near the surface, dark blue-green
    // in the deep. Kept desaturated so terrain colours stay readable.
    vec3 shallow = vec3(0.10, 0.38, 0.50);
    vec3 deep = vec3(0.012, 0.11, 0.22);
    vec3 water = mix(shallow, deep, uDepth);
    float amount = uStrength * (0.55 + 0.30 * uDepth);
    c.rgb = mix(c.rgb, water, amount);
    // Light attenuation with depth.
    c.rgb *= 1.0 - 0.35 * uStrength * uDepth;
    fragColor = c;
}
`;

/**
 * Registers the inline fragment in the engine's shader store, exactly the
 * way the engine registers its own post-process fragments (see
 * `Shaders/kernelBlur.fragment.js`: `<name>PixelShader` in
 * `ShaderStore.ShadersStore`, idempotent guard).
 *
 * Why this instead of the `source:` inline prefix: `PostProcess` passes
 * the fragment name to `engine.createEffect({ vertex, fragment })` and the
 * effect pipeline's `UseFinalCode()` inlines `baseName.fragment` verbatim
 * into the final source as
 * `#define SHADER_NAME fragment:<baseName.fragment>\n<code>`. A
 * `source:`-prefixed multi-line string therefore embeds the ENTIRE
 * fragment into that single-line `#define`, after which the real
 * (migrated) code is appended — the whole shader ends up present TWICE
 * (duplicate `vUV`/`textureSampler`/`uStrength`/`uDepth`/`fragColor`/`main`
 * declarations → guaranteed compile failure). With a short registered
 * name the `#define` stays one line and the fragment appears exactly once.
 */
{
  const glslStore = ShaderStore.GetShadersStore();
  if (!glslStore[UNDERWATER_EFFECT_ID + 'PixelShader']) {
    glslStore[UNDERWATER_EFFECT_ID + 'PixelShader'] = UNDERWATER_FRAGMENT;
  }
}

/** Exposes the underwater fragment source (QA regression guards). */
export function dumpUnderwaterGLSL(): string {
  return UNDERWATER_FRAGMENT;
}

/** Strength ramp speed (units of 0..1 per second ≈ 0.5 s to fully submerge). */
const RAMP_SPEED = 2.2;
/** Hysteresis so the pass attach/detach never flickers at the threshold. */
const ENABLE_EPS = 0.004;
const DISABLE_EPS = 0.001;

export class PostFx {
  readonly bloom: BloomEffect;
  /** Full-screen underwater tint pass (exposed for tests/inspection). */
  readonly underwater: PostProcess;
  /** Smoothed underwater strength 0..1 (drives the fragment shader). */
  strength = 0;
  /** Normalised feet depth 0..1 (drives the fragment shader). */
  depthNorm = 0;

  private readonly scene: Scene;
  private readonly camera: Camera;
  private readonly pipeline: PostProcessRenderPipeline;
  private targetStrength = 0;
  /** Whether the underwater pass is currently attached to the camera chain. */
  private underwaterAttached = true;

  constructor(scene: Scene, camera: Camera) {
    this.scene = scene;
    this.camera = camera;
    const engine = camera.getEngine();

    this.pipeline = new PostProcessRenderPipeline(engine, PIPELINE_NAME);
    scene.postProcessRenderPipelineManager.addPipeline(this.pipeline);

    // 1) Bloom for fire/glow sources. bloomScale 0.5 = blur at half
    // resolution (the project previously passed 32, which would be a
    // 32x oversize blur texture had the effect ever been wired up).
    this.bloom = new BloomEffect(scene, 0.5, 0.45, 16);
    this.bloom.threshold = 0.78;
    this.pipeline.addEffect(this.bloom);

    // 2) Underwater tint, full screen (size ratio 1.0). The camera must be
    // NULL here: the PostProcess constructor auto-attaches to a passed
    // camera, which would put this pass BEFORE the bloom group in the
    // camera chain. The pipeline manager below is the single attach point.
    //
    // IMPORTANT: the `fragmentUrl` argument is a SHADER STORE NAME (see the
    // registration above). The engine resolves it via LoadShader()
    // ("<name>FragmentShader" → "<name>PixelShader") and keeps it as the
    // short name in the final `#define SHADER_NAME` line. Passing an inline
    // `source:` string instead duplicates the entire fragment in the final
    // GLSL (see the registration block above this class).
    this.underwater = new PostProcess(
      UNDERWATER_EFFECT_ID,
      UNDERWATER_EFFECT_ID,
      ['uStrength', 'uDepth'],
      null,
      1.0,
      null,
      Texture.BILINEAR_SAMPLINGMODE,
      engine,
      false, // not reusable
      null, // no defines
      0, // RGBA8
      undefined, // use Babylon's built-in postprocess vertex shader
      undefined,
      false, // compile now
    );
    this.underwater.onApplyObservable.add((effect: Effect) => {
      effect.setFloat('uStrength', this.strength);
      effect.setFloat('uDepth', this.depthNorm);
    });
    const underwaterEffect = new PostProcessRenderEffect(
      engine,
      UNDERWATER_EFFECT_ID,
      () => this.underwater,
      true,
    );
    this.pipeline.addEffect(underwaterEffect);

    scene.postProcessRenderPipelineManager.attachCamerasToRenderPipeline(
      PIPELINE_NAME,
      camera,
    );
  }

  /**
   * Called every frame with the player's feet depth below the water surface
   * in metres, or <= 0 when out of water.
   */
  setUnderwater(depthBelow: number): void {
    const d = Math.max(0, depthBelow);
    this.targetStrength = d > 0.02 ? 1 : 0;
    this.depthNorm = Math.min(1, d / UNDERWATER_MAX_DEPTH);
  }

  /** Advance the smooth strength ramp and attach/detach the tint pass. */
  update(dt: number): void {
    const k = Math.min(1, RAMP_SPEED * dt);
    this.strength += (this.targetStrength - this.strength) * k;

    if (this.targetStrength > 0 && this.strength > ENABLE_EPS && !this.underwaterAttached) {
      this.underwaterAttached = true;
      this.scene.postProcessRenderPipelineManager.enableEffectInPipeline(
        PIPELINE_NAME,
        UNDERWATER_EFFECT_ID,
        this.camera,
      );
    } else if (this.targetStrength === 0 && this.strength < DISABLE_EPS && this.underwaterAttached) {
      this.underwaterAttached = false;
      this.scene.postProcessRenderPipelineManager.disableEffectInPipeline(
        PIPELINE_NAME,
        UNDERWATER_EFFECT_ID,
        this.camera,
      );
    }
  }

  dispose(): void {
    this.scene.postProcessRenderPipelineManager.detachCamerasFromRenderPipeline(
      PIPELINE_NAME,
      this.camera,
    );
    this.scene.postProcessRenderPipelineManager.removePipeline(PIPELINE_NAME);
    this.underwater.dispose(this.camera);
    this.bloom.disposeEffects(this.camera);
  }
}
