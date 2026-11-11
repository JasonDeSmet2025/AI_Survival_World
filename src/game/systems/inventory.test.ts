import { describe, expect, it } from 'vitest';
import { INVENTORY_SIZE, Inventory, type Slot } from './inventory';

const wood = (count: number): Slot => ({ id: 'wood', count });

describe('Inventory.pickUp', () => {
  it('empties the slot and returns the whole stack', () => {
    const inv = new Inventory();
    inv.add('wood', 60);
    const picked = inv.pickUp(0);
    expect(picked).toEqual({ id: 'wood', count: 60 });
    expect(inv.slots[0]).toBeNull();
    expect(inv.count('wood')).toBe(0);
  });

  it('returns null for an empty slot without side effects', () => {
    const inv = new Inventory();
    inv.add('stone', 2);
    expect(inv.pickUp(5)).toBeNull();
    expect(inv.slots[0]).toEqual({ id: 'stone', count: 2 });
  });

  it('returns null for out-of-range indices', () => {
    const inv = new Inventory();
    inv.add('wood', 3);
    expect(inv.pickUp(-1)).toBeNull();
    expect(inv.pickUp(INVENTORY_SIZE)).toBeNull();
    expect(inv.count('wood')).toBe(3);
  });

  it('preserves tool durability on the picked stack', () => {
    const inv = new Inventory();
    inv.add('stone_axe', 1);
    inv.slots[0]!.durability = 37;
    const picked = inv.pickUp(0);
    expect(picked!.durability).toBe(37);
  });
});

describe('Inventory.place', () => {
  it('places into an empty slot and returns null', () => {
    const inv = new Inventory();
    const left = inv.place(3, wood(5));
    expect(left).toBeNull();
    expect(inv.slots[3]).toEqual({ id: 'wood', count: 5 });
  });

  it('merges into a same-item stack and returns null when it fits', () => {
    const inv = new Inventory();
    inv.add('wood', 40);
    const left = inv.place(0, wood(20));
    expect(left).toBeNull();
    expect(inv.slots[0]).toEqual({ id: 'wood', count: 60 }); // capped at stack 60
  });

  it('returns the overflow when the merge exceeds the stack cap', () => {
    const inv = new Inventory();
    inv.add('wood', 55);
    const left = inv.place(0, wood(20));
    expect(inv.slots[0]).toEqual({ id: 'wood', count: 60 });
    expect(left).toEqual({ id: 'wood', count: 15 });
    expect(inv.count('wood')).toBe(60); // 55 + 20 - 15 leftover
  });

  it('swaps when the target holds a different item', () => {
    const inv = new Inventory();
    inv.add('stone', 4);
    const displaced = inv.place(0, wood(7));
    expect(displaced).toEqual({ id: 'stone', count: 4 });
    expect(inv.slots[0]).toEqual({ id: 'wood', count: 7 });
    expect(inv.count('stone')).toBe(0);
  });

  it('keeps the best-condition unit when merging tools', () => {
    const inv = new Inventory();
    inv.add('stone_axe', 1);
    inv.slots[0]!.durability = 30;
    const fresh: Slot = { id: 'stone_axe', count: 1, durability: 120 };
    const left = inv.place(0, fresh);
    // Stack size is 1, so the second axe cannot merge: it must be returned.
    expect(left).toEqual({ id: 'stone_axe', count: 1, durability: 120 });
    expect(inv.slots[0]).toEqual({ id: 'stone_axe', count: 1, durability: 120 });
  });

  it('preserves durability of a placed stack', () => {
    const inv = new Inventory();
    const worn: Slot = { id: 'stone_pick', count: 1, durability: 12.5 };
    inv.place(4, worn);
    expect(inv.slots[4]).toEqual({ id: 'stone_pick', count: 1, durability: 12.5 });
  });

  it('returns the held stack unchanged for an out-of-range target', () => {
    const inv = new Inventory();
    const held = wood(5);
    const left = inv.place(INVENTORY_SIZE, held);
    expect(left).toEqual({ id: 'wood', count: 5 });
    expect(inv.count('wood')).toBe(0);
  });

  it('does not alias the caller-held slot object', () => {
    const inv = new Inventory();
    const held: Slot = { id: 'wood', count: 5 };
    inv.place(2, held);
    inv.slots[2]!.count = 1; // mutate the inventory copy
    expect(held.count).toBe(5); // original untouched
  });
});

describe('Inventory cursor round-trip (game UI flow)', () => {
  it('pick up then place back restores the original layout', () => {
    const inv = new Inventory();
    inv.add('wood', 10); // slot 0
    inv.add('stone', 4); // slot 1
    const before = inv.slots.map((s) => (s ? { ...s } : null));
    const held = inv.pickUp(1)!;
    const left = inv.place(1, held);
    expect(left).toBeNull();
    expect(inv.slots).toEqual(before);
  });

  it('a stack can be moved from storage to the hotbar via pickUp/place', () => {
    const inv = new Inventory();
    // Fill the hotbar with 8 full, distinct stacks so new items land in storage.
    inv.add('wall', 10);
    inv.add('floor', 10);
    inv.add('roof', 10);
    inv.add('campfire', 5);
    inv.add('stone_axe', 1);
    inv.add('stone_pick', 1);
    inv.add('berry', 20);
    inv.add('stone', 60);
    inv.add('wood', 5); // hotbar full → storage slot 8
    expect(inv.slots[8]).toEqual({ id: 'wood', count: 5 });
    const held = inv.pickUp(8)!;
    const displaced = inv.place(0, held); // slot 0 (hotbar) holds wall x10
    expect(displaced).toEqual({ id: 'wall', count: 10 });
    expect(inv.slots[0]).toEqual({ id: 'wood', count: 5 });
    expect(inv.slots[8]).toBeNull();
    // The displaced wall goes back to storage.
    expect(inv.place(8, displaced!)).toBeNull();
    expect(inv.slots[8]).toEqual({ id: 'wall', count: 10 });
    expect(inv.count('wood')).toBe(5);
    expect(inv.count('wall')).toBe(10);
  });
});

