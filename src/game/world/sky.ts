import {
  Mesh,
  MeshBuilder,
  Scene,
  ShaderMaterial,
  Vector3,
} from '@babylonjs/core';
import { clamp } from '../core/noise';
import { COLOR_GRADE_GLSL, COLOR_GRADE_UNIFORMS, syncColorPipeline } from './colorPipeline';
import { NOISE_H21_GLSL } from './noiseGLSL';

const SKY_VERT = `
precision highp float;
attribute vec3 position;
uniform mat4 viewProjection;
uniform vec3 cameraPosition;
varying vec3 vDir;
void main() {
  // sky box is re-centered on the camera: direction is just object position
  vDir = position;
  vec4 wp = vec4(cameraPosition + position, 1.0);
  gl_Position = viewProjection * wp;
}
`;

const SKY_FRAG = `
precision highp float;
uniform vec3 sunDir;
uniform vec3 moonDir;
uniform float dayFactor;
uniform float nightStars;
varying vec3 vDir;

${NOISE_H21_GLSL}
${COLOR_GRADE_GLSL}

void main() {
  vec3 dir = normalize(vDir);
  float y = clamp(dir.y, -1.0, 1.0);

  vec3 dayZenith  = vec3(0.22, 0.45, 0.75);
  vec3 dayHorizon = vec3(0.62, 0.75, 0.85);
  vec3 duskHorizon= vec3(0.95, 0.55, 0.32);
  vec3 nightZenith= vec3(0.015, 0.03, 0.07);
  vec3 nightHorizon=vec3(0.05, 0.08, 0.14);

  float duskBand = clamp(1.0 - abs(dayFactor - 0.25) * 3.2, 0.0, 1.0) * step(0.0, dir.y);
  vec3 zenith = mix(nightZenith, dayZenith, dayFactor);
  vec3 horizon = mix(nightHorizon, dayHorizon, dayFactor);
  horizon = mix(horizon, duskHorizon, duskBand * 0.75);

  vec3 col = mix(horizon, zenith, pow(max(y, 0.0), 0.42));
  if (y < 0.0) col = mix(horizon * 0.85, vec3(0.10, 0.12, 0.12), min(1.0, -y * 2.0));

  // sun disc + glow
  float sd = max(dot(dir, normalize(sunDir)), 0.0);
  col += vec3(1.0, 0.92, 0.75) * (pow(sd, 900.0) * 2.2 + pow(sd, 24.0) * 0.28) * (0.25 + dayFactor);

  // moon disc + soft glow
  float md = max(dot(dir, normalize(moonDir)), 0.0);
  col += vec3(0.85, 0.9, 1.0) * (pow(md, 1400.0) * 0.9 + pow(md, 48.0) * 0.05) * nightStars;

  // stars: a per-pixel POINT star field. One hash per cell decides whether
  // a star exists there; separate hashes place it at a RANDOM spot inside
  // the cell (never on the grid lines), give it its own radius, brightness
  // and colour temperature; a radial falloff renders each star as a soft
  // point. The old per-cell uniform grid (whole cells lit at once) read as
  // an unnatural blocky pattern, so it is gone.
  vec2 sp = dir.xz / max(dir.y + 0.12, 0.12);
  vec2 stp = sp * 90.0;
  vec2 cell = floor(stp);
  vec2 fc = fract(stp);
  float s = h21(cell);
  vec2 starC = 0.18 + 0.64 * vec2(h21(cell + vec2(13.7, 0.0)), h21(cell + vec2(7.31, 0.0)));
  float starR = 0.02 + 0.055 * h21(cell + vec2(29.3, 0.0));
  float star = step(0.992, s) * (1.0 - smoothstep(starR * 0.15, starR, length(fc - starC)));
  float starB = 0.25 + 0.75 * pow(h21(cell + vec2(41.9, 0.0)), 2.0);
  vec3 starTint = mix(vec3(0.82, 0.88, 1.0), vec3(1.0, 0.94, 0.82), h21(cell + vec2(3.17, 0.0)));
  col += starTint * (star * starB * 0.95 * smoothstep(0.08, 0.3, y) * nightStars);

  // subtle haze near horizon
  col = mix(col, horizon, pow(1.0 - max(y, 0.0), 6.0) * 0.55);

  // Grade like the built-in materials so the sky matches the rest of the
  // frame (ACES + gamma + contrast + dither) instead of raw-linear output.
  gl_FragColor = vec4(colorGrade(col), 1.0);
}
`;

/** Exposes the final shader sources (QA regression guards). */
export function dumpSkyGLSL(): string {
  return SKY_VERT + '\n----------------\n' + SKY_FRAG;
}

/**
 * Procedural skydome with day/night cycle, sun, moon and a per-pixel point
 * star field (random in-cell placement/radius/brightness — no grid
 * alignment). Re-centered on the camera every frame.
 */
export class Sky {
  readonly mesh: Mesh;
  private material: ShaderMaterial;
  private scene: Scene;
  /** Scene observable used to mirror the image-processing pipeline. */
  private pipelineObserver: ReturnType<Scene['onBeforeRenderObservable']['add']> | null = null;

  constructor(scene: Scene) {
    this.scene = scene;
    this.mesh = MeshBuilder.CreateSphere('sky', { diameter: 3600, segments: 24 }, scene);
    this.mesh.isPickable = false;

    this.material = new ShaderMaterial(
      'skyMat',
      scene,
      { vertexSource: SKY_VERT, fragmentSource: SKY_FRAG },
      {
        attributes: ['position'],
        uniforms: ['viewProjection', 'cameraPosition', 'sunDir', 'moonDir', 'dayFactor', 'nightStars', ...COLOR_GRADE_UNIFORMS],
      },
    );
    this.material.backFaceCulling = false;
    this.material.fogEnabled = false;
    this.mesh.material = this.material;

    // Mirror the live image-processing settings each frame so the sky stays
    // graded identically to the standard materials.
    const sync = () => syncColorPipeline(scene, this.material);
    this.pipelineObserver = scene.onBeforeRenderObservable.add(sync);
    sync();
  }

  /** dir: unit vector pointing TOWARD the sun (used for glow in sky). */
  setDay(sunDir: Vector3, moonDir: Vector3, dayFactor: number): void {
    this.material.setVector3('sunDir', sunDir);
    this.material.setVector3('moonDir', moonDir);
    this.material.setFloat('dayFactor', dayFactor);
    this.material.setFloat('nightStars', clamp(1 - dayFactor * 2.4, 0, 1));
  }

  centerOn(cameraPos: Vector3): void {
    this.mesh.position.copyFrom(cameraPos);
  }

  dispose(): void {
    if (this.pipelineObserver) this.scene.onBeforeRenderObservable.remove(this.pipelineObserver);
    this.pipelineObserver = null;
    this.material.dispose();
    this.mesh.dispose();
  }
}
