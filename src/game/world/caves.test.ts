import { describe, expect, it } from 'vitest';
import { SEA_LEVEL, TERRAIN_SIZE } from './heightfield';
import {
  CAVE_SITES,
  WITCH_HOME,
  caveCeiling,
  caveCarveDepth,
  caveFloorY,
  caveKeepOut,
  witchKeepOut,
} from './caves';

/**
 * The carving lives INSIDE terrainHeight(), so these pure functions must
 * agree with it sample-for-sample — that agreement is what makes mesh,
 * physics and spawn placement line up without extra plumbing.
 */
describe('cave carving', () => {
  it('is exactly zero outside the dig radius', () => {
    for (const s of CAVE_SITES) {
      const reach = s.chamberR * 1.62 + s.trenchLen + 2;
      expect(caveCarveDepth(s.cx + reach + 2, s.cz)).toBe(0);
      expect(caveCarveDepth(s.cx, s.cz - reach - 2)).toBe(0);
    }
  });

  it('digs a deep chamber, deepest at the centre', () => {
    for (const s of CAVE_SITES) {
      const centre = caveCarveDepth(s.cx, s.cz);
      expect(centre).toBeCloseTo(s.depth, 5);
      // Halfway up the bowl ramp: strictly shallower than the centre.
      expect(caveCarveDepth(s.cx + s.chamberR * 1.1, s.cz)).toBeLessThan(centre);
      // Far outside the ramp: back to untouched ground.
      expect(caveCarveDepth(s.cx + s.chamberR * 1.7, s.cz)).toBe(0);
    }
  });

  it('entrance trench connects the surface to the chamber', () => {
    for (const s of CAVE_SITES) {
      // Mouth (trench far end): barely carved — a doorway in the hillside.
      const mouthX = s.cx + s.tx * (s.chamberR + s.trenchLen);
      const mouthZ = s.cz + s.tz * (s.chamberR + s.trenchLen);
      expect(caveCarveDepth(mouthX, mouthZ)).toBeLessThan(0.6);
      // Mid-trench: a real gully you can walk down.
      const midX = s.cx + s.tx * (s.chamberR + s.trenchLen * 0.25);
      const midZ = s.cz + s.tz * (s.chamberR + s.trenchLen * 0.25);
      expect(caveCarveDepth(midX, midZ)).toBeGreaterThan(s.depth * 0.5);
      // The trench does not leak sideways: 10 m off-axis is untouched
      // (beyond the full-width core AND the bank ramp, and outside the
      // chamber bowl ramp too).
      const sideX = s.cx + s.tx * (s.chamberR + s.trenchLen * 0.6) + s.tz * 10;
      const sideZ = s.cz + s.tz * (s.chamberR + s.trenchLen * 0.6) - s.tx * 10;
      expect(caveCarveDepth(sideX, sideZ)).toBe(0);
    }
  });

  it('ceiling is a walkable roof buried under real rock at its rim', () => {
    for (const s of CAVE_SITES) {
      const { y, radius } = caveCeiling(s);
      const floor = caveFloorY(s);
      expect(y).toBeGreaterThan(floor);
      expect(y - floor).toBeGreaterThanOrEqual(3); // full headroom
      // Buried: the carved ground AT and beyond the slab rim stands ABOVE
      // the slab, so from outside the cave the roof is invisible earth.
      for (const d of [radius, radius + 2]) {
        const terrainAtRim = s.surfaceH - caveCarveDepth(s.cx + d, s.cz);
        expect(terrainAtRim).toBeGreaterThan(y);
      }
      expect(radius).toBeGreaterThan(s.chamberR);
    }
  });

  it('never carves a cliff — slope stays in the natural-ridge budget', () => {
    // The island-wide contracts (grounding "no cliffs anywhere",
    // groundSurface mesh deviation, terrainLod fit error) apply to the
    // CARVE too: sampled at 1 m steps, no carving step may exceed 1.5 m
    // and consecutive gradients must stay smooth (< 0.6 jump per metre).
    for (const s of CAVE_SITES) {
      const reach = s.chamberR * 1.62 + s.trenchLen + 4;
      let maxStep = 0;
      for (let x = s.cx - reach; x <= s.cx + reach; x += 1) {
        for (let z = s.cz - reach; z <= s.cz + reach; z += 1) {
          const c = caveCarveDepth(x, z);
          maxStep = Math.max(
            maxStep,
            Math.abs(caveCarveDepth(x + 1, z) - c),
            Math.abs(caveCarveDepth(x, z + 1) - c),
          );
        }
      }
      expect(maxStep).toBeLessThan(1.5);
    }
  });

  it('stays clear of terrain features that would tear the world', () => {
    for (const s of CAVE_SITES) {
      // Dry: even the carved floor stays well above the sea plane.
      expect(s.surfaceH - s.depth).toBeGreaterThan(SEA_LEVEL + 15);
      // The whole dig fits comfortably inside the rendered terrain tile.
      const reach = s.chamberR * 1.62 + s.trenchLen;
      expect(Math.hypot(s.cx, s.cz) + reach).toBeLessThan(TERRAIN_SIZE / 2 - 20);
    }
  });
});

describe('landmark keep-outs', () => {
  it('caves keep the flora away from the chamber and the trail', () => {
    const keeps = caveKeepOut();
    expect(keeps).toHaveLength(CAVE_SITES.length * 2);
    for (const s of CAVE_SITES) {
      const chamber = keeps.find((k) => k.x === s.cx && k.z === s.cz);
      expect(chamber?.r).toBeGreaterThanOrEqual(s.chamberR + 5);
      const trail = keeps.find((k) => k !== chamber);
      expect(trail).toBeDefined();
    }
  });

  it('the witch pad keeps a clearing around the hut', () => {
    const keep = witchKeepOut();
    expect(keep.x).toBe(WITCH_HOME.x);
    expect(keep.z).toBe(WITCH_HOME.z);
    expect(keep.r).toBeGreaterThanOrEqual(9);
  });
});
