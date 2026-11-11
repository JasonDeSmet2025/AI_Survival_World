/**
 * Atmospheric system (Visual Agent scope).
 *
 * Adds the natural depth layer that uniform scene fog alone cannot provide:
 *  - a high, slowly drifting CLOUD layer (custom shader, no lighting,
 *    haze-attenuated fog so distant clouds melt into the horizon), and
 *  - a low-valley MIST layer that hugs low ground and lakes.
 *
 * Design constraints:
 *  - Deterministic: every sprite placement and every texture pixel is a
 *    pure function of WORLD_SEED (world generation is untouched).
 *  - Cheap on GPU + CPU: 2 draw calls total. Each layer is ONE static
 *    world-space mesh holding every sprite (all clouds in one mesh, all
 *    mist in one mesh); the per-frame drift is a single layer-root rotation
 *    instead of per-instance matrix updates. Unlit shaders, no shadow
 *    casting.
 *  - Day/night aware: tint and opacity follow the lighting day factor and
 *    the fog colour/density are mirrored from the engine scene each frame
 *    (same pattern as Water), so clouds/mist never desynchronise from the
 *    sky or the terrain fog.
 */
import {
  DynamicTexture,
  Mesh,
  Scene,
  ShaderMaterial,
  TransformNode,
  Vector3,
  VertexBuffer,
} from '@babylonjs/core';
import { fbm, mulberry32 } from '../core/noise';
import { SEA_LEVEL, TERRAIN_SIZE, WORLD_SEED, terrainHeight, terrainSlope } from './heightfield';
import { COLOR_GRADE_GLSL, COLOR_GRADE_UNIFORMS, syncColorPipeline } from './colorPipeline';

// ---------------------------------------------------------------------------
// Pure layout + texture generation (unit-testable without Babylon)
// ---------------------------------------------------------------------------

/** Number of cloud sprites in the layer. */
export const CLOUD_COUNT = 56;
/** Number of mist sprites in the layer. */
export const MIST_COUNT = 24;

/** Vertical band of the cloud layer (world units above the island). */
export const CLOUD_ALTITUDE_MIN = 240;
export const CLOUD_ALTITUDE_MAX = 330;
/** Maximum horizontal reach of the cloud layer from the island centre. */
export const CLOUD_REACH = 900;

/** Height of a mist sprite above the local terrain. */
export const MIST_HEIGHT = 2.6;

export interface SpritePlacement {
  x: number;
  y: number;
  z: number;
  /** Quad scale in world units (quad is 1x1). */
  scale: number;
  /** Rotation around the vertical axis. */
  rotY: number;
}

/**
 * Deterministic cloud sprite layout: a uniform disk of wide coverage around
 * the island so clouds always drift overhead, with per-sprite altitude,
 * size and rotation.
 */
export function generateCloudLayout(seed: number = WORLD_SEED): SpritePlacement[] {
  const rng = mulberry32((seed ^ 0xc10d57ad) >>> 0);
  const out: SpritePlacement[] = [];
  for (let i = 0; i < CLOUD_COUNT; i++) {
    const ang = rng() * Math.PI * 2;
    const rad = 40 + Math.sqrt(rng()) * (CLOUD_REACH - 40); // sqrt -> uniform disk
    out.push({
      x: Math.cos(ang) * rad,
      z: Math.sin(ang) * rad,
      y: CLOUD_ALTITUDE_MIN + rng() * (CLOUD_ALTITUDE_MAX - CLOUD_ALTITUDE_MIN),
      scale: 150 + rng() * 170,
      rotY: rng() * Math.PI * 2,
    });
  }
  return out;
}

/**
 * Deterministic mist sprite layout: rejection-sampled low, gentle terrain
 * (valleys, lake shores, shallow coastline) so mist pools where water
 * would. Pure — depends only on the analytic height field.
 */
