import { RECIPES, ITEMS, type Recipe } from '../core/items';
import { isRecipeUnlocked } from './progress';
import type { Inventory } from './inventory';

export type CraftTickResult = 'crafting' | 'done' | 'cancelled';

/**
 * One in-progress timed-craft attempt (Gameplay Agent scope).
 *
 * Inputs are NOT reserved or consumed when the session starts — they are
 * taken from the inventory exactly once, when the session completes.
 * Cancelling (or the player dying mid-craft) therefore loses nothing:
 * the materials were never touched. This keeps the state machine pure and
 * trivially save-safe (a session is transient and never persisted).
 */
export class CraftSession {
  readonly recipe: Recipe;

  private elapsed = 0;
  private cancelled = false;
  private finished = false;

  private constructor(recipe: Recipe) {
    this.recipe = recipe;
  }

  /**
   * Start a session for `recipeId`. Returns null when the recipe is
   * unknown, NOT UNLOCKED at `level` or the inventory does not hold all
   * inputs. `level` defaults to Infinity so callers without a progression
   * state (legacy tests, tools) keep the old behaviour.
   */
  static start(inv: Inventory, recipeId: string, level: number = Infinity): CraftSession | null {
    const recipe = RECIPES.find((r) => r.id === recipeId);
    if (!recipe) return null;
    if (!isRecipeUnlocked(recipe, level)) return null;
    if (!recipe.inputs.every((i) => inv.has(i.id, i.count))) return null;
    return new CraftSession(recipe);
  }

  /** Total real seconds this recipe takes. */
  get duration(): number {
    return this.recipe.craftSeconds;
  }

  /** Progress in [0, 1]. */
  get progress(): number {
    if (this.duration <= 0) return 1;
    return Math.min(1, this.elapsed / this.duration);
  }

  /** True once the session ended (completed or cancelled). */
  get isOver(): boolean {
    return this.cancelled || this.finished;
  }

  /**
   * Advance the session by `dt` seconds (negative dt is ignored).
   * - 'crafting': still working (progress advanced).
   * - 'done': the full duration elapsed; inputs consumed and the output
   *   added exactly once, even for a dt that overshoots the duration.
   * - 'cancelled': the session was cancelled, or (safety net) the inputs
   *   are no longer all present — nothing is consumed.
   */
  tick(inv: Inventory, dt: number): CraftTickResult {
    if (this.cancelled || this.finished) return this.cancelled ? 'cancelled' : 'done';
    if (!this.recipe.inputs.every((i) => inv.has(i.id, i.count))) {
      this.cancelled = true;
      return 'cancelled';
    }
    this.elapsed += Math.max(dt, 0);
    if (this.elapsed < this.duration) return 'crafting';
    // Complete: consume inputs exactly once, add the output.
    for (const input of this.recipe.inputs) inv.remove(input.id, input.count);
    inv.add(this.recipe.output.id, this.recipe.output.count);
    this.finished = true;
    return 'done';
  }

  /** Cancel: the session is dropped and no materials are lost. */
  cancel(): void {
    this.cancelled = true;
  }
}

/** Pure crafting logic (Gameplay Agent scope). */
export class Crafting {
  static canCraft(inv: Inventory, recipe: Recipe, level: number = Infinity): boolean {
    return isRecipeUnlocked(recipe, level) && recipe.inputs.every((i) => inv.has(i.id, i.count));
  }

  /** Whether the recipe is unlocked at the given player level. */
  static isUnlocked(recipe: Recipe, level: number): boolean {
    return isRecipeUnlocked(recipe, level);
  }

  /**
   * Attempt to craft. Consumes inputs and adds output.
   * Returns the crafted item id, or null when inputs are missing.
   */
  static craft(inv: Inventory, recipeId: string, level: number = Infinity): string | null {
    const recipe = RECIPES.find((r) => r.id === recipeId);
    if (!recipe) return null;
    if (!Crafting.canCraft(inv, recipe, level)) return null;

    // Consume inputs first: this frees room for the output.
    for (const input of recipe.inputs) {
      inv.remove(input.id, input.count);
    }
    inv.add(recipe.output.id, recipe.output.count);
    return recipe.output.id;
  }

  /** All recipes the player can currently craft (unlocked AND affordable). */
  static available(inv: Inventory, level: number = Infinity): Recipe[] {
    return RECIPES.filter((r) => Crafting.canCraft(inv, r, level));
  }

  /** Craft time (seconds) for a recipe, 0 for unknown ids. */
  static craftSeconds(recipeId: string): number {
    const r = RECIPES.find((x) => x.id === recipeId);
    return r ? r.craftSeconds : 0;
  }

  static recipeName(id: string): string {
    const r = RECIPES.find((x) => x.id === id);
    if (!r) return id;
    return ITEMS[r.output.id].name;
  }

  static recipeCost(id: string): string {
    const r = RECIPES.find((x) => x.id === id);
    if (!r) return '';
    return r.inputs.map((i) => `${i.count} ${ITEMS[i.id].name}`).join(', ');
  }
}
