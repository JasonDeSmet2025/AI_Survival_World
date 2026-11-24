import { describe, expect, it } from 'vitest';
import { ITEMS } from '../core/items';
import {
  POTION_BUFF_SECONDS,
  SHOP_OFFERS,
  SWIFT_SPEED_MULTIPLIER,
  canAfford,
  priceLabel,
  trade,
  type ShopOffer,
  type TradeBag,
} from './shop';

/** Tiny bag double with the real Inventory semantics: add() returns the
 * amount that did NOT fit, remove() the amount actually removed. */
class FakeBag implements TradeBag {
  slots = new Map<string, { count: number; max: number }>();
  stackOf: (id: string) => number;
  constructor(init: Record<string, number> = {}, stackOf: (id: string) => number = () => 64) {
    this.stackOf = stackOf;
    for (const [id, n] of Object.entries(init)) this.slots.set(id, { count: n, max: stackOf(id) });
  }
  count(id: string): number {
    return this.slots.get(id)?.count ?? 0;
  }
  add(id: string, count: number): number {
    let remaining = count;
    const existing = this.slots.get(id);
    if (existing) {
      const room = Math.max(0, this.stackOf(id) - existing.count);
      const fit = Math.min(room, remaining);
      existing.count += fit;
      remaining -= fit;
    }
    if (remaining > 0) {
      this.slots.set(id, { count: remaining, max: this.stackOf(id) });
      remaining = 0;
    }
    return remaining;
  }
  remove(id: string, count: number): number {
    const s = this.slots.get(id);
    if (!s) return 0;
    const removed = Math.min(s.count, count);
    s.count -= removed;
    if (s.count <= 0) this.slots.delete(id);
    return removed;
  }
}

const heal = SHOP_OFFERS.find((o) => o.id === 'heal') as ShopOffer;
const swift = SHOP_OFFERS.find((o) => o.id === 'swift') as ShopOffer;

describe('witch shop offers', () => {
  it('every offer trades real, defined items both ways', () => {
    for (const o of SHOP_OFFERS) {
      expect(ITEMS[o.gives]).toBeDefined();
      for (const [id] of o.cost) expect(ITEMS[id]).toBeDefined();
    }
  });

  it('potions are barter-only consumables, not tools', () => {
    // (guards against someone adding recipe_potion later)
    const potions = SHOP_OFFERS.filter((o) => o.gives.startsWith('potion_'));
    expect(potions.length).toBeGreaterThanOrEqual(6);
    for (const o of potions) expect(ITEMS[o.gives].kind).toBe('food');
    // torenkruid is the one non-food good on her shelf: a crafting seed,
    // deliberately not a snack and not a tool
    const herb = SHOP_OFFERS.find((o) => o.gives === 'herb');
    expect(herb, 'she sells herb').toBeDefined();
    expect(ITEMS[herb!.gives].kind).toBe('resource');
  });
});

describe('affordability + trades', () => {
  it('canAfford requires every price component at once', () => {
    expect(canAfford(new FakeBag({ wool: 2, berry: 1 }), heal)).toBe(true);
    expect(canAfford(new FakeBag({ wool: 5, berry: 0 }), heal)).toBe(false);
    expect(canAfford(new FakeBag({ wool: 1, berry: 1 }), heal)).toBe(false);
  });

  it('a fair trade moves both sides exactly', () => {
    const bag = new FakeBag({ wool: 2, berry: 1 });
    expect(trade(bag, heal)).toBe(true);
    expect(bag.count('wool')).toBe(0);
    expect(bag.count('berry')).toBe(0);
    expect(bag.count('potion_heal')).toBe(1);
  });

  it('a failed trade is free — nothing moves when unaffordable', () => {
    const bag = new FakeBag({ wood: 9 });
    expect(trade(bag, swift)).toBe(false);
    expect(bag.count('wood')).toBe(9);
    expect(bag.count('potion_swift')).toBe(0);
  });

  it('a full bag refunds the payment instead of eating it', () => {
    // Simulate an inventory where NOTHING fits: add always returns count.
    const refusing: TradeBag = {
      count: (id) => (id === 'leather' ? 3 : 0),
      add: (_id, n) => n, // nothing fits
      remove: () => 1,
    };
    expect(trade(refusing, swift)).toBe(false);
  });
});

describe('presentation helpers + buffs', () => {
  it('priceLabel reads like human Dutch', () => {
    const names: Record<string, string> = { wool: 'wol', berry: 'bessen', leather: 'leder' };
    const line = priceLabel(heal, (id) => names[id] ?? id, (id) => (id === 'berry' ? 'bes' : names[id] ?? id));
    expect(line).toBe('2 wol + 1 bes');
  });

  it('buff timers cover both timed potions and the speed math', () => {
    expect(POTION_BUFF_SECONDS.potion_swift).toBe(90);
    expect(POTION_BUFF_SECONDS.potion_night).toBe(120);
    expect(SWIFT_SPEED_MULTIPLIER).toBeGreaterThan(1);
    expect(SWIFT_SPEED_MULTIPLIER).toBeLessThan(1.6); // not a teleport hack
  });
});
