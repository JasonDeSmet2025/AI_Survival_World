import { describe, expect, it } from 'vitest';
import {
  ANIMAL_MELEE_DAMAGE,
  PUNCH_DAMAGE,
  PVP_HIT_MIN_INTERVAL,
  PVP_MAX_HIT_DISTANCE,
  SWING_ANIM_TIME,
  SWING_COOLDOWN,
  SWING_RANGE,
  SWORD_PLAYER_DAMAGE,
  animalMeleeDamage,
  canSwing,
  inSwingRange,
  playerMeleeDamage,
  validIncomingHit,
} from './combat';
import { ANIMALS } from './fauna';

describe('swing gating', () => {
  it('blocks swings until the cooldown expired', () => {
    expect(canSwing(0, -100)).toBe(true);
    expect(canSwing(10, 10)).toBe(false);
    expect(canSwing(10, 10 - SWING_COOLDOWN)).toBe(true);
    expect(canSwing(10, 10 - SWING_COOLDOWN + 0.01)).toBe(false);
  });

  it('only allows strikes within arm+blade reach', () => {
    expect(inSwingRange(0)).toBe(true);
    expect(inSwingRange(SWING_RANGE)).toBe(true);
    expect(inSwingRange(SWING_RANGE + 0.1)).toBe(false);
  });

  it('the swing animation is shorter than the cooldown (no idle lock)', () => {
    expect(SWING_ANIM_TIME).toBeLessThan(SWING_COOLDOWN);
  });
});

describe('weapon damage', () => {
  it('the sword two-shots every animal in the roster', () => {
    expect(ANIMAL_MELEE_DAMAGE.sword).toBe(2);
    // Sheep (3 hits) dies in ceil(3/2) = 2 sword strikes; cow (4) in 2.
    for (const def of Object.values(ANIMALS)) {
      const strikes = Math.ceil(def.hits / animalMeleeDamage('sword'));
      expect(strikes).toBeLessThanOrEqual(2);
      expect(animalMeleeDamage('sword') * strikes).toBeGreaterThanOrEqual(def.hits);
    }
  });

  it('hands and tools never hurt animals — F stays the unarmed hunt path', () => {
    expect(animalMeleeDamage(null)).toBe(0);
    expect(animalMeleeDamage('stone_axe')).toBe(0);
    expect(animalMeleeDamage('wood')).toBe(0);
  });

  it('the sword hits players exactly as hard as the crafted bow dart', () => {
    expect(SWORD_PLAYER_DAMAGE).toBe(16); // matches bow dart damage in items.ts
    expect(playerMeleeDamage('sword')).toBe(SWORD_PLAYER_DAMAGE);
    expect(playerMeleeDamage(null)).toBe(PUNCH_DAMAGE);
    expect(playerMeleeDamage('stone_pick')).toBe(PUNCH_DAMAGE);
  });
});

describe('incoming hit validation (victim side)', () => {
  const ok = { distance: 4, dmg: 16, sinceLastHit: 5 };

  it('accepts a fair duel hit', () => {
    expect(validIncomingHit(ok.distance, ok.dmg, ok.sinceLastHit)).toBe(true);
  });

  it('refuses out-of-range, over/under damage and hit-spam', () => {
    expect(validIncomingHit(PVP_MAX_HIT_DISTANCE + 0.1, 16, 5)).toBe(false);
    expect(validIncomingHit(4, SWORD_PLAYER_DAMAGE + 1, 5)).toBe(false);
    expect(validIncomingHit(4, 0, 5)).toBe(false);
    expect(validIncomingHit(4, 16, PVP_HIT_MIN_INTERVAL - 0.01)).toBe(false);
  });

  it('rejects nonsense distances', () => {
    expect(validIncomingHit(Number.NaN, 16, 5)).toBe(false);
  });
});
