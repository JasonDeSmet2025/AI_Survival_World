import { describe, it, expect } from 'vitest';
import {
  SEA_LEVEL,
  TERRAIN_SIZE,
  WORLD_SEED,
  LAKE,
  terrainHeight,
  terrainSlope,
  terrainNormal3,
  terrainMask,
  isNearLake,
  findSpawnPoint,
  findCampPoint,
  buildTerrainGrid,
} from './heightfield';

/** Walk speed from player/controller.ts (kept here so the test is self-contained). */
const WALK_SPEED = 5.2;

/** Coarse grid sample across the whole tile. */
function sampleGrid(n = 160) {
  const vals: number[] = [];
  let maxDryRadius = 0;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x = (ix / (n - 1) - 0.5) * TERRAIN_SIZE;
      const z = (iz / (n - 1) - 0.5) * TERRAIN_SIZE;
      const h = terrainHeight(x, z);
      vals.push(h);
      if (h > SEA_LEVEL && Math.hypot(x, z) > maxDryRadius) maxDryRadius = Math.hypot(x, z);
    }
  }
  return { vals, min: Math.min(...vals), max: Math.max(...vals), maxDryRadius };
}

describe('world constants', () => {
  it('has sea level at the origin', () => {
    expect(SEA_LEVEL).toBe(0);
  });

  it('substantially enlarged the playable tile', () => {
    // The prototype tile was 320 units; the world must be meaningfully larger.
    expect(TERRAIN_SIZE).toBeGreaterThan(320);
    expect(WORLD_SEED).toBeGreaterThan(0);
  });

  it('cannot be crossed on foot in 10 seconds', () => {
    const { maxDryRadius } = sampleGrid();
    const dryDiameter = 2 * maxDryRadius;
    // A large island: well over a couple hundred units across.
    expect(dryDiameter).toBeGreaterThan(200);
    // ...so a walk across takes far longer than 10 seconds.
    const crossTime = dryDiameter / WALK_SPEED;
    expect(crossTime).toBeGreaterThan(30);
  });
});

describe('terrainHeight', () => {
  it('is deterministic', () => {
    const a = terrainHeight(12.3, -5.7);
    const b = terrainHeight(12.3, -5.7);
    expect(a).toBe(b);
  });

  it('has realistic elevation range and variety', () => {
    const { min, max } = sampleGrid(120);
    expect(min).toBeLessThan(-10); // deep ocean floor
    expect(max).toBeGreaterThan(20); // real high ground
    expect(max - min).toBeGreaterThan(30);
  });

  it('keeps the island interior dry and the far corners underwater', () => {
    // Centre of the tile is deep inside the island body.
    expect(terrainHeight(0, 0)).toBeGreaterThan(0);
    const half = TERRAIN_SIZE / 2;
    // Corners are far outside the coast -> deep ocean.
    expect(terrainHeight(half - 1, half - 1)).toBeLessThan(SEA_LEVEL);
    expect(terrainHeight(-half + 1, half - 1)).toBeLessThan(SEA_LEVEL);
    expect(terrainHeight(half - 1, -half + 1)).toBeLessThan(SEA_LEVEL);
  });

  it('has snowy peaks and sandy beaches', () => {
    const { vals } = sampleGrid(140);
    const hasSnow = vals.some((h) => h > 28);
    const hasBeach = vals.some((h) => h > SEA_LEVEL && h < 2);
    expect(hasSnow).toBe(true);
    expect(hasBeach).toBe(true);
  });
});

describe('terrainSlope / terrainNormal3', () => {
  it('slope is non-negative and finite', () => {
    for (const [x, z] of [[0, 0], [50, -30], [-80, 60], [120, 100]] as const) {
      const s = terrainSlope(x, z);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(s)).toBe(true);
    }
  });

  it('normal is a unit vector pointing upward', () => {
    for (const [x, z] of [[0, 0], [40, 20], [-30, -60]] as const) {
      const n = terrainNormal3(x, z);
      const len = Math.hypot(n.x, n.y, n.z);
      expect(len).toBeCloseTo(1, 4);
      expect(n.y).toBeGreaterThan(0);
    }
  });
});

