import {
  Color3,
  GroundMesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  VertexBuffer,
} from '@babylonjs/core';

/** Width/depth of the square island terrain in world units. */
export const TERRAIN_SIZE = 260;
/** World Y level of the sea surface. */
export const SEA_LEVEL = 0;

/** Deterministic hash in [0, 1) for integer lattice points. */
function hash2(x: number, z: number): number {
  const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return n - Math.floor(n);
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 2D value noise in [0, 1]. */
function valueNoise(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const a = hash2(xi, zi);
  const b = hash2(xi + 1, zi);
  const c = hash2(xi, zi + 1);
  const d = hash2(xi + 1, zi + 1);
  const u = smoothstep(xf);
  const v = smoothstep(zf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal Brownian motion (3 octaves) in [0, 1]. */
function fbm(x: number, z: number): number {
  return (
    valueNoise(x * 0.02, z * 0.02) * 0.55 +
    valueNoise(x * 0.055 + 31.4, z * 0.055 + 17.2) * 0.28 +
    valueNoise(x * 0.13 + 71.9, z * 0.13 + 43.7) * 0.17
  );
}

/**
 * Procedural island height. The island rises in the middle, has rolling
 * hills from fbm noise, and sinks below SEA_LEVEL toward the edges so the
 * ocean covers the outer rim.
 */
export function terrainHeight(x: number, z: number): number {
  const half = TERRAIN_SIZE / 2;
  const nx = x / half;
  const nz = z / half;
  const r = Math.sqrt(nx * nx + nz * nz);

  let mask = 1 - Math.pow(Math.max(0, r), 2.4);
  mask = Math.max(0, mask);
  mask = smoothstep(mask);

  const hills = fbm(x, z) * 26;
  const pedestal = 4.5 * mask;
  const sink = -9 * (1 - mask);
  return hills * mask + pedestal + sink;
}

/** Estimate terrain slope (rise over run) at a point. */
export function terrainSlope(x: number, z: number): number {
  const e = 1.5;
  const dx = terrainHeight(x + e, z) - terrainHeight(x - e, z);
  const dz = terrainHeight(x, z + e) - terrainHeight(x, z - e);
  return Math.sqrt(dx * dx + dz * dz) / (2 * e);
}

const SAND = new Color3(0.85, 0.78, 0.55);
const GRASS = new Color3(0.28, 0.52, 0.20);
const GRASS_DARK = new Color3(0.22, 0.42, 0.16);
const ROCK = new Color3(0.45, 0.44, 0.42);
const DEEP_SAND = new Color3(0.52, 0.47, 0.33);

/**
 * Builds the island terrain from a procedural height map buffer, then paints
 * per-vertex colors (sand beach, grass, rocky highs, underwater sand).
 */
export function createTerrain(scene: Scene): void {
  const SAMPLES = 201; // height-map resolution
  const minH = -12;
  const maxH = 30;
  // Height maps are RGBA buffers; R=G=B carries the height, A marks visibility.
  const data = new Uint8Array(SAMPLES * SAMPLES * 4);

  for (let iz = 0; iz < SAMPLES; iz++) {
    for (let ix = 0; ix < SAMPLES; ix++) {
      const x = (ix / (SAMPLES - 1) - 0.5) * TERRAIN_SIZE;
      const z = (iz / (SAMPLES - 1) - 0.5) * TERRAIN_SIZE;
      const h = terrainHeight(x, z);
      const t = Math.max(0, Math.min(1, (h - minH) / (maxH - minH)));
      const v = Math.round(t * 255);
      // Builder reads row 0 at +Z, so flip the row index.
      const px = ((SAMPLES - 1 - iz) * SAMPLES + ix) * 4;
      data[px] = v;
      data[px + 1] = v;
      data[px + 2] = v;
      data[px + 3] = 255;
    }
  }

  const applyColors = (mesh: GroundMesh) => {
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind) as Float32Array;
    const colors = new Float32Array(positions.length);

    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i];
      const z = positions[i + 2];
      const h = positions[i + 1];

      // Choose base color by height.
      let color: Color3;
      if (h < SEA_LEVEL) {
        color = DEEP_SAND;
      } else if (h < 0.9) {
        color = SAND;
      } else if (h < 2.2) {
        const t = smoothstep((h - 0.9) / 1.3);
        color = Color3.Lerp(SAND, GRASS, t);
      } else if (h > 17) {
        const t = smoothstep(Math.min(1, (h - 17) / 5));
        color = Color3.Lerp(GRASS, ROCK, t);
      } else {
        color = GRASS;
      }

      // Subtle large-scale mottling for visual richness.
      const mottle = 0.88 + 0.24 * valueNoise(x * 0.09 + 99.1, z * 0.09 + 55.7);
      const final =
        h < 2.2
          ? color
          : Color3.Lerp(color, h > 12 ? GRASS_DARK : GRASS, 0.25 * mottle);

      colors[i] = final.r * mottle;
      colors[i + 1] = final.g * mottle;
      colors[i + 2] = final.b * mottle;
    }

    mesh.setVerticesData(VertexBuffer.ColorKind, colors);
  };

  const mesh = MeshBuilder.CreateGroundFromHeightMap(
    'island',
    { data, width: SAMPLES, height: SAMPLES },
    {
      width: TERRAIN_SIZE,
      height: TERRAIN_SIZE,
      subdivisions: SAMPLES - 1,
      minHeight: minH,
      maxHeight: maxH,
      updatable: false,
      onReady: (m) => applyColors(m),
    },
    scene,
  );
  // In-memory height maps build synchronously, but also paint now as a fallback.
  applyColors(mesh);

  const mat = new StandardMaterial('terrainMat', scene);
  mat.diffuseColor = new Color3(1, 1, 1); // vertex colors provide the tint
  mat.specularColor = new Color3(0.03, 0.03, 0.03);
  mesh.material = mat;
}

/** A large, gently translucent sea plane surrounding the island. */
export function createOcean(scene: Scene) {
  const ocean = MeshBuilder.CreateGround('ocean', {
    width: 900,
    height: 900,
    subdivisions: 1,
  }, scene);
  ocean.position.y = SEA_LEVEL;

  const mat = new StandardMaterial('oceanMat', scene);
  mat.diffuseColor = new Color3(0.09, 0.34, 0.52);
  mat.specularColor = new Color3(0.35, 0.45, 0.5);
  mat.specularPower = 64;
  mat.alpha = 0.88;
  mat.disableLighting = false;
  ocean.material = mat;
  return ocean;
}
