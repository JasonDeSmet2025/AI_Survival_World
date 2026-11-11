import {
  Color3,
  Engine,
  Mesh,
  MeshBuilder,
  Scene,
  ShaderMaterial,
  Vector3,
} from '@babylonjs/core';
import { SEA_LEVEL } from './terrain';
import { COLOR_GRADE_GLSL, COLOR_GRADE_UNIFORMS, syncColorPipeline } from './colorPipeline';
import {
  SHADOW_FRAG_DECL,
  SHADOW_SAMPLE,
  SHADOW_UNIFORMS,
  SHADOW_VERT_DECL,
  SHADOW_VERT_MAIN,
  ShadowReceiver,
  shadowReceiveDefines,
} from '../visual/shadowReceiver';
import { terrainHeight } from './heightfield';

/**
 * One directional sine-wave octave.
 *  - amp:   peak-to-crest amplitude in world units,
 *  - wl:    wavelength in world units,
 *  - dir:   unnormalised travel direction in the XZ plane,
 *  - speed: angular speed (rad/s) of the phase.
 * The GLSL wave + analytic-gradient terms are GENERATED from this table, so
 * the amplitude budget is testable from TypeScript.
 */
export interface WaveOctave {
  amp: number;
  wl: number;
  dir: [number, number];
  speed: number;
}

/**
 * Swell octaves DISPLACED in the vertex shader (with an exact analytic
 * normal). Every wavelength here must satisfy `wl >= 2 * vertex spacing`
 * (Nyquist) — undersampled vertex waves linearly interpolate into moiré
 * beat patterns (measured ~16-35 u patches) that read as unnatural
 * large-scale patching across the sea. The vertex grid is 6.25 u apart
 * (WATER_SIZE / WATER_SUBDIVISIONS), so only 13 u and 22 u swells qualify.
 */
export const WATER_VERTEX_WAVES: WaveOctave[] = [
  { amp: 0.080, wl: 22.0, dir: [0.96, 0.28], speed: 0.55 },
  { amp: 0.055, wl: 13.0, dir: [0.42, -0.90], speed: 0.75 },
];

/**
 * Wave octaves applied in the FRAGMENT shader as normal perturbation only
 * (no displacement): the mid-size waves that do not fit the vertex grid
 * plus the fine ripples. Displacement-free, so they cannot alias the
 * vertex lattice and cannot z-fight the deep-ocean plane — they only
 * perturb the shading normal and feed the wave-crest brightness factor.
 * No checker/quantised hash patterns: every term is a real directional
 * sine.
 */
export const WATER_FRAGMENT_WAVES: WaveOctave[] = [
  { amp: 0.035, wl: 7.5, dir: [-0.72, 0.69], speed: 1.05 },
  { amp: 0.020, wl: 4.4, dir: [0.88, -0.47], speed: 1.45 },
  { amp: 0.030, wl: 2.2, dir: [0.85, 0.52], speed: 2.2 },
  { amp: 0.018, wl: 1.25, dir: [-0.55, 0.84], speed: 2.9 },
];

/**
 * Full wave table (vertex + fragment) — the single source of truth for the
 * amplitude budget tests. Order is stable: coarse first.
 */
export const WATER_WAVES: WaveOctave[] = [
  ...WATER_VERTEX_WAVES,
  ...WATER_FRAGMENT_WAVES,
];

/** Sum of ALL wave amplitudes (conservative crest/normal budget). */
export const MAX_WAVE_AMPLITUDE = WATER_WAVES.reduce((s, w) => s + w.amp, 0);

/** One directional sine field of the shoreline foam streak pattern. */
export interface FoamStreak {
  dir: [number, number];
  freq: number;
  speed: number;
}

/**
 * Animated shoreline foam tuning. A thin white band is drawn where the
 * wave-washed waterline meets the baked shallow shelf (see the per-vertex
 * `depth` attribute). The wave phase pushes the band up the beach and the
 * directional sine streak fields break it into moving, organic filaments —
 * the same anti-pattern policy as the wave table: real directional sines
 * only, NO quantised hash checkers. The GLSL is GENERATED from this table
 * and a pure TS mirror (`foamMask`) keeps it unit-testable in Node.
 */
