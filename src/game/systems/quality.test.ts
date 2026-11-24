import { describe, expect, it } from 'vitest';
import {
  FPS_BAD,
  FPS_GOOD,
  GOOD_SAMPLES_TO_RECOVER,
  SHADOW_COST,
  TIERS,
  newQualityState,
  settingsFor,
  stepQuality,
} from './quality';

const step = (state: ReturnType<typeof newQualityState>, fps: number) => stepQuality(state, fps);

describe('adaptive quality state machine', () => {
  it('starts at the top tier with native resolution', () => {
    const s = newQualityState();
    expect(s.tier).toBe('high');
    expect(settingsFor(s)).toEqual({ scale: 1.0, bloom: true, maxLights: 0, shadow: 'full' });
  });

  it('needs two bad samples before stepping down (one hitch is not a trend)', () => {
    const s = newQualityState();
    expect(step(s, 20)).toBe(false); // first bad sample: wait
    expect(step(s, 20)).toBe(true); // second: drop a tier
    expect(s.tier).toBe('medium');
    expect(step(s, 20)).toBe(false);
    expect(step(s, 20)).toBe(true);
    expect(s.tier).toBe('low');
  });

  it('the potato tier is the floor — it never goes lower', () => {
    const s = newQualityState();
    for (let i = 0; i < 20; i++) step(s, 5);
    expect(s.tier).toBe('potato');
    expect(step(s, 5)).toBe(false);
    expect(TIERS[TIERS.length - 1]).toBe('potato');
  });

  it('recovers only after a long comfortable streak, one tier at a time', () => {
    const s = newQualityState();
    step(s, 20);
    step(s, 20); // -> medium
    expect(s.tier).toBe('medium');
    for (let i = 0; i < GOOD_SAMPLES_TO_RECOVER - 1; i++) {
      expect(step(s, FPS_GOOD + 10)).toBe(false);
    }
    expect(step(s, FPS_GOOD + 10)).toBe(true);
    expect(s.tier).toBe('high');
  });

  it('a single dip inside the recovery streak resets it (no oscillation)', () => {
    const s = newQualityState();
    step(s, 20);
    step(s, 20); // -> medium
    for (let i = 0; i < GOOD_SAMPLES_TO_RECOVER - 1; i++) step(s, 70);
    step(s, 40); // falls back into the dead band -> streak resets
    for (let i = 0; i < GOOD_SAMPLES_TO_RECOVER - 1; i++) {
      expect(step(s, 70)).toBe(false);
    }
    // …so it stays on medium one more round.
    expect(s.tier).toBe('medium');
  });

  it('the dead band between bad and good keeps the current tier forever', () => {
    const s = newQualityState();
    step(s, 20);
    step(s, 20); // -> medium
    for (let i = 0; i < 30; i++) expect(step(s, 45)).toBe(false);
    expect(s.tier).toBe('medium');
  });

  it('every lower tier is cheaper: shadows shrink first, pixels only after', () => {
    for (let i = 1; i < TIERS.length; i++) {
      const prev = settingsFor({ tier: TIERS[i - 1], goodStreak: 0, badStreak: 0 });
      const next = settingsFor({ tier: TIERS[i], goodStreak: 0, badStreak: 0 });
      expect(next.scale).toBeGreaterThanOrEqual(prev.scale);
      expect(SHADOW_COST.indexOf(next.shadow)).toBeGreaterThan(SHADOW_COST.indexOf(prev.shadow));
      if (prev.maxLights > 0 && next.maxLights > 0) expect(next.maxLights).toBeLessThan(prev.maxLights);
      if (!prev.bloom) expect(next.bloom).toBe(false); // bloom never comes back on
    }
  });

  it('the caps sit above the always-on lights (sun+moon+camp fire)', () => {
    // potato = 4: the world's fixed lights must survive the cap.
    expect(settingsFor({ tier: 'potato', goodStreak: 0, badStreak: 0 }).maxLights).toBeGreaterThanOrEqual(4);
    expect(FPS_BAD).toBeLessThan(FPS_GOOD);
  });
});
