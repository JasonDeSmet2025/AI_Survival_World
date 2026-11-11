import { describe, expect, it } from 'vitest';
import {
  CAMPFIRE,
  addWood,
  burnFuel,
  isLit,
  justDied,
  nearlyOut,
  warmthAt,
  warmthFrom,
} from './campfire';
import { SurvivalStats } from './stats';

describe('campfire fuel', () => {
  it('burnFuel drains in real time', () => {
    expect(burnFuel(300, 60)).toBe(240);
    expect(burnFuel(300, 0)).toBe(300);
  });

  it('burnFuel clamps at zero and ignores negative dt', () => {
    expect(burnFuel(30, 60)).toBe(0);
    expect(burnFuel(30, -5)).toBe(30);
  });

  it('a freshly placed fire burns for its initial fuel, then dies', () => {
    let fuel: number = CAMPFIRE.initialFuel;
    for (let i = 0; i < 60; i++) fuel = burnFuel(fuel, 1); // one minute
    expect(fuel).toBe(CAMPFIRE.initialFuel - 60);
    expect(isLit(fuel)).toBe(true);
    expect(justDied(fuel, burnFuel(fuel, 1000))).toBe(true);
    expect(isLit(0)).toBe(false);
  });

  it('addWood adds one log and clamps at maxFuel', () => {
    expect(addWood(0)).toBe(CAMPFIRE.fuelPerWood);
    expect(addWood(300)).toBe(300 + CAMPFIRE.fuelPerWood);
    expect(addWood(CAMPFIRE.maxFuel)).toBe(CAMPFIRE.maxFuel);
    expect(addWood(undefined)).toBe(CAMPFIRE.fuelPerWood);
  });

  it('nearlyOut flags the final seconds of burn time', () => {
    expect(nearlyOut(45, 60)).toBe(true);
    expect(nearlyOut(61, 60)).toBe(false);
    expect(nearlyOut(0, 60)).toBe(false); // out, not "nearly"
  });
});

describe('campfire warmth', () => {
  it('warms at the fire and fades smoothly to zero at the radius', () => {
    expect(warmthAt(100, 0)).toBe(CAMPFIRE.warmCore);
    expect(warmthAt(100, CAMPFIRE.warmRadius)).toBe(0);
    expect(warmthAt(100, CAMPFIRE.warmRadius + 0.01)).toBe(0);
    // Continuous: just inside the radius is barely above zero.
    expect(warmthAt(100, CAMPFIRE.warmRadius - 0.05)).toBeGreaterThan(0);
    expect(warmthAt(100, CAMPFIRE.warmRadius - 0.05)).toBeLessThan(1);
  });

  it('falls off monotonically with distance', () => {
    const at = (d: number) => warmthAt(100, d);
    const seq = [0, 1, 2, 3, 4, 5, 5.99];
    for (let i = 1; i < seq.length; i++) expect(at(seq[i])).toBeLessThan(at(seq[i - 1]));
  });

  it('half-radius warmth still prevents freezing at night', () => {
    // Night ambient target is ~6..8 °C; the fire target at half radius is
    // 30 * (1 - 0.25) = 22.5 °C, far above the 4 °C freeze-damage threshold.
    expect(warmthAt(100, CAMPFIRE.warmRadius / 2)).toBeCloseTo(22.5, 1);
  });

  it('never exceeds the heat-damage threshold, even on top of the fire', () => {
    expect(CAMPFIRE.warmCore).toBeLessThan(34);
  });

  it('an extinguished fire never warms', () => {
    expect(warmthAt(0, 0)).toBe(0);
    expect(warmthAt(undefined, 0)).toBe(0);
  });

  it('warmthFrom picks the strongest fire', () => {
    const fires = [
      { fuel: 100, x: 0, z: 0 },
      { fuel: 100, x: 20, z: 0 },
      { fuel: 0, x: 1, z: 0 },
    ];
    // Standing 2 m from the near fire, 18 m from the far one.
    expect(warmthFrom(fires, 2, 0)).toBeCloseTo(warmthAt(100, 2), 5);
    // Standing between both, the closer one wins.
    const mid = warmthFrom(fires, 10, 0);
    expect(mid).toBeCloseTo(warmthAt(100, 8), 5);
  });

  it('integration: sitting by a lit fire at night prevents freeze damage', () => {
    const s = new SurvivalStats();
    s.temperature = 20;
    // Deep night, standing 1 m from a burning fire.
    for (let i = 0; i < 60 * 60; i++) {
      const dt = 1 / 60;
      const w = warmthAt(1000, 1);
      s.update(dt, {
        sprinting: false,
        inWater: false,
        fireWarmth: w,
        dayFactor: 0,
      });
    }
    // Temperature settles well above the freeze threshold and no freeze
    // damage is taken.
    expect(s.temperature).toBeGreaterThan(12);
    expect(s.health).toBe(100);
  });
});