describe('Inventory (existing behaviour regression)', () => {
  it('add tops up existing stacks then opens new ones', () => {
    const inv = new Inventory();
    expect(inv.add('wood', 60)).toBe(0);
    // A full first stack still leaves room for a second stack.
    expect(inv.add('wood', 10)).toBe(0);
    // Topping up continues across stacks until they are all full.
    expect(inv.add('wood', 100)).toBe(0);
    expect(inv.add('stone', 5)).toBe(0);
    expect(inv.count('wood')).toBe(170);
    expect(inv.count('stone')).toBe(5);
    expect(inv.slots[0]).toEqual({ id: 'wood', count: 60 });
    expect(inv.slots[1]).toEqual({ id: 'wood', count: 60 });
    expect(inv.slots[2]).toEqual({ id: 'wood', count: 50 });
    expect(inv.slots[3]).toEqual({ id: 'stone', count: 5 });
    // A truly full inventory reports the unplaced remainder.
    const full = new Inventory();
    for (let i = 0; i < INVENTORY_SIZE; i++) full.slots[i] = { id: 'wood', count: 60 };
    expect(full.add('wood', 1)).toBe(1);
  });

  it('add ignores unknown item ids', () => {
    const inv = new Inventory();
    expect(inv.add('berries', 3)).toBe(3); // 'berries' is not a real item id
    expect(inv.count('berries')).toBe(0);
    expect(inv.slots.every((s) => s === null)).toBe(true);
  });

  it('remove takes from the earliest stacks', () => {
    const inv = new Inventory();
    inv.add('wood', 30);
    inv.add('wood', 30); // tops up slot 0 to the stack cap of 60
    expect(inv.slots[0]).toEqual({ id: 'wood', count: 60 });
    expect(inv.remove('wood', 35)).toBe(35);
    expect(inv.slots[0]).toEqual({ id: 'wood', count: 25 });
    expect(inv.slots[1]).toBeNull();
    // empty the last remainder
    expect(inv.remove('wood', 25)).toBe(25);
    expect(inv.slots[0]).toBeNull();
  });

  it('has checks the total across stacks', () => {
    const inv = new Inventory();
    inv.add('berry', 10);
    inv.add('berry', 10);
    expect(inv.has('berry', 19)).toBe(true);
    expect(inv.has('berry', 21)).toBe(false);
  });

  it('serialize/restore round-trips including tool durability', () => {
    const inv = new Inventory();
    inv.add('wood', 12);
    inv.add('stone_axe', 1);
    inv.slots[1]!.durability = 42;
    const data = inv.serialize();
    const restored = new Inventory();
    restored.restore(data, 2);
    expect(restored.slots[0]).toEqual({ id: 'wood', count: 12 });
    expect(restored.slots[1]).toEqual({ id: 'stone_axe', count: 1, durability: 42 });
    expect(restored.selected).toBe(2);
  });

  it('restore treats legacy 2-tuple tools as full and drops worn-out ones', () => {
    const inv = new Inventory();
    inv.restore([
      ['stone_pick', 1], // legacy: no durability
      ['stone_axe', 1, 0], // fully worn out
      ['wood', 10],
    ]);
    expect(inv.slots[0]).toEqual({ id: 'stone_pick', count: 1, durability: 120 });
    expect(inv.slots[1]).toBeNull();
    expect(inv.slots[2]).toEqual({ id: 'wood', count: 10 });
  });

  it('applyDeathPenalty keeps 80% rounded up and durability', () => {
    const inv = new Inventory();
    inv.add('wood', 10);
    inv.add('stone_axe', 1);
    inv.slots[1]!.durability = 77;
    inv.applyDeathPenalty();
    expect(inv.slots[0]).toEqual({ id: 'wood', count: 8 });
    expect(inv.slots[1]).toEqual({ id: 'stone_axe', count: 1, durability: 77 });
  });

  it('moveToHotbar merges same items and swaps otherwise', () => {
    const inv = new Inventory();
    // merge case: hotbar berry stack has room, storage stack folds in
    inv.slots[0] = { id: 'berry', count: 15 };
    inv.slots[8] = { id: 'berry', count: 2 };
    expect(inv.moveToHotbar(8, 0)).toBe(true);
    expect(inv.slots[0]).toEqual({ id: 'berry', count: 17 });
    expect(inv.slots[8]).toBeNull();
    // swap case: different items just exchange slots
    const inv2 = new Inventory();
    inv2.slots[0] = { id: 'wood', count: 5 };
    inv2.slots[3] = { id: 'stone', count: 9 };
    expect(inv2.moveToHotbar(3, 0)).toBe(true);
    expect(inv2.slots[0]).toEqual({ id: 'stone', count: 9 });
    expect(inv2.slots[3]).toEqual({ id: 'wood', count: 5 });
    // invalid hotbar index: nothing moves
    expect(inv2.moveToHotbar(0, 99)).toBe(false);
    // empty source: nothing moves
    expect(inv2.moveToHotbar(5, 0)).toBe(false);
    expect(inv2.slots[0]).toEqual({ id: 'stone', count: 9 });
  });
});
