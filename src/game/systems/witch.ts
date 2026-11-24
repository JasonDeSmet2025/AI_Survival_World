/**
 * The witch's MOOD — pure rules (no Babylon, no DOM), the twin of
 * systems/shop.ts: the shop is what she trades, this module is when she
 * stops trading nicely and starts hexing.
 *
 * One number drives everything: `anger` (0..100).
 *  - blows landed on her, opening HER strongbox and insults in chat push it
 *    up; apologies and the passage of time (nobody poking her) pull it down;
 *  - at HOSTILE_AT she is hostile: she chases and hex-hits the player
 *    (ai/witch.ts moves her, this module decides when the hit may land);
 *  - she CANNOT be killed — steel slides off a witch. When her hits run out
 *    she vanishes in a puff of black smoke and crawls back out of the tower
 *    door WITCH_RETURN_S later, still furious. The shop is never lost.
 *
 * The chat scan is deliberately a dumb keyword gate, not an LLM: anger must
 * be deterministic (unit-testable, the same offline as with a gateway) and
 * must never be steerable by the model's reply text — only the PLAYER's
 * words can change her mood.
 */

/** Anger thresholds and deltas (all in anger points, 0..100 scale). */
export const WITCH_ANGER = {
  /** One sword blow landed on her person. */
  BLOW: 34,
  /** Opening the GREAT chest on her tower top, in her sight. */
  STEAL: 100,
  /** One insult thrown at her in conversation. */
  INSULT: 22,
  /** One genuine apology in conversation (subtracted). */
  APOLOGY: 30,
  /** Anger lost per second of peace (nobody attacking her for a while). */
  DECAY_PER_SEC: 0.25,
} as const;

/** From this anger up she is hostile: she follows and hits. */
export const HOSTILE_AT = 60;

/** Gold she accepts as a formal apology (systems/shop.ts: the `gold` item). */
export const APPEASE_COST = 20;

/**
 * Hits she "has" — the same whole-hit economy as the herd and the spiders
 * (bare fist chips 1, the stone sword lands 2). She never dies; see the
 * module header. Below 1 hit left she blinks away and returns later.
 */
export const WITCH_HITS = 8;

/** Seconds between her appearance and return after being overpowered. */
export const WITCH_RETURN_S = 25;

/** How far she starts chasing you (metres, horizontal, from the tower). */
export const WITCH_CHASE_RANGE = 12;

/** How far from her tower door she will follow before giving up. */
export const WITCH_CHASE_LIMIT = 30;

/** A hex-hand lands inside this reach (metres). */
export const WITCH_HIT_RANGE = 1.9;

/** Damage of one hex-hand to the player (before shield/bark absorption). */
export const WITCH_HIT_DAMAGE = 12;

/** Seconds between two hex-hits by the same witch. */
export const WITCH_HIT_COOLDOWN = 1.6;

/** Her walk speed while patrolling the court, and while chasing (m/s). */
export const WITCH_SPEED_PATROL = 1.3;
export const WITCH_SPEED_CHASE = 2.4;

/** The living mood of the witch (owned by the game shell, saved as a number). */
export interface WitchState {
  /** 0..100 — see HOSTILE_AT. Clamped by every mutator here. */
  anger: number;
  /** Hits she has left before she blinks away (WITCH_HITS when whole). */
  hits: number;
  /** combatT at which the overpowered witch crawls back (0 = present). */
  returnsAt: number;
  /** combatT of her last landed hex-hand (cooldown gate). */
  lastHitAt: number;
}

export function createWitchState(anger = 0): WitchState {
  return {
    anger: clampAnger(anger),
    hits: WITCH_HITS,
    returnsAt: 0,
    lastHitAt: -999,
  };
}

function clampAnger(a: number): number {
  return Math.max(0, Math.min(100, a));
}

/** True from the moment her anger crosses HOSTILE_AT. */
export function isHostile(s: WitchState): boolean {
  return s.anger >= HOSTILE_AT;
}

/** True while she is hiding in smoke after being overpowered. */
export function isHidden(s: WitchState, now: number): boolean {
  return s.returnsAt > now;
}

/**
 * Add anger for a reason (blow / steal / insult). Clamped; hostile flips as
 * soon as the threshold is crossed. Returns true when THIS event made her
 * hostile (the game uses it to fire the one-time warning toast).
 */
export function angerWitch(s: WitchState, delta: number): boolean {
  const before = isHostile(s);
  s.anger = clampAnger(s.anger + delta);
  return !before && isHostile(s);
}

/** Passive calming while the world leaves her alone. */
export function tickWitchMood(s: WitchState, dt: number): void {
  if (s.anger > 0) s.anger = clampAnger(s.anger - WITCH_ANGER.DECAY_PER_SEC * dt);
}

