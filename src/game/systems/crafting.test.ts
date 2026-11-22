import { describe, expect, it } from 'vitest';
import { ITEMS, RECIPES } from '../core/items';
import { Inventory } from './inventory';
import {
  CRAFT_GROUP_LABEL,
  CRAFT_GROUP_ORDER,
  CraftSession,
  Crafting,
  craftGroupOf,
  handRecipes,
  needsTable,
  type CraftTickResult,
} from './crafting';

/** Fresh inventory stocked with exactly the inputs of `recipeId`. */
function stockedInventory(recipeId: string): Inventory {
  const inv = new Inventory();
  const r = RECIPES.find((x) => x.id === recipeId)!;
  for (const i of r.inputs) inv.add(i.id, i.count);
  return inv;
}

/** Total units of an item across all slots. */
const units = (inv: Inventory, id: string): number => inv.count(id);

describe('the tekentafel is a station (not just a speed bonus)', () => {
  /** A bag that could afford every recipe, so only the station can refuse. */
  function richInventory(): Inventory {
    const inv = new Inventory();
    const need = new Map<string, number>();
    for (const r of RECIPES) {
      for (const i of r.inputs) need.set(i.id, Math.max(need.get(i.id) ?? 0, i.count));
    }
    for (const [id, count] of need) expect(inv.add(id, count)).toBe(0);
    return inv;
  }

  it('hand work is craftable in the open field', () => {
    for (const r of handRecipes()) {
      const inv = richInventory();
      expect(Crafting.canCraft(inv, r, Infinity, false), r.id).toBe(true);
      expect(CraftSession.start(inv, r.id, Infinity, 1, false), r.id).not.toBeNull();
    }
  });

  it('table work is refused off the station and allowed on it', () => {
    const tableRecipes = RECIPES.filter((r) => needsTable(r));
    expect(tableRecipes.length).toBeGreaterThan(0);
    for (const r of tableRecipes) {
      const off = richInventory();
      expect(Crafting.canCraft(off, r, Infinity, false), r.id).toBe(false);
      expect(CraftSession.start(off, r.id, Infinity, 1, false), r.id).toBeNull();
      // Refusing at the station level must not have touched the materials.
      for (const i of r.inputs) expect(off.has(i.id, i.count), r.id).toBe(true);
      const on = richInventory();
      expect(Crafting.canCraft(on, r, Infinity, true), r.id).toBe(true);
      expect(Crafting.craft(on, r.id, Infinity, true), r.id).toBe(r.output.id);
    }
  });

  it('available() follows the station the player is standing at', () => {
    const inv = richInventory();
    const inField = Crafting.available(inv, Infinity, false).map((r) => r.id);
    const atTable = Crafting.available(inv, Infinity, true).map((r) => r.id);
    expect(inField).toEqual(handRecipes().map((r) => r.id));
    expect(atTable.length).toBeGreaterThan(inField.length);
  });

  it('the table itself is hand work — the gate can never lock itself out', () => {
    // A locked station that could only be built FROM the station would be a
    // dead end, so this one recipe is the load-bearing exception.
    const table = RECIPES.find((r) => r.id === 'recipe_workbench')!;
    expect(needsTable(table)).toBe(false);
    expect(table.unlockLevel ?? 1).toBe(1);
    const inv = stockedInventory('recipe_workbench');
    expect(Crafting.craft(inv, 'recipe_workbench', 1, false)).toBe('workbench');
  });

  it('puts the tekentafel at the very top of the menu', () => {
    // The menu is the tutorial now: the first row the player sees must be the
    // one thing that opens the rest of the tree.
    const table = RECIPES.find((r) => r.id === 'recipe_workbench')!;
    expect(craftGroupOf(table)).toBe('start');
    expect(CRAFT_GROUP_ORDER[0]).toBe('start');
    expect(CRAFT_GROUP_LABEL.start).toBe('Start');
  });

  it('a missing flag means "needs the table", never "free for all"', () => {
    // The safe default is what keeps the tech tree honest when a recipe is
    // added: forgetting the field is a locked row, not a leaked one.
    expect(needsTable({ ...RECIPES.find((r) => r.id === 'recipe_wall')!, fieldRecipe: undefined })).toBe(true);
    expect(needsTable({ ...RECIPES.find((r) => r.id === 'recipe_wall')!, fieldRecipe: true })).toBe(false);
  });

  it('every recipe has exactly one menu section', () => {
    for (const r of RECIPES) {
      expect(CRAFT_GROUP_ORDER, r.id).toContain(craftGroupOf(r));
    }
    // The explicit table is not allowed to name items that are never crafted.
    const groups = new Set(RECIPES.map(craftGroupOf));
    expect(groups.has('build')).toBe(true);
    expect(groups.has('fight')).toBe(true);
  });
});

