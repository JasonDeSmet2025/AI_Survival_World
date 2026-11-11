/**
 * Player progression: XP, levels and recipe unlocks (Gameplay Agent scope).
 *
 * The survival loop (gather → craft → build → survive) produces XP. Levels
 * unlock new recipes, so early play (bare hands + basic tools) opens up into
 * building and sleeping as the player invests effort — the classic
 * Valheim/The Forest progression arc.
 *
 * Pure logic, no rendering, trivially save-safe: the whole state is a
 * (level, xpInLevel) pair (see snapshot/restore).
 */
import { RECIPES, type Recipe } from '../core/items';

/** Highest reachable level. XP stops accumulating at this level. */
export const MAX_LEVEL = 10;

/** XP needed to advance from level 1 → 2. */
export const XP_BASE = 30;
/** Extra XP per level above the base (linear growth). */
export const XP_STEP = 20;

/**
 * XP required to advance FROM `level` TO `level + 1`:
 * level 1 → 2 needs 30, 2 → 3 needs 50, 3 → 4 needs 70, …
 */
export function xpForLevel(level: number): number {
  if (level < 1) return 0;
  return XP_BASE + (level - 1) * XP_STEP;
}

/**
 * XP granted per action, by source. Gathering yields are per node kind;
 * the rest are flat per completed action.
 */
export const XP_SOURCE = {
  gather: { tree: 6, pine: 6, rock: 5, bush: 3 } as Record<string, number>,
  /** XP for one completed (timed) craft. */
  craft: 6,
  /** XP for one placed building. */
  build: 4,
  /** XP for one completed campfire cook. */
  cook: 4,
  /** XP for one full night slept in a bed. */
  sleep: 12,
} as const;

/** XP granted by gathering a finished node of this kind (0 = no XP). */
export function gatherXp(nodeKind: string): number {
  return XP_SOURCE.gather[nodeKind] ?? 0;
}

/**
 * Result of an XP grant. `unlocked` lists the ids of recipes that became
 * available because of the levels gained by THIS grant (so the HUD can
 * announce "Nieuw level 2 — ontgrendeld: Wooden Wall, Wooden Floor").
 */
export interface LevelUpReport {
  /** The amount of XP that was actually added (0 when ignored). */
  gained: number;
  /** Number of levels gained by this grant. */
  levelsGained: number;
  /** True when the player is now at MAX_LEVEL (XP no longer accrues). */
  reachedMax: boolean;
  /** Recipe ids newly unlocked by the levels gained in this grant. */
  unlocked: string[];
}

/** The level at which a recipe unlocks (missing field = level 1). */
export function recipeUnlockLevel(recipe: Recipe): number {
  return recipe.unlockLevel ?? 1;
}

export function isRecipeUnlocked(recipe: Recipe, level: number): boolean {
  return level >= recipeUnlockLevel(recipe);
}

/**
 * Persistent progression state.
 *
 * XP is intentionally NOT reset on death: items can be lost, but skill and
 * the recipes unlocked by it are kept (the same contract as Valheim's
 * skill tree) — only the inventory pays the death penalty.
 */
export class Progression {
  level = 1;
  /** XP earned within the current level (always 0 at MAX_LEVEL). */
  xp = 0;

  /** True once the player cannot earn more levels. */
  get isMax(): boolean {
    return this.level >= MAX_LEVEL;
  }

  /** Progress within the current level in [0, 1] (1 at max level). */
  get fraction(): number {
    if (this.isMax) return 1;
    return Math.min(1, this.xp / xpForLevel(this.level));
  }

  /**
   * Add XP. Non-positive amounts and a player already at max level are
   * no-ops. Multiple level-ups from one large grant are handled in a loop;
   * the report lists every recipe unlocked across the gained levels.
   */
  addXp(amount: number): LevelUpReport {
    if (amount <= 0 || this.isMax) {
      return {
        gained: 0,
        levelsGained: 0,
        reachedMax: this.isMax,
        unlocked: [],
      };
    }
    const before = this.level;
    this.xp += amount;
    let levelsGained = 0;
    while (!this.isMax && this.xp >= xpForLevel(this.level)) {
      this.xp -= xpForLevel(this.level);
      this.level += 1;
      levelsGained += 1;
    }
    if (this.isMax) this.xp = 0; // surplus XP beyond the cap is discarded
    return {
      gained: amount,
      levelsGained,
      reachedMax: this.isMax,
      unlocked: RECIPES.filter(
        (r) => recipeUnlockLevel(r) > before && recipeUnlockLevel(r) <= this.level,
      ).map((r) => r.id),
    };
  }

  /** Serializable state (save file). */
  snapshot(): { level: number; xp: number } {
    return { level: this.level, xp: this.xp };
  }

  /**
   * Restore from a save. Old saves have no progress field at all — the
   * caller only invokes this when one exists. Malformed values are clamped
   * (level into [1, MAX_LEVEL], xp into [0, xpForLevel(level))).
   */
  restore(s: { level: number; xp: number }): void {
    if (!s || !Number.isFinite(s.level) || !Number.isFinite(s.xp)) return;
    this.level = Math.max(1, Math.min(MAX_LEVEL, Math.round(s.level)));
    if (this.isMax) {
      this.xp = 0;
      return;
    }
    this.xp = Math.max(0, Math.min(xpForLevel(this.level), s.xp));
  }
}
