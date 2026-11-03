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

const WATER_VERT = `
precision highp float;
attribute vec3 position;
uniform mat4 world;
uniform mat4 viewProjection;
uniform float time;
uniform float seaLevel;
varying vec3 vPos;
varying vec3 vNormal;
void main() {
  vec3 p = position;
  vec3 wp = (world * vec4(p, 1.0)).xyz;
  float w1 = sin(wp.x * 0.35 + time * 0.9) * 0.11;
  float w2 = sin(wp.z * 0.27 + time * 0.7 + 1.7) * 0.09;
  float w3 = sin((wp.x + wp.z) * 0.12 + time * 0.5) * 0.07;
  p.y += (w1 + w2 + w3) * 0.55;
  // approximate analytic normal from wave derivatives
  float dx = cos(wp.x * 0.35 + time * 0.9) * 0.11 * 0.35
           + cos((wp.x + wp.z) * 0.12 + time * 0.5) * 0.07 * 0.12;
  float dz = cos(wp.z * 0.27 + time * 0.7 + 1.7) * 0.09 * 0.27
           + cos((wp.x + wp.z) * 0.12 + time * 0.5) * 0.07 * 0.12;
  vNormal = normalize(vec3(-dx * 0.55, 1.0, -dz * 0.55));
  vec4 wpp = world * vec4(p, 1.0);
  vPos = wpp.xyz;
  gl_Position = viewProjection * wpp;
}
`;

const WATER_FRAG = `
precision highp float;
uniform vec3 cameraPosition;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform float time;
uniform float seaLevel;
varying vec3 vPos;
varying vec3 vNormal;

float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec3 V = normalize(cameraPosition - vPos);
  vec3 N = normalize(vNormal);
  float fresnel = 0.08 + 0.92 * pow(1.0 - max(dot(V, N), 0.0), 3.0);

  vec3 deep    = vec3(0.030, 0.160, 0.210);
  vec3 shallow = vec3(0.100, 0.420, 0.420);
  vec3 skyRef  = vec3(0.55, 0.68, 0.78);

  // cheap shore tint: water close to camera shore reads lighter
  float sparkle = h21(floor(vPos.xz * 2.2) + floor(time * 1.3));
  vec3 col = mix(deep, shallow, fresnel * 0.55 + sparkle * 0.05);
  col = mix(col, skyRef, fresnel * 0.6);

  // sun specular
  vec3 H = normalize(normalize(sunDir) + V);
  float spec = pow(max(dot(N, H), 0.0), 240.0) * 1.6;
  col += sunColor * spec;

  float alpha = 0.72 + fresnel * 0.22;
  // engine fog (EXP2) match
  float dist = length(vPos - cameraPosition);
  float f = clamp(1.0 - exp(-0.0016 * 0.0016 * dist * dist), 0.0, 1.0);
  col = mix(col, vec3(0.62, 0.70, 0.72), f);
  gl_FragColor = vec4(col, alpha * (1.0 - f * 0.5));
}
`;

/**
 * Animated procedural ocean. Vertex waves in the shader (no CPU updates),
 * fresnel + sun specular in the fragment shader.
 */
export class Water {
  readonly mesh: Mesh;
  private material: ShaderMaterial;
  private time = 0;
  private engine: Engine;
  /** Cached vector for the sun-color uniform (Color3 values reused each frame). */
  private sunColorV = new Vector3(1, 0.96, 0.86);

  constructor(scene: Scene, engine: Engine) {
    this.engine = engine;
    this.mesh = MeshBuilder.CreateGround('water', {
      width: 1200,
      height: 1200,
      subdivisions: 96,
    }, scene);
    this.mesh.position.y = SEA_LEVEL;
    this.mesh.isPickable = false;

    this.material = new ShaderMaterial(
      'waterMat',
      scene,
      { vertexSource: WATER_VERT, fragmentSource: WATER_FRAG },
      {
        attributes: ['position'],
        uniforms: ['world', 'viewProjection', 'cameraPosition', 'sunDir', 'sunColor', 'time', 'seaLevel'],
      },
    );
    this.material.setFloat('seaLevel', SEA_LEVEL);
    this.material.setFloat('time', 0);
    this.material.setVector3('sunDir', new Vector3(-0.4, -0.8, 0.3));
    this.material.setVector3('sunColor', this.sunColorV);
    this.material.backFaceCulling = false;
    this.mesh.material = this.material;
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
    this.material.dispose();
    this.mesh.dispose();
    void this.engine;
  }
}