describe('Crafting static API (unchanged legacy behaviour)', () => {
  it('canCraft reflects the inventory contents', () => {
    const axe = RECIPES.find((r) => r.id === 'recipe_axe')!;
    const inv = stockedInventory('recipe_axe');
    expect(Crafting.canCraft(inv, axe)).toBe(true);
    inv.remove('wood', 1);
    expect(Crafting.canCraft(inv, axe)).toBe(false);
  });

  it('craft() consumes inputs and adds the output', () => {
    const inv = stockedInventory('recipe_wall');
    expect(units(inv, 'wall')).toBe(0);
    expect(Crafting.craft(inv, 'recipe_wall')).toBe('wall');
    expect(units(inv, 'wood')).toBe(0);
    expect(units(inv, 'wall')).toBe(2);
  });

  it('craft() refuses unknown recipes and missing materials', () => {
    const inv = stockedInventory('recipe_axe');
    expect(Crafting.craft(inv, 'nope')).toBeNull();
    inv.remove('stone', 1);
    expect(Crafting.craft(inv, 'recipe_axe')).toBeNull();
    expect(units(inv, 'stone_axe')).toBe(0);
  });

  it('available() lists only craftable recipes', () => {
    const inv = stockedInventory('recipe_axe');
    const ids = Crafting.available(inv).map((r) => r.id);
    expect(ids).toContain('recipe_axe');
    expect(ids).not.toContain('recipe_wall'); // needs 6 wood
  });

  it('every recipe has a positive craft time and known items', () => {
    for (const r of RECIPES) {
      expect(r.craftSeconds).toBeGreaterThan(0);
      expect(ITEMS[r.output.id]).toBeDefined();
      for (const i of r.inputs) expect(ITEMS[i.id]).toBeDefined();
      expect(Crafting.craftSeconds(r.id)).toBe(r.craftSeconds);
    }
    expect(Crafting.craftSeconds('unknown')).toBe(0);
  });
});

