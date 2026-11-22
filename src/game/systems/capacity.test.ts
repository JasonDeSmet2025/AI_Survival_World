import { describe, expect, it } from 'vitest';
import { ITEMS, RECIPES } from '../core/items';
import { INVENTORY_SIZE, Inventory } from './inventory';
import { CraftSession, Crafting } from './crafting';
import { CookSession, cookHasRoom } from './cook';
import { resolveHarvest } from './harvest';

/**
 * Every way the survival loop hands out items — gathering, crafting and
 * cooking — used to ignore `Inventory.add()`'s return value (the units that
 * did NOT fit). The result: in a full bag, resources, crafted goods and
 * cooked food were destroyed while the game still reported success, paid XP
 * and damaged the node. These tests pin the capacity contract across ALL
 * three gain paths, so the fix cannot regress in just one of them.
 */

/** Filler item with a small stack: cheap way to pack the bag. */
const FILLER = 'wall';

/** INVENTORY_SIZE full stacks of `id`: zero capacity for anything else. */
function packedBag(id = FILLER): Inventory {
  const inv = new Inventory();
  for (let i = 0; i < INVENTORY_SIZE; i++) inv.add(id, ITEMS[id].stack);
  return inv;
}

const totalUnits = (inv: Inventory): number =>
  inv.slots.reduce((sum, s) => sum + (s ? s.count : 0), 0);

/** Does the bag hold the materials (ignoring output room)? */
function hasMaterials(inv: Inventory, recipeId: string): boolean {
  const r = RECIPES.find((x) => x.id === recipeId)!;
  return r.inputs.every((i) => inv.has(i.id, i.count));
}

describe('Inventory.roomFor / canAdd (capacity projection)', () => {
  it('reports the free capacity of an empty bag', () => {
    const inv = new Inventory();
    expect(inv.roomFor('wood')).toBe(INVENTORY_SIZE * ITEMS.wood.stack);
    expect(inv.canAdd('wood', 1)).toBe(true);
  });

  it('counts matching stacks AND empty slots', () => {
    const inv = new Inventory();
    inv.add('wood', 45); // one wood stack → 15 units of room inside it
    expect(inv.roomFor('wood')).toBe(15 + (INVENTORY_SIZE - 1) * ITEMS.wood.stack);
    inv.add('stone', ITEMS.stone.stack);
    expect(inv.roomFor('wood')).toBe(15 + (INVENTORY_SIZE - 2) * ITEMS.wood.stack);
  });

  it('shrinks to zero as the bag fills', () => {
    const inv = new Inventory();
    let previous = inv.roomFor('berry');
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      inv.add('berry', ITEMS.berry.stack);
      const now = inv.roomFor('berry');
      expect(now, `after slot ${i}`).toBeLessThan(previous);
      previous = now;
    }
    expect(previous).toBe(0);
    expect(inv.canAdd('berry', 1)).toBe(false);
  });

  it('is a PROJECTION: it never mutates the inventory', () => {
    const inv = packedBag();
    const before = inv.serialize();
    inv.roomFor('wood');
    inv.canAdd('wood', 999);
    inv.roomFor('wood', [{ id: FILLER, count: 5 }]);
    expect(inv.serialize()).toEqual(before);
    // ...and a real add reports the very same zero capacity.
    expect(inv.add('wood', 5)).toBe(5);
  });

  it('treats unknown items as unstashable', () => {
    const inv = new Inventory();
    expect(inv.roomFor('')).toBe(0);
    expect(inv.roomFor('nope')).toBe(0);
    expect(inv.canAdd('nope', 1)).toBe(false);
    expect(inv.add('nope', 1)).toBe(1);
  });

  it('projects freed space when items are consumed first (the crafting case)', () => {
    const inv = packedBag();
    expect(inv.roomFor('campfire')).toBe(0);
    // recipe_campfire consumes 4 wood + 2 stone. In a bag of wall stacks,
    // removing 5 walls of one slot does NOT create an empty slot, so the
    // projection must stay at 0...
    expect(inv.roomFor('campfire', [{ id: FILLER, count: 5 }])).toBe(0);
    // ...but consuming a WHOLE stack does.
    expect(inv.roomFor('campfire', [{ id: FILLER, count: ITEMS[FILLER].stack }])).toBe(
      ITEMS.campfire.stack,
    );
  });

  it('sees capacity spread over many partial stacks', () => {
    const inv = new Inventory();
    // Placed directly: `add` would merge the partial stacks into full ones.
    for (let i = 0; i < INVENTORY_SIZE; i++) inv.slots[i] = { id: 'wood', count: 30 };
    expect(inv.roomFor('wood')).toBe(INVENTORY_SIZE * (ITEMS.wood.stack - 30));
    expect(inv.canAdd('wood', 1)).toBe(true);
    // No empty slot left, and stone stacks nowhere in the bag: no room.
    expect(inv.roomFor('stone')).toBe(0);
  });
});

