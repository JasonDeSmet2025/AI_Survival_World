/**
 * Tool wear + breakage (Gameplay Agent scope).
 * Pure logic — no rendering, testable in isolation.
 *
 * A tool in the SELECTED hotbar slot wears down while the player is
 * actively gathering a node kind the tool is effective on (see
 * toolForNode). When durability reaches 0 the tool breaks: the slot is
 * emptied and gathering falls back to bare hands automatically because
 * the selected slot no longer holds the tool.
 */
import { ITEMS, toolForNode } from '../core/items';
import type { Inventory } from './inventory';

export interface ToolInfo {
  id: string;
  maxDurability: number;
  wearPerSec: number;
}

export interface WearResult {
  /** True when the tool just broke (slot removed). */
  broke: boolean;
  /** Item id that was worn (or broke), null when the slot held no tool. */
  itemId: string | null;
}

/** Wear model for the given item id, or null when it is not a tool. */
export function toolInfo(itemId: string | null): ToolInfo | null {
  if (!itemId) return null;
  const tool = ITEMS[itemId]?.tool;
  if (!tool) return null;
  return { id: itemId, maxDurability: tool.maxDurability, wearPerSec: tool.wearPerSec };
}

/**
 * True when `itemId` is the tool that works on this node kind.
 * Gathering only wears the matching tool: swinging a pickaxe at a tree
 * or an axe at a rock does no damage to the tool (it has no effect on
 * the node either, so nothing is spent).
 */
export function isEffectiveTool(itemId: string | null, nodeKind: string): boolean {
  return itemId !== null && itemId === toolForNode(nodeKind);
}

/**
 * Remaining durability of a slot's tool (undefined for non-tools).
 * A tool slot without an explicit durability value is treated as full
 * (legacy save compatibility).
 */
export function slotDurability(inv: Inventory, slotIndex: number): { current: number; max: number } | null {
  const s = inv.slots[slotIndex];
  if (!s) return null;
  const info = toolInfo(s.id);
  if (!info) return null;
  return { current: s.durability ?? info.maxDurability, max: info.maxDurability };
}

/**
 * Drain durability of the tool in slot `slotIndex` by `dt` seconds of
 * active use. Breaks the tool (empties the slot) when durability hits 0.
 * No-op for empty slots and non-tool items.
 */
export function wearTool(inv: Inventory, slotIndex: number, dt: number): WearResult {
  const s = inv.slots[slotIndex];
  if (!s) return { broke: false, itemId: null };
  const info = toolInfo(s.id);
  if (!info) return { broke: false, itemId: null };
  if (dt <= 0) return { broke: false, itemId: s.id };

  const current = s.durability ?? info.maxDurability;
  const next = current - info.wearPerSec * dt;
  if (next <= 0) {
    inv.slots[slotIndex] = null;
    return { broke: true, itemId: s.id };
  }
  s.durability = next;
  return { broke: false, itemId: s.id };
}

/** Estimated remaining harvests for a slot's tool at the given per-harvest duration. */
export function remainingUses(inv: Inventory, slotIndex: number, harvestSecondsPerHit: number): number | null {
  const d = slotDurability(inv, slotIndex);
  if (!d) return null;
  const info = toolInfo(inv.slots[slotIndex]!.id);
  if (!info || harvestSecondsPerHit <= 0) return null;
  // Each harvest spends wearPerSec * harvestSeconds of durability.
  const perHit = info.wearPerSec * harvestSecondsPerHit;
  if (perHit <= 0) return null;
  return Math.floor(d.current / perHit);
}
