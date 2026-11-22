import { describe, expect, it } from 'vitest';
import { ITEMS, YIELDS } from '../core/items';
import { Inventory, INVENTORY_SIZE } from './inventory';
import { harvestToast, resolveHarvest } from './harvest';

/** Deterministic PRNG (mulberry32) so yield rolls are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A bag with zero capacity for anything: INVENTORY_SIZE full stacks of a
 * single item. Nothing new fits, not even one unit.
 */
function fullBag(id = 'stone'): Inventory {
  const inv = new Inventory();
  const cap = ITEMS[id].stack;
  for (let i = 0; i < INVENTORY_SIZE; i++) inv.add(id, cap);
  return inv;
}

describe('resolveHarvest — yield roll', () => {
  it('rolls inside the YIELDS range and stores everything it rolled', () => {
    const inv = new Inventory();
    for (let i = 0; i < 200; i++) {
      const out = resolveHarvest({ kind: 'tree', inventory: inv, toolId: null, rng: mulberry32(i) });
      const y = YIELDS.tree;
      expect(out.status).toBe('gathered');
      expect(out.rolled).toBeGreaterThanOrEqual(y.min);
      expect(out.rolled).toBeLessThanOrEqual(y.max);
      expect(out.granted).toBe(out.rolled);
      expect(out.lost).toBe(0);
      expect(inv.count('wood')).toBeGreaterThanOrEqual(out.rolled);
    }
  });

  it('is reproducible for the same rng seed', () => {
    const a = new Inventory();
    const b = new Inventory();
    const one = resolveHarvest({ kind: 'rock', inventory: a, toolId: null, rng: mulberry32(7) });
    const two = resolveHarvest({ kind: 'rock', inventory: b, toolId: null, rng: mulberry32(7) });
    expect(one.rolled).toBe(two.rolled);
    expect(a.serialize()).toEqual(b.serialize());
  });

  it('adds the +1 tool bonus only for the effective tool', () => {
    // rng() = 0 pins the roll to YIELDS.min + bonus, so the bonus is exact.
    const zero = () => 0;
    const bare = new Inventory();
    const axe = new Inventory();
    const wrong = new Inventory();

    const bareOut = resolveHarvest({ kind: 'tree', inventory: bare, toolId: null, rng: zero });
    const axeOut = resolveHarvest({ kind: 'tree', inventory: axe, toolId: 'stone_axe', rng: zero });
    const pickOnTree = resolveHarvest({ kind: 'tree', inventory: wrong, toolId: 'stone_pick', rng: zero });

    expect(bareOut.rolled).toBe(YIELDS.tree.min);
    expect(bareOut.bonus).toBe(0);
    expect(axeOut.rolled).toBe(YIELDS.tree.min + 1);
    expect(axeOut.bonus).toBe(1);
    expect(axeOut.usedTool).toBe(true);
    expect(pickOnTree.bonus).toBe(0);
  });

  it('never gives a bush bonus (bushes are picked by hand)', () => {
    const inv = new Inventory();
    const out = resolveHarvest({ kind: 'bush', inventory: inv, toolId: 'stone_axe', rng: () => 0 });
    expect(out.bonus).toBe(0);
    expect(out.itemId).toBe('berry');
  });

  it('reports an unknown node kind without touching the bag', () => {
    const inv = new Inventory();
    const out = resolveHarvest({ kind: 'flower', inventory: inv, toolId: null, rng: () => 0 });
    expect(out.status).toBe('unknown');
    expect(out.itemId).toBeNull();
    expect(inv.count('wood')).toBe(0);
  });
});

