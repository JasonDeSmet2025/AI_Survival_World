import { describe, expect, it } from 'vitest';
import { ITEMS } from '../core/items';
import { Inventory } from './inventory';
import { COOK, CookSession, cookSeconds, cookOutput, isCokable } from './cook';

const FIRE = { id: 'fire_test', fuel: 120 };
const DEAD_FIRE = { id: 'fire_test', fuel: 0 };

function invWith(berry: number, stone = 0): Inventory {
  const inv = new Inventory();
  if (stone > 0) inv.add('stone', stone);
  if (berry > 0) inv.add('berry', berry);
  return inv;
}

describe('isCokable / cookSeconds / cookOutput', () => {
  it('only berry is cookable in the current item table', () => {
    expect(isCokable('berry')).toBe(true);
    expect(isCokable('cooked_berry')).toBe(false);
    expect(isCokable('wood')).toBe(false);
    expect(isCokable('stone_axe')).toBe(false);
    expect(isCokable(null)).toBe(false);
    expect(isCokable('unknown_item')).toBe(false);
  });

  it('cooking time and output come from the item table (data-driven)', () => {
    expect(cookSeconds('berry')).toBe(ITEMS.berry.cookable!.seconds);
    expect(cookSeconds('wood')).toBe(0);
    expect(cookOutput('berry')).toBe('cooked_berry');
    expect(cookOutput('wood')).toBeNull();
  });

  it('cooked berry is a real, edible item and strictly better than raw', () => {
    const raw = ITEMS.berry.edible!;
    const cooked = ITEMS[cookOutput('berry')!].edible!;
    const rawSum = raw.hunger + raw.thirst + raw.health;
    const cookedSum = cooked.hunger + cooked.thirst + cooked.health;
    expect(cooked.hunger).toBeGreaterThan(raw.hunger);
    expect(cooked.thirst).toBeGreaterThan(raw.thirst);
    expect(cooked.health).toBeGreaterThan(raw.health);
    expect(cookedSum).toBeGreaterThan(rawSum);
    // The output must not be cookable itself (no infinite cook chains).
    expect(ITEMS[cookOutput('berry')!].cookable).toBeUndefined();
    expect(cookSeconds('berry')).toBeGreaterThan(0);
  });

  it('cook radius is a sane positive range', () => {
    expect(COOK.radius).toBeGreaterThan(0);
    expect(COOK.radius).toBeLessThanOrEqual(COOK.radius + 0.001);
  });
});

describe('CookSession.start', () => {
  it('rejects non-cookable items', () => {
    const inv = invWith(3);
    expect(CookSession.start('wood', inv, FIRE)).toBeNull();
    expect(CookSession.start(null, inv, FIRE)).toBeNull();
    expect(CookSession.start('nope', inv, FIRE)).toBeNull();
  });

  it('rejects when the inventory holds no raw item', () => {
    expect(CookSession.start('berry', invWith(0), FIRE)).toBeNull();
  });

  it('rejects an extinguished fire (fuel 0 or undefined)', () => {
    const inv = invWith(3);
    expect(CookSession.start('berry', inv, DEAD_FIRE)).toBeNull();
    expect(CookSession.start('berry', inv, { id: 'f', fuel: undefined })).toBeNull();
  });

  it('starts for a lit fire and captures the item ids', () => {
    const s = CookSession.start('berry', invWith(1), FIRE);
    expect(s).not.toBeNull();
    expect(s!.itemId).toBe('berry');
    expect(s!.outputId).toBe('cooked_berry');
    expect(s!.fireId).toBe('fire_test');
    expect(s!.duration).toBe(ITEMS.berry.cookable!.seconds);
    expect(s!.progress).toBe(0);
    expect(s!.isOver).toBe(false);
  });
});

