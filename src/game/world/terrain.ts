import {
  Mesh,
  MeshBuilder,
  Scene,
  ShaderMaterial,
  Vector3,
  VertexBuffer,
} from '@babylonjs/core';
import {
  SEA_LEVEL,
  TERRAIN_SIZE,
  WORLD_SEED,
  buildTerrainGrid,
  findCampPoint,
  findSpawnPoint,
  isNearLake,
  terrainHeight,
  terrainSlope,
  terrainNormal3,
} from './heightfield';

// Re-export the deterministic world API so existing consumers keep importing
// from './terrain'.
export {
  TERRAIN_SIZE,
  SEA_LEVEL,
  WORLD_SEED,
  terrainHeight,
  isNearLake,
  terrainSlope,
  findSpawnPoint,
  findCampPoint,
};

/** Terrain surface normal as a Babylon Vector3 (approximate). */
export function terrainNormal(x: number, z: number): Vector3 {
  const n = terrainNormal3(x, z);
  return new Vector3(n.x, n.y, n.z);
}

const TERRAIN_VERT = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec4 color;
uniform mat4 world;
uniform mat4 viewProjection;
varying vec3 vNormal;
varying vec3 vPos;
varying vec4 vMask;
void main() {
  vec4 wp = world * vec4(position, 1.0);
  vPos = wp.xyz;
  vNormal = normalize(mat3(world) * normal);
  vMask = color;
  gl_Position = viewProjection * wp;
}
`;

const TERRAIN_FRAG = `
precision highp float;
uniform vec3 cameraPosition;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 ambientTop;
uniform vec3 ambientGround;
uniform vec3 fogColor;
uniform float fogDensity;
uniform float seaLevel;
varying vec3 vNormal;
varying vec3 vPos;
varying vec4 vMask;

float h21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = h21(i);
  float b = h21(i + vec2(1.0, 0.0));
  float c = h21(i + vec2(0.0, 1.0));
  float d = h21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float detail(vec2 p) {
  return vnoise(p * 0.30) * 0.55 + vnoise(p * 1.6) * 0.45;
}

void main() {
  // Muted, natural biome palette (no saturated / rainbow tones).
  vec3 sandLo  = vec3(0.60, 0.545, 0.415);
  vec3 sandHi  = vec3(0.715, 0.655, 0.505);
  vec3 grassLo = vec3(0.175, 0.265, 0.125);
  vec3 grassHi = vec3(0.255, 0.345, 0.175);
  vec3 rockLo  = vec3(0.315, 0.305, 0.290);
  vec3 rockHi  = vec3(0.415, 0.405, 0.385);
  vec3 snowLo  = vec3(0.600, 0.635, 0.695);
  vec3 snowHi  = vec3(0.820, 0.845, 0.885);
  vec3 seabed  = vec3(0.280, 0.345, 0.300);

  float d = detail(vPos.xz);
  vec3 sandC  = mix(sandLo,  sandHi,  d);
  vec3 grassC = mix(grassLo, grassHi, 0.35 + 0.65 * d);
  vec3 rockC  = mix(rockLo,  rockHi,  d);
  vec3 snowC  = mix(snowLo,  snowHi,  0.40 + 0.60 * d);

  vec3 col = sandC * vMask.r + grassC * vMask.g + rockC * vMask.b + snowC * vMask.a;
  // fine grain so flat areas are not plastic
  col *= 0.92 + 0.18 * d;

  // Underwater terrain reads as silt/rock rather than surface biomes.
  float wet = smoothstep(seaLevel + 0.25, seaLevel - 1.5, vPos.y);
  col = mix(col, seabed, wet * 0.72);

  vec3 N = normalize(vNormal);
  float ndl = max(dot(N, normalize(sunDir)), 0.0);
  float hemi = 0.5 + 0.5 * N.y;
  vec3 amb = mix(ambientGround, ambientTop, hemi);
  vec3 light = sunColor * ndl + amb;
  vec3 c = col * light;

  // Match the engine scene fog (EXP2) so the shoreline/horizon blends cleanly.
  float dist = length(vPos - cameraPosition);
  float f = 1.0 - exp(-fogDensity * fogDensity * dist * dist);
  c = mix(c, fogColor, clamp(f, 0.0, 1.0));
  gl_FragColor = vec4(c, 1.0);
}
`;

/**
 * Builds the island terrain as a single static grid mesh:
 *  - Float32 height/normal buffers (no byte-quantised heightmap),
 *  - per-vertex 4-channel biome mask (sand/grass/rock/snow),
 *  - a custom shader with muted biome colours and engine-matched fog.
 * The material's sun/ambient uniforms are driven by the lighting system each
 * frame; fog colour/density are mirrored from the scene so day/night fog
 * stays consistent between the terrain and standard materials.
 */
export function createTerrain(scene: Scene): {
  mesh: Mesh;
  material: ShaderMaterial;
} {
  const grid = buildTerrainGrid();
  const { positions, normals, colors, indices } = grid;

  const mesh = new Mesh('island', scene);
  mesh.setVerticesData(VertexBuffer.PositionKind, positions);
  mesh.setVerticesData(VertexBuffer.NormalKind, normals);
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
  mesh.setIndices(indices);

  const material = new ShaderMaterial(
    'terrainMat',
    scene,
    { vertexSource: TERRAIN_VERT, fragmentSource: TERRAIN_FRAG },
    {
      attributes: ['position', 'normal', 'color'],
      uniforms: [
        'world',
        'viewProjection',
        'cameraPosition',
        'sunDir',
        'sunColor',
        'ambientTop',
        'ambientGround',
        'fogColor',
        'fogDensity',
        'seaLevel',
      ],
    },
  );
  material.setFloat('seaLevel', SEA_LEVEL);
  material.setVector3('sunDir', new Vector3(-0.4, -0.8, 0.3));
  material.setVector3('sunColor', new Vector3(1, 0.96, 0.86));
  material.setVector3('ambientTop', new Vector3(0.32, 0.36, 0.42));
  material.setVector3('ambientGround', new Vector3(0.2, 0.18, 0.15));
  material.setFloat('fogDensity', 0.0028);
  material.setVector3('fogColor', new Vector3(0.62, 0.72, 0.82));

  mesh.material = material;

  // Mirror the engine scene fog (set by the lighting system each frame) into
  // the shader so day/night fog matches standard materials exactly.
  const fogV = new Vector3(0.62, 0.72, 0.82);
  const fogSync = () => {
    if (scene.fogDensity != null) material.setFloat('fogDensity', scene.fogDensity);
    if (scene.fogColor) {
      const fc = scene.fogColor;
      fogV.set(fc.r, fc.g, fc.b);
      material.setVector3('fogColor', fogV);
    }
  };
  const observable = scene.onBeforeRenderObservable.add(fogSync);
  mesh.onDisposeObservable.add(() => {
    scene.onBeforeRenderObservable.remove(observable);
  });

  return { mesh, material };
}

/**
 * A large sea plane that extends well beyond the island into the fog, hiding
 * the world boundary. Visual only; the animated surface is provided by
 * Water and gameplay interaction by the controller.
 */
export function createSeaPlane(scene: Scene): Mesh {
  const ocean = MeshBuilder.CreateGround('ocean', {
    width: TERRAIN_SIZE * 3.2,
    height: TERRAIN_SIZE * 3.2,
    subdivisions: 2,
  }, scene);
  ocean.position.y = SEA_LEVEL;
  ocean.isPickable = false;
  return ocean;
}
