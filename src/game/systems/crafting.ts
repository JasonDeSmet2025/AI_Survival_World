import { RECIPES, ITEMS, type Recipe } from '../core/items';
import { isRecipeUnlocked } from './progress';
import type { Inventory } from './inventory';

export type CraftTickResult = 'crafting' | 'blocked' | 'done' | 'cancelled';

/**
 * The tekentafel (`workbench`) is the game's ONE work station, and it does
 * two independent things when the player stands within BENCH_RADIUS of their
 * OWN table:
 *
 * 1. STATION — every recipe that is not flagged `fieldRecipe` in core/items
 *    can only be made here: tools, rope, torches and the table itself are
 *    hand work, everything else (walls, bed, bow, stew, shield, …) is table
 *    work. That is the whole tech tree, and it is what keeps the craft menu
 *    short while the player is still bare-handed.
 * 2. WORKSHOP BONUS — the craft time divides by BENCH_SPEED_SCALE.
 *
 * Both rules read the same `nearestWorkbench()` answer, so the menu can never
 * offer something the session would then refuse. Like the speed bonus, the
 * station is deliberately NOT a second recipe table: there stays one list,
 * one set of ids and one save format.
 */
export const BENCH_RADIUS = 3;
export const BENCH_SPEED_SCALE = 1.4;

/**
 * Whether a recipe must be made at the table. The DEFAULT IS "yes": only an
 * explicit `fieldRecipe: true` in core/items.ts lets a recipe be made in the
 * open field, so new recipes join the table by default (see Recipe).
 */
export function needsTable(recipe: Recipe): boolean {
  return recipe.fieldRecipe !== true;
}

/** Recipes that are always available (no station), in table order. */
export function handRecipes(): Recipe[] {
  return RECIPES.filter((r) => !needsTable(r));
}

/**
 * Menu sections. The ORDER of the craft list is a design decision, so it
 * lives here in pure data (same rule as KEYBIND_GROUPS in systems/keybinds):
 * the HUD stays a renderer and the grouping is unit-testable.
 *
 * Two levels: first the STATION (hand work vs. table work — that is the
 * question the player acts on), then what the result is FOR. Every output id
 * is listed explicitly, and `craftGroupOf` falls back to the item kind, so a
 * new recipe always lands in a real section instead of disappearing.
 */
export type CraftGroupId = 'start' | 'tools' | 'camp' | 'build' | 'fight' | 'food' | 'other';

/** Dutch section titles, in menu order. */
export const CRAFT_GROUP_LABEL: Record<CraftGroupId, string> = {
  start: 'Start',
  tools: 'Gereedschap',
  camp: 'Kamp & licht',
  build: 'Bouw',
  fight: 'Vechten',
  food: 'Eten & drinken',
  other: 'Overig',
};

/** The section order inside each station. */
export const CRAFT_GROUP_ORDER: CraftGroupId[] = ['start', 'camp', 'tools', 'fight', 'build', 'food', 'other'];

const GROUP_BY_OUTPUT: Record<string, CraftGroupId> = {
  workbench: 'start',
  stone_axe: 'tools',
  stone_pick: 'tools',
  campfire: 'camp',
  torch: 'camp',
  rope: 'camp',
  sword: 'fight',
  shield: 'fight',
  bow: 'fight',
  arrow: 'fight',
  stew: 'food',
};

/** Which menu section a recipe belongs to. */
export function craftGroupOf(recipe: Recipe): CraftGroupId {
  const explicit = GROUP_BY_OUTPUT[recipe.output.id];
  if (explicit) return explicit;
  const kind = ITEMS[recipe.output.id]?.kind;
  if (kind === 'building') return 'build';
  if (kind === 'tool') return 'tools';
  if (kind === 'food') return 'food';
  return 'other';
}

/** Minimal shape `nearestWorkbench` needs (world state buildings qualify). */
export interface WorkbenchLike {
  kind: string;
  x: number;
  z: number;
  ownerId: string;
}

/**
 * The player's own nearest workbench inside BENCH_RADIUS, or null.
 * Only your own bench counts: helping a friend craft faster would be a
 * free upgrade you cannot build, earn or lose.
 */
export function nearestWorkbench<T extends WorkbenchLike>(
  buildings: T[],
  pos: { x: number; z: number },
  ownerId: string,
): T | null {
  let best: T | null = null;
  let bestD = BENCH_RADIUS;
  for (const b of buildings) {
    if (b.kind !== 'workbench' || b.ownerId !== ownerId) continue;
    const d = Math.hypot(b.x - pos.x, b.z - pos.z);
    if (d <= bestD) {
      best = b;
      bestD = d;
    }
  }
  return best;
}

/**
 * One in-progress timed-craft attempt (Gameplay Agent scope).
 *
 * Inputs are NOT reserved or consumed when the session starts — they are
 * taken from the inventory exactly once, when the session completes.
 * Cancelling (or the player dying mid-craft) therefore loses nothing:
 * the materials were never touched. This keeps the state machine pure and
 * trivially save-safe (a session is transient and never persisted).
 *
 * The same contract holds for the OUTPUT: a session only completes when
 * the crafted item actually fits in the bag (the input removals count as
 * free space). If the bag fills up mid-craft the session goes to
 * 'blocked' — work paused at 100 %, materials intact — and finishes the
 * moment the player makes room. A completed craft never destroys items.
 */
