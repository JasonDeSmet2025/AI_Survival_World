import { describe, expect, it } from 'vitest';
import {
  AbstractMesh,
  DirectionalLight,
  FreeCamera,
  MeshBuilder,
  NullEngine,
  Scene,
  ShaderMaterial,
  ShadowGenerator,
  Vector3,
} from '@babylonjs/core';
import { DAY_LENGTH, Lighting } from './lighting';
import { Sky } from '../world/sky';
import { Water } from '../world/water';

/** The game's directional 'sun' light from the scene. */
function sunOf(scene: Scene): DirectionalLight {
  const sun = scene.lights.find((l) => l.name === 'sun');
  expect(sun).toBeInstanceOf(DirectionalLight);
  return sun as DirectionalLight;
}

/**
 * Lighting behaviour tests. Runs on NullEngine: the sun arc, day factor,
 * fog/exposure cycle and clock API are pure scene-state updates, so no
 * real WebGL context is required.
 */
describe('Lighting', () => {
  function build(): { lighting: Lighting; scene: Scene; dispose: () => void } {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const sky = new Sky(scene);
    const water = new Water(scene, engine);
    const terrainMat = new ShaderMaterial(
      'terrainStub',
      scene,
      { vertexSource: 'void main() {}', fragmentSource: 'void main() {}' },
      { attributes: [], uniforms: [] },
    );
    const lighting = new Lighting(scene, sky, water, terrainMat);
    return {
      lighting,
      scene,
      dispose: () => {
        lighting.dispose();
        scene.dispose();
        engine.dispose();
      },
    };
  }

  it('runs the full day cycle without errors and keeps sunDir unit-length', () => {
    const { lighting, dispose } = build();
    lighting.setTimeOfDay(0.1);
    for (let i = 0; i < 60; i++) lighting.update(DAY_LENGTH / 60);
    for (const dir of [lighting.sunDir, lighting.moonDir]) {
      expect(dir.length()).toBeCloseTo(1, 4);
    }
    dispose();
  });

  it('places the sun above the horizon at noon and below it at midnight', () => {
    const { lighting, dispose } = build();
    lighting.setTimeOfDay(0.5); // noon
    expect(lighting.sunDir.y).toBeGreaterThan(0.7);
    expect(lighting.dayFactor).toBeGreaterThan(0.9);
    lighting.setTimeOfDay(0.0); // midnight
    expect(lighting.sunDir.y).toBeLessThan(0);
    expect(lighting.dayFactor).toBeCloseTo(0, 2);
    dispose();
  });

  it('syncs fog, clear color and exposure with the time of day', () => {
    const { lighting, scene, dispose } = build();
    lighting.setTimeOfDay(0.5);
    const dayFog = scene.fogColor!.clone();
    const dayExposure = scene.imageProcessingConfiguration.exposure;
    lighting.setTimeOfDay(0.0);
    expect(scene.fogColor!.r).toBeLessThan(dayFog.r);
    expect(scene.imageProcessingConfiguration.exposure).toBeLessThan(dayExposure);
    // Clear color must match the fog so the horizon stays seamless.
    expect(scene.clearColor.r).toBeCloseTo(scene.fogColor!.r, 5);
    dispose();
  });

  it('exposes a stable clock API used by save/load', () => {
    const { lighting, dispose } = build();
    const start = lighting.timeOfDay;
    lighting.update(1);
    expect(lighting.timeOfDay).toBeCloseTo((start + 1 / DAY_LENGTH) % 1, 5);
    // Wrapping: elapsed time never exceeds one day in the public API.
    lighting.setTimeOfDay(1.25);
    expect(lighting.timeOfDay).toBeCloseTo(0.25, 5);
    dispose();
  });

  it('sun and moon directions are opposite', () => {
    const { lighting, dispose } = build();
    lighting.setTimeOfDay(0.35);
    expect(lighting.sunDir.dot(lighting.moonDir)).toBeCloseTo(-1, 4);
    const d = new Vector3();
    d.copyFrom(lighting.sunDir).negateInPlace();
    expect(d.subtract(lighting.moonDir).length()).toBeLessThan(1e-5);
    dispose();
  });

  describe('shadow pipeline wiring', () => {
    it('owns a BSM shadow generator with a fixed, player-following frustum', () => {
      const { scene, dispose } = build();
      const sun = sunOf(scene);
      const gen = sun.getShadowGenerator() as ShadowGenerator;
      expect(gen).toBeDefined();
      expect(gen.useBlurExponentialShadowMap).toBe(true);
      expect(gen.darkness).toBeCloseTo(0.7, 5);
      // Fixed frustum: keeps 2048 px resolution around the player instead
      // of auto-extending over the whole 640u world once flora casters
      // exist. Depth spans both sides of the player.
      expect(sun.shadowFrustumSize).toBeGreaterThan(0);
      expect(sun.shadowMinZ).toBeLessThan(0);
      expect(sun.shadowMaxZ).toBeGreaterThan(sun.shadowFrustumSize);
      expect(gen.frustumEdgeFalloff).toBeGreaterThan(0); // no visible edge
      dispose();
    });

    it('keeps shadowed characters readable during daylight', () => {
      const { lighting, scene, dispose } = build();
      lighting.setTimeOfDay(0.5);
      const hemi = scene.lights.find((light) => light.name === 'hemi');
      expect(hemi?.intensity).toBeCloseTo(0.8, 5);
      lighting.setTimeOfDay(0);
      expect(hemi?.intensity).toBeCloseTo(0.32, 5);
      expect(scene.imageProcessingConfiguration.exposure).toBeCloseTo(0.95, 5);
      dispose();
    });

    it('moves the shadow camera to the active camera each frame', () => {
      const { lighting, scene, dispose } = build();
      const cam = new FreeCamera('cam', new Vector3(12, 5, -30), scene);
      cam.minZ = 0.1;
      cam.maxZ = 1000;
      scene.activeCamera = cam;
      const sun = sunOf(scene);

      lighting.update(1);
      expect(sun.position.x).toBeCloseTo(12, 6);
      expect(sun.position.z).toBeCloseTo(-30, 6);
      expect(sun.position.y).toBe(0); // grounded box, never the camera height

      cam.position.set(-55, 8, 41);
      lighting.update(1);
      expect(sun.position.x).toBeCloseTo(-55, 6);
      expect(sun.position.z).toBeCloseTo(41, 6);

      cam.dispose();
      dispose();
    });

    it('registering and un-registering casters reaches the generator', () => {
      const { lighting, scene, dispose } = build();
      const gen = sunOf(scene).getShadowGenerator()!;
      const renderList = gen.getShadowMap()!.renderList;
      const box = MeshBuilder.CreateBox('caster', { size: 1 }, scene) as AbstractMesh;
      lighting.addShadowCaster(box);
      expect(renderList).toContain(box);
      lighting.removeShadowCaster(box);
      expect(renderList).not.toContain(box);
      box.dispose();
      dispose();
    });
  });
});
