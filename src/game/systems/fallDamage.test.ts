import { describe, expect, it } from 'vitest';
import { computeFallDamage, FALL_DAMAGE } from './fallDamage';

describe('computeFallDamage', () => {
  it('returns 0 for zero or negative distances', () => {
    expect(computeFallDamage(0)).toBe(0);
    expect(computeFallDamage(-5)).toBe(0);
  });

  it('never damages inside the safe distance', () => {
    // The full jump arc (~1.24 m) and small ledges are always safe.
    expect(computeFallDamage(0.1)).toBe(0);
    expect(computeFallDamage(1.24)).toBe(0);
    expect(computeFallDamage(FALL_DAMAGE.safeDistance)).toBe(0);
  });

  it('damages linearly beyond the safe distance', () => {
    const d = 5;
    const expected = (d - FALL_DAMAGE.safeDistance) * FALL_DAMAGE.damagePerUnit;
    expect(computeFallDamage(d)).toBeCloseTo(expected, 6);
  });

  it('is strictly monotonic beyond the safe distance', () => {
    // Up to the cap the curve must be strictly increasing.
    let prev = 0;
    for (let d = FALL_DAMAGE.safeDistance; d <= 25; d += 0.5) {
      const v = computeFallDamage(d);
      expect(v).toBeGreaterThanOrEqual(prev);
      if (d > FALL_DAMAGE.safeDistance) expect(v).toBeGreaterThan(prev);
      prev = v;
    }
    expect(prev).toBeLessThan(FALL_DAMAGE.maxDamage); // 25 m stays below the cap
  });

  it('caps a single fall at maxDamage', () => {
    expect(computeFallDamage(500)).toBe(FALL_DAMAGE.maxDamage);
    expect(computeFallDamage(100)).toBe(FALL_DAMAGE.maxDamage);
  });

  it('crouching extends the safe distance', () => {
    const extended = FALL_DAMAGE.safeDistance + FALL_DAMAGE.crouchSafeBonus;
    expect(computeFallDamage(extended, true)).toBe(0);
    // The same drop WOULD have damaged without crouching: the bonus is real.
    expect(extended).toBeGreaterThan(FALL_DAMAGE.safeDistance);
    expect(computeFallDamage(extended + 0.5, false)).toBeGreaterThan(0);
  });

  it('crouching reduces damage for the same drop', () => {
    for (const d of [5, 8, 15, 30]) {
      const standing = computeFallDamage(d);
      const crouched = computeFallDamage(d, true);
      expect(crouched).toBeLessThan(standing);
    }
  });

  it('crouch mitigation is bounded: the multiplier applies to the reduced excess', () => {
    const d = 10;
    const excess = d - (FALL_DAMAGE.safeDistance + FALL_DAMAGE.crouchSafeBonus);
    expect(computeFallDamage(d, true)).toBeCloseTo(
      Math.min(FALL_DAMAGE.maxDamage, excess * FALL_DAMAGE.damagePerUnit * FALL_DAMAGE.crouchMultiplier),
      6,
    );
  });

  it('never produces damage or NaN for absurd inputs', () => {
    for (const d of [1e-9, 1e6, Number.MAX_SAFE_INTEGER]) {
      const v = computeFallDamage(d);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(FALL_DAMAGE.maxDamage);
    }
  });
});
