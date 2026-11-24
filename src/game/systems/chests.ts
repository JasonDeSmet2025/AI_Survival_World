/**
 * Loot chests in world landmarks (the witch's tower) — pure rules.
 *
 * A chest is opened ONCE per world: the id joins the `opened` set, which the
 * save file carries (SaveData.chests). Gold coins (core/items.ts `gold`) are
 * the currency the villagers negotiate for, so chests are the pure-discovery
 * income and the tower top is the heist that pays best.
 *
 * The gold roll uses the world rng passed in, so a headless test (or a
 * re-run of the same world seed) opens exactly the same strongbox.
 */

/** One gold payout: the chest's tier limits, generous but bounded. */
export const CHEST_TIERS: Record<'small' | 'great', { min: number; max: number; label: string }> = {
  // A bedside box in the servant quarters: a handful of coins.
  small: { min: 4, max: 11, label: 'een handvol munten' },
  // The witch's strongbox: real money — enough to make a villager's eyes go wide.
  great: { min: 28, max: 55, label: 'de sterkbak vol goud' },
};

export type Rng = () => number;

/** How many gold coins the tier rolls (inclusive bounds, whole coins). */
export function rollChestGold(tier: 'small' | 'great', rng: Rng): number {
  const t = CHEST_TIERS[tier];
  return Math.round(t.min + rng() * (t.max - t.min));
}

/** State of every chest in the world: which ids have already been emptied. */
export interface ChestState {
  opened: Set<string>;
}

export function emptyChestState(): ChestState {
  return { opened: new Set<string>() };
}

/**
 * Open a chest. Returns the gold payout, or null when it was already
 * emptied (the prompt then reads "leeg"). Mutates the state.
 */
export function openChest(
  state: ChestState,
  id: string,
  tier: 'small' | 'great',
  rng: Rng,
): { gold: number } | null {
  if (state.opened.has(id)) return null;
  state.opened.add(id);
  return { gold: rollChestGold(tier, rng) };
}

/** Plain-array form for the save file (validated on load). */
export function chestStateToArray(state: ChestState): string[] {
  return [...state.opened].sort();
}

export function chestStateFromArray(ids: readonly string[] | undefined): ChestState {
  const state = emptyChestState();
  for (const id of ids ?? []) {
    if (typeof id === 'string' && id.length > 0) state.opened.add(id);
  }
  return state;
}
