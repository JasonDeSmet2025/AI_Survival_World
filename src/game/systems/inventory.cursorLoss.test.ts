import { describe, expect, test } from 'vitest';
import { Inventory } from './inventory';

/**
 * Documents the item-loss sequence that `Game.closeInventory()` is only
 * safe against when NO slot changes while the panel is open: a gather
 * that refills the cursor's origin slot while the inventory is full makes
 * the held stack unplaceable on close, and the cursor is then null-ed
 * (silent item loss). The game shell prevents this by pausing gathering
 * while the inventory panel is open (game.ts `updateGathering` + the
 * invOpen gates on E/R), so this sequence is unreachable in-game.
 */
describe('QA repro: item loss via panel-open gather (pre-fix sequence)', () => {
  test('cursor stack dropped when origin slot refilled and no free slot left', () => {
    const inv = new Inventory();
    // 24/24 slots full: 23 wood stacks at cap (60, slots 0-22) + one berry stack (slot 23).
    for (let i = 0; i < 23; i++) inv.add('wood', 60);
    inv.add('berry', 3);
    expect(inv.slots.filter(Boolean).length).toBe(24);

    // Player opens the panel and picks up the berry stack from slot 23
    // (the only slot that can now refill via a finished gather).
    const cursor = inv.pickUp(23);
    const cursorFrom = 23;
    expect(cursor).not.toBeNull();
    expect(inv.slots[23]).toBeNull();

    // PRE-FIX: gathering ran while the panel was open. Every wood stack is
    // at cap, so the gathered wood lands in the only free slot: 23 — the
    // cursor's origin slot. The inventory is full again.
    inv.add('wood', 1);
    expect(inv.slots[23]).not.toBeNull();

    // closeInventory() logic (pre-fix):
    let cursorLeft: ReturnType<typeof inv.pickUp> = cursor;
    if (inv.slots[cursorFrom] === null) {
      cursorLeft = inv.place(cursorFrom, cursorLeft!);
    } else {
      const free = inv.slots.findIndex((s) => s === null);
      if (free !== -1) cursorLeft = inv.place(free, cursorLeft!);
      // else: nothing happens -> the held berry stack is silently lost
    }
    // Loss confirmed: the held stack could not be placed anywhere, yet
    // closeInventory() nulls the cursor unconditionally -> items gone.
    expect(cursorLeft).not.toBeNull();
    const total = inv.slots.reduce((n, s) => n + (s?.count ?? 0), 0);
    // Before the close the player owned 23*60 wood + 3 berries + the
    // gathered log = 1384; the 3 berries on the cursor are gone.
    expect(total).toBe(23 * 60 + 1);
  });
});