describe('crafting is blocked instead of destroying its output', () => {
  const recipeOf = (id: string) => RECIPES.find((r) => r.id === id)!;

  it('refuses to START a craft whose output has nowhere to go', () => {
    const recipe = recipeOf('recipe_axe');
    // Materials present, but every partial stack stays partial after the
    // removals (a tool needs a slot of its own, stack 1): zero output room.
    const inv = new Inventory();
    for (let i = 0; i < INVENTORY_SIZE - 2; i++) inv.slots[i] = { id: FILLER, count: 5 };
    inv.slots[INVENTORY_SIZE - 2] = { id: 'wood', count: ITEMS.wood.stack };
    inv.slots[INVENTORY_SIZE - 1] = { id: 'stone', count: ITEMS.stone.stack };
    expect(hasMaterials(inv, 'recipe_axe')).toBe(true);
    expect(Crafting.canCraft(inv, recipe)).toBe(false);
    const before = totalUnits(inv);
    expect(CraftSession.start(inv, recipe.id, 1)).toBeNull();
    expect(totalUnits(inv)).toBe(before); // inputs NOT consumed
  });

  it('lets a craft START when its own inputs free up the space', () => {
    // The bag holds ONLY the inputs of recipe_campfire (4 wood, 2 stone)
    // plus filler: consuming them opens the slots the output needs, so the
    // capacity projection must not lock the player out of crafting.
    const recipe = recipeOf('recipe_campfire');
    const inv = new Inventory();
    inv.add('wood', 4);
    inv.add('stone', 2);
    for (let i = 0; i < INVENTORY_SIZE - 2; i++) inv.add(FILLER, ITEMS[FILLER].stack);
    expect(inv.roomFor(recipe.output.id)).toBe(0); // before consumption
    const session = CraftSession.start(inv, recipe.id, 1);
    expect(session).not.toBeNull();
    expect(session!.isBlocked).toBe(false);
  });

  it('pauses (blocked) when the bag fills during the craft, then resumes', () => {
    const recipe = recipeOf('recipe_axe'); // 2 wood + 1 stone → 1 stone_axe
    // Materials sit inside FULL stacks, so consuming them frees no slot:
    // completion is only possible because ONE slot is still empty.
    const inv = new Inventory();
    for (let i = 0; i < INVENTORY_SIZE - 3; i++) inv.slots[i] = { id: FILLER, count: 5 };
    inv.slots[INVENTORY_SIZE - 3] = { id: 'wood', count: ITEMS.wood.stack };
    inv.slots[INVENTORY_SIZE - 2] = { id: 'stone', count: ITEMS.stone.stack };
    // slot INVENTORY_SIZE-1 stays empty → the axe has somewhere to go.
    const session = CraftSession.start(inv, recipe.id, 1);
    expect(session).not.toBeNull();

    // Something fills that last slot while the craft runs (an MP echo of a
    // partner's drop, a quick pick-up): the finished axe no longer fits.
    inv.slots[INVENTORY_SIZE - 1] = { id: FILLER, count: 5 };

    // Blocked ticks never consume materials and never finish the craft.
    expect(session!.tick(inv, recipe.craftSeconds)).toBe('blocked');
    expect(session!.isBlocked).toBe(true);
    expect(session!.progress).toBe(1);
    expect(inv.count('wood')).toBe(ITEMS.wood.stack);
    expect(inv.count('stone')).toBe(ITEMS.stone.stack);
    expect(inv.count('stone_axe')).toBe(0);

    // Make room → the SAME session completes, materials consumed once.
    inv.slots[INVENTORY_SIZE - 1] = null;
    expect(session!.tick(inv, 0.016)).toBe('done');
    expect(inv.count('stone_axe')).toBe(1);
    expect(inv.count('wood')).toBe(ITEMS.wood.stack - 2);
    expect(inv.count('stone')).toBe(ITEMS.stone.stack - 1);
  });

  it('still crafts in a nearly full bag when one slot is free', () => {
    const inv = new Inventory();
    for (let i = 0; i < INVENTORY_SIZE - 3; i++) inv.add(FILLER, ITEMS[FILLER].stack);
    inv.add('wood', 2);
    inv.add('stone', 1);
    // 21 filler + wood + stone = 23 slots, one empty: exactly enough for the
    // axe the inputs free up (tools have stack 1, so they need a free slot).
    const session = CraftSession.start(inv, 'recipe_axe', 1);
    expect(session).not.toBeNull();
    expect(session!.tick(inv, recipeOf('recipe_axe').craftSeconds * 2)).toBe('done');
    expect(inv.count('stone_axe')).toBe(1);
  });
});

