import {
  AbstractMesh,
  BloomEffect,
  Color3,
  Color4,
  DirectionalLight,
  HemisphericLight,
  ImageProcessingConfiguration,
  Scene,
  ShadowGenerator,
  ShaderMaterial,
  Vector3,
} from '@babylonjs/core';
import { clamp, lerp } from '../core/noise';
import { createEnvironmentPresets, type EnvironmentPreset } from './textures';
import type { Sky } from '../world/sky';
import type { Water } from '../world/water';

/** Full day length in seconds (15 minutes). */
export const DAY_LENGTH = 900;

const DAY_SUN = new Color3(1.0, 0.96, 0.86);
const DUSK_SUN = new Color3(1.0, 0.58, 0.30);
const NIGHT_SUN = new Color3(0.17, 0.21, 0.34); // moonlight
const DAY_SKY_FOG = new Color3(0.62, 0.75, 0.85);
const NIGHT_SKY_FOG = new Color3(0.035, 0.055, 0.1);
const DAY_TOP = new Color3(0.34, 0.4, 0.5);
const NIGHT_TOP = new Color3(0.05, 0.07, 0.13);
const DAY_GROUND = new Color3(0.22, 0.2, 0.16);
const NIGHT_GROUND = new Color3(0.02, 0.03, 0.06);

function mix3(out: Color3, a: Color3, b: Color3, t: number): Color3 {
  Color3.LerpToRef(a, b, t, out);
  return out;
}

/**
 * Drives sun/moon position, engine lights, fog, sky, water and terrain
 * shader uniforms from one deterministic cycle clock.
 * T (0..1): 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset.
 */
export class Lighting {
  readonly sunDir = new Vector3(0, 1, 0);
  readonly moonDir = new Vector3(0, -1, 0);
  readonly sunColor = new Color3(1, 0.96, 0.86);

  private hemi: HemisphericLight;
  private sun: DirectionalLight;
  private shadow: ShadowGenerator;
  private sky: Sky;
  private water: Water;
  private terrainMat: ShaderMaterial;
  private scene: Scene;
  private envPresets: ReturnType<typeof createEnvironmentPresets>;
  private currentEnv: EnvironmentPreset | null = null;
  /** Cycle clock in seconds since midnight. */
  private elapsed: number;

  constructor(
    scene: Scene,
    sky: Sky,
    water: Water,
    terrainMat: ShaderMaterial,
    startT = 0.35,
  ) {
    this.scene = scene;
    this.sky = sky;
    this.water = water;
    this.terrainMat = terrainMat;
    this.elapsed = startT * DAY_LENGTH;
    this.envPresets = createEnvironmentPresets(scene.getEngine());

    this.hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
    this.sun = new DirectionalLight('sun', new Vector3(0, -1, 0), scene);

    this.shadow = new ShadowGenerator(2048, this.sun);
    this.shadow.useBlurExponentialShadowMap = true;
    this.shadow.blurKernel = 24;

    this.applyPostProcessing();
    this.apply();
  }

  /**
   * Global image look: ACES filmic tone mapping for a consistent, natural
   * color response across all materials, mild contrast, a subtle vignette
   * and bloom for fire/glow sources. One lightweight post chain.
   */
  private applyPostProcessing(): void {
    const ipc = this.scene.imageProcessingConfiguration;
    ipc.toneMappingEnabled = true;
    ipc.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    ipc.exposure = 1.12;
    ipc.contrast = 1.06;
    ipc.vignetteEnabled = true;
    ipc.vignetteWeight = 0.12;

    const bloom = new BloomEffect(this.scene, 32, 0.45, 16);
    bloom.threshold = 0.78;
  }

  get timeOfDay(): number {
    return (this.elapsed % DAY_LENGTH) / DAY_LENGTH;
  }

  /** 0 = deep night, 1 = full day. */
  get dayFactor(): number {
    const elev = -Math.cos(this.timeOfDay * Math.PI * 2);
    return clamp(elev * 1.6 + 0.15, 0, 1);
  }

  /**
   * Register a mesh as a shadow caster. (The shadow pipeline only accepts
   * real meshes — TransformNodes lack subMeshes — so group roots must be
   * expanded to their child meshes by the caller.)
   */
  addShadowCaster(mesh: AbstractMesh, includeDescendants = false): void {
    this.shadow.addShadowCaster(mesh, includeDescendants);
  }

