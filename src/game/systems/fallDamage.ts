/**
 * Fall damage model (pure logic, no rendering).
 *
 * The movement controller tracks the peak height of every airborne phase
 * and reports the landing distance (see PlayerController.consumeImpact).
 * This module turns that distance into health damage with a soft-landing
 * mitigation for players who are crouching at the moment of impact.
 *
 * Water is NOT a parameter here on purpose: the controller never reports
 * an impact at all when the fall ends in water (buoyant landing absorbs
 * the energy), so the model only ever sees solid-ground landings.
 */

/** Tuning constants (single source of truth, shared with tests). */
export const FALL_DAMAGE = {
  /**
   * Free-fall distance (world units) that always lands without damage.
   * Chosen above the full jump arc (~1.24 m: v²/2g with JUMP_VELOCITY 7.4
   * and GRAVITY 22) plus walking off small ledges.
   */
  safeDistance: 2.2,
  /** Health removed per unit of fall distance beyond the safe distance. */
  damagePerUnit: 3.5,
  /** Hard cap on the health a single fall can remove. */
  maxDamage: 95,
  /**
   * Crouching at impact extends the safe distance by this many units
   * (the player bends the knees on landing, Valheim-style soft landing).
   */
  crouchSafeBonus: 1.5,
  /** Damage beyond the (extended) safe distance is multiplied by this. */
  crouchMultiplier: 0.75,
} as const;

/**
 * Health removed by a fall of `distance` world units.
 *
 * @param distance peak-to-landing vertical distance (0..n, world units).
 * @param crouching true when the player was crouching at the moment of
 *   impact — grants the extended safe distance and reduced damage.
 * @returns 0 for safe falls, clamped to FALL_DAMAGE.maxDamage otherwise.
 */
export function computeFallDamage(distance: number, crouching = false): number {
  if (distance <= 0) return 0;
  const safe = FALL_DAMAGE.safeDistance + (crouching ? FALL_DAMAGE.crouchSafeBonus : 0);
  if (distance <= safe) return 0;
  const raw = (distance - safe) * FALL_DAMAGE.damagePerUnit * (crouching ? FALL_DAMAGE.crouchMultiplier : 1);
  return Math.min(FALL_DAMAGE.maxDamage, raw);
}