describe('resolveHarvest — bag capacity (the silent item loss bug)', () => {
  it('blocks the harvest when nothing fits, instead of destroying items', () => {
    const inv = fullBag('stone');
    const before = inv.serialize();
    const out = resolveHarvest({ kind: 'rock', inventory: inv, toolId: 'stone_pick', rng: () => 0.5 });
    expect(out.status).toBe('blocked');
    expect(out.granted).toBe(0);
    expect(out.xp).toBe(0);
    // Nothing was added: the caller must NOT damage the node or pay XP.
    expect(inv.serialize()).toEqual(before);
  });

  it('blocks a wood harvest in a bag that is full of other items', () => {
    const inv = fullBag('stone');
    const out = resolveHarvest({ kind: 'tree', inventory: inv, toolId: null, rng: () => 0 });
    expect(out.status).toBe('blocked');
    expect(out.itemId).toBe('wood');
    expect(inv.count('wood')).toBe(0);
  });

  it('grants what fits, reports the shortfall and pays scaled XP', () => {
    // 23 full stone stacks + one partial wood stack of 58 (room for 2).
    const inv = new Inventory();
    for (let i = 0; i < INVENTORY_SIZE - 1; i++) inv.add('stone', ITEMS.stone.stack);
    inv.add('wood', 58);

    const out = resolveHarvest({ kind: 'tree', inventory: inv, toolId: 'stone_axe', rng: () => 0.999 });
    expect(out.status).toBe('gathered');
    expect(out.rolled).toBe(YIELDS.tree.max + 1); // 3 + tool bonus
    expect(out.granted).toBe(2);
    expect(out.lost).toBe(out.rolled - 2);
    expect(inv.count('wood')).toBe(60);
    // Full gather XP is 6; two of four units may not pay more than half of it.
    expect(out.xp).toBeGreaterThan(0);
    expect(out.xp).toBeLessThan(6);
  });

  it('pays full XP when the whole yield fits', () => {
    const inv = new Inventory();
    const out = resolveHarvest({ kind: 'tree', inventory: inv, toolId: null, rng: () => 0 });
    expect(out.lost).toBe(0);
    expect(out.xp).toBe(6); // XP_SOURCE.gather.tree
    expect(resolveHarvest({ kind: 'rock', inventory: inv, toolId: null, rng: () => 0 }).xp).toBe(5);
    expect(resolveHarvest({ kind: 'bush', inventory: inv, toolId: null, rng: () => 0 }).xp).toBe(3);
  });

  it('repeats until the bag is really full and then blocks (no invisible drain)', () => {
    const inv = new Inventory();
    // 23 slots are locked by full stone stacks: wood has exactly ONE slot
    // left, so capacity for wood is exactly its stack cap (60).
    for (let i = 0; i < INVENTORY_SIZE - 1; i++) inv.add('stone', ITEMS.stone.stack);
    let harvests = 0;
    let lastStatus: string = 'gathered';
    for (let i = 0; i < 300 && lastStatus !== 'blocked'; i++) {
      const out = resolveHarvest({ kind: 'tree', inventory: inv, toolId: null, rng: mulberry32(i + 1) });
      lastStatus = out.status;
      if (out.status === 'gathered') {
        harvests++;
        // Every rolled unit is accounted for: granted + lost.
        expect(out.granted + out.lost).toBe(out.rolled);
      }
    }
    expect(lastStatus).toBe('blocked');
    expect(inv.count('wood')).toBe(ITEMS.wood.stack);
    expect(harvests).toBeGreaterThan(0);
    // Total units in the bag are exactly stone + granted wood: the last
    // (blocked) swing added nothing and nothing ever vanished.
    let total = 0;
    for (const s of inv.slots) if (s) total += s.count;
    expect(total).toBe(ITEMS.stone.stack * (INVENTORY_SIZE - 1) + ITEMS.wood.stack);
  });
});

describe('harvestToast', () => {
  it('names the item and only mentions the shortfall when there is one', () => {
    const inv = new Inventory();
    const ok = resolveHarvest({ kind: 'tree', inventory: inv, toolId: null, rng: () => 0 });
    expect(harvestToast(ok)).toBe(`+${YIELDS.tree.min} Wood`);

    const tight = new Inventory();
    for (let i = 0; i < INVENTORY_SIZE - 1; i++) tight.add('stone', ITEMS.stone.stack);
    tight.add('wood', 59);
    const partial = resolveHarvest({ kind: 'tree', inventory: tight, toolId: null, rng: () => 0.999 });
    expect(partial.lost).toBeGreaterThan(0);
    expect(harvestToast(partial)).toContain('rugzak vol');

    const blocked = resolveHarvest({ kind: 'tree', inventory: fullBag(), toolId: null, rng: () => 0 });
    expect(harvestToast(blocked)).toBeNull();
  });
});
