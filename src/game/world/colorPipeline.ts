/**
 * Colour-pipeline unification for custom shaders.
 *
 * Babylon applies its image-processing chain
 *   exposure -> vignette -> tone mapping -> gamma -> contrast -> dither
 * INSIDE each built-in material shader (default `applyByPostProcess = false`).
 * Custom ShaderMaterials bypass it entirely. Before this module existed that
 * caused three visible problems:
 *
 *  1. Raw-linear output: terrain/water/sky wrote untonemapped, ungammaed
 *     colours straight into the 8-bit LDR target while every
 *     StandardMaterial object (trees, player, buildings, sea plane) was
 *     ACES-tonemapped + gamma encoded. The same physical colour therefore
 *     rendered differently depending on the material -> the terrain read as
 *     unnatural/desaturated next to the correctly graded flora.
 *
 *  2. Horizon seams: scene fog is blended in LINEAR space; engine materials
 *     grade AFTER the fog blend, custom shaders graded nothing. Distant
 *     terrain and the standard-material sea plane therefore faded into
 *     slightly different fog colours.
 *
 *  3. 8-bit banding ("kleurbanden"): gradients banded on the LDR canvas.
 *     The engine only dithers when `ditheringEnabled` is set, and custom
 *     shaders never dithered at all.
 *
 * The GLSL chunk below is a faithful copy of the engine's
 * `imageProcessingFunctions` include (see
 * node_modules/@babylonjs/core/Shaders/ShadersInclude/
 * imageProcessingFunctions.js, v9.33), reduced to the parts this project
 * enables (ACES tone mapping == engine TONEMAPPING value 2, multiply
 * vignette, dither). `syncColorPipeline` mirrors the live
 * `scene.imageProcessingConfiguration` values (exposure is animated by the
 * Lighting system each frame) into the matching uniforms.
 *
 * IMPORTANT: fog must be blended BEFORE `colorGrade()` in every shader that
 * uses this chunk, exactly like the engine materials do.
 */
import { Scene, ShaderMaterial, Vector2, Vector4 } from '@babylonjs/core';

/**
 * GLSL chunk. Insert into a fragment shader BEFORE `void main()`.
 * Exposes `vec3 colorGrade(vec3)`.
 */
export const COLOR_GRADE_GLSL = `
uniform float exposureLinear;
uniform float contrastValue;
uniform vec2 vInverseScreenSize;
uniform float ditherIntensity;
uniform vec4 vignetteSettings1;
uniform vec4 vignetteSettings2;

const mat3 ACES_INPUT = mat3(
  vec3(0.59719, 0.07600, 0.02840),
  vec3(0.35458, 0.90834, 0.13383),
  vec3(0.04823, 0.01566, 0.83777));
const mat3 ACES_OUTPUT = mat3(
  vec3(1.60475, -0.10208, -0.00327),
  vec3(-0.53108, 1.10813, -0.07276),
  vec3(-0.07367, -0.00605, 1.07602));

// Same hash as the engine's getRand() in helperFunctions.
float gradeRand(vec2 seed) {
  return fract(sin(dot(seed, vec2(12.9898, 78.233))) * 43758.5453);
}

// Mirrors the engine's applyImageProcessing() in exactly the same order:
// exposure -> vignette -> ACES -> gamma -> contrast -> dither.
vec3 colorGrade(vec3 col) {
  col *= exposureLinear;
  vec2 viewportXY = gl_FragCoord.xy * vInverseScreenSize;
  viewportXY = viewportXY * 2.0 - 1.0;
  vec3 vignetteXY1 = vec3(viewportXY * vignetteSettings1.xy + vignetteSettings1.zw, 1.0);
  float vignetteTerm = dot(vignetteXY1, vignetteXY1);
  float vignette = pow(vignetteTerm, vignetteSettings2.w);
  col *= mix(vignetteSettings2.rgb, vec3(1.0), vignette);
  col = ACES_INPUT * col;
  {
    vec3 a = col * (col + 0.0245786) - 0.000090537;
    vec3 b = col * (0.983729 * col + 0.4329510) + 0.238081;
    col = a / b;
  }
  col = ACES_OUTPUT * col;
  col = clamp(col, 0.0, 1.0);
  col = pow(col, vec3(0.4545));
  col = clamp(col, 0.0, 1.0);
  vec3 hc = col * col * (3.0 - 2.0 * col);
  if (contrastValue < 1.0) {
    col = mix(vec3(0.5), col, contrastValue);
  } else {
    col = mix(col, hc, contrastValue - 1.0);
  }
  col = max(col, vec3(0.0));
  float rand = gradeRand(gl_FragCoord.xy * vInverseScreenSize);
  float dither = mix(-ditherIntensity, ditherIntensity, rand);
  col = clamp(col + vec3(dither), 0.0, 1.0);
  return col;
}
`;

