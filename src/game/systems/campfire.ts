/**
 * Campfire fuel + warmth simulation (Gameplay Agent scope).
 *
 * Pure logic, no Babylon imports: unit-testable in Node and reusable by a
 * future server-authoritative multiplayer backend.
 *
 * A campfire has a fuel reserve measured in seconds of burn time. One log
 * of wood adds FUEL_PER_WOOD seconds. Fuel drains in real time; at zero
 * the fire is out (no warmth, no light, no particles) until another log
 * is added, which re-lights it.
 *
 * Warmth is distance-based: inside WARM_RADIUS metres the fire raises the
 * player's target body temperature by WARM_CORE at the fire itself, fading
 * smoothly (quadratic) to exactly 0 at WARM_RADIUS. WARM_CORE stays below
 * the 34 °C heat-damage threshold in SurvivalStats, so camping on top of
 * the fire is safe — it prevents freezing, it does not burn you.
 */

export const CAMPFIRE = {
  /** Seconds of burn time added per log of wood. */
  fuelPerWood: 120,
  /** Fuel given to a freshly placed campfire (2.5 minutes). */
  initialFuel: 300,
  /** Maximum fuel reserve (1 hour). */
  maxFuel: 3600,
  /** Radius in metres of the warmth falloff. */
  warmRadius: 6,
  /** Target temperature contribution at the fire (°C). Must stay < 34 (heat damage). */
  warmCore: 30,
} as const;

/** True while the fire is lit (has fuel left). */
export function isLit(fuel: number | undefined): boolean {
  return (fuel ?? 0) > 0;
}

/** Add one log of wood; returns the new fuel value (clamped to maxFuel). */
export function addWood(fuel: number | undefined): number {
  return Math.min(CAMPFIRE.maxFuel, (fuel ?? 0) + CAMPFIRE.fuelPerWood);
}

/**
 * Advance fuel by dt seconds; returns the new fuel value.
 * Never goes negative.
 */
export function burnFuel(fuel: number, dt: number): number {
  return Math.max(0, fuel - Math.max(0, dt));
}

/** True when the fire went out during this tick (fuel crossed zero). */
export function justDied(prevFuel: number, newFuel: number): boolean {
  return prevFuel > 0 && newFuel <= 0;
}

/**
 * Warmth target (°C) contributed by one fire at a given distance.
 * Quadratic falloff from WARM_CORE at 0 m to exactly 0 at WARM_RADIUS
 * (continuous, no step at the boundary). An extinguished fire never
 * warms (a cold hearth is just ambient).
 */
export function warmthAt(fuel: number | undefined, distance: number): number {
  if (!isLit(fuel) || distance >= CAMPFIRE.warmRadius) return 0;
  const t = distance / CAMPFIRE.warmRadius; // 0 at fire, 1 at radius
  return CAMPFIRE.warmCore * (1 - t * t);
}

/**
 * Combined warmth target from several fires (the strongest one wins —
 * fire warmth is a target temperature, not an additive heat source).
 */
export function warmthFrom(
  fires: ReadonlyArray<{ fuel: number | undefined; x: number; z: number }>,
  px: number,
  pz: number,
): number {
  let best = 0;
  for (const f of fires) {
    const w = warmthAt(f.fuel, Math.hypot(f.x - px, f.z - pz));
    if (w > best) best = w;
  }
  return best;
}

/** True when the fuel reserve has less than `seconds` of burn time left. */
export function nearlyOut(fuel: number | undefined, seconds: number): boolean {
  return isLit(fuel) && (fuel ?? 0) <= seconds;
}
