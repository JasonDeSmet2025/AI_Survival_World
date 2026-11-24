/**
 * Pure melee combat rules (no Babylon) so damage maths, cooldowns and the
 * PvP trust checks are unit-testable in Node.
 *
 * The combat model deliberately reuses the existing hit economy:
 *  - Animals track HP in whole "hits" (see systems/fauna.ts `AnimalHealth`).
 *    A bare hand removes 1 hit; a stone sword removes 2 — so a sheep (3)
 *    dies in two sword strikes and a cow (4) in two as well, while the
 *    harvest-F hunting flow stays the unarmed path.
 *  - Players share the 0..100 health pool (systems/stats.ts). A sword
 *    strike does PLAYER_DAMAGE_PER_HIT; hand punches are a token 2.
 *
 * Multiplayer: hits are applied by the VICTIM (each client owns its stats).
 * The attacker sends `hit` through the server, which forwards after its own
 * distance/rate check, and the victim re-validates range with
 * `validIncomingHit` before subtracting health. Trust model: same as the
 * rest of the MP layer (semi-trusted friends' server).
 */

/** Item id -> melee damage against animals (in whole animal hits). */
export const ANIMAL_MELEE_DAMAGE: Record<string, number> = {
  sword: 2,
};

// ---------------------------------------------------------------------------
// The witch's combat buffs (systems/shop.ts sells the potions; the game
// shell owns the timers — these are the pure multiplier rules).
// ---------------------------------------------------------------------------

/** Krachtdrank: melee and bow damage double while it burns. */
export const STRENGTH_DAMAGE_MULTIPLIER = 2;

/** Houtenhuid: incoming blows (bites, hex-hands, lava, falls) halve. */
export const TOUGH_INCOMING_MULTIPLIER = 0.5;

/** Scale an outgoing hit by the strength buff (never rounds below 1). */
export function withStrength(damage: number, strengthActive: boolean): number {
  if (!(damage > 0) || !strengthActive) return damage;
  return Math.max(1, Math.round(damage * STRENGTH_DAMAGE_MULTIPLIER));
}

/**
 * Scale an incoming blow by the barkskin buff AFTER the shield rule
 * (systems/combat.ts absorbDamage runs first): half, never below 1.
 */
export function withTough(amount: number, toughActive: boolean): number {
  if (!(amount > 0) || !toughActive) return amount;
  return Math.max(1, Math.round(amount * TOUGH_INCOMING_MULTIPLIER));
}

/**
 * Item id -> ranged damage against animals, in whole hits. The bow is the
 * expensive answer: 3 hits drops a sheep (3) in a single arrow and a cow (4)
 * in two, which is what the arrows and the draw time buy you.
 */
export const ANIMAL_RANGED_DAMAGE: Record<string, number> = {
  bow: 3,
};

/** Ammo a shot consumes, and the item id it comes from. */
export const ARROW_AMMO = 'arrow';

/** Maximum distance an arrow may be claimed from (metres). */
export const BOW_RANGE = 22;

/** Damage against players for the selected item (sword) — default is a punch. */
export const PUNCH_DAMAGE = 2;
export const SWORD_PLAYER_DAMAGE = 16;

/** Cooldown between player swings (seconds). */
export const SWING_COOLDOWN = 0.55;

/** Reach of a swing, metres (targets must be closer than this). */
export const SWING_RANGE = 3.6;

/** Maximum distance a PvP hit may claim (victim-side + server validation). */
export const PVP_MAX_HIT_DISTANCE = 5.5;

/** Minimum spacing between two hits the same attacker may land (seconds). */
export const PVP_HIT_MIN_INTERVAL = 0.7;

/** Damage a sword strike deals to an animal (0 when unarmed/holding junk). */
export function animalMeleeDamage(itemId: string | null): number {
  return (itemId && ANIMAL_MELEE_DAMAGE[itemId]) || 0;
}

/** Damage a swing deals to a player (punch when unarmed or holding non-swords). */
export function playerMeleeDamage(itemId: string | null): number {
  return itemId === 'sword' ? SWORD_PLAYER_DAMAGE : PUNCH_DAMAGE;
}

/** Damage an arrow deals to an animal (0 when the held item does not shoot). */
export function animalRangedDamage(itemId: string | null): number {
  return (itemId && ANIMAL_RANGED_DAMAGE[itemId]) || 0;
}

/** Cooldown between bow draws (seconds) — slower than a swing on purpose. */
export const SHOOT_COOLDOWN = 0.8;

/** Duration of the draw/release animation (seconds); also the wear window. */
export const SHOOT_ANIM_TIME = 0.3;