/**
 * Pay gold: her anger is wiped to zero (you keep the goods back — that part
 * is story, the game owns the inventory). Returns false when the wallet or
 * her pride refuses (not enough gold, or she was not even angry).
 */
export function appease(s: WitchState, gold: number): boolean {
  if (s.anger <= 0 || gold < APPEASE_COST) return false;
  s.anger = 0;
  return true;
}

/**
 * Land hits on her. Returns true when this blow made her vanish in smoke
 * (the game hides the mesh and sets up the return). Hits never go below 1
 * in the visible world: the moment they would, she blinks away and comes
 * back WHOLE — the number is her pride, not her health bar.
 */
export function strikeWitch(
  s: WitchState,
  hits: number,
  now: number,
): { vanished: boolean } {
  angerWitch(s, WITCH_ANGER.BLOW);
  s.hits -= Math.max(1, hits);
  if (s.hits <= 0) {
    s.hits = WITCH_HITS;
    s.returnsAt = now + WITCH_RETURN_S;
    return { vanished: true };
  }
  return { vanished: false };
}

/** A hex-hand may land now (same cooldown shape as a spider bite). */
export function canHex(s: WitchState, now: number): boolean {
  // The 1e-6 is not sloppiness: combatT accumulates frame dt's, so the
  // exact-boundary difference can be 1.5999999999999996 instead of 1.6 —
  // a witch who is one nanosecond shy of her cooldown must still be able
  // to hit, and the cooldown is not a puzzle the player can observe.
  return now - s.lastHitAt >= WITCH_HIT_COOLDOWN - 1e-6;
}

/** Hex reach check, same shape as the spider's bite range. */
export function inWitchReach(dist: number): boolean {
  return dist <= WITCH_HIT_RANGE;
}

/**
 * Does she see the player close enough to chase? Needs horizontal range AND
 * roughly her own floor (climbing the tower does not pull her out of the
 * court, and standing on the top floor is the one place she cannot reach).
 */
export function witchAggro(
  playerX: number,
  playerZ: number,
  playerY: number,
  witch: { x: number; z: number; y: number },
): boolean {
  const dx = playerX - witch.x;
  const dz = playerZ - witch.z;
  return (
    Math.hypot(dx, dz) <= WITCH_CHASE_RANGE &&
    Math.abs(playerY - witch.y) < 2.2
  );
}

// ---------------------------------------------------------------------------
// Chat mood gate — only the PLAYER's own words move her
// ---------------------------------------------------------------------------

/** Dutch insults that land on a witch (lower-case, matched as words). */
export const INSULT_WORDS = [
  'dom', 'domme', 'dwaas', 'lelijk', 'lelijke', 'stink', 'stinker',
  'kwakzalver', 'bedriger', 'bedrieger', 'drol', 'dik', 'viezig', 'haat',
  'haatje', 'sul', 'eikel', 'kut', 'tering', 'teringheks', 'wruug',
  // NOT 'zak': in Dutch it is also a grocery bag, and a witch who hexes
  // people for carrying flour is a farce, not a threat.
] as const;

/** Dutch words that read as a genuine apology or courtesy (they cool her). */
export const APOLOGY_WORDS = [
  'sorry', 'vergeef', 'vergeeft', 'excuses', 'excuus', 'alsjeblieft',
  'gracieus', 'gracieuses', 'dankjewel', 'dank', 'bedankt', 'respect',
] as const;

function containsWord(text: string, word: string): boolean {
  // Word boundary on both sides so "zak" does not fire on "zakelijk" and
  // "dom" not on "dominee" (the hyphen/apostrophe count as boundaries).
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z])${esc}([^a-z]|$)`, 'i').test(text);
}

/**
 * Mood delta of one player chat message: +INSULT per insult word (the first
 * only, so copy-paste insults cannot stack infinitely per line), −APOLOGY
 * when an apology word is present (and none is present, she smells pity).
 */
export function chatMoodDelta(text: string): number {
  const t = text.toLowerCase();
  const insulted = INSULT_WORDS.some((w) => containsWord(t, w));
  if (insulted) return WITCH_ANGER.INSULT;
  if (APOLOGY_WORDS.some((w) => containsWord(t, w))) return -WITCH_ANGER.APOLOGY;
  return 0;
}

/** Her mood, in words for the HUD/shop header. */
export function moodLabel(s: WitchState): string {
  if (isHostile(s)) return 'kookt van woede';
  if (s.anger >= 30) return 'geprikkeld';
  if (s.anger >= 1) return 'grommend';
  return 'gedienstig';
}
