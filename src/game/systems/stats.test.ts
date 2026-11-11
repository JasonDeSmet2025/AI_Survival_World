import { describe, expect, it } from 'vitest';
import { SurvivalStats, type Environment } from './stats';
import { computeRest } from './rest';

const DT = 1 / 60;

function env(over: Partial<Environment> = {}): Environment {
  return {
    sprinting: false,
    inWater: false,
    fireWarmth: 0,
    dayFactor: 1,
    ...over,
  };
}

function tick(stats: SurvivalStats, dt: number, e: Partial<Environment> = {}): number {
  const full = env(e);
  let damage = 0;
  for (let i = 0, n = Math.round(dt / DT); i < n; i++) damage += stats.update(DT, full);
  return damage;
}

describe('SurvivalStats sprint / exhaustion', () => {
  it('sprint drains stamina at 14/s while actually sprinting', () => {
    const s = new SurvivalStats();
    tick(s, 5, { sprinting: true });
    expect(s.stamina).toBeCloseTo(100 - 14 * 5, 1); // 30
    expect(s.exhausted).toBe(false);
  });

  it('walking (no sprint) regenerates stamina at 10/s', () => {
    const s = new SurvivalStats();
    s.stamina = 0;
    tick(s, 5);
    expect(s.stamina).toBeCloseTo(50, 1);
  });

  it('holding shift while sprint is blocked does NOT drain stamina', () => {
    // This is the game-shell guarantee: the controller only reports
    // sprinting=true when the canSprint gate passed, so stats never sees
    // "sprinting" for a blocked sprint. Verify the stats side: with
    // sprinting=false, stamina always regenerates, even from zero.
    const s = new SurvivalStats();
    s.stamina = 0;
    tick(s, 10);
    expect(s.stamina).toBeGreaterThan(0);
    expect(s.exhausted).toBe(false);
  });

  it('sprinting to empty stamina triggers the exhaustion lockout', () => {
    const s = new SurvivalStats();
    // 100 stamina / 14 per s => empty after ~7.14 s.
    tick(s, 8, { sprinting: true });
    expect(s.stamina).toBe(0);
    expect(s.exhausted).toBe(true);
    expect(s.canSprint()).toBe(false);
  });

  it('no stamina regens while exhausted; recovers after the lockout', () => {
    const s = new SurvivalStats();
    tick(s, 8, { sprinting: true });
    expect(s.exhausted).toBe(true);
    // Walk for 5 s (longer than the 4 s lockout).
    tick(s, 5);
    expect(s.exhausted).toBe(false);
    expect(s.stamina).toBeGreaterThan(0); // regen started once lockout ended
    // Sprinting is possible again once stamina exists.
    expect(s.canSprint()).toBe(true);
  });

  it('canSprint() gates on exhaustion, stamina and death', () => {
    const s = new SurvivalStats();
    expect(s.canSprint()).toBe(true);
    s.stamina = 0;
    expect(s.canSprint()).toBe(false);
    s.stamina = 100;
    tick(s, 8, { sprinting: true }); // exhaust
    expect(s.stamina).toBe(0);
    expect(s.canSprint()).toBe(false);
    s.stamina = 50; // hypothetical: exhausted but with stamina
    expect(s.canSprint()).toBe(false); // still locked by exhaustion
    const dead = new SurvivalStats();
    dead.dead = true;
    expect(dead.canSprint()).toBe(false);
  });

  it('sprint calorie drain only applies while actually sprinting', () => {
    const a = new SurvivalStats();
    const b = new SurvivalStats();
    tick(a, 120, { sprinting: true });
    tick(b, 120);
    // Sprinting burns hunger/thirst at 1.6x / 1.4x — b must be ahead.
    expect(a.hunger).toBeLessThan(b.hunger);
    expect(a.thirst).toBeLessThan(b.thirst);
  });

  it('snapshot/restore round-trips the exhaustion state', () => {
    const s = new SurvivalStats();
    tick(s, 8, { sprinting: true });
    const snap = s.snapshot();
    expect(snap.exhausted).toBe(true);
    const r = new SurvivalStats();
    r.restore(snap);
    expect(r.exhausted).toBe(true);
    expect(r.canSprint()).toBe(false);
    // Pre-exhaustion saves (no flag) restore as not exhausted.
    const legacy = { ...snap, exhausted: undefined };
    const r2 = new SurvivalStats();
    r2.restore(legacy as typeof snap);
    expect(r2.exhausted).toBe(false);
  });

  it('respawn clears exhaustion', () => {
    const s = new SurvivalStats();
    tick(s, 8, { sprinting: true });
    expect(s.exhausted).toBe(true);
    s.respawn();
    expect(s.exhausted).toBe(false);
    expect(s.stamina).toBe(100);
  });

  it('fireWarmth overrides the cold night target', () => {
    const s = new SurvivalStats();
    s.temperature = 20;
    tick(s, 10, { fireWarmth: 30, dayFactor: 0 });
    expect(s.temperature).toBeGreaterThan(25);
    // Without the fire the same night tick would pull the player down.
    // (Longer: temperature approaches its target at 0.08/s.)
    const cold = new SurvivalStats();
    cold.temperature = 20;
    tick(cold, 30, { dayFactor: 0 });
    expect(cold.temperature).toBeLessThan(10);
  });

  it('existing deprivation behaviour is unchanged (starvation, dehydration, freeze)', () => {
    const s = new SurvivalStats();
    s.hunger = 0;
    s.thirst = 0;
    const damage = tick(s, 2);
    expect(damage).toBeCloseTo((4 + 6) * 2, 1); // starve + dehydrate
    const cold = new SurvivalStats();
    cold.temperature = 0;
    tick(cold, 2);
    expect(cold.health).toBeLessThan(100); // freeze damage at 0°C
    expect(cold.dead).toBe(false); // 2.5 * 2 * (4-0) * 0.4 = 8 damage only
  });
});

