import { describe, expect, it } from 'vitest';
import { computeRest, REST, REST_WAKE_TIME } from './rest';

const H = (hour: number) => hour / 24; // game-hour → time-of-day

describe('computeRest', () => {
  it('sleeps from evening to the fixed wake time (06:00)', () => {
    const r = computeRest({ timeOfDay: H(22), health: 100, hunger: 100, thirst: 100 });
    expect(r.wakeTime).toBe(REST_WAKE_TIME);
    expect(r.gameHoursSlept).toBeCloseTo(8, 5);
    // 8 h well fed: meters drain proportionally, no damage, health clamps at 100.
    expect(r.hunger).toBeCloseTo(100 - REST.hungerPerGameHour * 8, 5);
    expect(r.thirst).toBeCloseTo(100 - REST.thirstPerGameHour * 8, 5);
    expect(r.health).toBe(100); // 100 + regen clamps at the cap
    expect(r.died).toBe(false);
  });

  it('sleeping before the wake time only sleeps until that morning', () => {
    // 05:00 → 06:00 = 1 hour.
    const r = computeRest({ timeOfDay: H(5), health: 80, hunger: 50, thirst: 50 });
    expect(r.gameHoursSlept).toBeCloseTo(1, 5);
    expect(r.hunger).toBeCloseTo(50 - REST.hungerPerGameHour, 5);
    expect(r.thirst).toBeCloseTo(50 - REST.thirstPerGameHour, 5);
  });

  it('going to bed just after the wake time takes the long way around (≈24 h)', () => {
    const r = computeRest({ timeOfDay: H(6.1), health: 100, hunger: 100, thirst: 100 });
    expect(r.gameHoursSlept).toBeCloseTo(24 - 0.1, 5);
    // A full day of sleeping still costs, but at the reduced sleep rates:
    expect(r.hunger).toBeCloseTo(100 - REST.hungerPerGameHour * (24 - 0.1), 4);
    expect(r.thirst).toBeCloseTo(100 - REST.thirstPerGameHour * (24 - 0.1), 4);
    // Neither meter empties during the sleep → no deprivation damage,
    // health clamps at 100 with the small regen.
    expect(r.health).toBe(100);
    expect(r.died).toBe(false);
  });

  it('sleeping exactly at the wake time is a full 24 h sleep', () => {
    const r = computeRest({ timeOfDay: REST_WAKE_TIME, health: 100, hunger: 100, thirst: 100 });
    expect(r.gameHoursSlept).toBeCloseTo(24, 5);
  });

  it('wraps fractional / out-of-range input times sanely', () => {
    const a = computeRest({ timeOfDay: H(22), health: 50, hunger: 40, thirst: 40 });
    const b = computeRest({ timeOfDay: H(22) + 1, health: 50, hunger: 40, thirst: 40 });
    const neg = computeRest({ timeOfDay: H(22) - 1, health: 50, hunger: 40, thirst: 40 });
    // +24 h or −24 h of input describes the same sleep.
    for (const other of [b, neg]) {
      expect(other.wakeTime).toBe(a.wakeTime);
      expect(other.gameHoursSlept).toBeCloseTo(a.gameHoursSlept, 10);
      expect(other.hunger).toBeCloseTo(a.hunger, 10);
      expect(other.thirst).toBeCloseTo(a.thirst, 10);
      expect(other.health).toBeCloseTo(a.health, 10);
      expect(other.died).toBe(a.died);
    }
  });

  it('is deterministic and pure (same input → identical output, twice)', () => {
    const input = { timeOfDay: H(21.5), health: 63, hunger: 71, thirst: 55 };
    expect(computeRest(input)).toEqual(computeRest(input));
  });

  it('deprivation: hunger running out mid-sleep deals damage for the depleted hours', () => {
    // Hunger 20 lasts exactly 8 h at 2.5/h; an 8 h sleep → no depleted hour.
    const safe = computeRest({ timeOfDay: H(22), health: 100, hunger: 20, thirst: 100 });
    expect(safe.hunger).toBe(0);
    expect(safe.health).toBe(100); // no damage → only (capped) regen
    expect(safe.died).toBe(false);

    // Sleep 12 h (18:00 → 06:00) with hunger 20: depleted after 8 h → 4 h of damage.
    const starved = computeRest({ timeOfDay: H(18), health: 100, hunger: 20, thirst: 100 });
    expect(starved.hunger).toBe(0);
    expect(starved.health).toBeCloseTo(100 - REST.deprivationPerGameHour * 4, 5);
    expect(starved.died).toBe(false);
  });

  it('deprivation from both meters stacks', () => {
    // 8 h sleep; hunger 5 (lasts 2 h) and thirst 5 (lasts 5/3.3 h).
    const r = computeRest({ timeOfDay: H(22), health: 100, hunger: 5, thirst: 5 });
    const dmg =
      REST.deprivationPerGameHour * (8 - 5 / REST.hungerPerGameHour) +
      REST.deprivationPerGameHour * (8 - 5 / REST.thirstPerGameHour);
    expect(r.hunger).toBe(0);
    expect(r.thirst).toBe(0);
    expect(r.health).toBeCloseTo(100 - dmg, 5);
    expect(r.died).toBe(false);
  });

  it('a badly starved player can die in their sleep', () => {
    // 8 h sleep, nearly empty meters: damage ≈ 2/h × (7.6 h + 7.7 h) ≈ 30
    // → from 20 HP the player does not survive the night.
    const r = computeRest({ timeOfDay: H(22), health: 20, hunger: 1, thirst: 1 });
    expect(r.health).toBe(0);
    expect(r.died).toBe(true);
  });

  it('never exceeds the stat caps (health ≤ 100, meters ≥ 0)', () => {
    const r = computeRest({ timeOfDay: H(23), health: 100, hunger: 100, thirst: 100 });
    expect(r.health).toBeLessThanOrEqual(100);
    expect(r.hunger).toBeGreaterThanOrEqual(0);
    expect(r.thirst).toBeGreaterThanOrEqual(0);
    expect(r.health).toBe(100); // short well-fed sleep from full: clamped
  });
});
