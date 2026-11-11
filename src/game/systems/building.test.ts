import { describe, expect, it } from 'vitest';
import {
  BUILDING_SIZE,
  buildingPlacementHeight,
  validatePlacement,
  type BuildingData,
} from './building';

const flatGround = (_x: number, _z: number) => 2.0;
const SEA = 0;

function building(over: Partial<BuildingData> = {}): BuildingData {
  return {
    id: 'b_test_1',
    kind: 'campfire',
    x: 0,
    z: 0,
    y: 2.0,
    rot: 0,
    ownerId: 'test',
    ...over,
  };
}

describe('bed placement validation', () => {
  it('accepts a bed on valid ground', () => {
    const err = validatePlacement(
      'bed', 5, 5, 2.0, [], { x: 8, z: 8 }, flatGround, SEA,
    );
    expect(err).toBeNull();
  });

  describe('terrain-aware wall and floor placement', () => {
    const slopedGround = (x: number, z: number) => 2 + x * 0.35 + z * 0.12;

    it('raises floors above the highest sampled point in their footprint', () => {
      const y = buildingPlacementHeight('floor', 10, 4, 0, slopedGround);
      expect(y).toBeGreaterThan(slopedGround(10.92, 4.92));
      expect(y).toBeCloseTo(slopedGround(10.92, 4.92) + 0.08, 6);
    });

    it('supports walls along their rotated footprint rather than only at the centre', () => {
      const y = buildingPlacementHeight('wall', 10, 4, 1, slopedGround);
      expect(y).toBeGreaterThan(slopedGround(10 + 0.12, 4 + 1.08));
      expect(y).toBeCloseTo(slopedGround(10 + 0.12, 4 + 1.08) + 0.08, 6);
    });

    it('validates a raised floor against its centre ground instead of its raised base', () => {
      const centerY = slopedGround(10, 4);
      const baseY = buildingPlacementHeight('floor', 10, 4, 0, slopedGround);
      expect(baseY - centerY).toBeGreaterThan(0.5);
      expect(validatePlacement('floor', 10, 4, centerY, [], { x: 0, z: 0 }, slopedGround, SEA))
        .toBeNull();
    });

    it('keeps campfires and other small structures at the centre ground height', () => {
      expect(buildingPlacementHeight('campfire', 10, 4, 0, slopedGround))
        .toBe(slopedGround(10, 4));
    });
  });

  it('rejects a bed underwater', () => {
    const err = validatePlacement(
      'bed', 5, 5, -2.0, [], { x: 8, z: 8 }, (_x, _z) => -2.0, SEA,
    );
    expect(err).toBe('cannot build underwater');
  });

  it('rejects a bed where another bed occupies the same spot', () => {
    const existing = [building({ id: 'b_other', kind: 'bed', x: 5, z: 5 })];
    const err = validatePlacement(
      'bed', 5, 5, 2.0, existing, { x: 8, z: 8 }, flatGround, SEA,
    );
    expect(err).toBe('a building already occupies this spot');
  });

  it('allows a bed in a cell shared by a different building kind (current cell rules)', () => {
    // The placement rules only block same-kind overlaps (and floor/roof
    // combos), so a bed may share a cell with a wall — beds lean on walls.
    const existing = [building({ id: 'b_other', kind: 'wall', x: 5, z: 5 })];
    const err = validatePlacement(
      'bed', 5, 5, 2.0, existing, { x: 8, z: 8 }, flatGround, SEA,
    );
    expect(err).toBeNull();
  });

  it('rejects a bed placed too far off the ground (floating)', () => {
    const err = validatePlacement(
      'bed', 5, 5, 10.0, [], { x: 8, z: 8 }, flatGround, SEA,
    );
    expect(err).toBe('not on a valid platform');
  });

  it('has a registered building size', () => {
    expect(BUILDING_SIZE.bed).toBeGreaterThan(0);
  });
});
