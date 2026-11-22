/**
 * Pure animal logic (Gameplay scope): the animal roster, hunt balance and
 * the loot rolls. No Babylon imports, so all of it is unit-testable in
 * Node — the RENDERED animal (ai/animals.ts) and the game loop read these
 * exact numbers, the same contract building.ts sets for construction.
 *
 * The hunting model deliberately mirrors harvesting: holding F fills a
 * progress bar (one `hitSeconds` per swing), each completed swing lands one
 * hit, and a dead animal drops raw meat + its material (wool / leather).
 * Raw meat cooks on a campfire into a proper meal (see core/items.ts).
 */

export type AnimalKind = 'sheep' | 'cow';

export interface AnimalDrop {
  itemId: string;
  min: number;
  max: number;
}

export interface AnimalDef {
  /** Dutch display name (prompts, toasts). */
  name: string;
  /** Hits needed to take the animal down. */
  hits: number;
  /** Real seconds of holding F per landed hit. */
  hitSeconds: number;
  /** Seconds the animal runs away from the player after being hit. */
  fleeSeconds: number;
  /** Loot rolled on death — everything drops, Minecraft-style. */
  drops: AnimalDrop[];
}

export const ANIMALS: Record<AnimalKind, AnimalDef> = {
  sheep: {
    name: 'Schaap',
    hits: 3,
    hitSeconds: 0.6,
    fleeSeconds: 10,
    drops: [
      { itemId: 'raw_mutton', min: 1, max: 2 },
      { itemId: 'wool', min: 1, max: 2 },
    ],
  },
  cow: {
    name: 'Koe',
    hits: 4,
    hitSeconds: 0.6,
    fleeSeconds: 12,
    drops: [
      { itemId: 'raw_beef', min: 1, max: 3 },
      { itemId: 'leather', min: 1, max: 2 },
    ],
  },
};

/** Deterministic RNG shape used for loot (mulberry32 or Math.random). */
export type Rng = () => number;

/** Roll the loot table of a dead animal into concrete stacks. */
export function rollDrops(kind: AnimalKind, rng: Rng): Array<{ itemId: string; count: number }> {
  const def = ANIMALS[kind];
  const out: Array<{ itemId: string; count: number }> = [];
  if (!def) return out;
  for (const d of def.drops) {
    const span = Math.max(0, d.max - d.min);
    const count = d.min + Math.floor(rng() * (span + 1));
    if (count > 0) out.push({ itemId: d.itemId, count });
  }
  return out;
}

/**
 * A live animal's mutable combat state. Kept separate from the Babylon
 * object so the hit/flee/death bookkeeping is testable on its own.
 */
export class AnimalHealth {
  hp: number;
  constructor(kind: AnimalKind) {
    this.hp = ANIMALS[kind].hits;
  }
  get dead(): boolean {
    return this.hp <= 0;
  }
  /** Apply one hit; returns true when this hit was the killing blow. */
  hit(): boolean {
    if (this.hp <= 0) return false;
    this.hp -= 1;
    return this.hp <= 0;
  }
}

/**
 * Where a herd animal spawns. Given an angle + distance ring around camp,
 * returns the position; the caller checks terrain height (no water, no
 * cliffs) and retries with a new draw when the spot is unsuitable.
 */
export function herdSpot(
  camp: { x: number; z: number },
  rng: Rng,
  minDist = 14,
  maxDist = 42,
): { x: number; z: number } {
  const ang = rng() * Math.PI * 2;
  const dist = minDist + rng() * (maxDist - minDist);
  return { x: camp.x + Math.cos(ang) * dist, z: camp.z + Math.sin(ang) * dist };
}