describe('terrainMask', () => {
  it('produces normalised biome weights', () => {
    for (const h of [0, 4, 12, 20, 30, 40]) {
      const m = terrainMask(10, -20, h);
      expect(m.sand).toBeGreaterThanOrEqual(0);
      expect(m.sand).toBeLessThanOrEqual(1);
      expect(m.grass).toBeGreaterThanOrEqual(0);
      expect(m.rock).toBeGreaterThanOrEqual(0);
      expect(m.snow).toBeGreaterThanOrEqual(0);
      const sum = m.sand + m.grass + m.rock + m.snow;
      expect(sum).toBeCloseTo(1, 4);
    }
  });

  it('is sand at low ground and rock/snow at altitude, not the reverse', () => {
    const low = terrainMask(10, -20, 0);
    expect(low.sand).toBeGreaterThan(0.7);
    const high = terrainMask(10, -20, 35);
    expect(high.sand).toBeLessThan(0.1);
    expect(high.rock + high.snow).toBeGreaterThan(0.6);
  });
});

describe('lake', () => {
  it('reports proximity correctly', () => {
    expect(isNearLake(LAKE.x, LAKE.z)).toBe(true);
    expect(isNearLake(LAKE.x + LAKE.radius * 3, LAKE.z + LAKE.radius * 3)).toBe(false);
  });

  it('is a contained basin (dry rim, submerged centre)', () => {
    const centre = terrainHeight(LAKE.x, LAKE.z);
    expect(centre).toBeLessThan(SEA_LEVEL); // filled by the water plane
    let rimMin = Infinity;
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 36) {
      const rh = terrainHeight(LAKE.x + Math.cos(a) * LAKE.radius, LAKE.z + Math.sin(a) * LAKE.radius);
      rimMin = Math.min(rimMin, rh);
    }
    expect(rimMin).toBeGreaterThan(SEA_LEVEL); // shoreline stays dry all round
  });
});

describe('spawn / camp', () => {
  it('finds a dry, flat, on-island spawn point (deterministic)', () => {
    const a = findSpawnPoint();
    const b = findSpawnPoint();
    expect(a).toEqual(b);
    const half = TERRAIN_SIZE / 2;
    expect(Math.abs(a.x)).toBeLessThan(half);
    expect(Math.abs(a.z)).toBeLessThan(half);
    expect(a.y).toBeGreaterThan(SEA_LEVEL);
    expect(terrainSlope(a.x, a.z)).toBeLessThan(0.35);
    expect(isNearLake(a.x, a.z, 8)).toBe(false);
  });

  it('finds a dry camp point near spawn, clear of the lake', () => {
    const spawn = findSpawnPoint();
    const camp = findCampPoint(spawn);
    expect(camp.y).toBeGreaterThan(SEA_LEVEL);
    expect(terrainSlope(camp.x, camp.z)).toBeLessThan(0.35);
    expect(isNearLake(camp.x, camp.z, 8)).toBe(false);
    const dist = Math.hypot(camp.x - spawn.x, camp.z - spawn.z);
    expect(dist).toBeLessThan(90);
  });
});

describe('buildTerrainGrid', () => {
  it('produces consistent, well-formed geometry', () => {
    const g = buildTerrainGrid(96); // small grid for fast tests
    const s = g.samples;
    const count = s * s;
    expect(g.positions.length).toBe(count * 3);
    expect(g.normals.length).toBe(count * 3);
    expect(g.colors.length).toBe(count * 4);
    expect(g.indices.length).toBe((s - 1) * (s - 1) * 6);

    const vertexCount = count;
    for (let i = 0; i < g.indices.length; i++) {
      expect(g.indices[i]).toBeLessThan(vertexCount);
    }

    // Normals are unit length.
    for (let i = 0; i < count; i += 137) {
      const len = Math.hypot(g.normals[i * 3], g.normals[i * 3 + 1], g.normals[i * 3 + 2]);
      expect(len).toBeCloseTo(1, 3);
    }

    // Heights match the analytic height field at the same position.
    for (let i = 0; i < count; i += 501) {
      const x = g.positions[i * 3];
      const z = g.positions[i * 3 + 2];
      expect(g.positions[i * 3 + 1]).toBeCloseTo(terrainHeight(x, z), 4);
    }
  });

  it('is deterministic', () => {
    const a = buildTerrainGrid(64);
    const b = buildTerrainGrid(64);
    expect(a.samples).toBe(b.samples);
    expect(a.positions).toEqual(b.positions);
    expect(a.colors).toEqual(b.colors);
    expect(a.indices).toEqual(b.indices);
  });
});