export function generateMistLayout(seed: number = WORLD_SEED): SpritePlacement[] {
  const rng = mulberry32((seed ^ 0x210b57a1) >>> 0);
  const out: SpritePlacement[] = [];
  const half = TERRAIN_SIZE * 0.46;
  for (let attempt = 0; out.length < MIST_COUNT && attempt < 12000; attempt++) {
    const x = (rng() * 2 - 1) * half;
    const z = (rng() * 2 - 1) * half;
    const h = terrainHeight(x, z);
    // Low and gently sloped ground only (valleys, shores, lake bed rim).
    if (h > 3.0 || h < SEA_LEVEL - 4.5) continue;
    if (terrainSlope(x, z) > 0.5) continue;
    out.push({
      x,
      z,
      y: h + MIST_HEIGHT,
      scale: 70 + rng() * 80,
      rotY: rng() * Math.PI * 2,
    });
  }
  return out;
}

/**
 * Cloud sprite alpha map (0..1 per pixel, row-major). Large fbm puffs
 * thresholded for ragged coverage, multiplied by an elliptical falloff so
 * every border pixel is fully transparent (no visible quad edges).
 */
export function generateCloudAlpha(size: number, seed: number = WORLD_SEED): Float32Array {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / (size - 1);
      const v = y / (size - 1);
      const macro = fbm(u * 5.1 + seed * 0.131, v * 5.1 + seed * 0.071, 4);
      const fine = fbm(u * 17.3 + seed * 0.211, v * 17.3 + seed * 0.151, 3);
      const cover = 0.72 * macro + 0.28 * fine;
      let a = smoothstep01(0.44, 0.58, cover);
      // Elliptical fade: 1 at centre, 0 at the quad border.
      const ex = (u - 0.5) * 2.25; // slight horizontal stretch
      const ey = (v - 0.5) * 2.0;
      const e = 1 - (ex * ex + ey * ey);
      a *= smoothstep01(0.02, 1.0, e);
      out[y * size + x] = a;
    }
  }
  return out;
}

/**
 * Mist sprite alpha map: soft, nearly uniform blob with low-frequency
 * breakup and a hard elliptical border fade. Overall softer than a cloud.
 */
export function generateMistAlpha(size: number, seed: number = WORLD_SEED): Float32Array {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / (size - 1);
      const v = y / (size - 1);
      const n = fbm(u * 3.4 + seed * 0.091, v * 3.4 + seed * 0.149, 3);
      let a = 0.35 + 0.65 * smoothstep01(0.2, 0.85, n);
      const ex = (u - 0.5) * 2.1;
      const ey = (v - 0.5) * 2.1;
      const e = 1 - (ex * ex + ey * ey);
      a *= smoothstep01(0.05, 1.0, e);
      out[y * size + x] = a;
    }
  }
  return out;
}

