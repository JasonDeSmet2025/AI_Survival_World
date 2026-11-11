import { describe, it, expect } from 'vitest';
import { NullEngine, Scene, ShaderMaterial } from '@babylonjs/core';
import {
  COLOR_GRADE_GLSL,
  COLOR_GRADE_UNIFORMS,
  syncColorPipeline,
} from './colorPipeline';

/**
 * ColorPipeline tests on NullEngine. The GLSL itself cannot compile here,
 * but the scene-state wiring (mirroring the live
 * imageProcessingConfiguration into the shader uniforms) is pure JS and
 * fully testable — including the exact vignette formula used by the engine.
 */

function makeGradedMaterial(scene: Scene): ShaderMaterial {
  const fragmentSource = `
precision highp float;
attribute vec3 position;
uniform mat4 world;
uniform mat4 viewProjection;
${COLOR_GRADE_GLSL}
void main() {
  gl_FragColor = vec4(colorGrade(vec3(0.2, 0.3, 0.4)), 1.0);
}
`;
  return new ShaderMaterial(
    'gradeTest',
    scene,
    {
      vertexSource: 'precision highp float; void main() { gl_Position = vec4(0.0); }',
      fragmentSource,
    },
    {
      attributes: ['position'],
      uniforms: ['world', 'viewProjection', ...COLOR_GRADE_UNIFORMS],
    },
  );
}

function floats(mat: ShaderMaterial): Record<string, number> {
  return (mat as unknown as { _floats: Record<string, number> })._floats;
}
function vec2(mat: ShaderMaterial, name: string): { x: number; y: number } {
  return (mat as unknown as { _vectors2: Record<string, { x: number; y: number }> })._vectors2[name];
}
function vec4(mat: ShaderMaterial, name: string): { x: number; y: number; z: number; w: number } {
  return (mat as unknown as { _vectors4: Record<string, { x: number; y: number; z: number; w: number }> })._vectors4[name];
}

describe('colorPipeline', () => {
  it('mirrors exposure, contrast and dithering from the scene', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const mat = makeGradedMaterial(scene);

    const ipc = scene.imageProcessingConfiguration;
    ipc.exposure = 1.12;
    ipc.contrast = 1.05;
    ipc.ditheringEnabled = true;
    ipc.ditheringIntensity = 1 / 255;

    syncColorPipeline(scene, mat);

    expect(floats(mat).exposureLinear).toBeCloseTo(1.12, 6);
    expect(floats(mat).contrastValue).toBeCloseTo(1.05, 6);
    // Engine applies dither as +/- ditheringIntensity / 2.
    expect(floats(mat).ditherIntensity).toBeCloseTo(0.5 / 255, 10);

    // Live change (the lighting system animates exposure each frame).
    ipc.exposure = 0.9;
    syncColorPipeline(scene, mat);
    expect(floats(mat).exposureLinear).toBeCloseTo(0.9, 6);

    // Dithering off => no banding compensation in the custom shader either.
    ipc.ditheringEnabled = false;
    syncColorPipeline(scene, mat);
    expect(floats(mat).ditherIntensity).toBe(0);

    mat.dispose();
    scene.dispose();
    engine.dispose();
  });

  it('replicates the engine vignette formula (enabled + disabled)', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const mat = makeGradedMaterial(scene);
    const ipc = scene.imageProcessingConfiguration;

    // Default: vignette disabled => power 0 => in-shader multiplier no-op.
    expect(ipc.vignetteEnabled).toBe(false);
    syncColorPipeline(scene, mat);
    expect(vec4(mat, 'vignetteSettings2').w).toBe(0);

    // Enabled with the lighting system's weight 0.12. The engine formula:
    //   scaleY = tan(fov/2); scaleX = scaleY * aspect;
    //   geo = sqrt(scaleX*scaleY); scale = mix(scale, geo, stretch)
    //   settings2.w = -2 * weight
    ipc.vignetteEnabled = true;
    ipc.vignetteWeight = 0.12;
    ipc.vignetteStretch = 0; // default
    ipc.vignetteCenterX = 0; // default
    ipc.vignetteCenterY = 0; // default
    ipc.vignetteCameraFov = 0.5; // default (radians)
    syncColorPipeline(scene, mat);

    const w = engine.getRenderWidth() || 1;
    const h = engine.getRenderHeight() || 1;
    const aspect = h / w;
    const expectedScaleY = Math.tan(ipc.vignetteCameraFov * 0.5);
    const expectedScaleX = expectedScaleY * aspect;

    const s1 = vec4(mat, 'vignetteSettings1');
    expect(s1.x).toBeCloseTo(expectedScaleX, 8);
    expect(s1.y).toBeCloseTo(expectedScaleY, 8);
    expect(s1.z).toBeCloseTo(0, 8);
    expect(s1.w).toBeCloseTo(0, 8);
    expect(vec4(mat, 'vignetteSettings2').w).toBeCloseTo(-2 * 0.12, 6);

    mat.dispose();
    scene.dispose();
    engine.dispose();
  });

  it('keeps the vInverseScreenSize reciprocal of the render size', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const mat = makeGradedMaterial(scene);

    syncColorPipeline(scene, mat);

    const w = engine.getRenderWidth() || 1;
    const h = engine.getRenderHeight() || 1;
    const v = vec2(mat, 'vInverseScreenSize');
    expect(v.x).toBeCloseTo(1 / w, 8);
    expect(v.y).toBeCloseTo(1 / h, 8);

    mat.dispose();
    scene.dispose();
    engine.dispose();
  });
});