describe('SurvivalStats.applyRest (bed sleep)', () => {
  it('applies the rested stats, refills stamina and clears exhaustion', () => {
    const s = new SurvivalStats();
    s.stamina = 0;
    tick(s, 8, { sprinting: true }); // exhausted, empty stamina
    expect(s.exhausted).toBe(true);

    const r = computeRest({ timeOfDay: 22 / 24, health: 55, hunger: 40, thirst: 35 });
    s.applyRest(r);

    expect(s.health).toBeCloseTo(r.health, 5);
    expect(s.hunger).toBeCloseTo(r.hunger, 5);
    expect(s.thirst).toBeCloseTo(r.thirst, 5);
    expect(s.stamina).toBe(100);
    expect(s.exhausted).toBe(false);
    expect(s.canSprint()).toBe(true);
    expect(s.dead).toBe(false);
  });

  it('a fatal rest kills the player', () => {
    const s = new SurvivalStats();
    const r = computeRest({ timeOfDay: 22 / 24, health: 10, hunger: 1, thirst: 1 });
    expect(r.died).toBe(true);
    s.applyRest(r);
    expect(s.dead).toBe(true);
    expect(s.health).toBe(0);
  });

  it('end-to-end: a well-fed evening sleep heals and refills the player', () => {
    const s = new SurvivalStats();
    s.health = 60;
    s.hunger = 90;
    s.thirst = 90;
    s.stamina = 20;
    s.applyRest(computeRest({
      timeOfDay: 22 / 24,
      health: s.health,
      hunger: s.hunger,
      thirst: s.thirst,
    }));
    expect(s.health).toBeGreaterThan(60); // regen during a well-fed sleep
    expect(s.stamina).toBe(100);
    expect(s.hunger).toBeLessThan(90);
    expect(s.dead).toBe(false);
  });
});

describe('SurvivalStats.takeDamage (instant hits, e.g. fall damage)', () => {
  it('applies the full amount and returns it', () => {
    const s = new SurvivalStats();
    expect(s.takeDamage(12)).toBe(12);
    expect(s.health).toBe(88);
    expect(s.dead).toBe(false);
  });

  it('clamps at zero health and kills the player', () => {
    const s = new SurvivalStats();
    s.health = 8;
    expect(s.takeDamage(50)).toBe(8);
    expect(s.health).toBe(0);
    expect(s.dead).toBe(true);
  });

  it('ignores non-positive amounts', () => {
    const s = new SurvivalStats();
    expect(s.takeDamage(0)).toBe(0);
    expect(s.takeDamage(-30)).toBe(0);
    expect(s.health).toBe(100);
    expect(s.dead).toBe(false);
  });

  it('does nothing for an already-dead player', () => {
    const s = new SurvivalStats();
    s.takeDamage(100);
    expect(s.dead).toBe(true);
    expect(s.takeDamage(50)).toBe(0);
  });

  it('accumulates across repeated hits', () => {
    const s = new SurvivalStats();
    s.takeDamage(30);
    s.takeDamage(30);
    expect(s.health).toBe(40);
    s.takeDamage(40);
    expect(s.health).toBe(0);
    expect(s.dead).toBe(true);
  });
});