/** Uniform names a material using COLOR_GRADE_GLSL must declare. */
export const COLOR_GRADE_UNIFORMS = [
  'exposureLinear',
  'contrastValue',
  'vInverseScreenSize',
  'ditherIntensity',
  'vignetteSettings1',
  'vignetteSettings2',
];

// Shared scratch values: setVector2/setVector4 store the value BY REFERENCE
// (v9 behaviour), so reusing one scratch per sync call is safe (single
// thread) and keeps the frame loop allocation-free.
const scratchInvScreen = new Vector2(1, 1);
const scratchVig1 = new Vector4(1, 1, 0, 0);
const scratchVig2 = new Vector4(0, 0, 0, 0);

/**
 * Mirrors the scene's live image-processing settings into a custom
 * shader's color-grade uniforms.
 *
 * Call once at material creation and from the scene's
 * onBeforeRenderObservable every frame (exposure/aspect change over time;
 * fog sync observers already fire there in each shader system).
 *
 * The vignette math replicates the engine's registerBeforeBind block
 * (vignetteScaleX = Mix(tan(fov/2)*aspect, geoMean, stretch) with
 * Mix(a, b, m) = a*(1-m) + b*m). When the engine vignette is disabled the
 * power is set to 0, which makes the in-shader multiplier a no-op.
 */
export function syncColorPipeline(scene: Scene, material: ShaderMaterial): void {
  const ipc = scene.imageProcessingConfiguration;
  material.setFloat('exposureLinear', ipc.exposure);
  material.setFloat('contrastValue', ipc.contrast);

  const engine = scene.getEngine();
  const w = engine.getRenderWidth() || 1;
  const h = engine.getRenderHeight() || 1;
  scratchInvScreen.set(1 / w, 1 / h);
  material.setVector2('vInverseScreenSize', scratchInvScreen);
  material.setFloat('ditherIntensity', ipc.ditheringEnabled ? 0.5 * ipc.ditheringIntensity : 0);

  if (ipc.vignetteEnabled) {
    const aspect = h / w;
    let scaleY = Math.tan(ipc.vignetteCameraFov * 0.5);
    let scaleX = scaleY * aspect;
    const geo = Math.sqrt(scaleX * scaleY);
    const s = ipc.vignetteStretch;
    scaleX = scaleX * (1 - s) + geo * s;
    scaleY = scaleY * (1 - s) + geo * s;
    scratchVig1.set(scaleX, scaleY, -scaleX * ipc.vignetteCenterX, -scaleY * ipc.vignetteCenterY);
    scratchVig2.set(
      ipc.vignetteColor.r,
      ipc.vignetteColor.g,
      ipc.vignetteColor.b,
      -2 * ipc.vignetteWeight,
    );
  } else {
    // Vignette disabled: power 0 => in-shader multiplier stays white.
    scratchVig1.set(1, 1, 0, 0);
    scratchVig2.set(0, 0, 0, 0);
  }
  material.setVector4('vignetteSettings1', scratchVig1);
  material.setVector4('vignetteSettings2', scratchVig2);
}
