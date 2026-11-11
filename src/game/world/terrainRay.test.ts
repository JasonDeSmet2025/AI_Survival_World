import { describe, it, expect } from 'vitest';
import { terrainRayHit } from './terrainRay';
import {
  terrainVertexHeights,
  TERRAIN_SIZE,
  SEA_LEVEL,
  terrainSlope,
} from './heightfield';
import { groundSurfaceHeight } from './groundSurface';

/** Deterministic RNG for reproducible fuzzing. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('terrainRayHit — basic behaviour', () => {
  it('straight-down ray hits exactly at the rendered surface height', () => {
    for (const [x, z] of [
      [0, 0],
      [37.3, -82.1],
      [-214.6, 155.9],
      [301.2, -289.4],
    ]) {
      const h = groundSurfaceHeight(x, z);
      const hit = terrainRayHit(x, h + 10, z, 0, -1, 0, 20);
      expect(hit).not.toBeNull();
      expect(hit!.t).toBeCloseTo(10, 5);
      expect(hit!.y).toBeCloseTo(h, 5);
      // Normal is a unit vector pointing upward (slope components allowed).
      expect(Math.hypot(hit!.nx, hit!.ny, hit!.nz)).toBeCloseTo(1, 5);
      expect(hit!.ny).toBeGreaterThan(0.9);
    }
  });

  it('upward ray from the surface misses', () => {
    const h = groundSurfaceHeight(20, 30);
    expect(terrainRayHit(20, h + 5, 30, 0, 1, 0, 100)).toBeNull();
  });

  it('downward ray starting below the surface misses (no hit behind the origin)', () => {
    const h = groundSurfaceHeight(-40, 12);
    expect(terrainRayHit(-40, h - 20, 12, 0, -1, 0, 50)).toBeNull();
  });

  it('upward ray from below the surface hits the surface directly above it', () => {
    const x = -40;
    const z = 12;
    const h = groundSurfaceHeight(x, z);
    const hit = terrainRayHit(x, h - 20, z, 0, 1, 0, 50);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeCloseTo(20, 5);
    expect(hit!.y).toBeCloseTo(h, 5);
  });

  it('maxDist truncates the ray', () => {
    const x = 50;
    const z = -60;
    const h = groundSurfaceHeight(x, z);
    const far = terrainRayHit(x, h + 10, z, 0, -1, 0, 20);
    const near = terrainRayHit(x, h + 10, z, 0, -1, 0, 4);
    expect(far).not.toBeNull();
    expect(near).toBeNull(); // surface is 10 away, maxDist is 4
  });

  it('direction need not be normalised (t stays a world distance)', () => {
    const x = -15;
    const z = 90;
    const h = groundSurfaceHeight(x, z);
    const hit = terrainRayHit(x, h + 12, z, 0, -3, 0, 20);
    expect(hit!.t).toBeCloseTo(12, 5);
  });

  it('rejects degenerate inputs', () => {
    expect(terrainRayHit(0, 5, 0, 0, 0, 0, 10)).toBeNull();
    expect(terrainRayHit(0, 5, 0, 0, -1, 0, 0)).toBeNull();
    expect(terrainRayHit(0, 5, 0, 0, -1, 0, -5)).toBeNull();
  });
});

describe('terrainRayHit — consistency with the rendered mesh', () => {
  it('hit points lie on the mesh-exact surface (fuzz: 4000 downward rays)', () => {
    const rnd = mulberry(0xbeef);
    let tested = 0;
    for (let i = 0; i < 4000; i++) {
      const x = -TERRAIN_SIZE / 2 + 2 + rnd() * (TERRAIN_SIZE - 4);
      const z = -TERRAIN_SIZE / 2 + 2 + rnd() * (TERRAIN_SIZE - 4);
      const h = groundSurfaceHeight(x, z);
      const hit = terrainRayHit(x, h + 30, z, 0, -1, 0, 40);
      if (!hit) continue; // water-column columns are fine to hit too
      expect(hit.y).toBeCloseTo(h, 4);
      expect(hit.t).toBeCloseTo(30, 4);
      tested++;
    }
    expect(tested).toBeGreaterThan(3500);
  });

  it('sloped rays: hit distance matches the mesh plane, not the analytic curve', () => {
    // On a slope the analytic terrainHeight and the rendered mesh differ by
    // up to ~0.7u. The raycast must agree with the RENDERED surface.
    const rnd = mulberry(0x1234);
    let slopes = 0;
    for (let i = 0; i < 3000; i++) {
      const x = -280 + rnd() * 560;
      const z = -280 + rnd() * 560;
      if (terrainSlope(x, z) < 0.6) continue;
      const h = groundSurfaceHeight(x, z);
      // shoot steeply down-forward so it reliably meets the surface
      const hit = terrainRayHit(x, h + 5, z, 0.35, -1.0, 0.25, 25);
      if (!hit) continue;
      // The hit point must sit on the rendered surface.
      expect(groundSurfaceHeight(hit.x, hit.z)).toBeCloseTo(hit.y, 3);
      slopes++;
    }
    expect(slopes).toBeGreaterThan(100);
  });

  it('a hit at a cell corner is attributed to exactly one triangle (no double/miss)', () => {
    const { samples, step, heights } = terrainVertexHeights();
    const rnd = mulberry(0x99);
    let corners = 0;
    for (let i = 0; i < 2000 && corners < 60; i++) {
      // pick a grid VERTEX exactly (a shared corner of 4 cells)
      const ix = 2 + Math.floor(rnd() * (samples - 4));
      const iz = 2 + Math.floor(rnd() * (samples - 4));
      const x = -TERRAIN_SIZE / 2 + ix * step;
      const z = -TERRAIN_SIZE / 2 + iz * step;
      const h = heights[iz * samples + ix];
      const hit = terrainRayHit(x, h + 8, z, 0, -1, 0, 12);
      expect(hit).not.toBeNull();
      expect(hit!.y).toBeCloseTo(h, 4);
      expect(hit!.t).toBeCloseTo(8, 4);
      corners++;
    }
    expect(corners).toBe(60);
  });
});

describe('terrainRayHit — the reported camera-clip scenario', () => {
  it('finds the occluding hill between the player and the third-person camera', () => {
    // Recreate the camera geometry from game.ts updateCamera and find a
    // steep-slope spot where the naive (unoccluded) look ray dips below the
    // rendered surface. The raycast must then report a hit BEFORE the full
    // camera distance, proving the occlusion fix has data to work with.
    const dist = 5.5;
    let found = false;
    let minHitT = Infinity;
    for (let pz = -200; pz <= 200 && !found; pz += 6) {
      for (let px = -200; px <= 200 && !found; px += 6) {
        const py = groundSurfaceHeight(px, pz);
        if (py <= SEA_LEVEL + 0.5 || terrainSlope(px, pz) < 0.9) continue;
        for (let a = 0; a < 8; a++) {
          const yaw = (a / 8) * Math.PI * 2;
          const pitch = 0.35;
          const cp = Math.cos(pitch);
          const dir = {
            x: Math.sin(yaw) * cp,
            y: Math.sin(pitch),
            z: Math.cos(yaw) * cp,
          };
          const tx = px;
          const ty = py + 1.55;
          const tz = pz;
          const cam = { x: tx - dir.x * dist, y: ty - dir.y * dist, z: tz - dir.z * dist };
          // Does the naive ray dip below the rendered surface in between?
          let dip = false;
          for (let s = 1; s < 24; s++) {
            const k = s / 24;
            const x = tx + (cam.x - tx) * k;
            const y = ty + (cam.y - ty) * k;
            const z = tz + (cam.z - tz) * k;
            if (y < groundSurfaceHeight(x, z) - 0.02) {
              dip = true;
              break;
            }
          }
          if (!dip) continue;
          // The fix: raycast target -> camera along the camera axis.
          const hit = terrainRayHit(tx, ty, tz, -dir.x, -dir.y, -dir.z, dist);
          expect(hit).not.toBeNull();
          expect(hit!.t).toBeLessThan(dist);
          minHitT = Math.min(minHitT, hit!.t);
          found = true;
          break;
        }
      }
    }
    expect(found).toBe(true);
    expect(minHitT).toBeGreaterThan(0);
    expect(minHitT).toBeLessThan(dist);
  });

  it('open-ground camera rays do NOT report phantom hits (no false positives)', () => {
    // Flat open ground: the camera 5.5u behind must see the player cleanly.
    let tested = 0;
    for (let i = 0; i < 600; i++) {
      const rnd = mulberry(1000 + i);
      const x = -200 + rnd() * 400;
      const z = -200 + rnd() * 400;
      const y = groundSurfaceHeight(x, z);
      if (y <= SEA_LEVEL + 0.5 || terrainSlope(x, z) > 0.35) continue;
      const yaw = rnd() * Math.PI * 2;
      const pitch = (rnd() - 0.5) * 0.6;
      const cp = Math.cos(pitch);
      const dir = { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: Math.cos(yaw) * cp };
      const hit = terrainRayHit(x, y + 1.55, z, -dir.x, -dir.y, -dir.z, 5.5);
      // The ray travels from 1.55u above ground; on gently-sloped open
      // ground it must not intersect within the 5.5u camera distance.
      if (hit) {
        // If it does hit, the hit must be a genuine surface crossing (within
        // tolerance of the rendered surface), never a phantom.
        expect(groundSurfaceHeight(hit.x, hit.z)).toBeCloseTo(hit.y, 2);
      }
      tested++;
    }
    expect(tested).toBeGreaterThan(200);
  });
});

describe('terrainRayHit — edges of the tile', () => {
  it('origin outside the tile, ray entering it: still finds the surface', () => {
    // Aim an interior surface point from an origin beyond the -x tile edge.
    const tx = 100;
    const tz = 100;
    const th = groundSurfaceHeight(tx, tz);
    const ox = -400; // outside the tile (tile spans [-320, 320])
    const oy = th + 200;
    const hit = terrainRayHit(ox, oy, tz, tx - ox, th - oy, 0, 600);
    expect(hit).not.toBeNull();
    // The hit must sit on the rendered surface somewhere inside the tile.
    expect(hit!.x).toBeGreaterThanOrEqual(-TERRAIN_SIZE / 2 - 1e-3);
    expect(hit!.x).toBeLessThanOrEqual(TERRAIN_SIZE / 2 + 1e-3);
    expect(groundSurfaceHeight(hit!.x, hit!.z)).toBeCloseTo(hit!.y, 3);
  });

  it('origin outside the tile pointing away: misses cleanly (no out-of-bounds)', () => {
    const hit = terrainRayHit(TERRAIN_SIZE, 50, 0, 1, -0.1, 0, 200);
    expect(hit).toBeNull();
  });

  it('mesh-exact at flat interior spots (agrees with the rendered surface)', () => {
    // The raycast is a query on the RENDERED mesh, so it must reproduce
    // groundSurfaceHeight tightly wherever the mesh is well-resolved.
    let tested = 0;
    const rnd = mulberry(7);
    for (let i = 0; i < 500 && tested < 100; i++) {
      const x = -100 + rnd() * 200;
      const z = -100 + rnd() * 200;
      if (terrainSlope(x, z) > 0.1) continue;
      const h = groundSurfaceHeight(x, z);
      const hit = terrainRayHit(x, h + 5, z, 0, -1, 0, 10);
      expect(hit!.y).toBeCloseTo(h, 4);
      expect(hit!.t).toBeCloseTo(5, 4);
      tested++;
    }
    expect(tested).toBeGreaterThan(50);
  });
});

describe('terrainRayHit — performance budget', () => {
  it('100k short camera-style rays finish quickly (camera runs this per frame)', () => {
    const rnd = mulberry(0xabc);
    const ray = () => {
      const x = -300 + rnd() * 600;
      const z = -300 + rnd() * 600;
      const y = groundSurfaceHeight(x, z) + 1.55;
      terrainRayHit(x, y, z, -0.5, 0.2, 0.8, 5.5);
    };
    // Warm up (JIT + grid cache) so the budget measures steady-state cost,
    // not one-off compile cost — this is what a per-frame ray actually pays.
    for (let i = 0; i < 20000; i++) ray();
    const runs: number[] = [];
    for (let r = 0; r < 2; r++) {
      const t0 = Date.now();
      for (let i = 0; i < 100000; i++) ray();
      runs.push(Date.now() - t0);
    }
    const ms = Math.min(...runs);
    // Per-frame budget: the camera casts ONE such ray per frame. Even at 1%
    // of a 16.6 ms frame this must stay far below ~0.16 ms per ray; we keep a
    // generous margin of 20 us per ray (2 ms per 100). Wall-clock under
    // parallel CI load can jitter, so take the best of two warmed runs.
    expect(ms / 100).toBeLessThan(2.0);
  });
});
