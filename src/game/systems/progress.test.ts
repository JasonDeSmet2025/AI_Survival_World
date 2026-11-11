import { describe, expect, it } from 'vitest';
import { ITEMS, RECIPES } from '../core/items';
import { Inventory } from './inventory';
import {
  MAX_LEVEL,
  XP_BASE,
  XP_STEP,
  XP_SOURCE,
  Progression,
  gatherXp,
  isRecipeUnlocked,
  recipeUnlockLevel,
  xpForLevel,
} from './progress';
import { Crafting, CraftSession } from './crafting';

/** Fill an inventory enough to craft every recipe (all inputs). */
function stockedInventory(): Inventory {
  const inv = new Inventory();
  inv.add('wood', 30);
  inv.add('stone', 15);
  return inv;
}

const recipeById = (id: string): (typeof RECIPES)[number] => {
  const r = RECIPES.find((x) => x.id === id);
  if (!r) throw new Error(`unknown recipe ${id}`);
  return r;
};

describe('progression curve', () => {
  it('grows linearly from the base', () => {
    expect(xpForLevel(1)).toBe(XP_BASE);
    expect(xpForLevel(2)).toBe(XP_BASE + XP_STEP);
    expect(xpForLevel(3)).toBe(XP_BASE + 2 * XP_STEP);
  });

  it('is monotonically increasing up to the max level', () => {
    for (let l = 2; l < MAX_LEVEL; l++) {
      expect(xpForLevel(l)).toBeGreaterThan(xpForLevel(l - 1));
    }
  });

  it('returns 0 below level 1', () => {
    expect(xpForLevel(0)).toBe(0);
    expect(xpForLevel(-5)).toBe(0);
  });
});

describe('Progression.addXp', () => {
  it('does not level up before the threshold', () => {
    const p = new Progression();
    const r = p.addXp(xpForLevel(1) - 1);
    expect(p.level).toBe(1);
    expect(p.xp).toBe(xpForLevel(1) - 1);
    expect(r.levelsGained).toBe(0);
    expect(r.gained).toBe(xpForLevel(1) - 1);
    expect(p.fraction).toBeCloseTo((xpForLevel(1) - 1) / xpForLevel(1));
  });

  it('levels up exactly at the threshold and banks no XP', () => {
    const p = new Progression();
    const r = p.addXp(xpForLevel(1));
    expect(p.level).toBe(2);
    expect(p.xp).toBe(0);
    expect(r.levelsGained).toBe(1);
    expect(r.reachedMax).toBe(false);
  });

  it('banks surplus XP when not enough for a level-up', () => {
    const p = new Progression();
    p.addXp(xpForLevel(1) + 12);
    expect(p.level).toBe(2);
    expect(p.xp).toBe(12);
    expect(p.fraction).toBeCloseTo(12 / xpForLevel(2));
  });

  it('handles a multi-level jump from one large grant', () => {
    const p = new Progression();
    const total = xpForLevel(1) + xpForLevel(2) + xpForLevel(3) + 5;
    const r = p.addXp(total);
    expect(p.level).toBe(4);
    expect(p.xp).toBe(5);
    expect(r.levelsGained).toBe(3);
  });

  it('ignores non-positive amounts', () => {
    const p = new Progression();
    for (const amount of [0, -5]) {
      const r = p.addXp(amount);
      expect(r.gained).toBe(0);
      expect(r.levelsGained).toBe(0);
    }
    expect(p.level).toBe(1);
    expect(p.xp).toBe(0);
  });

  it('caps at MAX_LEVEL and stops accruing XP', () => {
    const p = new Progression();
    // Walk to the cap with exact thresholds.
    for (let l = 1; l < MAX_LEVEL; l++) p.addXp(xpForLevel(l));
    expect(p.level).toBe(MAX_LEVEL);
    expect(p.isMax).toBe(true);
    expect(p.fraction).toBe(1);
    const r = p.addXp(1000);
    expect(r.gained).toBe(0);
    expect(r.reachedMax).toBe(true);
    expect(p.xp).toBe(0);
    expect(p.level).toBe(MAX_LEVEL);
  });

  it('discards surplus XP granted past the cap in one shot', () => {
    const p = new Progression();
    p.addXp(100_000);
    expect(p.level).toBe(MAX_LEVEL);
    expect(p.xp).toBe(0);
  });
});

