import { describe, it, expect } from 'vitest';
import {
  TERRAIN_SIZE,
  SEA_LEVEL,
  WORLD_SEED,
  terrainHeight,
  terrainSlope,
  terrainNormal,
  isNearLake,
  findSpawnPoint,
  findCampPoint,
  createTerrain,
  createSeaPlane,
} from './terrain';
import { TERRAIN_SIZE as HF_SIZE, SEA_LEVEL as HF_SEA } from './heightfield';

describe('terrain module API', () => {
  it('re-exports the deterministic world API from the heightfield', () => {
    expect(TERRAIN_SIZE).toBe(HF_SIZE);
    expect(SEA_LEVEL).toBe(HF_SEA);
    expect(SEA_LEVEL).toBe(0);
    expect(WORLD_SEED).toBeGreaterThan(0);
  });

  it('exposes the world functions as callable values', () => {
    for (const fn of [
      terrainHeight,
      terrainSlope,
      terrainNormal,
      isNearLake,
      findSpawnPoint,
      findCampPoint,
      createTerrain,
      createSeaPlane,
    ]) {
      expect(typeof fn).toBe('function');
    }
  });

  it('terrainNormal returns a unit Vector3 with an upward component', () => {
    const n = terrainNormal(20, -30);
    expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 4);
    expect(n.y).toBeGreaterThan(0);
  });
});
