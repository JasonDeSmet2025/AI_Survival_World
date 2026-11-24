/**
 * The four elements — pure drop rules, no Babylon.
 *
 * Every kind of nature carries exactly one element, which is what pulls the
 * player into the corners of the map: fire only bonds to the crater's glassy
 * rocks, air shakes loose from leafy trees, earth clods slide out from under
 * the pines and dew gathers in the berry bushes. The crater is the jackpot
 * (high chance) but it sits on the volcano — a deliberate risk/reward.
 *
 * Rolls take the game rng so a seeded headless run drops exactly what the
 * browser will drop.
 */
import { BOWL_R, VOLCANO_HOME } from '../world/volcano';

/** Which element each harvested node kind can yield. */
export const ELEMENT_BY_NODE: Record<string, string> = {
  rock: 'element_fire',
  tree: 'element_air',
  pine: 'element_earth',
  bush: 'element_water',
};

/** Chance per harvest that the element shakes loose (outside the crater). */
export const ELEMENT_CHANCE = 0.14;

/** Chance for a rock harvested inside the crater rim to yield fire glass. */
export const CRATER_FIRE_CHANCE = 0.5;

/** Horizontal distance to the volcano centre that still counts as crater. */
export function inCrater(x: number, z: number): boolean {
  const dx = x - VOLCANO_HOME.x;
  const dz = z - VOLCANO_HOME.z;
  return Math.hypot(dx, dz) <= BOWL_R + 10;
}

/**
 * Roll the bonus element drop of one completed harvest. Returns the item id
 * and count (1, or a lucky 2), or null when the node keeps its secrets.
 */
export function rollElementDrop(
  kind: string,
  x: number,
  z: number,
  rng: () => number,
): { itemId: string; count: number } | null {
  const itemId = ELEMENT_BY_NODE[kind];
  if (!itemId) return null;
  const chance = kind === 'rock' && inCrater(x, z) ? CRATER_FIRE_CHANCE : ELEMENT_CHANCE;
  if (rng() >= chance) return null;
  return { itemId, count: rng() < 0.3 ? 2 : 1 };
}
