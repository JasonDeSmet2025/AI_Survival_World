import { describe, expect, it } from 'vitest';
import { Inventory } from './inventory';
import { SurvivalStats } from './stats';
import { consumeItem, isConsumable } from './consume';

describe('isConsumable', () => {
  it('accepts food items with edible definitions', () => {
    expect(isConsumable('berry')).toBe(true);
  });

  it('rejects non-food items and empty selection', () => {
    expect(isConsumable('wood')).toBe(false);
    expect(isConsumable('stone_axe')).toBe(false);
    expect(isConsumable('campfire')).toBe(false);
    expect(isConsumable(null)).toBe(false);
    expect(isConsumable('unknown_item')).toBe(false);
  });
});

describe('consumeItem', () => {
  it('eats a berry: removes one unit and restores stats', () => {
    const inv = new Inventory();
    inv.add('berry', 3);
    const stats = new SurvivalStats();
    stats.hunger = 40;
    stats.thirst = 30;
    stats.health = 50;

    const r = consumeItem('berry', inv, stats);

    expect(r.ok).toBe(true);
    expect(inv.count('berry')).toBe(2);
    expect(stats.hunger).toBeCloseTo(52);
    expect(stats.thirst).toBeCloseTo(35);
    expect(stats.health).toBeCloseTo(51);
  });

  it('clamps stats at 100 instead of overflowing', () => {
    const inv = new Inventory();
    inv.add('berry', 5);
    const stats = new SurvivalStats();
    stats.hunger = 99;
    stats.thirst = 99;
    stats.health = 100;

    const r = consumeItem('berry', inv, stats);

    expect(r.ok).toBe(true);
    expect(stats.hunger).toBe(100);
    expect(stats.thirst).toBe(100);
    expect(stats.health).toBe(100);
    expect(inv.count('berry')).toBe(4);
  });

  it('fails for non-consumable items and keeps inventory', () => {
    const inv = new Inventory();
    inv.add('wood', 5);
    const stats = new SurvivalStats();

    const r = consumeItem('wood', inv, stats);

    expect(r.ok).toBe(false);
    expect(inv.count('wood')).toBe(5);
    expect(stats.hunger).toBe(100);
  });

  it('fails with empty inventory', () => {
    const inv = new Inventory();
    const stats = new SurvivalStats();

    const r = consumeItem('berry', inv, stats);

    expect(r.ok).toBe(false);
    expect(stats.hunger).toBe(100);
  });

  it('fails when the player is dead', () => {
    const inv = new Inventory();
    inv.add('berry', 2);
    const stats = new SurvivalStats();
    stats.dead = true;

    const r = consumeItem('berry', inv, stats);

    expect(r.ok).toBe(false);
    expect(inv.count('berry')).toBe(2);
  });

  it('fails on null selection', () => {
    const inv = new Inventory();
    inv.add('berry', 1);
    const stats = new SurvivalStats();

    const r = consumeItem(null, inv, stats);

    expect(r.ok).toBe(false);
    expect(inv.count('berry')).toBe(1);
  });
});
