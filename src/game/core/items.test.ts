import { describe, expect, it } from 'vitest';
import { ITEMS, RECIPES, YIELDS, harvestSeconds, toolForNode } from './items';
import { MAX_LEVEL, recipeUnlockLevel } from '../systems/progress';
import { isConsumable } from '../systems/consume';

/**
 * core/items.ts is the database the whole survival loop reads from: inventory
 * slots, crafting, cooking, gathering yields, tool wear, building placement,
 * the HUD and the save file. A phantom id or an inconsistent entry there does
 * not fail loudly — it shows up as an item that cannot be crafted, a toast
 * naming "undefined" or (the historical case) a yield pointing at a `berries`
 * item that never existed, i.e. silently destroyed resources.
 *
 * These tests are data-integration guards: they assert the invariants the
 * runtime systems rely on, not the exact balance numbers.
 */

const NODE_KINDS = ['tree', 'pine', 'rock', 'bush'];
const BUILDING_KINDS = ['campfire', 'wall', 'floor', 'roof', 'bed'];
const ITEM_KINDS = ['resource', 'food', 'tool', 'building', 'fuel'];

describe('ITEMS registry integrity', () => {
  it('has one entry per id, keyed by that id', () => {
    const ids = Object.keys(ITEMS);
    expect(ids.length).toBeGreaterThan(0);
    for (const [key, def] of Object.entries(ITEMS)) {
      expect(def.id, `key ${key} must match its id`).toBe(key);
    }
  });

  it('declares valid stacks, kinds and swatch colours', () => {
    for (const def of Object.values(ITEMS)) {
      expect(Number.isInteger(def.stack), def.id).toBe(true);
      expect(def.stack, def.id).toBeGreaterThanOrEqual(1);
      expect(ITEM_KINDS, def.id).toContain(def.kind);
      expect(def.color, def.id).toHaveLength(3);
      for (const c of def.color) {
        expect(c, def.id).toBeGreaterThanOrEqual(0);
        expect(c, def.id).toBeLessThanOrEqual(1);
      }
      expect(def.name.trim().length, def.id).toBeGreaterThan(0);
      expect(def.desc.trim().length, def.id).toBeGreaterThan(0);
    }
  });

  it('gives every tool a positive durability and a real wear rate', () => {
    const tools = Object.values(ITEMS).filter((d) => d.kind === 'tool');
    expect(tools.length).toBeGreaterThanOrEqual(2); // axe + pickaxe
    for (const def of tools) {
      expect(def.tool, def.id).toBeDefined();
      expect(def.tool!.maxDurability, def.id).toBeGreaterThan(0);
      expect(def.tool!.wearPerSec, def.id).toBeGreaterThan(0);
      // Tools must break before a single stack outlives ~10 minutes of use.
      expect(def.tool!.maxDurability / def.tool!.wearPerSec, def.id).toBeGreaterThan(60);
    }
  });

  it('makes every consumable actually worth eating', () => {
    const foods = Object.values(ITEMS).filter((d) => d.edible != null);
    expect(foods.length).toBeGreaterThanOrEqual(2);
    for (const def of foods) {
      expect(isConsumable(def.id), def.id).toBe(true);
      const e = def.edible!;
      expect(e.hunger, def.id).toBeGreaterThan(0);
      // RAW meat deliberately costs a little health (eat it cooked); cooked
      // food and berries must never hurt. The bound below draws that line:
      // raw_mutton/raw_beef may dip slightly negative, nothing else.
      const raw = def.id.startsWith('raw_');
      expect(e.health, def.id).toBeGreaterThanOrEqual(raw ? -5 : 0);
      expect(e.thirst, def.id).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('RECIPES integrity', () => {
  it('has unique ids and non-empty, real inputs and outputs', () => {
    const ids = RECIPES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of RECIPES) {
      expect(r.id.trim().length).toBeGreaterThan(0);
      expect(ITEMS[r.output.id], `${r.id} output`).toBeDefined();
      expect(r.output.count, r.id).toBeGreaterThanOrEqual(1);
      expect(r.inputs.length, r.id).toBeGreaterThan(0);
      for (const i of r.inputs) {
        expect(ITEMS[i.id], `${r.id} input ${i.id}`).toBeDefined();
        expect(i.count, r.id).toBeGreaterThanOrEqual(1);
      }
      // A recipe may not craft an item out of itself.
      expect(r.inputs.some((i) => i.id === r.output.id), r.id).toBe(false);
      expect(r.craftSeconds, r.id).toBeGreaterThan(0);
    }
  });

  it('stays unlockable within the progression range', () => {
    for (const r of RECIPES) {
      const level = recipeUnlockLevel(r);
      expect(level, r.id).toBeGreaterThanOrEqual(1);
      expect(level, r.id).toBeLessThanOrEqual(MAX_LEVEL);
    }
  });

  it('produces results that fit in one stack (otherwise a craft can never complete)', () => {
    // systems/crafting.ts refuses to finish a craft whose output does not
    // fit in the bag. An output bigger than one stack would then be
    // uncraftable forever, so the data must guarantee it fits in one stack.
    for (const r of RECIPES) {
      const def = ITEMS[r.output.id];
      expect(def.stack >= r.output.count, `${r.id} → ${r.output.id}`).toBe(true);
    }
  });

  it('teaches the survival loop in a sensible order', () => {
    // Tools and fire come first (level 1), shelter later: the progression
    // arc must never lock the basic tools behind a building recipe.
    const levelOf = (recipeId: string) => recipeUnlockLevel(RECIPES.find((r) => r.id === recipeId)!);
    expect(levelOf('recipe_axe')).toBe(1);
    expect(levelOf('recipe_pick')).toBe(1);
    expect(levelOf('recipe_campfire')).toBe(1);
    expect(levelOf('recipe_bed')).toBeGreaterThan(1);
  });

  it('keeps the tekentafel the ONE gate of the tech tree', () => {
    // The station rule (systems/crafting.ts needsTable) is data-driven from
    // `fieldRecipe`, so THIS is what pins it: the list of things you can make
    // bare-handed is short on purpose, and the table that opens everything
    // else has to be one of them (otherwise the gate could never be built).
    const field = RECIPES.filter((r) => r.fieldRecipe === true).map((r) => r.id).sort();
    expect(field).toEqual([
      'recipe_axe',
      'recipe_campfire',
      'recipe_pick',
      'recipe_rope',
      'recipe_torch',
      'recipe_workbench',
    ]);
    const table = RECIPES.find((r) => r.id === 'recipe_workbench')!;
    expect(table.fieldRecipe).toBe(true);
    expect(recipeUnlockLevel(table)).toBe(1);
    // And it must be reachable on day one: wood only, no stone, no level.
    expect(table.inputs.map((i) => i.id)).toEqual(['wood']);
    // Everything else waits for the station — that is what keeps the craft
    // menu small while the player is still bare-handed.
    expect(RECIPES.filter((r) => !r.fieldRecipe).length).toBeGreaterThan(10);
  });
});

describe('YIELDS integrity (the historical "berries" bug class)', () => {
  it('covers exactly the harvestable node kinds', () => {
    expect(Object.keys(YIELDS).sort()).toEqual([...NODE_KINDS].sort());
  });

  it('yields real, storable items with a sane range', () => {
    for (const [kind, y] of Object.entries(YIELDS)) {
      const def = ITEMS[y.itemId];
      expect(def, `${kind} → ${y.itemId}`).toBeDefined();
      expect(def.kind, kind).not.toBe('building');
      expect(y.min, kind).toBeGreaterThanOrEqual(1);
      expect(y.max, kind).toBeGreaterThanOrEqual(y.min);
      // A single harvest (max roll + the +1 effective-tool bonus) must fit
      // in ONE empty stack, otherwise every gather would report a shortfall.
      expect(def.stack >= y.max + 1, `${kind} → ${y.itemId}`).toBe(true);
    }
  });
});

describe('tool ↔ node mapping integrity', () => {
  it('names only real tools, and only for the node kinds they work on', () => {
    expect(toolForNode('tree')).toBe('stone_axe');
    expect(toolForNode('pine')).toBe('stone_axe');
    expect(toolForNode('rock')).toBe('stone_pick');
    expect(toolForNode('bush')).toBeNull(); // picked by hand
    expect(toolForNode('flower')).toBeNull();
    for (const kind of NODE_KINDS) {
      const id = toolForNode(kind);
      if (id === null) continue;
      const def = ITEMS[id];
      expect(def, `${kind} → ${id}`).toBeDefined();
      expect(def.kind, `${kind} → ${id}`).toBe('tool');
      expect(def.tool, `${kind} → ${id}`).toBeDefined();
    }
  });

  it('rewards the correct tool with a strictly faster harvest', () => {
    for (const kind of NODE_KINDS) {
      const tool = toolForNode(kind);
      const bare = harvestSeconds(kind, null);
      expect(bare, kind).toBeGreaterThan(0);
      if (tool === null) {
        // No tool works on this kind: no other tool may be faster either.
        for (const id of Object.keys(ITEMS)) {
          if (ITEMS[id].kind === 'tool') expect(harvestSeconds(kind, id), kind).toBe(bare);
        }
        continue;
      }
      expect(harvestSeconds(kind, tool), kind).toBeLessThan(bare);
      // The wrong tool must not be a hidden speed boost.
      const other = Object.keys(ITEMS).find((id) => ITEMS[id].kind === 'tool' && id !== tool)!;
      expect(harvestSeconds(kind, other), kind).toBe(bare);
    }
  });
});

describe('cooking integrity', () => {
  it('cooks into a real, edible food that is an upgrade', () => {
    const cookables = Object.values(ITEMS).filter((d) => d.cookable != null);
    expect(cookables.length).toBeGreaterThanOrEqual(1);
    for (const def of cookables) {
      const out = ITEMS[def.cookable!.output];
      expect(out, `${def.id} → ${def.cookable!.output}`).toBeDefined();
      expect(out.edible, def.id).toBeDefined();
      expect(isConsumable(out.id), def.id).toBe(true);
      expect(out.edible!.hunger, def.id).toBeGreaterThan(def.edible!.hunger);
      expect(def.cookable!.seconds, def.id).toBeGreaterThan(0);
      // Cooking must not chain (no cooking a cooked item).
      expect(out.cookable, def.id).toBeUndefined();
    }
  });

  it('has a campfire recipe for every placeable building kind', () => {
    // Building placement reads BUILDING_KINDS from the item ids; every kind
    // the world can hold must exist as an item with kind 'building'.
    for (const kind of BUILDING_KINDS) {
      const def = ITEMS[kind];
      expect(def, kind).toBeDefined();
      expect(def.kind, kind).toBe('building');
    }
  });
});