describe('cooking is blocked instead of destroying the food', () => {
  const FIRE = { id: 'fire_cap', fuel: 600 };

  it('does not start a cook with no room for the cooked result', () => {
    const inv = new Inventory();
    for (let i = 0; i < INVENTORY_SIZE - 1; i++) inv.add(FILLER, ITEMS[FILLER].stack);
    inv.add('berry', 5); // last slot: the ingredient fits, the result does not
    expect(inv.count('berry')).toBe(5);
    expect(cookHasRoom(inv, 'berry')).toBe(false);
    expect(CookSession.start('berry', inv, FIRE)).toBeNull();
    // The raw food is still there: starting was refused, nothing was lost.
    expect(inv.count('berry')).toBe(5);
  });

  it('counts the ingredient slot as free space when it empties (no false block)', () => {
    const inv = new Inventory();
    // One slot holding EXACTLY one berry: consuming it empties the slot, so
    // the cooked berry can take that very space — the cook must be allowed.
    for (let i = 0; i < INVENTORY_SIZE - 1; i++) inv.add(FILLER, ITEMS[FILLER].stack);
    inv.add('berry', 1);
    expect(inv.roomFor('cooked_berry')).toBe(0); // without the projection
    expect(cookHasRoom(inv, 'berry')).toBe(true); // with it
    const session = CookSession.start('berry', inv, FIRE);
    expect(session).not.toBeNull();
    expect(session!.tick(inv, FIRE.fuel, session!.duration)).toBe('done');
    expect(inv.count('cooked_berry')).toBe(1);
    expect(inv.count('berry')).toBe(0);
  });

  it('pauses (blocked) when the bag fills mid-cook and keeps the raw food', () => {
    const inv = new Inventory();
    inv.add('berry', 2);
    const session = CookSession.start('berry', inv, FIRE)!;
    for (let i = 0; i < INVENTORY_SIZE - 1; i++) inv.add(FILLER, ITEMS[FILLER].stack);

    expect(session.tick(inv, FIRE.fuel, session.duration)).toBe('blocked');
    expect(session.isBlocked).toBe(true);
    expect(session.progress).toBe(1);
    expect(inv.count('cooked_berry')).toBe(0);
    expect(inv.count('berry')).toBe(2); // neither consumed nor destroyed

    // The fire is still lit: a pause is not a cancel.
    expect(session.tick(inv, FIRE.fuel, 1)).toBe('blocked');

    inv.remove(FILLER, 9999);
    expect(session.tick(inv, FIRE.fuel, 0.016)).toBe('done');
    expect(inv.count('cooked_berry')).toBe(1);
    expect(inv.count('berry')).toBe(1); // one raw berry per cooked one
  });

  it('a dead fire still cancels, capacity or not (blocked ≠ cancelled)', () => {
    const inv = new Inventory();
    inv.add('berry', 2);
    const session = CookSession.start('berry', inv, FIRE)!;
    for (let i = 0; i < INVENTORY_SIZE - 1; i++) inv.add(FILLER, ITEMS[FILLER].stack);
    // Lit fire + finished cook + full bag → paused, not cancelled.
    expect(session.tick(inv, FIRE.fuel, session.duration)).toBe('blocked');
    // The fire going out is the real cancel, even with no output room.
    expect(session.tick(inv, 0, 0.016)).toBe('cancelled');
    expect(inv.count('berry')).toBe(2);
  });

  it('refuses non-food and empty selections as before', () => {
    const inv = new Inventory();
    expect(CookSession.start('stone', inv, FIRE)).toBeNull();
    expect(CookSession.start('berry', inv, FIRE)).toBeNull(); // count 0
    expect(cookHasRoom(inv, 'stone')).toBe(false);
    expect(cookHasRoom(inv, 'berry')).toBe(true);
  });
});

