import { ITEMS } from '../core/items';

export interface Slot {
  id: string;
  count: number;
  /**
   * Remaining durability for tool items (see ItemDef.tool).
   * Undefined on non-tools; a tool slot without durability is treated as
   * full (legacy save compatibility).
   */
  durability?: number;
}

export type Slots = Array<Slot | null>;

export const INVENTORY_SIZE = 24;
export const HOTBAR_SIZE = 8;

/**
 * Player inventory: fixed slot array, first HOTBAR_SIZE slots form the hotbar.
 * Pure logic, unit-testable.
 */
export class Inventory {
  slots: Slots = new Array(INVENTORY_SIZE).fill(null);
  selected = 0;

  count(id: string): number {
    let n = 0;
    for (const s of this.slots) if (s?.id === id) n += s.count;
    return n;
  }

  /** Add items; returns the amount that did NOT fit. */
  add(id: string, count: number): number {
    const def = ITEMS[id];
    if (!def || count <= 0) return count;
    let remaining = count;

    // 1) Top up existing stacks.
    for (const s of this.slots) {
      if (remaining <= 0) break;
      if (s && s.id === id && s.count < def.stack) {
        const put = Math.min(def.stack - s.count, remaining);
        s.count += put;
        // A freshly crafted/added unit is in full condition: merging keeps
        // the best-condition unit (tools are stack-1, so this rarely runs).
        if (def.tool && s.durability !== def.tool.maxDurability) {
          s.durability = def.tool.maxDurability;
        }
        remaining -= put;
      }
    }
    // 2) New stacks in empty slots.
    for (let i = 0; i < this.slots.length && remaining > 0; i++) {
      if (this.slots[i]) continue;
      const put = Math.min(def.stack, remaining);
      const slot: Slot = { id, count: put };
      if (def.tool) slot.durability = def.tool.maxDurability;
      this.slots[i] = slot;
      remaining -= put;
    }
    return remaining;
  }

  /** Remove up to `count` items; returns amount actually removed. */
  remove(id: string, count: number): number {
    let removed = 0;
    for (let i = 0; i < this.slots.length && removed < count; i++) {
      const s = this.slots[i];
      if (!s || s.id !== id) continue;
      const take = Math.min(s.count, count - removed);
      removed += take;
      s.count -= take;
      if (s.count <= 0) this.slots[i] = null;
    }
    return removed;
  }

  has(id: string, count: number): boolean {
    return this.count(id) >= count;
  }

  getSelected(): Slot | null {
    return this.slots[this.selected] ?? null;
  }

  select(index: number): void {
    if (index >= 0 && index < HOTBAR_SIZE) this.selected = index;
  }

  /** Swap two slots (reorder UI). */
  swap(a: number, b: number): void {
    if (a < 0 || b < 0 || a >= this.slots.length || b >= this.slots.length) return;
    const tmp = this.slots[a];
    this.slots[a] = this.slots[b];
    this.slots[b] = tmp;
  }

  /**
   * Pick up the ENTIRE stack in `index` (inventory UI cursor model).
   * The slot is emptied; the slot data is returned so the UI can hold it
   * and later re-place it with `place()`. Returns null for empty slots or
   * out-of-range indices.
   */
  pickUp(index: number): Slot | null {
    if (index < 0 || index >= this.slots.length) return null;
    const s = this.slots[index];
    if (!s) return null;
    this.slots[index] = null;
    return s;
  }

  /**
   * Place a held stack into slot `to` (inventory UI cursor model).
   * Semantics:
   * - empty target  -> the whole held stack is placed, returns null.
   * - same item     -> merge as much as the stack cap allows; any overflow
   *                    is returned as the leftover (null when it all fit).
   * - other item    -> swap: the held stack goes into the target and the
   *                    displaced stack is returned.
   * - out-of-range  -> nothing happens, the held stack is returned.
   * Tool durability is preserved through moves; a merge keeps the
   * best-condition unit (same rule as `add()`).
   */
  place(to: number, held: Slot): Slot | null {
    if (to < 0 || to >= this.slots.length) return { ...held };
    const target = this.slots[to];
    if (!target) {
      this.slots[to] = { ...held };
      return null;
    }
    const def = ITEMS[held.id];
    if (target.id === held.id) {
      const room = Math.max(0, def.stack - target.count);
      const put = Math.min(room, held.count);
      target.count += put;
      held.count -= put;
      if (def.tool) {
        const a = target.durability ?? def.tool.maxDurability;
        const b = held.durability ?? def.tool.maxDurability;
        target.durability = Math.max(a, b);
      }
      return held.count > 0 ? { ...held } : null;
    }
    const displaced = { ...target };
    this.slots[to] = { ...held };
    return displaced;
  }

  /**
   * Move an item from a normal slot to the hotbar slot `hotIndex`
   * (used by UI click). Returns true if anything moved.
   */
  moveToHotbar(fromSlot: number, hotIndex: number): boolean {
    if (hotIndex < 0 || hotIndex >= HOTBAR_SIZE) return false;
    const src = this.slots[fromSlot];
    if (!src) return false;
    if (this.slots[hotIndex] && this.slots[hotIndex].id === src.id) {
      // Stack-merge if possible.
      const def = ITEMS[src.id];
      const room = def.stack - this.slots[hotIndex]!.count;
      const move = Math.min(room, src.count);
      this.slots[hotIndex]!.count += move;
      src.count -= move;
      if (src.count <= 0) this.slots[fromSlot] = null;
      return true;
    }
    this.swap(fromSlot, hotIndex);
    return true;
  }

  /** Drop 20% of each stack (death penalty). Tool durability is kept. */
  applyDeathPenalty(): void {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s) continue;
      const keep = Math.ceil(s.count * 0.8);
      this.slots[i] = keep > 0 ? { id: s.id, count: keep, durability: s.durability } : null;
    }
  }

  /**
   * Serialize slots as [id, count, durability?] tuples. The third element
   * is only present for tools, so legacy [id, count] tuples stay valid.
   */
  serialize(): Array<[string, number, number?] | null> {
    return this.slots.map((s) =>
      s ? (s.durability !== undefined ? [s.id, s.count, s.durability] : [s.id, s.count]) : null,
    );
  }

  restore(data: Array<[string, number, number?] | null>, selected = 0): void {
    this.slots = new Array(INVENTORY_SIZE).fill(null);
    if (!Array.isArray(data)) return;
    for (let i = 0; i < Math.min(INVENTORY_SIZE, data.length); i++) {
      const e = data[i];
      if (!e || !ITEMS[e[0]]) continue;
      const def = ITEMS[e[0]];
      const slot: Slot = { id: e[0], count: Math.min(def.stack, Math.max(1, e[1])) };
      if (def.tool) {
        // Legacy saves have no third element → treat the tool as new.
        const stored = e[2];
        const d = stored === undefined ? def.tool.maxDurability : Math.max(0, Math.min(def.tool.maxDurability, stored));
        if (d <= 0) continue; // a fully worn-out tool is gone, not saved as 0
        slot.durability = d;
      }
      this.slots[i] = slot;
    }
    this.selected = Math.min(Math.max(0, selected), HOTBAR_SIZE - 1);
  }
}