describe('recipe unlock reporting', () => {
  it('reports only the recipes unlocked by the levels gained in one grant', () => {
    const p = new Progression();
    // Level 1 → 2 unlocks wall + floor.
    const r2 = p.addXp(xpForLevel(1));
    expect(r2.unlocked.sort()).toEqual(['recipe_floor', 'recipe_wall']);
    // Level 2 → 3 unlocks roof.
    const r3 = p.addXp(xpForLevel(2));
    expect(r3.unlocked).toEqual(['recipe_roof']);
    // Level 3 → 4 unlocks bed.
    const r4 = p.addXp(xpForLevel(3));
    expect(r4.unlocked).toEqual(['recipe_bed']);
    // A non-unlocking grant reports nothing new.
    const r5 = p.addXp(xpForLevel(4));
    expect(r5.unlocked).toEqual([]);
  });

  it('reports all unlocks across a multi-level jump', () => {
    const p = new Progression();
    const r = p.addXp(xpForLevel(1) + xpForLevel(2));
    expect(r.unlocked.sort()).toEqual(['recipe_floor', 'recipe_roof', 'recipe_wall']);
  });

  it('unlockLevel falls back to 1 for recipes without the field', () => {
    for (const r of RECIPES) {
      expect(recipeUnlockLevel(r)).toBeGreaterThanOrEqual(1);
    }
    // The starter recipes must be available from level 1 (fresh player
    // needs them to bootstrap: axe, pickaxe, campfire).
    for (const id of ['recipe_axe', 'recipe_pick', 'recipe_campfire']) {
      expect(recipeUnlockLevel(recipeById(id))).toBe(1);
    }
  });

  it('every recipe unlocks at or before MAX_LEVEL', () => {
    for (const r of RECIPES) {
      expect(recipeUnlockLevel(r)).toBeLessThanOrEqual(MAX_LEVEL);
      expect(isRecipeUnlocked(r, MAX_LEVEL)).toBe(true);
    }
  });

  it('isRecipeUnlocked compares levels inclusively', () => {
    const wall = recipeById('recipe_wall'); // unlockLevel 2
    expect(isRecipeUnlocked(wall, 1)).toBe(false);
    expect(isRecipeUnlocked(wall, 2)).toBe(true);
    expect(isRecipeUnlocked(wall, 10)).toBe(true);
  });
});

describe('Progression snapshot / restore', () => {
  it('round-trips level and XP', () => {
    const p = new Progression();
    p.addXp(55);
    const snap = p.snapshot();
    const q = new Progression();
    q.restore(snap);
    expect(q.level).toBe(p.level);
    expect(q.xp).toBe(p.xp);
  });

  it('clamps malformed saves', () => {
    const q = new Progression();
    q.restore({ level: 999, xp: 5 });
    expect(q.level).toBe(MAX_LEVEL);
    expect(q.xp).toBe(0);

    const r = new Progression();
    r.restore({ level: -3, xp: -10 });
    expect(r.level).toBe(1);
    expect(r.xp).toBe(0);

    const s = new Progression();
    s.restore({ level: 2, xp: 10_000 });
    expect(s.level).toBe(2);
    expect(s.xp).toBe(xpForLevel(2));

    const t = new Progression();
    t.level = 3;
    t.restore({ level: NaN, xp: NaN });
    expect(t.level).toBe(3); // invalid restore is a no-op
  });
});