export class CraftSession {
  readonly recipe: Recipe;

  private elapsed = 0;
  private cancelled = false;
  private finished = false;
  private blocked = false;
  /** Workshop speed multiplier (1 = no bench, see BENCH_SPEED_SCALE). */
  private speed = 1;

  private constructor(recipe: Recipe, speed = 1) {
    this.recipe = recipe;
    this.speed = Number.isFinite(speed) && speed > 0 ? speed : 1;
  }

  /**
   * Start a session for `recipeId`. Returns null when the recipe is
   * unknown, NOT UNLOCKED at `level`, needs the table while `atTable` is
   * false, the inventory does not hold all inputs, or the output has nowhere
   * to go (a craft whose result cannot fit in the bag would only destroy the
   * materials). `level` and `atTable` default to the unrestricted values so
   * callers without a progression or station state (legacy tests, tools) keep
   * the old behaviour.
   */
  static start(
    inv: Inventory,
    recipeId: string,
    level: number = Infinity,
    speedScale = 1,
    atTable = true,
  ): CraftSession | null {
    const recipe = RECIPES.find((r) => r.id === recipeId);
    if (!recipe) return null;
    if (!isRecipeUnlocked(recipe, level)) return null;
    if (needsTable(recipe) && !atTable) return null;
    if (!Crafting.canCraft(inv, recipe, level)) return null;
    return new CraftSession(recipe, speedScale);
  }

  /** Total real seconds this recipe takes (workshop bonus already applied). */
  get duration(): number {
    return this.recipe.craftSeconds / this.speed;
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

  /** True while a full bag holds the finished craft back (work paused). */
  get isBlocked(): boolean {
    return this.blocked;
  }

  /**
   * Advance the session by `dt` seconds (negative dt is ignored).
   * - 'crafting': still working (progress advanced).
   * - 'blocked': the work is done but the output does not fit; progress
   *   stays at 1, nothing is consumed and the session keeps waiting for
   *   room (a later tick completes as soon as space exists).
   * - 'done': the full duration elapsed with room available; inputs
   *   consumed and the output added exactly once, even for a dt that
   *   overshoots the duration.
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
    if (this.elapsed < this.duration) {
      this.blocked = false;
      return 'crafting';
    }
    // Work finished. The inputs may only be touched now, and only when the
    // result fits: canAdd simulates the removals first, so a craft that
    // frees space out of its own materials is never blocked by mistake.
    if (!inv.canAdd(this.recipe.output.id, this.recipe.output.count, this.recipe.inputs)) {
      this.elapsed = this.duration;
      this.blocked = true;
      return 'blocked';
    }
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
  /**
   * Whether this recipe can be started right now: unlocked, made at the
   * right place (`atTable`), affordable AND with room for the output (in a
   * full bag a craft would only eat the materials, so it is not offered).
   *
   * NOTE: `atTable` defaults to true so the pure inventory question ("could
   * this be made at all?") stays answerable without a world. The GAME always
   * passes the real answer — see Game.atWorkbench().
   */
  static canCraft(
    inv: Inventory,
    recipe: Recipe,
    level: number = Infinity,
    atTable = true,
  ): boolean {
    if (!isRecipeUnlocked(recipe, level)) return false;
    if (needsTable(recipe) && !atTable) return false;
    if (!recipe.inputs.every((i) => inv.has(i.id, i.count))) return false;
    return inv.canAdd(recipe.output.id, recipe.output.count, recipe.inputs);
  }

  /** Whether the recipe is unlocked at the given player level. */
  static isUnlocked(recipe: Recipe, level: number): boolean {
    return isRecipeUnlocked(recipe, level);
  }

  /**
   * Attempt to craft. Consumes inputs and adds output.
   * Returns the crafted item id, or null when inputs are missing or the
   * output has nowhere to go — in that case nothing is consumed at all.
   */
  static craft(
    inv: Inventory,
    recipeId: string,
    level: number = Infinity,
    atTable = true,
  ): string | null {
    const recipe = RECIPES.find((r) => r.id === recipeId);
    if (!recipe) return null;
    if (!Crafting.canCraft(inv, recipe, level, atTable)) return null;

    // Consume inputs first: this frees room for the output.
    for (const input of recipe.inputs) {
      inv.remove(input.id, input.count);
    }
    inv.add(recipe.output.id, recipe.output.count);
    return recipe.output.id;
  }

  /**
   * All recipes the player can currently craft (unlocked, affordable and —
   * for table recipes — standing at their own table).
   */
  static available(inv: Inventory, level: number = Infinity, atTable = true): Recipe[] {
    return RECIPES.filter((r) => Crafting.canCraft(inv, r, level, atTable));
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
