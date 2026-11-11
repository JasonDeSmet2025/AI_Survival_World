/**
 * Campfire cooking (Gameplay Agent scope).
 *
 * Pure logic, no Babylon imports: unit-testable in Node and reusable by a
 * future server-authoritative multiplayer backend.
 *
 * A player standing next to a LIT campfire can cook a cookable item
 * selected in the hotbar. Cooking takes real time (per the item's
 * `cookable` definition in core/items.ts); the raw item is consumed only
 * when the session completes, exactly once — the same safety contract as
 * timed crafting, so a cancelled or fire-killed cook loses nothing. The
 * fire's fuel is the gate: when the fire goes out the session cancels.
 */
import { ITEMS } from '../core/items';
import { isLit } from './campfire';
import type { Inventory } from './inventory';

export type CookTickResult = 'cooking' | 'done' | 'cancelled';

export const COOK = {
  /** Maximum distance (metres) from the fire at which cooking is possible. */
  radius: 3.0,
} as const;

/** Whether the item can be cooked at a campfire at all. */
export function isCokable(itemId: string | null): itemId is string {
  return itemId != null && ITEMS[itemId]?.cookable != null;
}

/** Cooking time (real seconds) for an item; 0 when it is not cookable. */
export function cookSeconds(itemId: string | null): number {
  return itemId ? (ITEMS[itemId]?.cookable?.seconds ?? 0) : 0;
}

/** The item id produced by cooking `itemId` (null when not cookable). */
export function cookOutput(itemId: string | null): string | null {
  return itemId ? (ITEMS[itemId]?.cookable?.output ?? null) : null;
}

/**
 * One in-progress timed-cook attempt (Gameplay Agent scope).
 *
 * The raw item is NOT consumed when the session starts — it is taken from
 * the inventory exactly once, when the session completes, and the cooked
 * output is added at the same moment. Cancelling (or the fire going out,
 * or the raw item disappearing) therefore loses nothing. The session is
 * transient and never persisted: a save while cooking simply resumes with
 * the raw item still in the inventory.
 */
export class CookSession {
  /** The raw item being cooked. */
  readonly itemId: string;
  /** The cooked item produced on completion. */
  readonly outputId: string;
  /** The campfire building id this cook runs next to. */
  readonly fireId: string;

  private elapsed = 0;
  private cancelled = false;
  private finished = false;

  private constructor(itemId: string, outputId: string, fireId: string) {
    this.itemId = itemId;
    this.outputId = outputId;
    this.fireId = fireId;
  }

  /**
   * Start a cook session for the selected item next to a fire.
   * Returns null when the item is unknown/not cookable, the inventory
   * holds none of it, or the fire is not lit.
   */
  static start(
    itemId: string | null,
    inv: Inventory,
    fire: { id: string; fuel?: number },
  ): CookSession | null {
    if (!isCokable(itemId)) return null;
    const def = ITEMS[itemId];
    const output = def.cookable as { output: string; seconds: number };
    if (inv.count(itemId) <= 0) return null;
    if (!isLit(fire.fuel)) return null;
    return new CookSession(itemId, output.output, fire.id);
  }

  /** Total real seconds this item takes to cook. */
  get duration(): number {
    const def = ITEMS[this.itemId];
    return (def.cookable as { output: string; seconds: number }).seconds;
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
   * `fuel` is the fire's CURRENT fuel: a fire that went out mid-cook
   * cancels the session (the raw item stays in the inventory).
   * - 'cooking': still cooking.
   * - 'done': the full duration elapsed next to a lit fire; the raw item
   *   was consumed and the cooked output added exactly once, even for a
   *   dt that overshoots the duration.
   * - 'cancelled': cancelled by the caller, by a dead fire, or (safety
   *   net) when the raw item is no longer in the inventory.
   */
  tick(inv: Inventory, fuel: number | undefined, dt: number): CookTickResult {
    if (this.cancelled || this.finished) return this.cancelled ? 'cancelled' : 'done';
    if (!isLit(fuel) || inv.count(this.itemId) <= 0) {
      this.cancelled = true;
      return 'cancelled';
    }
    this.elapsed += Math.max(dt, 0);
    if (this.elapsed < this.duration) return 'cooking';
    // Complete: consume the raw item exactly once, add the cooked output.
    inv.remove(this.itemId, 1);
    inv.add(this.outputId, 1);
    this.finished = true;
    return 'done';
  }

  /** Cancel: the session is dropped and the raw item is kept. */
  cancel(): void {
    this.cancelled = true;
  }
}
