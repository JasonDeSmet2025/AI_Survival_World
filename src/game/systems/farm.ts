/**
 * Planter farming (Gameplay Agent scope) — pure logic, no Babylon.
 *
 * A planter is the one place in the game that GROWS rather than gathers: you
 * build it, it accumulates `growth` seconds while you are nearby, and once a
 * crop is ripe (E) it hands out berries. This mirrors the bush regrowth the
 * world already does, but on your own terms and inside your own base.
 *
 * Ownership: growth is only ticked for the owner of the planter (the same
 * semi-trusted model as campfire fuel, where the fire that burns is the one
 * you placed). In multiplayer a friend's planter simply stands still on your
 * screen — nobody can farm someone else's crops, and no client can invent
 * someone else's harvest.
 */
import type { BuildingData } from '../world/types';

/** Seconds of tending a crop needs before it is ripe. */
export const PLANTER_SECONDS = 90;

/** Berries a ripe planter hands out per pick. */
export const PLANTER_YIELD = 3;

/** How close the owner must be (metres) for a planter to keep growing. */
export const PLANTER_TEND_RADIUS = 18;

/** Item a planter produces. */
export const PLANTER_CROP = 'berry';

/** True when this building is a planter. */
export function isPlanter(b: BuildingData | null | undefined): boolean {
  return b?.kind === 'planter';
}

/** Growth accumulated so far, clamped into [0, PLANTER_SECONDS]. */
export function growthOf(b: BuildingData): number {
  const g = Number(b.growth);
  if (!Number.isFinite(g) || g < 0) return 0;
  return Math.min(PLANTER_SECONDS, g);
}

/** True when the crop is ripe and E can pick it. */
export function isRipe(b: BuildingData): boolean {
  return growthOf(b) >= PLANTER_SECONDS;
}

/**
 * Advance one planter by `dt` seconds. It only grows for its owner, only
 * while the owner stands within PLANTER_TEND_RADIUS (a field you never visit
 * does not quietly stock itself) and never past ripe.
 *
 * Returns the growth value after the tick, so the caller can detect the
 * moment a crop turns ripe and announce it exactly once.
 */
export function growPlanter(
  b: BuildingData,
  dt: number,
  ownerId: string,
  ownerPos: { x: number; z: number },
): number {
  if (!isPlanter(b)) return growthOf(b);
  const before = growthOf(b);
  if (before >= PLANTER_SECONDS) return before;
  if (b.ownerId !== ownerId) return before;
  if (!(dt > 0)) return before;
  if (Math.hypot(b.x - ownerPos.x, b.z - ownerPos.z) > PLANTER_TEND_RADIUS) return before;
  const next = Math.min(PLANTER_SECONDS, before + dt);
  b.growth = next;
  return next;
}

export interface PickResult {
  /** Whether fruit actually reached the bag. */
  picked: boolean;
  /** Berries that reached the bag. */
  gained: number;
  /** Berries the bag could not take (reported honestly, never destroyed). */
  missed: number;
  /** Why the pick failed ('not-ripe' / 'not-a-planter' / 'no-room'), when it did. */
  reason: string | null;
}

/**
 * Pick a ripe planter. The bag rules are the project's standing contract:
 * `Inventory.add` returns what did NOT fit. A completely full bag therefore
 * does NOT complete the pick (the crop keeps its fruit, nothing is
 * destroyed), and a partial fit reports the shortfall instead of pretending
 * the whole harvest arrived — exactly like animal drops and gathering.
 */
export function pickPlanter(
  b: BuildingData,
  inv: { add(id: string, n: number): number },
): PickResult {
  if (!isPlanter(b)) return { picked: false, gained: 0, missed: 0, reason: 'not-a-planter' };
  if (!isRipe(b)) return { picked: false, gained: 0, missed: 0, reason: 'not-ripe' };
  const missed = inv.add(PLANTER_CROP, PLANTER_YIELD);
  const gained = PLANTER_YIELD - missed;
  if (gained <= 0) {
    // add() took nothing (no room at all): the crop stays ripe.
    return { picked: false, gained: 0, missed, reason: 'no-room' };
  }
  // The pick happened: the crop restarts from zero.
  b.growth = 0;
  return { picked: true, gained, missed, reason: null };
}

/** Progress in [0,1] for the HUD prompt. */
export function planterFraction(b: BuildingData): number {
  return PLANTER_SECONDS <= 0 ? 1 : growthOf(b) / PLANTER_SECONDS;
}
