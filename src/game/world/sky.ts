import {
  Mesh,
  MeshBuilder,
  Scene,
  ShaderMaterial,
  Vector3,
} from '@babylonjs/core';
import { clamp } from '../core/noise';

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

float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

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

  // stars: hashed direction grid, visible at night, high in the sky
  vec2 sp = dir.xz / max(dir.y + 0.12, 0.12);
  vec2 cell = floor(sp * 90.0);
  float s = h21(cell);
  float star = step(0.992, s) * smoothstep(0.08, 0.3, y) * nightStars;
  float twinkle = 0.7 + 0.3 * h21(cell + s * 17.0);
  col += vec3(star * twinkle * 0.9);

  // subtle haze near horizon
  col = mix(col, horizon, pow(1.0 - max(y, 0.0), 6.0) * 0.55);

  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * Procedural skydome with day/night cycle, sun, moon and stars.
 * Re-centered on the camera every frame.
 */
export class Sky {
  readonly mesh: Mesh;
  private material: ShaderMaterial;

  constructor(scene: Scene) {
    this.mesh = MeshBuilder.CreateSphere('sky', { diameter: 3600, segments: 24 }, scene);
    this.mesh.isPickable = false;

    this.material = new ShaderMaterial(
      'skyMat',
      scene,
      { vertexSource: SKY_VERT, fragmentSource: SKY_FRAG },
      {
        attributes: ['position'],
        uniforms: ['viewProjection', 'cameraPosition', 'sunDir', 'moonDir', 'dayFactor', 'nightStars'],
      },
    );
    this.material.backFaceCulling = false;
    this.material.fogEnabled = false;
    this.mesh.material = this.material;
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
    this.material.dispose();
    this.mesh.dispose();
  }
}