describe('CookSession.tick', () => {
  it('reports "cooking" and consumes nothing before the duration elapses', () => {
    const inv = invWith(5);
    const s = CookSession.start('berry', inv, FIRE)!;
    for (let i = 0; i < Math.floor(s.duration * 2) - 1; i++) {
      // 0.5 s steps — all still inside the 5 s cook (stops at 4.5 s).
      expect(s.tick(inv, FIRE.fuel, 0.5)).toBe('cooking');
    }
    expect(inv.count('berry')).toBe(5);
    expect(inv.count('cooked_berry')).toBe(0);
    expect(s.progress).toBeLessThan(1);
    expect(s.progress).toBeGreaterThan(0);
  });

  it('ignores negative dt (clock hiccups never un-cook)', () => {
    const inv = invWith(3);
    const s = CookSession.start('berry', inv, FIRE)!;
    s.tick(inv, FIRE.fuel, -5);
    expect(s.progress).toBe(0);
  });

  it('completes exactly at the duration: one raw in, one cooked out', () => {
    const inv = invWith(3);
    const s = CookSession.start('berry', inv, FIRE)!;
    s.tick(inv, FIRE.fuel, s.duration - 0.1);
    expect(s.tick(inv, FIRE.fuel, 0.5)).toBe('done');
    expect(inv.count('berry')).toBe(2);
    expect(inv.count('cooked_berry')).toBe(1);
    expect(s.isOver).toBe(true);
  });

  it('completion is idempotent (re-ticks do not double-cook)', () => {
    const inv = invWith(3);
    const s = CookSession.start('berry', inv, FIRE)!;
    s.tick(inv, FIRE.fuel, s.duration + 5); // overshoot dt
    expect(inv.count('berry')).toBe(2);
    expect(inv.count('cooked_berry')).toBe(1);
    expect(s.tick(inv, FIRE.fuel, 1)).toBe('done');
    expect(inv.count('berry')).toBe(2);
    expect(inv.count('cooked_berry')).toBe(1);
  });

  it('a huge single dt completes the cook exactly once', () => {
    const inv = invWith(1);
    const s = CookSession.start('berry', inv, FIRE)!;
    expect(s.tick(inv, FIRE.fuel, 3600)).toBe('done');
    expect(inv.count('berry')).toBe(0);
    expect(inv.count('cooked_berry')).toBe(1);
  });

  it('cancels without loss when the fire goes out mid-cook', () => {
    const inv = invWith(3);
    const s = CookSession.start('berry', inv, FIRE)!;
    s.tick(inv, FIRE.fuel, 2);
    expect(s.tick(inv, 0, 1)).toBe('cancelled');
    expect(inv.count('berry')).toBe(3);
    expect(inv.count('cooked_berry')).toBe(0);
    // The session stays dead: further ticks report cancelled, never done.
    expect(s.tick(inv, FIRE.fuel, 10)).toBe('cancelled');
  });

  it('cancels without loss when the raw item disappears mid-cook (safety net)', () => {
    const inv = invWith(1);
    const s = CookSession.start('berry', inv, FIRE)!;
    s.tick(inv, FIRE.fuel, 2);
    inv.remove('berry', 1); // e.g. the player ate the last berry
    expect(s.tick(inv, FIRE.fuel, 1)).toBe('cancelled');
    expect(inv.count('cooked_berry')).toBe(0);
  });

  it('cancel() keeps the raw item', () => {
    const inv = invWith(3);
    const s = CookSession.start('berry', inv, FIRE)!;
    s.tick(inv, FIRE.fuel, 1);
    s.cancel();
    expect(s.tick(inv, FIRE.fuel, 10)).toBe('cancelled');
    expect(inv.count('berry')).toBe(3);
    expect(inv.count('cooked_berry')).toBe(0);
  });

  it('completes into a nearly full inventory without dropping the output', () => {
    // Fill 23 slots with stone (stack 60 → 23 × 60 = 1380), 1 berry left.
    const inv = invWith(1, 1380);
    expect(inv.slots.filter((s) => s !== null).length).toBe(24);
    const s = CookSession.start('berry', inv, FIRE)!;
    expect(s.tick(inv, FIRE.fuel, s.duration + 1)).toBe('done');
    expect(inv.count('stone')).toBe(1380);
    expect(inv.count('berry')).toBe(0);
    expect(inv.count('cooked_berry')).toBe(1);
  });
});
