import { describe, expect, it } from 'vitest';
import { Inventory } from './inventory';
import type { BuildingData } from '../world/types';
import {
  PLANTER_CROP,
  PLANTER_SECONDS,
  PLANTER_TEND_RADIUS,
  PLANTER_YIELD,
  growPlanter,
  growthOf,
  isPlanter,
  isRipe,
  pickPlanter,
  planterFraction,
} from './farm';

/**
 * A planter is the only thing in the world that grows by itself, so the two
 * things worth testing are WHO may grow it and WHAT the pick really hands
 * out. Both are contracts the save game and other players depend on.
 */
function planter(over: Partial<BuildingData> = {}): BuildingData {
  return {
    id: 'b_planter',
    kind: 'planter',
    x: 4,
    z: 5,
    y: 0,
    rot: 0,
    ownerId: 'p1',
    growth: 0,
    ...over,
  };
}

describe('planter growth', () => {
  it('starts empty and not ripe', () => {
    const b = planter();
    expect(growthOf(b)).toBe(0);
    expect(isRipe(b)).toBe(false);
    expect(planterFraction(b)).toBe(0);
  });

  it('treats a missing or corrupt growth value as zero, not as ripe', () => {
    for (const bad of [undefined, null, NaN, -30, 'x'] as unknown[]) {
      const b = planter({ growth: bad as number });
      expect(growthOf(b), String(bad)).toBe(0);
      expect(isRipe(b), String(bad)).toBe(false);
    }
  });

  it('grows for its owner who is standing nearby', () => {
    const b = planter();
    expect(growPlanter(b, 10, 'p1', { x: 4, z: 5 })).toBe(10);
    expect(growPlanter(b, 10, 'p1', { x: 4, z: 5 })).toBe(20);
    expect(growthOf(b)).toBe(20);
  });

  it('never grows for somebody else', () => {
    const b = planter();
    expect(growPlanter(b, 60, 'p2', { x: 4, z: 5 })).toBe(0);
    expect(growthOf(b)).toBe(0);
  });

  it('stops when the owner walks away — an unvisited field does not stock itself', () => {
    const b = planter();
    const far = { x: 4 + PLANTER_TEND_RADIUS + 5, z: 5 };
    expect(growPlanter(b, 60, 'p1', far)).toBe(0);
    // Just inside the radius still counts.
    expect(growPlanter(b, 5, 'p1', { x: 4 + PLANTER_TEND_RADIUS - 0.5, z: 5 })).toBe(5);
  });

  it('never grows past ripe, and a ripe planter stays ripe', () => {
    const b = planter({ growth: PLANTER_SECONDS - 1 });
    expect(growPlanter(b, 999, 'p1', { x: 4, z: 5 })).toBe(PLANTER_SECONDS);
    expect(isRipe(b)).toBe(true);
    expect(growPlanter(b, 999, 'p1', { x: 4, z: 5 })).toBe(PLANTER_SECONDS);
  });

  it('ignores a nonsense tick', () => {
    const b = planter({ growth: 30 });
    for (const dt of [0, -5, NaN]) {
      expect(growPlanter(b, dt, 'p1', { x: 4, z: 5 }), String(dt)).toBe(30);
    }
  });

  it('is not a planter, is not farmed', () => {
    const camp = planter({ kind: 'campfire' });
    expect(isPlanter(camp)).toBe(false);
    expect(growPlanter(camp, 60, 'p1', { x: 4, z: 5 })).toBe(0);
  });

  it('reports progress for the prompt in [0,1]', () => {
    const b = planter({ growth: PLANTER_SECONDS / 2 });
    expect(planterFraction(b)).toBeCloseTo(0.5);
  });
});

describe('picking a planter', () => {
  it('hands out the crop and restarts the growth clock', () => {
    const b = planter({ growth: PLANTER_SECONDS });
    const inv = new Inventory();
    const r = pickPlanter(b, inv);
    expect(r).toMatchObject({ picked: true, gained: PLANTER_YIELD, missed: 0, reason: null });
    expect(inv.count(PLANTER_CROP)).toBe(PLANTER_YIELD);
    expect(growthOf(b)).toBe(0);
    expect(isRipe(b)).toBe(false);
  });

  it('refuses an unripe crop and a non-planter', () => {
    const inv = new Inventory();
    const unripe = planter({ growth: PLANTER_SECONDS - 1 });
    expect(pickPlanter(unripe, inv).reason).toBe('not-ripe');
    expect(pickPlanter(planter({ kind: 'wall' }), inv).reason).toBe('not-a-planter');
    expect(inv.count(PLANTER_CROP)).toBe(0);
    expect(growthOf(unripe)).toBe(PLANTER_SECONDS - 1);
  });

  it('a completely full bag does not harvest anything', () => {
    const b = planter({ growth: PLANTER_SECONDS });
    const inv = new Inventory();
    // Fill every slot to capacity with a foreign item so nothing can be added.
    for (let i = 0; i < inv.slots.length; i++) {
      inv.slots[i] = { id: 'stone', count: Infinity as unknown as number };
    }
    const r = pickPlanter(b, inv);
    expect(r).toMatchObject({ picked: false, gained: 0, reason: 'no-room' });
    // The crop keeps its fruit: a failed pick must not reset the growth.
    expect(growthOf(b)).toBe(PLANTER_SECONDS);
  });

  it('a bag that only partly fits reports the shortfall instead of lying', () => {
    const b = planter({ growth: PLANTER_SECONDS });
    const partial = { add: (_id: string, n: number) => n - 1 }; // takes one berry
    const r = pickPlanter(b, partial);
    expect(r).toEqual({ picked: true, gained: 1, missed: PLANTER_YIELD - 1, reason: null });
    expect(growthOf(b)).toBe(0);
  });
});
