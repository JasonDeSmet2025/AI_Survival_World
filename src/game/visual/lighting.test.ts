import { describe, expect, it } from 'vitest';
import { NullEngine, Scene, ShaderMaterial, Vector3 } from '@babylonjs/core';
import { DAY_LENGTH, Lighting } from './lighting';
import { Sky } from '../world/sky';
import { Water } from '../world/water';

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
});