/** True when an arrow may leave the bow now. */
export function canShoot(now: number, lastShotAt: number): boolean {
  return now - lastShotAt >= SHOOT_COOLDOWN;
}

/** True when `dist` is inside arrow reach. */
export function inBowRange(dist: number): boolean {
  return dist >= 0 && dist <= BOW_RANGE;
}

// ---------------------------------------------------------------------------
// Shield
// ---------------------------------------------------------------------------

/** Item id that blocks while it is the SELECTED hotbar slot. */
export const SHIELD_ITEM = 'shield';

/** Share of an incoming blow a raised shield lets through. */
export const SHIELD_BLOCK_MULTIPLIER = 0.5;

/** Wear charged (in `wearPerSec` seconds) for one absorbed blow. */
export const SHIELD_BLOCK_WEAR = 1;

/**
 * What a blow actually does while the shield is in hand: half damage, never
 * less than 1 (a shield is armour, not immunity). Everything else — bare
 * hands, a pickaxe, a sword — takes the full amount.
 */
export function absorbDamage(amount: number, heldItem: string | null): number {
  if (!(amount > 0)) return 0;
  if (heldItem !== SHIELD_ITEM) return amount;
  return Math.max(1, Math.round(amount * SHIELD_BLOCK_MULTIPLIER));
}

/** True when a swing may start now (cooldown expired). */
export function canSwing(now: number, lastSwingAt: number): boolean {
  return now - lastSwingAt >= SWING_COOLDOWN;
}

/** True when a horizontal distance is inside swing reach. */
export function inSwingRange(dist: number): boolean {
  return dist <= SWING_RANGE;
}

/**
 * Victim-side validation of an incoming `hit`: the claimed attacker must be
 * close enough that the swing was physically possible, and the damage must
 * be a sane value (one swing of any known weapon, not a firehose).
 */
export function validIncomingHit(
  distanceToAttacker: number,
  damage: number,
  intervalSinceLastHit: number,
): boolean {
  return (
    distanceToAttacker <= PVP_MAX_HIT_DISTANCE &&
    damage >= PUNCH_DAMAGE &&
    damage <= SWORD_PLAYER_DAMAGE &&
    intervalSinceLastHit >= PVP_HIT_MIN_INTERVAL
  );
}

/** Duration of the swing animation on the player character (seconds). */
export const SWING_ANIM_TIME = 0.35;

// ---------------------------------------------------------------------------
// Tower spiders (ai/spiders.ts) — the hostile fauna of the witch's tower
// ---------------------------------------------------------------------------

/**
 * Sword hits needed to squash a spider. A spider takes the same whole-hit
 * economy as herd animals: a bare fist chips 1, the stone sword lands 2 —
 * so a spider dies in two swings, while the fist needs a panicked flurry.
 */
export const SPIDER_HITS = 4;

/** Item id -> melee damage against spiders, in whole hits (fist = 1). */
export function spiderMeleeDamage(itemId: string | null): number {
  return (itemId && ANIMAL_MELEE_DAMAGE[itemId]) || 1;
}

/** How far a spider starts chasing you (metres, horizontal). */
export const SPIDER_AGGRO_RANGE = 8;

/** How far from its spawn a spider will follow before giving up. */
export const SPIDER_CHASE_LIMIT = 16;

/** A bite lands inside this reach (metres). */
export const SPIDER_BITE_RANGE = 1.25;

/** Damage of one bite to the player (before shield absorption). */
export const SPIDER_BITE_DAMAGE = 6;

/** Seconds between two bites by the same spider. */
export const SPIDER_BITE_COOLDOWN = 1.7;

/** Walk speed while stalking its court, and while chasing (m/s). */
export const SPIDER_SPEED_PATROL = 0.9;
export const SPIDER_SPEED_CHASE = 2.7;

/** A bite may land now (same cooldown shape as the player's swing). */
export function canBite(now: number, lastBiteAt: number): boolean {
  return now - lastBiteAt >= SPIDER_BITE_COOLDOWN;
}

/**
 * Does the spider see the player enough to chase? Aggro needs both horizontal
 * range AND the player being on (almost) the spider's own floor — a player
 * walking past OUTSIDE the tower must not be stalked through the stone by
 * the floor-2 spider, and climbing the stairs pulls only the spider whose
 * floor you enter.
 */
export function spiderAggro(playerX: number, playerZ: number, playerY: number, spider: {
  x: number; z: number; y: number;
}): boolean {
  const dx = playerX - spider.x;
  const dz = playerZ - spider.z;
  return Math.hypot(dx, dz) <= SPIDER_AGGRO_RANGE && Math.abs(playerY - spider.y) < 2.2;
}