/** smoothstep with explicit edges, returns 0..1. */
function smoothstep01(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Shader (shared by cloud + mist layers; per-material uniforms differ)
// ---------------------------------------------------------------------------

const ATMO_VERT = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 world;
uniform mat4 viewProjection;
varying vec2 vUV;
varying vec3 vPos;
void main() {
  vUV = uv;
  vec4 wp = world * vec4(position, 1.0);
  vPos = wp.xyz;
  gl_Position = viewProjection * wp;
}
`;

const ATMO_FRAG = `
precision highp float;
uniform sampler2D spriteSampler;
uniform vec3 cameraPosition;
uniform vec3 tint;
uniform float opacity;
uniform vec3 fogColor;
uniform float fogDensity;
uniform float fogScale;
varying vec2 vUV;
varying vec3 vPos;

${COLOR_GRADE_GLSL}

void main() {
  float a = texture2D(spriteSampler, vUV).a * opacity;
  if (a < 0.004) discard;
  vec3 col = tint;
  // EXP2 scene-fog match. fogScale attenuates the haze for the cloud
  // layer: ground haze concentrates near the surface, so high clouds stay
  // clearer than terrain at the same distance (natural aerial perspective).
  float d = fogDensity * fogScale;
  float dist = length(vPos - cameraPosition);
  float f = clamp(1.0 - exp(-d * d * dist * dist), 0.0, 1.0);
  col = mix(col, fogColor, f);
  // Grade like the built-in materials (fog blended in linear space first).
  gl_FragColor = vec4(colorGrade(col), a * (1.0 - f * 0.9));
}
`;

const ATMO_ATTRIBUTES = ['position', 'uv'];
const ATMO_UNIFORMS = [
  'world',
  'viewProjection',
  'cameraPosition',
  'spriteSampler',
  'tint',
  'opacity',
  'fogColor',
  'fogDensity',
  'fogScale',
  ...COLOR_GRADE_UNIFORMS,
];

/** Clouds live above the main haze layer: attenuated fog density. */
const CLOUD_FOG_SCALE = 0.45;
/** Mist sits inside the haze layer: full scene fog. */
const MIST_FOG_SCALE = 1.0;

/** Drift speeds (radians / second). Full cloud turn ~ 1.5 h; mist ~ 3.5 h. */
const CLOUD_DRIFT = 0.0011;
const MIST_DRIFT = 0.0004;

const TINT_CLOUD_DAY = new Vector3(0.93, 0.94, 0.965);
const TINT_CLOUD_NIGHT = new Vector3(0.055, 0.075, 0.12);
const TINT_MIST_DAY = new Vector3(0.8, 0.86, 0.9);
const TINT_MIST_NIGHT = new Vector3(0.05, 0.07, 0.11);
// Precomputed day-night deltas so update() stays allocation-free.
const DELTA_CLOUD = TINT_CLOUD_DAY.subtract(TINT_CLOUD_NIGHT);
const DELTA_MIST = TINT_MIST_DAY.subtract(TINT_MIST_NIGHT);
const OPACITY_CLOUD = { day: 0.88, night: 0.52 };
const OPACITY_MIST = { day: 0.17, night: 0.09 };

const SPRITE_TEXTURE_SIZE = 256;

/**
 * Bakes one sprite layer into a static world-space quad strip.
 *
 * Every sprite (position + Y-rotation + uniform scale, exactly as the old
 * InstancedMesh transforms) is expanded into 4 world-space vertices. The
 * result is a single index/position/uv buffer that renders the whole layer
 * in ONE draw call instead of one per sprite. The per-frame layer drift is
 * applied by rotating the (single) layer root TransformNode, which
 * composes with the baked world-space vertices — visually identical to the
 * previous per-instance drift.
 *
 * Pure + deterministic: same placements in, same bytes out.
 */
export function bakeSpriteLayer(placements: SpritePlacement[]): {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
} {
  const n = placements.length;
  const positions = new Float32Array(n * 4 * 3);
  const uvs = new Float32Array(n * 4 * 2);
  const indices = new Uint32Array(n * 6);

  // Unit-plane corners/UVs matching Babylon's CreatePlane(size=1) with
  // useOpenGLOrientationForUV=false, so the baked quads sample the sprite
  // texture with the identical orientation as the old instanced quads.
  const CX = [-0.5, 0.5, 0.5, -0.5];
  const CY = [-0.5, -0.5, 0.5, 0.5];
  const U = [0.0, 1.0, 1.0, 0.0];
  const V = [0.0, 0.0, 1.0, 1.0];

  for (let i = 0; i < n; i++) {
    const p = placements[i];
    const c = Math.cos(p.rotY);
    const s = Math.sin(p.rotY);
    for (let k = 0; k < 4; k++) {
      const vi = i * 4 + k;
      // world = pos + R_y(rotY) * (scale * corner); corner.z is 0.
      positions[vi * 3 + 0] = p.x + p.scale * CX[k] * c;
      positions[vi * 3 + 1] = p.y + p.scale * CY[k];
      positions[vi * 3 + 2] = p.z - p.scale * CX[k] * s;
      uvs[vi * 2 + 0] = U[k];
      uvs[vi * 2 + 1] = V[k];
    }
    const b = i * 4;
    indices[i * 6 + 0] = b + 0;
    indices[i * 6 + 1] = b + 1;
    indices[i * 6 + 2] = b + 2;
    indices[i * 6 + 3] = b + 0;
    indices[i * 6 + 4] = b + 2;
    indices[i * 6 + 5] = b + 3;
  }

  return { positions, uvs, indices };
}

/**
 * Builds one sprite layer: a single static world-space mesh holding every
 * sprite of the layer plus one unlit ShaderMaterial. One draw call per
 * layer (clouds + mist = 2 total) instead of one per sprite.
 */
function buildSpriteLayer(
  scene: Scene,
  name: string,
  placements: SpritePlacement[],
  texture: DynamicTexture | null,
  fogScale: number,
  opacity: number,
  tint: Vector3,
): { root: TransformNode; material: ShaderMaterial; mesh: Mesh; texture: DynamicTexture | null } {
  const root = new TransformNode(`atmo_${name}_root`, scene);

  const material = new ShaderMaterial(`atmo_${name}_mat`, scene,
    { vertexSource: ATMO_VERT, fragmentSource: ATMO_FRAG },
    { attributes: ATMO_ATTRIBUTES, uniforms: ATMO_UNIFORMS, needAlphaBlending: true },
  );
  if (texture) material.setTexture('spriteSampler', texture);
  material.setVector3('tint', tint);
  material.setFloat('opacity', opacity);
  material.setVector3('fogColor', new Vector3(0.62, 0.75, 0.85));
  material.setFloat('fogDensity', 0.0022);
  material.setFloat('fogScale', fogScale);
  material.backFaceCulling = false;
  material.disableDepthWrite = true;

  const { positions, uvs, indices } = bakeSpriteLayer(placements);
  const mesh = new Mesh(`atmo_${name}_layer`, scene);
  mesh.setVerticesData(VertexBuffer.PositionKind, positions);
  mesh.setVerticesData(VertexBuffer.UVKind, uvs);
  mesh.setIndices(indices);
  mesh.material = material;
  mesh.parent = root;
  mesh.isPickable = false;
  mesh.refreshBoundingInfo(); // correct frustum culling for the full layer box

  return { root, material, mesh, texture };
}

/**
 * Renders the alpha map into an RGBA canvas texture (white RGB, alpha from
 * the map). Returns null in headless environments without a DOM where no
 * canvas can be created (the layer then simply renders nothing).
 */
function createSpriteTexture(
  scene: Scene,
  name: string,
  alpha: Float32Array,
  size: number,
): DynamicTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < alpha.length; i++) {
    d[i * 4] = 255;
    d[i * 4 + 1] = 255;
    d[i * 4 + 2] = 255;
    d[i * 4 + 3] = Math.round(alpha[i] * 255);
  }
  ctx.putImageData(img, 0, 0);
  return new DynamicTexture(name, canvas, scene, false);
}

/**
 * Atmosphere = cloud layer + valley mist layer. Create once with the scene;
 * drive from the frame loop with update(dt, dayFactor).
 */
export class Atmosphere {
  readonly cloudRoot: TransformNode;
  readonly mistRoot: TransformNode;
  readonly cloudMaterial: ShaderMaterial;
  readonly mistMaterial: ShaderMaterial;
  /** Total baked sprites (clouds + mist) — for QA/diagnostics. */
  readonly spriteCount: number;

  private scene: Scene;
  private cloudTexture: DynamicTexture | null;
  private mistTexture: DynamicTexture | null;
  private time = 0;
  private lastDay = -1;
  private fogObserver: ReturnType<Scene['onBeforeRenderObservable']['add']> | null = null;
  private cloudTint = new Vector3();
  private mistTint = new Vector3();
  private fogV = new Vector3();

  constructor(scene: Scene, seed: number = WORLD_SEED) {
    this.scene = scene;

    const cloudTex = createSpriteTexture(scene, 'cloudAlpha', generateCloudAlpha(SPRITE_TEXTURE_SIZE, seed), SPRITE_TEXTURE_SIZE);
    const mistTex = createSpriteTexture(scene, 'mistAlpha', generateMistAlpha(SPRITE_TEXTURE_SIZE, seed), SPRITE_TEXTURE_SIZE);

    const clouds = buildSpriteLayer(
      scene, 'cloud', generateCloudLayout(seed), cloudTex,
      CLOUD_FOG_SCALE, OPACITY_CLOUD.night, TINT_CLOUD_NIGHT,
    );
    const mist = buildSpriteLayer(
      scene, 'mist', generateMistLayout(seed), mistTex,
      MIST_FOG_SCALE, OPACITY_MIST.night, TINT_MIST_NIGHT,
    );

    this.cloudRoot = clouds.root;
    this.mistRoot = mist.root;
    this.cloudMaterial = clouds.material;
    this.mistMaterial = mist.material;
    this.cloudTexture = clouds.texture;
    this.mistTexture = mist.texture;
    this.spriteCount = CLOUD_COUNT + MIST_COUNT;

    // Mirror engine scene fog (EXP2 density + colour, set by Lighting each
    // frame) into both sprite shaders so the atmosphere always matches the
    // same day/night horizon as terrain, water and sky.
    const fogSync = () => this.syncFog(scene);
    this.fogObserver = scene.onBeforeRenderObservable.add(fogSync);
    fogSync();
    this.update(0, 1); // start in day state so uniforms are sane pre-lighting
  }

  /** Copy the current scene fog (EXP2 density + colour) and the live
   *  image-processing pipeline into both sprite layers. */
  syncFog(scene: Scene): void {
    if (scene.fogDensity != null) {
      this.cloudMaterial.setFloat('fogDensity', scene.fogDensity);
      this.mistMaterial.setFloat('fogDensity', scene.fogDensity);
    }
    if (scene.fogColor) {
      this.fogV.set(scene.fogColor.r, scene.fogColor.g, scene.fogColor.b);
      this.cloudMaterial.setVector3('fogColor', this.fogV);
      this.mistMaterial.setVector3('fogColor', this.fogV);
    }
    syncColorPipeline(scene, this.cloudMaterial);
    syncColorPipeline(scene, this.mistMaterial);
  }

  /**
   * Per-frame update.
   * @param dt seconds since last frame (clamped by the caller).
   * @param dayFactor 0 (deep night) .. 1 (full day) from the Lighting system.
   */
  update(dt: number, dayFactor: number): void {
    this.time += dt;

    // Slow layer drift + a gentle mist bob.
    this.cloudRoot.rotation.y = this.time * CLOUD_DRIFT;
    this.mistRoot.rotation.y = -this.time * MIST_DRIFT;
    this.mistRoot.position.y = Math.sin(this.time * 0.05) * 0.5;

    if (dayFactor !== this.lastDay) {
      this.lastDay = dayFactor;
      const d = dayFactor;
      this.cloudTint.set(
        TINT_CLOUD_NIGHT.x + DELTA_CLOUD.x * d,
        TINT_CLOUD_NIGHT.y + DELTA_CLOUD.y * d,
        TINT_CLOUD_NIGHT.z + DELTA_CLOUD.z * d,
      );
      this.mistTint.set(
        TINT_MIST_NIGHT.x + DELTA_MIST.x * d,
        TINT_MIST_NIGHT.y + DELTA_MIST.y * d,
        TINT_MIST_NIGHT.z + DELTA_MIST.z * d,
      );
      this.cloudMaterial.setVector3('tint', this.cloudTint);
      this.mistMaterial.setVector3('tint', this.mistTint);
      this.cloudMaterial.setFloat(
        'opacity',
        OPACITY_CLOUD.night + (OPACITY_CLOUD.day - OPACITY_CLOUD.night) * d,
      );
      this.mistMaterial.setFloat(
        'opacity',
        OPACITY_MIST.night + (OPACITY_MIST.day - OPACITY_MIST.night) * d,
      );
    }
  }

  dispose(): void {
    if (this.fogObserver) this.scene.onBeforeRenderObservable.remove(this.fogObserver);
    this.fogObserver = null;
    for (const root of [this.cloudRoot, this.mistRoot]) {
      for (const m of root.getChildMeshes()) m.dispose();
      root.dispose();
    }
    this.cloudTexture?.dispose();
    this.mistTexture?.dispose();
    this.cloudMaterial.dispose();
    this.mistMaterial.dispose();
  }
}