describe('CraftSession (timed crafting)', () => {
  it('refuses to start without materials or for unknown recipes', () => {
    const inv = new Inventory();
    expect(CraftSession.start(inv, 'recipe_axe')).toBeNull();
    expect(CraftSession.start(stockedInventory('recipe_axe'), 'nope')).toBeNull();
    const partial = stockedInventory('recipe_axe');
    partial.remove('wood', 1);
    expect(CraftSession.start(partial, 'recipe_axe')).toBeNull();
  });

  it('starts with zero progress and the recipe duration', () => {
    const s = CraftSession.start(stockedInventory('recipe_campfire'), 'recipe_campfire')!;
    expect(s.recipe.id).toBe('recipe_campfire');
    expect(s.duration).toBe(4);
    expect(s.progress).toBe(0);
    expect(s.isOver).toBe(false);
  });

  it('consumes nothing while still crafting', () => {
    const inv = stockedInventory('recipe_axe');
    const s = CraftSession.start(inv, 'recipe_axe')!;
    // 90% of the way through — inputs must be fully intact.
    s.tick(inv, s.duration * 0.9);
    expect(units(inv, 'wood')).toBe(2);
    expect(units(inv, 'stone')).toBe(1);
    expect(units(inv, 'stone_axe')).toBe(0);
    expect(s.progress).toBeCloseTo(0.9, 5);
    expect(s.isOver).toBe(false);
  });

  it('completes at the full duration: consumes inputs exactly once, adds output', () => {
    const inv = stockedInventory('recipe_pick');
    // Add extra resources that must survive the craft untouched.
    inv.add('wood', 10);
    inv.add('berry', 3);
    const s = CraftSession.start(inv, 'recipe_pick')!;

    let res: CraftTickResult;
    do {
      res = s.tick(inv, 0.1);
    } while (res === 'crafting');

    expect(res).toBe('done');
    expect(units(inv, 'wood')).toBe(10); // 12 - 2 consumed
    expect(units(inv, 'stone')).toBe(0); // 2 - 2 consumed
    expect(units(inv, 'berry')).toBe(3); // untouched
    expect(units(inv, 'stone_pick')).toBe(1);
    const tool = inv.slots.find((sl) => sl?.id === 'stone_pick')!;
    expect(tool.durability).toBe(ITEMS.stone_pick.tool!.maxDurability);
    expect(s.progress).toBe(1);
    expect(s.isOver).toBe(true);
  });

  it('ticking after completion is a no-op (no double consume / double add)', () => {
    const inv = stockedInventory('recipe_floor');
    const s = CraftSession.start(inv, 'recipe_floor')!;
    expect(s.tick(inv, s.duration)).toBe('done');
    const woodAfter = units(inv, 'wood');
    const floorAfter = units(inv, 'floor');
    for (let i = 0; i < 5; i++) expect(s.tick(inv, 0.5)).toBe('done');
    expect(units(inv, 'wood')).toBe(woodAfter);
    expect(units(inv, 'floor')).toBe(floorAfter);
  });

  it('cancel() drops the session and loses nothing', () => {
    const inv = stockedInventory('recipe_campfire');
    const s = CraftSession.start(inv, 'recipe_campfire')!;
    s.tick(inv, s.duration * 0.5);
    s.cancel();
    expect(s.isOver).toBe(true);
    expect(units(inv, 'wood')).toBe(4);
    expect(units(inv, 'stone')).toBe(2);
    expect(units(inv, 'campfire')).toBe(0);
    // Further ticks report cancelled and stay inert.
    expect(s.tick(inv, s.duration)).toBe('cancelled');
    expect(units(inv, 'campfire')).toBe(0);
  });

  it('a huge dt (tab restore) completes the craft exactly once', () => {
    const inv = stockedInventory('recipe_roof');
    const s = CraftSession.start(inv, 'recipe_roof')!;
    // game.ts clamps frame dt to 0.05 s, so the session only ever sees sane
    // steps in practice; the bookkeeping must still survive a 1 h spike:
    // one completion, inputs consumed once, output added once.
    expect(s.tick(inv, 3600)).toBe('done');
    expect(units(inv, 'roof')).toBe(2);
    expect(units(inv, 'wood')).toBe(0);
    expect(s.tick(inv, 3600)).toBe('done'); // still settled, no double add
    expect(units(inv, 'roof')).toBe(2);
  });

  it('cancels safely if the inputs are no longer all present (safety net)', () => {
    const inv = stockedInventory('recipe_axe');
    const s = CraftSession.start(inv, 'recipe_axe')!;
    inv.remove('stone', 1); // simulated external removal
    expect(s.tick(inv, 0.1)).toBe('cancelled');
    expect(units(inv, 'stone_axe')).toBe(0);
    expect(units(inv, 'wood')).toBe(2);
    expect(units(inv, 'stone')).toBe(0);
  });

  it('accepts fractional progress accumulation (frame-granular)', () => {
    const inv = stockedInventory('recipe_wall');
    const s = CraftSession.start(inv, 'recipe_wall')!;
    const frame = 1 / 60;
    // 5 s at 60 fps: done at ~300 frames (±1 for float accumulation).
    let doneAt = -1;
    for (let i = 1; i <= 320; i++) {
      if (s.tick(inv, frame) === 'done') {
        doneAt = i;
        break;
      }
    }
    expect(doneAt).toBeGreaterThanOrEqual(299);
    expect(doneAt).toBeLessThanOrEqual(301);
    expect(units(inv, 'wall')).toBe(2);
  });
});
