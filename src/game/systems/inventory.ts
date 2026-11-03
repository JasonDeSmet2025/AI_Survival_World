import { ITEMS } from '../core/items';

export interface Slot {
  id: string;
  count: number;
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
        remaining -= put;
      }
    }
    // 2) New stacks in empty slots.
    for (let i = 0; i < this.slots.length && remaining > 0; i++) {
      if (this.slots[i]) continue;
      const put = Math.min(def.stack, remaining);
      this.slots[i] = { id, count: put };
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

  /** Drop 20% of each stack (death penalty). */
  applyDeathPenalty(): void {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s) continue;
      const keep = Math.ceil(s.count * 0.8);
      this.slots[i] = keep > 0 ? { id: s.id, count: keep } : null;
    }
  }

  serialize(): Array<[string, number] | null> {
    return this.slots.map((s) => (s ? [s.id, s.count] : null));
  }

  restore(data: Array<[string, number] | null>, selected = 0): void {
    this.slots = new Array(INVENTORY_SIZE).fill(null);
    if (!Array.isArray(data)) return;
    for (let i = 0; i < Math.min(INVENTORY_SIZE, data.length); i++) {
      const e = data[i];
      if (e && ITEMS[e[0]]) {
        const def = ITEMS[e[0]];
        this.slots[i] = { id: e[0], count: Math.min(def.stack, Math.max(1, e[1])) };
      }
    }
    this.selected = Math.min(Math.max(0, selected), HOTBAR_SIZE - 1);
  }
}
