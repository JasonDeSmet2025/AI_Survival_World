import { ITEMS } from '../core/items';
import type { Inventory } from './inventory';
import type { SurvivalStats } from './stats';

export interface ConsumeResult {
  /** True when an item was actually consumed and effects applied. */
  ok: boolean;
  /** Human-readable toast message (Dutch, matching the rest of the HUD). */
  message: string;
}

/**
 * Consumables (Gameplay Agent scope).
 *
 * Lets the player use a consumable item from the hotbar. All item effects
 * are data-driven from `ItemDef.edible`, so new food/drink items only need
 * an entry in core/items.ts.
 *
 * Pure logic: no rendering, no DOM — unit-testable.
 */

/** Whether the item can be consumed at all (has food effects). */
export function isConsumable(itemId: string | null): itemId is string {
  return itemId != null && ITEMS[itemId]?.edible != null;
}

/**
 * Consume one unit of the given item, applying its food effects to the
 * survival stats.
 *
 * Rules:
 * - Fails when the player is dead.
 * - Fails when the item is not a consumable.
 * - Fails when the inventory holds none of the item.
 * - On success removes exactly one unit and applies the effects
 *   (stats are clamped to 0..100 by SurvivalStats itself).
 */
export function consumeItem(
  itemId: string | null,
  inventory: Inventory,
  stats: SurvivalStats,
): ConsumeResult {
  if (stats.dead) {
    return { ok: false, message: 'Je bent dood' };
  }
  if (!isConsumable(itemId)) {
    return { ok: false, message: 'Dit kan je niet gebruiken' };
  }
  if (inventory.count(itemId) <= 0) {
    return { ok: false, message: 'Geen voorraad' };
  }

  const def = ITEMS[itemId];
  const effect = def.edible as { hunger: number; thirst: number; health: number };

  if (inventory.remove(itemId, 1) < 1) {
    return { ok: false, message: 'Geen voorraad' };
  }

  stats.eat(effect.hunger, effect.thirst);
  if (effect.health > 0) {
    stats.health = Math.min(100, stats.health + effect.health);
  }
  return { ok: true, message: `Gegeten: ${def.name} x1` };
}
