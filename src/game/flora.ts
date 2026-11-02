import {
  Color3,
  MeshBuilder,
  Scene,
  StandardMaterial,
} from '@babylonjs/core';
import { TERRAIN_SIZE, terrainHeight, terrainSlope } from './terrain';

/** Circular collider used to keep the player out of trees/rocks/bushes. */
export interface Collider {
  x: number;
  z: number;
  radius: number;
}

/** Deterministic RNG (mulberry32) so the island looks the same every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Finds random positions on the island that fit a given height/slope range. */
function findSpots(
  rng: () => number,
  count: number,
  minH: number,
  maxH: number,
  maxSlope: number,
): Array<{ x: number; z: number; h: number }> {
  const spots: Array<{ x: number; z: number; h: number }> = [];
  const half = TERRAIN_SIZE / 2 - 8;
  let attempts = 0;
  while (spots.length < count && attempts < count * 80) {
    attempts++;
    const x = (rng() * 2 - 1) * half;
    const z = (rng() * 2 - 1) * half;
    const h = terrainHeight(x, z);
    if (h < minH || h > maxH) continue;
    if (terrainSlope(x, z) > maxSlope) continue;
    // Keep spots apart for a more natural look.
    let tooClose = false;
    for (const s of spots) {
      const dx = s.x - x;
      const dz = s.z - z;
      if (dx * dx + dz * dz < 6 * 6) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) spots.push({ x, z, h });
  }
  return spots;
}

function greenMat(scene: Scene, name: string, base: Color3): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = base;
  mat.specularColor = new Color3(0.05, 0.05, 0.05);
  return mat;
}

function makeTree(scene: Scene, x: number, z: number, h: number, rng: () => number, colliders: Collider[]): void {
  const size = 0.8 + rng() * 0.7;

  const trunk = MeshBuilder.CreateCylinder(
    'trunk',
    { diameter: 0.45 * size, height: 2.6 * size, tessellation: 8 },
    scene,
  );
  trunk.position.set(x, h + 1.3 * size, z);

  const canopy = MeshBuilder.CreateIcoSphere(
    'canopy',
    { radius: 1.7 * size, subdivisions: 0 },
    scene,
  );
  canopy.scaling.set(1, 0.9, 1);
  canopy.position.set(x, h + 4.0 * size, z);
  canopy.rotation.set(rng() * Math.PI, rng() * Math.PI, 0);
  canopy.material = greenMat(scene, `canopyMat${x.toFixed(1)}`, new Color3(0.18 + rng() * 0.12, 0.42 + rng() * 0.14, 0.15));
  canopy.freezeWorldMatrix();
  trunk.freezeWorldMatrix();

  colliders.push({ x, z, radius: 0.4 * size + 0.25 });
}

function makeRock(scene: Scene, x: number, z: number, h: number, rng: () => number, colliders: Collider[]): void {
  const size = 1 + rng() * 2.2;
  const rock = MeshBuilder.CreateIcoSphere(
    `rock${x.toFixed(1)}`,
    { radius: size / 2, subdivisions: 0 },
    scene,
  );
  rock.scaling.set(1, 0.55 + rng() * 0.3, 0.8 + rng() * 0.4);
  rock.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);
  rock.position.set(x, h + 0.25, z);
  const gray = 0.38 + rng() * 0.18;
  const mat = new StandardMaterial(`rockMat${x.toFixed(1)}`, scene);
  mat.diffuseColor = new Color3(gray, gray * 0.98, gray * 0.94);
  mat.specularColor = new Color3(0.08, 0.08, 0.08);
  rock.material = mat;
  rock.freezeWorldMatrix();

  if (size > 1.6) {
    colliders.push({ x, z, radius: 0.45 * size + 0.2 });
  }
}

function makeBush(scene: Scene, x: number, z: number, h: number, rng: () => number): void {
  const size = 0.6 + rng() * 0.8;
  const bush = MeshBuilder.CreateIcoSphere(
    `bush${x.toFixed(1)}`,
    { radius: size / 2, subdivisions: 0 },
    scene,
  );
  bush.scaling.set(1, 0.65, 1);
  bush.position.set(x, h + 0.25 * size, z);
  bush.rotation.set(0, rng() * Math.PI, 0);
  bush.material = greenMat(scene, `bushMat${x.toFixed(1)}`, new Color3(0.2 + rng() * 0.1, 0.45 + rng() * 0.12, 0.18));
  bush.freezeWorldMatrix();
}

/**
 * Scatters procedural trees, rocks and bushes across the island.
 * Fills `colliders` with circular blockers so the player can't walk through them.
 */
export function populateFlora(scene: Scene, colliders: Collider[]): void {
  const rng = mulberry32(0x5eed2024);

  const trees = findSpots(rng, 16, 2.5, 16, 0.55);
  for (const s of trees) makeTree(scene, s.x, s.z, s.h, rng, colliders);

  const rocks = findSpots(rng, 12, 0.6, 20, 0.75);
  for (const s of rocks) makeRock(scene, s.x, s.z, s.h, rng, colliders);

  const bushes = findSpots(rng, 40, 1.2, 18, 0.9);
  for (const s of bushes) makeBush(scene, s.x, s.z, s.h, rng);
}
