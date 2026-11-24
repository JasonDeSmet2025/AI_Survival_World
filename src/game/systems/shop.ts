/**
 * The witch's potion shop — pure trade rules (no Babylon, no DOM).
 *
 * The witch does not sell crafted goods: she BARTERS potions for materials
 * the hunt and the mines provide (wool, leather, stone, berries). That
 * makes her the sink for hunting loot and the reason to carry a sword.
 * Trades mutate the inventory through a minimal structural interface so
 * this module (and its tests) never need the real Inventory class.
 */

/** What a trade needs from the player's bag (duck-typed Inventory). */
export interface TradeBag {
  count(id: string): number;
  /** Returns the amount that did NOT fit (same contract as Inventory.add). */
  add(id: string, count: number): number;
  remove(id: string, count: number): number;
}

export interface ShopOffer {
  id: string;
  /** Item the player receives. */
  gives: string;
  giveCount: number;
  /** Price as [itemId, count] pairs — all must be payable at once. */
  cost: Array<[string, number]>;
}

/** The witch's fixed shelf (potions are NOT craftable — barter only). */
export const SHOP_OFFERS: ShopOffer[] = [
  { id: 'heal', gives: 'potion_heal', giveCount: 1, cost: [['wool', 2], ['berry', 1]] },
  { id: 'swift', gives: 'potion_swift', giveCount: 1, cost: [['leather', 3]] },
  { id: 'night', gives: 'potion_night', giveCount: 1, cost: [['stone', 2], ['wool', 1]] },
  // --- the tower shelf: her stronger brews, priced in the hunt's rarer
  // haul (silk and herb come from her own towers — she happily sells the
  // overflow of her cauldron back to the person who harvested it).
  { id: 'fire', gives: 'potion_fire', giveCount: 1, cost: [['herb', 2], ['leather', 2]] },
  { id: 'strength', gives: 'potion_strength', giveCount: 1, cost: [['silk', 3], ['stone', 3]] },
  { id: 'tough', gives: 'potion_tough', giveCount: 1, cost: [['herb', 1], ['wool', 3]] },
  { id: 'herb', gives: 'herb', giveCount: 2, cost: [['berry', 3]] },
  // --- the element drawer: raw reagents for the young alchemist, priced
  // so that harvesting them yourself stays clearly the better deal.
  { id: 'fire_dust', gives: 'element_fire', giveCount: 2, cost: [['stone', 4], ['berry', 1]] },
  { id: 'water_dew', gives: 'element_water', giveCount: 2, cost: [['berry', 4]] },
  { id: 'air_feather', gives: 'element_air', giveCount: 2, cost: [['wood', 5]] },
  { id: 'earth_clod', gives: 'element_earth', giveCount: 2, cost: [['wood', 3], ['stone', 2]] },
];

/** True when every price component is present in the bag. */
export function canAfford(bag: TradeBag, offer: ShopOffer): boolean {
  return offer.cost.every(([id, n]) => bag.count(id) >= n);
}

/**
 * Execute a trade: returns true and moves the goods when affordable;
 * false (and touches nothing) otherwise. If the inventory cannot physically
 * place the potion (full bag), the payment is refunded and the trade fails.
 */
export function trade(bag: TradeBag, offer: ShopOffer): boolean {
  if (!canAfford(bag, offer)) return false;
  for (const [id, n] of offer.cost) bag.remove(id, n);
  const left = bag.add(offer.gives, offer.giveCount);
  if (left > 0) {
    // Refund — no partial trades.
    for (const [id, n] of offer.cost) bag.add(id, n);
    bag.remove(offer.gives, offer.giveCount - left);
    return false;
  }
  return true;
}

/** Human-readable Dutch price line, e.g. "2 wol + 1 bes". */
export function priceLabel(
  offer: ShopOffer,
  itemName: (id: string) => string,
  singular: (id: string) => string = itemName,
): string {
  return offer.cost
    .map(([id, n]) => `${n} ${n === 1 ? singular(id) : itemName(id)}`)
    .join(' + ');
}

/** Buff durations granted by the witch's potions (seconds; 0 = instant). */
export const POTION_BUFF_SECONDS: Record<string, number> = {
  potion_swift: 90,
  potion_night: 120,
  potion_fire: 120,
  potion_strength: 90,
  potion_tough: 90,
  // Raw elemental pinches: the same buff in miniature (systems/elements.ts
  // drops them, core/items.ts brews them into the full drink at the table).
  element_fire: 20,
  element_water: 20,
  element_air: 20,
  element_earth: 20,
};

/** Movement speed multiplier while the swiftness buff is active. */
export const SWIFT_SPEED_MULTIPLIER = 1.35;