  removeShadowCaster(mesh: AbstractMesh, includeDescendants = false): void {
    this.shadow.removeShadowCaster(mesh, includeDescendants);
  }

  update(dt: number): void {
    this.elapsed += dt;
    this.apply();
  }

  private apply(): void {
    const t = this.timeOfDay;
    const elev = -Math.cos(t * Math.PI * 2); // -1 midnight .. 1 noon
    const dayF = this.dayFactor;

    // Sun position on a tilted arc.
    const az = t * Math.PI * 2;
    this.sunDir
      .set(Math.cos(az) * 0.55, Math.max(elev, -1), 0.42)
      .normalize();
    this.moonDir.copyFrom(this.sunDir).scale(-1);

    const duskW = clamp(1 - Math.abs(elev) / 0.32, 0, 1) * (elev > -0.3 ? 1 : 0);
    mix3(this.sunColor, NIGHT_SUN, DAY_SUN, dayF);
    if (duskW > 0) mix3(this.sunColor, this.sunColor, DUSK_SUN, duskW * 0.85);

    // Engine lights (used by standard/PBR meshes: player, trees, buildings).
    this.sun.direction.set(-this.sunDir.x, -this.sunDir.y, -this.sunDir.z);
    this.sun.intensity = 0.15 + dayF * 1.05;
    mix3(this.sun.diffuse, NIGHT_SUN, DAY_SUN, dayF);
    if (duskW > 0) mix3(this.sun.diffuse, this.sun.diffuse, DUSK_SUN, duskW * 0.8);

    this.hemi.intensity = 0.1 + dayF * 0.5;
    mix3(this.hemi.diffuse, NIGHT_TOP, DAY_TOP, dayF);
    mix3(this.hemi.groundColor, NIGHT_GROUND, DAY_GROUND, dayF);

    // Scene fog + clear color follow the sky.
    const fogC = new Color3();
    mix3(fogC, NIGHT_SKY_FOG, DAY_SKY_FOG, dayF);
    this.scene.fogMode = Scene.FOGMODE_EXP2;
    this.scene.fogDensity = lerp(0.0038, 0.0022, dayF);
    this.scene.fogColor = fogC;
    this.scene.clearColor = new Color4(fogC.r, fogC.g, fogC.b, 1);

    // Image-based lighting for all PBR materials follows the sky cycle.
    this.applyEnvironment(dayF);

    // Shader systems.
    this.water.syncSun(this.sunDir, this.sunColor);
    this.sky.setDay(this.sunDir, this.moonDir, dayF);

    const sunStrength = 0.25 + dayF * 1.15;
    this.terrainMat.setVector3('sunDir', this.sunDir);
    const sc = this.sunColor.scale(sunStrength);
    this.terrainMat.setColor3('sunColor', sc);
    const top = new Color3();
    mix3(top, NIGHT_TOP, DAY_TOP, dayF);
    const ground = new Color3();
    mix3(ground, NIGHT_GROUND, DAY_GROUND, dayF);
    this.terrainMat.setColor3('ambientTop', top);
    this.terrainMat.setColor3('ambientGround', ground);
  }

  /**
   * Select the procedural environment cube that matches the current sky
   * (only swapped on change; switching a texture reference is cheap).
   */
  private applyEnvironment(dayF: number): void {
    const preset: EnvironmentPreset = dayF > 0.6 ? 'day' : dayF > 0.25 ? 'dusk' : 'night';
    const tex = this.envPresets[preset];
    if (tex?.isReady() && preset !== this.currentEnv) {
      this.scene.environmentTexture = tex;
      this.currentEnv = preset;
    }
    this.scene.environmentIntensity = lerp(0.45, 1.2, dayF);
  }

  /** Restore the cycle clock (save/load). */
  setTimeOfDay(t: number): void {
    this.elapsed = ((t % 1) + 1) % 1 * DAY_LENGTH;
    this.apply();
  }

  dispose(): void {
    this.shadow.dispose();
    this.hemi.dispose();
    this.sun.dispose();
  }
}