describe('crafting is gated by level', () => {
  it('CraftSession.start rejects locked recipes at low level', () => {
    const inv = stockedInventory();
    const wall = recipeById('recipe_wall'); // unlockLevel 2
    expect(CraftSession.start(inv, wall.id, 1)).toBeNull();
    expect(CraftSession.start(inv, wall.id, 2)).not.toBeNull();
    expect(CraftSession.start(inv, wall.id)).not.toBeNull(); // legacy default
  });

  it('CraftSession.start still rejects missing inputs when unlocked', () => {
    const empty = new Inventory();
    expect(CraftSession.start(empty, 'recipe_wall', 2)).toBeNull();
    expect(CraftSession.start(empty, 'recipe_axe', 1)).toBeNull();
  });

  it('Crafting.canCraft and available filter by level', () => {
    const inv = stockedInventory();
    expect(Crafting.canCraft(inv, recipeById('recipe_wall'), 1)).toBe(false);
    expect(Crafting.canCraft(inv, recipeById('recipe_wall'), 2)).toBe(true);
    // Level 1: only level-1 recipes are available.
    const lvl1 = Crafting.available(inv, 1).map((r) => r.id).sort();
    expect(lvl1).toEqual(['recipe_axe', 'recipe_campfire', 'recipe_pick']);
    // Level 4: everything in the current table.
    expect(Crafting.available(inv, 4).map((r) => r.id).sort())
      .toEqual(RECIPES.map((r) => r.id).sort());
  });

  it('legacy Crafting.craft works with the default level', () => {
    const inv = new Inventory();
    inv.add('wood', 6);
    expect(Crafting.craft(inv, 'recipe_wall')).toBe('wall'); // default = unlocked
    expect(Crafting.craft(inv, 'recipe_wall', 1)).toBeNull(); // gated
  });
});

describe('XP sources and gameplay integration', () => {
  it('every gatherable node kind pays XP, bushes least, trees/pines most', () => {
    for (const kind of ['tree', 'pine', 'rock', 'bush']) {
      expect(gatherXp(kind)).toBeGreaterThan(0);
    }
    expect(gatherXp('tree')).toBe(XP_SOURCE.gather.tree);
    expect(gatherXp('bush')).toBeLessThan(gatherXp('tree'));
    expect(gatherXp('bush')).toBeLessThan(gatherXp('rock'));
    expect(gatherXp('unknown')).toBe(0);
  });

  it('a fresh player reaches level 2 after five bare-hand tree gathers', () => {
    // Mirrors the real loop: each completed tree harvest grants gatherXp.
    const p = new Progression();
    for (let i = 0; i < 4; i++) {
      const r = p.addXp(gatherXp('tree'));
      expect(r.levelsGained).toBe(0);
    }
    expect(p.level).toBe(1);
    const fifth = p.addXp(gatherXp('tree'));
    expect(fifth.levelsGained).toBe(1);
    expect(p.level).toBe(2);
    // Level 2 is when the player can actually build: wall + floor unlock.
    expect(isRecipeUnlocked(recipeById('recipe_wall'), p.level)).toBe(true);
    expect(isRecipeUnlocked(recipeById('recipe_floor'), p.level)).toBe(true);
    expect(isRecipeUnlocked(recipeById('recipe_roof'), p.level)).toBe(false);
  });

  it('XP pacing stays reasonable: ~5-6 gathers per early level', () => {
    // Level 1 → 2: 30 XP / 6 per tree = 5 gathers.
    expect(xpForLevel(1) / gatherXp('tree')).toBeCloseTo(5);
    // Sleeps (12 XP) + crafts (6 XP) must also make levels reachable.
    const p = new Progression();
    p.addXp(XP_SOURCE.sleep + XP_SOURCE.craft + gatherXp('tree'));
    expect(p.xp).toBe(24); // 12 + 6 + 6
    expect(p.level).toBe(1);
  });

  it('level-1 recipes only need resources that exist in the world', () => {
    for (const r of RECIPES) {
      if ((r.unlockLevel ?? 1) > 1) continue;
      for (const input of r.inputs) {
        expect(ITEMS[input.id]).toBeDefined();
      }
    }
  });
});