export const WATER_FOAM = {
  /** Resting depth (m below sea level) of the foam band centre. */
  washBase: 0.55,
  /** Crest factor (-1..1) pushes the band out by up to this many metres. */
  crestGain: 0.35,
  /** Fine fragment-wave displacement fy (max ~0.103) is scaled by this. */
  fineGain: 2.0,
  /** Half-width of the foam band in depth space (m). */
  bandHalf: 0.55,
  /** Foam fades to zero over this depth (m) so nothing renders on land. */
  fadeStart: 0.02,
  fadeEnd: 0.2,
  /** Two crossing directional sine fields multiply into the streak mask. */
  streaks: [
    { dir: [0.62, 0.38], freq: 1.9, speed: -1.1 },
    { dir: [-0.31, 0.86], freq: 3.1, speed: 0.6 },
  ] as FoamStreak[],
  /** Streak modulation window: below streakLo the foam is suppressed. */
  streakLo: -0.25,
  streakHi: 0.35,
  /** Overall foam opacity multiplier. */
  strength: 0.85,
};

/** GLSL smoothstep(0..1) with the same clamping as GLSL requires. */
function smoothstep01(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Pure TS mirror of the GLSL foam mask — returns the foam opacity
 * contribution in [0, 1] at a world-space point.
 * @param x,z      world position on the water surface
 * @param depth    baked water depth at that point (m, 0 over land)
 * @param crest    normalised wave crest factor in [-1, 1] (vertex swell +
 *                 fine waves, as computed by the shader)
 * @param fy       fine fragment-wave vertical displacement (m)
 * @param time     shader time (s)
 */
export function foamMask(
  x: number,
  z: number,
  depth: number,
  crest: number,
  fy: number,
  time: number,
): number {
  const F = WATER_FOAM;
  if (depth <= 0) return 0;
  const c = Math.min(1, Math.max(-1, crest));
  const wash = F.washBase + F.crestGain * c + F.fineGain * fy;
  let m = 1 - smoothstep01(0, F.bandHalf, Math.abs(depth - wash));
  let st = 1;
  for (const s of F.streaks) {
    st *= Math.sin(x * s.dir[0] * s.freq + z * s.dir[1] * s.freq + time * s.speed);
  }
  m *= smoothstep01(F.streakLo, F.streakHi, st);
  m *= smoothstep01(F.fadeStart, F.fadeEnd, depth);
  return Math.min(1, Math.max(0, m * F.strength));
}

/**
 * Deeper water can never carry foam: the wash band reaches at most
 * washBase + crestGain + fineGain*MAX_FRAGMENT_AMPLITUDE + bandHalf below
 * sea level. Exported as a testable budget.
 */
export function foamMaxDepth(): number {
  const F = WATER_FOAM;
  const fineMax = WATER_FRAGMENT_WAVES.reduce((s, w) => s + w.amp, 0);
  return F.washBase + F.crestGain + F.fineGain * fineMax + F.bandHalf;
}

/**
 * Generate the shoreline-foam GLSL block from WATER_FOAM (single source of
 * truth). Requires `xzw`, `time`, `vDepth`, `fy`, `crest`, `skyTint`, `col`
 * and `alpha` to be in scope (all are, at the insertion point).
 */
export function genFoamGLSL(): string {
  const F = WATER_FOAM;
  const lines: string[] = [
    '  // Animated shoreline foam: a thin white band where the wave',
    '  // wash meets the baked shallow shelf. Directional sine streaks only',
    '  // (no hash checkers); the band moves in/out with the wave phases.',
    `  float foamWash = ${F.washBase.toFixed(4)} + ${F.crestGain.toFixed(4)} * clamp(crest, -1.0, 1.0) + ${F.fineGain.toFixed(4)} * fy;`,
    `  float foamBand = 1.0 - smoothstep(0.0, ${F.bandHalf.toFixed(4)}, abs(vDepth - foamWash));`,
  ];
  F.streaks.forEach((s, i) => {
    lines.push(
      `  float fs${i} = sin(dot(xzw, vec2(${s.dir[0].toFixed(5)}, ${s.dir[1].toFixed(5)})) * ${s.freq.toFixed(5)} + time * ${s.speed.toFixed(5)});`,
    );
  });
  lines.push(
    `  float foam = foamBand * smoothstep(${F.streakLo.toFixed(4)}, ${F.streakHi.toFixed(4)}, ${F.streaks.map((_, i) => `fs${i}`).join(' * ')});`,
    `  foam *= smoothstep(${F.fadeStart.toFixed(4)}, ${F.fadeEnd.toFixed(4)}, vDepth);`,
    `  float foamA = clamp(foam * ${F.strength.toFixed(4)}, 0.0, 1.0);`,
    `  vec3 foamCol = mix(vec3(0.80, 0.88, 0.90), skyTint, 0.22);`,
    `  col = mix(col, foamCol, foamA * 0.9);`,
    `  alpha = max(alpha, foamA);`,
  );
  return lines.join('\n');
}

/** Generated shoreline-foam GLSL (inserted into the fragment shader). */
export const FOAM_GLSL = genFoamGLSL();

/**
 * Sum of the VERTIX-displaced amplitudes — the real z-fight budget: the
 * deepest actual surface trough stays this far below sea level and MUST
 * remain above the static deep-ocean plane (SEA_PLANE_DEPTH below it).
 */
export const VERTEX_WAVE_AMPLITUDE = WATER_VERTEX_WAVES.reduce((s, w) => s + w.amp, 0);

/** Depth buffer is flat beyond this (world units below sea level). */
export const WATER_DEPTH_CAP = 24;

/** Water surface size in world units (square, centred on the world). */
export const WATER_SIZE = 1200;

/**
 * Water surface subdivisions per axis. 1200 / 192 = 6.25 u vertex spacing —
 * dense enough that both vertex waves (13 u, 22 u) clear the Nyquist limit
 * with headroom (2.08 and 3.52 samples per wavelength), while keeping the
 * grid at ~37k vertices (single static mesh, cheap on mid-range GPUs).
 */
export const WATER_SUBDIVISIONS = 192;

/** Vertex spacing of the water grid in world units. */
export function waterVertexSpacing(): number {
  return WATER_SIZE / WATER_SUBDIVISIONS;
}

/** Normalise an XZ direction to unit length. */
function unitDir(d: [number, number]): [number, number] {
  const l = Math.hypot(d[0], d[1]) || 1;
  return [d[0] / l, d[1] / l];
}

/**
 * Emit GLSL that accumulates the vertical displacement (y) and the
 * analytic XZ gradient of all octaves. Uses `xzw` (world XZ) and `time`.
 * The generated code has no per-pixel randomness — no quantised hash
 * checkers (the old `h21(floor(xz * 2.2))` sparkle grid is gone).
 */
function genWaveTerms(waves: WaveOctave[], yOut: string, gradOut: string): string {
  let s = '';
  if (yOut) s += `  float ${yOut} = 0.0;\n`;
  s += `  vec2 ${gradOut} = vec2(0.0);\n`;
  waves.forEach((w, i) => {
    const [dx, dz] = unitDir(w.dir);
    const k = (2 * Math.PI) / w.wl;
    const gx = w.amp * k * dx;
    const gz = w.amp * k * dz;
    s += `  float ph${i} = (xzw.x * ${dx.toFixed(5)} + xzw.y * ${dz.toFixed(5)}) * ${k.toFixed(5)} + time * ${w.speed.toFixed(4)};\n`;
    s += `  ${gradOut} += cos(ph${i}) * vec2(${gx.toFixed(6)}, ${gz.toFixed(6)});\n`;
    if (yOut) s += `  ${yOut} += ${w.amp.toFixed(5)} * sin(ph${i});\n`;
  });
  return s;
}

const VERT_WAVES = genWaveTerms(WATER_VERTEX_WAVES, 'wy', 'wgrad');
const FRAG_WAVES = genWaveTerms(WATER_FRAGMENT_WAVES, 'fy', 'fgrad');

/** Exposes the final generated shader sources (used by QA/tests to verify GLSL). */
export function dumpWaterGLSL(): string {
  return WATER_VERT + '\n----------------\n' + WATER_FRAG;
}

const WATER_VERT = `
precision highp float;
attribute vec3 position;
attribute float depth;
uniform mat4 world;
uniform mat4 viewProjection;
uniform float time;
varying vec3 vPos;
varying vec3 vNormal;
varying float vDepth;
varying float vWave;
${SHADOW_VERT_DECL}
void main() {
  vec3 p = position;
  vec4 wp = world * vec4(p, 1.0);
  vec2 xzw = wp.xz;
${VERT_WAVES}
  p.y += wy;
  // Exact analytic normal of the summed (vertex) sine field.
  vNormal = normalize(vec3(-wgrad, 1.0));
  // Coarse crest factor in [-1, 1]; the fragment adds the fine-wave
  // contribution before clamping (see WATER_FRAG).
  vWave = clamp(wy / ${VERTEX_WAVE_AMPLITUDE.toFixed(5)}, -1.0, 1.0);
  // Baked per-vertex water depth (SEA_LEVEL - terrain height at this grid
  // point, 0 over land). Depth-based colour comes from here — no texture.
  vDepth = depth;
  vec4 wpp = world * vec4(p, 1.0);
  vPos = wpp.xyz;
${SHADOW_VERT_MAIN('wpp')}
  gl_Position = viewProjection * wpp;
}
`;

const WATER_FRAG = `
precision highp float;
uniform vec3 cameraPosition;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform float time;
uniform vec3 fogColor;
uniform float fogDensity;
// Sky tone the water reflects at grazing angles: mirrored from the scene
// fog (horizon) colour every frame so the sea reflects the ACTUAL sky —
// bright blue by day, warm haze at dusk, near-black at night.
uniform vec3 skyTint;
varying vec3 vPos;
varying vec3 vNormal;
varying float vDepth;
varying float vWave;
${SHADOW_FRAG_DECL}

${COLOR_GRADE_GLSL}

void main() {
  // The ocean plane spans the whole map, including dry ground. Do not rely
  // on terrain depth writes alone to hide it: transparent water is rendered
  // separately and can otherwise veil land and the player at the shoreline.
  if (vDepth <= 0.0) discard;

  vec3 V = normalize(cameraPosition - vPos);
  vec2 xzw = vPos.xz;
  // Mid/fine waves perturb the normal (no displacement) for realistic
  // glint structure that is far too short-wavelength for the vertex grid.
${FRAG_WAVES}
  vec3 N = normalize(vNormal + vec3(fgrad, 0.0));
  // Full crest factor: coarse vertex swell + fine fragment waves.
  float crest = clamp(vWave + fy / ${MAX_WAVE_AMPLITUDE.toFixed(5)}, -1.0, 1.0);

  float fres = 0.06 + 0.94 * pow(1.0 - max(dot(V, N), 0.0), 3.0);

  // Depth-based water colour: shallow turquoise at the shore, mid blue over
  // the shelf, deep navy far out (matches the static deep-ocean plane).
  float d = clamp(vDepth, 0.0, ${WATER_DEPTH_CAP.toFixed(1)});
  float shallow = 1.0 - smoothstep(0.3, 4.0, d);
  float mid = (1.0 - smoothstep(4.0, 14.0, d)) * (1.0 - shallow);

  vec3 deep = vec3(0.030, 0.160, 0.210);
  vec3 midC = vec3(0.055, 0.280, 0.315);
  vec3 shallowC = vec3(0.110, 0.440, 0.430);

  vec3 base = mix(deep, midC, mid * 0.6);
  base = mix(base, shallowC, shallow * 0.8);
  // Wave crests catch more sky light (strongest in shallow water).
  base += vec3(0.015, 0.025, 0.030) * max(0.0, crest) * (0.5 + 0.5 * shallow);
  // Sky reflection at grazing angles follows the live sky (skyTint uniform).
  base = mix(base, skyTint, fres * 0.55);

  // Directional sun glint from the (wave-perturbed) normal: tight glint +
  // wide sheen. No hash/checker sparkle — the glint follows real geometry.
  vec3 H = normalize(normalize(sunDir) + V);
  float ndh = max(dot(N, H), 0.0);
  // Sun shadows (flora/player cast): tree and building shadows shade the
  // water surface too, so forests read as darker water, not flat blue.
  float shadow = ${SHADOW_SAMPLE};
  vec3 col = (base + sunColor * (pow(ndh, 320.0) * 2.0 + pow(ndh, 24.0) * 0.08)) * shadow;

  float alpha = clamp(0.70 + fres * 0.22 + shallow * 0.05, 0.0, 0.97);

${FOAM_GLSL}

  // Engine fog (EXP2) match: colour and density are mirrored from the scene
  // each frame (see Water.syncFog) so water fades into the same day/night
  // horizon as terrain and sky.
  float dist = length(vPos - cameraPosition);
  float f = clamp(1.0 - exp(-fogDensity * fogDensity * dist * dist), 0.0, 1.0);
  col = mix(col, fogColor, f);
  // Grade like the built-in materials (fog was blended in linear space).
  gl_FragColor = vec4(colorGrade(col), alpha * (1.0 - f * 0.5));
}
`;

/**
 * Animated procedural ocean.
 *  - Coarse swell (13 u / 22 u) is vertex-displaced with an exact analytic
 *    normal on a 6.25 u grid — every vertex wave clears Nyquist, so no
 *    moiré/patch artefacts from undersampled waves.
 *  - Mid/fine waves (1.25-7.5 u) perturb the shading normal in the fragment
 *    (displacement-free) for crisp directional glints.
 *  - Per-vertex BAKED water depth (pure function of the deterministic
 *    height field) drives the deep -> mid -> shallow colour transition, so
 *    the shoreline reads as a natural shallow shelf instead of a flat tint.
 *  - Sun glint is directional (specular on the real wave normal); the old
 *    quantised hash "sparkle" checker (an unnatural blue/white pattern) is
 *    gone.
 *  - Fog colour/density and the sky-reflection tint are mirrored from the
 *    scene fog every frame so the sea always blends into the same day/night
 *    atmosphere as terrain/sky — including reflecting a dark sky at night
 *    instead of a hardcoded day-blue.
 *  - Animated shoreline foam: a thin white band in the baked shallow shelf
 *    that the wave phases push in and out, broken into filaments by two
 *    crossing directional sine streak fields (see WATER_FOAM). Zero new
 *    uniforms, zero per-frame CPU cost — pure fragment ALU driven by the
 *    existing depth attribute and wave phases.
 *
 * Amplitude budget: VERTEX_WAVE_AMPLITUDE (< SEA_PLANE_DEPTH) guarantees
 * the deepest displaced trough stays above the static deep-ocean plane,
 * so no z-fighting.
 */
export class Water {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private time = 0;
  private engine: Engine;
  /** Cached vector for the sun-color uniform (Color3 values reused each frame). */
  private sunColorV = new Vector3(1, 0.96, 0.86);
  /** Cached vector for the fog-color uniform (no per-frame allocation). */
  private fogV = new Vector3();
  /** Cached vector for the sky-reflection tint (synced from the scene each frame). */
  private skyTintV = new Vector3(0.55, 0.68, 0.78);
  /** Scene the water was built into (for fog-observable cleanup). */
  private scene: Scene;
  /** Scene observable used to mirror scene fog into the shader. */
  private fogObserver: ReturnType<Scene['onBeforeRenderObservable']['add']> | null = null;
  /** Mirrors the directional-light shadow map into the water shader. */
  private shadowReceiver: ShadowReceiver | null = null;

  constructor(scene: Scene, engine: Engine) {
    this.scene = scene;
    this.engine = engine;
    this.mesh = MeshBuilder.CreateGround('water', {
      width: WATER_SIZE,
      height: WATER_SIZE,
      subdivisions: WATER_SUBDIVISIONS,
    }, scene);
    this.mesh.position.y = SEA_LEVEL;
    this.mesh.isPickable = false;

    this.bakeDepth();

    this.material = new ShaderMaterial(
      'waterMat',
      scene,
      { vertexSource: WATER_VERT, fragmentSource: WATER_FRAG },
      {
        attributes: ['position', 'depth'],
        uniforms: ['world', 'viewProjection', 'cameraPosition', 'sunDir', 'sunColor', 'time', 'fogColor', 'fogDensity', 'skyTint', ...COLOR_GRADE_UNIFORMS, ...SHADOW_UNIFORMS],
        defines: shadowReceiveDefines(engine),
      },
    );
    this.material.setFloat('time', 0);
    this.material.setVector3('sunDir', new Vector3(-0.4, -0.8, 0.3));
    this.material.setVector3('sunColor', this.sunColorV);
    this.material.setVector3('skyTint', this.skyTintV);
    this.material.backFaceCulling = false;
    this.mesh.material = this.material;

    // Mirror the engine scene fog (set by the lighting system each frame)
    // into the water shader so day/night fog matches standard materials.
    const fogSync = () => this.syncFog(scene);
    this.fogObserver = scene.onBeforeRenderObservable.add(fogSync);
    fogSync();

    // Mirror the directional-light shadow map (tree/player shadows on the
    // water surface). Safe no-op until the shadow generator exists.
    this.shadowReceiver = new ShadowReceiver(scene, this.material);
  }

  /**
   * Bake the per-vertex water depth attribute: SEA_LEVEL minus the terrain
   * height at each grid point, clamped to [0, WATER_DEPTH_CAP] (0 over
   * land). The mesh has no XZ rotation/translation, so local XZ equals
   * world XZ. Pure function of the deterministic height field.
   */
  private bakeDepth(): void {
    const pos = this.mesh.getVerticesData('position') as Float32Array;
    const count = pos.length / 3;
    const depth = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const x = pos[i * 3];
      const z = pos[i * 3 + 2];
      let d = SEA_LEVEL - terrainHeight(x, z);
      if (d < 0) d = 0;
      else if (d > WATER_DEPTH_CAP) d = WATER_DEPTH_CAP;
      depth[i] = d;
    }
    // Custom vertex kind: v9.33's Geometry deduces the stride from the kind
    // for built-in kinds only, so pass stride=1 explicitly for 'depth'.
    this.mesh.setVerticesData('depth', depth, false, 1);
  }

  /** Copy the current scene fog (EXP2 density + colour), the sky tint
   *  (the fog colour is the sky's horizon colour — the light the water
   *  reflects at grazing angles) and the live image-processing pipeline
   *  into the shader. */
  syncFog(scene: Scene): void {
    if (scene.fogDensity != null) this.material.setFloat('fogDensity', scene.fogDensity);
    if (scene.fogColor) {
      this.fogV.set(scene.fogColor.r, scene.fogColor.g, scene.fogColor.b);
      this.material.setVector3('fogColor', this.fogV);
      this.skyTintV.set(this.fogV.x, this.fogV.y, this.fogV.z);
      this.material.setVector3('skyTint', this.skyTintV);
    }
    syncColorPipeline(scene, this.material);
  }

  syncSun(dir: Vector3, color: Color3): void {
    this.material.setVector3('sunDir', dir);
    this.sunColorV.set(color.r, color.g, color.b);
    this.material.setVector3('sunColor', this.sunColorV);
  }

  update(dt: number): void {
    this.time += dt;
    this.material.setFloat('time', this.time);
  }

  dispose(): void {
    if (this.fogObserver) this.scene.onBeforeRenderObservable.remove(this.fogObserver);
    this.fogObserver = null;
    if (this.shadowReceiver) this.shadowReceiver.dispose();
    this.shadowReceiver = null;
    this.material.dispose();
    this.mesh.dispose();
    void this.engine;
  }
}