describe('all gain paths share one capacity rule', () => {
  it('a packed bag destroys nothing on any path', () => {
    const gather = packedBag();
    const gatherBefore = totalUnits(gather);
    expect(resolveHarvest({ kind: 'tree', inventory: gather, toolId: null, rng: () => 0.5 }).status).toBe(
      'blocked',
    );
    expect(totalUnits(gather)).toBe(gatherBefore);

    const craft = new Inventory();
    for (let i = 0; i < INVENTORY_SIZE - 2; i++) craft.slots[i] = { id: FILLER, count: 5 };
    craft.slots[INVENTORY_SIZE - 2] = { id: 'wood', count: ITEMS.wood.stack };
    craft.slots[INVENTORY_SIZE - 1] = { id: 'stone', count: ITEMS.stone.stack };
    const craftBefore = totalUnits(craft);
    expect(hasMaterials(craft, 'recipe_axe')).toBe(true);
    expect(CraftSession.start(craft, 'recipe_axe', 1)).toBeNull();
    expect(totalUnits(craft)).toBe(craftBefore);

    const cook = new Inventory();
    for (let i = 0; i < INVENTORY_SIZE - 1; i++) cook.slots[i] = { id: FILLER, count: 5 };
    cook.slots[INVENTORY_SIZE - 1] = { id: 'berry', count: 3 };
    const cookBefore = totalUnits(cook);
    expect(CookSession.start('berry', cook, { id: 'f', fuel: 100 })).toBeNull();
    expect(totalUnits(cook)).toBe(cookBefore);
  });

  it('gathering into a nearly full bag never loses more than the room allows', () => {
    for (let seed = 0; seed < 30; seed++) {
      const inv = new Inventory();
      for (let i = 0; i < INVENTORY_SIZE - 1; i++) inv.add(FILLER, ITEMS[FILLER].stack);
      inv.add('wood', ITEMS.wood.stack - 1); // exactly ONE unit of room left
      const out = resolveHarvest({ kind: 'tree', inventory: inv, toolId: null, rng: () => (seed % 10) / 10 });
      expect(out.status).toBe('gathered');
      expect(out.granted).toBe(1);
      expect(out.granted + out.lost).toBe(out.rolled);
      expect(inv.count('wood')).toBe(ITEMS.wood.stack);
      expect(out.xp).toBeGreaterThan(0); // partial work still pays something
    }
  });
});
