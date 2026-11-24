/**
 * THE PERK TREE (Talenten) — the XP tree the player spends while playing.
 *
 * XP and levels already exist (systems/progress.ts: 10 levels that unlock
 * RECIPES). Levels also pay out one talentpunt each, and THIS module decides
 * what those points can buy: a real TREE, not a list. Every perk names one
 * parent (the root names none), so the player first unlocks the root and
 * then faces a genuine choice between the two perks hanging under it — and
 * each of those opens two more. One rank per perk, one point each, no
 * refunds: a choice is a choice, which is what makes a tree a tree rather
 * than a shopping list.
 *
 * Shape (9 perks — more than the 9 levels pay out, so every pick bites):
 *
 *                    gehard
 *                 /          \
 *       krachtige_slagen   snelle_handen          ← the first real choice
 *          /       \            /        \
 *    rotsbenen  stuivende   scherpe_koop  vruchtbaar_land
 *                     \        /
 *                  lichtvoetig  hekenvriend
 *
 * The module is PURE state + pure multiplier helpers: it never touches the
 * player, the HUD or Babylon. game.ts asks a question ("how much damage does
 * the player take?") at exactly the place where that number is computed and
 * multiplies by the answer here; every multiplier is 1 when the perk is
 * unowned, so the rest of the game behaves exactly as before for a player
 * who never visited the tree. treeLayout() is pure geometry too — the HUD
 * just draws what it returns.
 */

export interface PerkDef {
  /** Stable save id — never rename, saves store these. */
  id: string;
  /** The perk that must be owned before this one can be, null for the root. */
  parent: string | null;
  /** What the player reads in the panel. */
  name: string;
  desc: string;
}

/** One talentpunt per perk. A whole tree (9) costs more than the 9 levels pay out. */
export const PERK_COST = 1;

/** Tree order is the drawing order: DFS, left branch first. */
export const PERKS: PerkDef[] = [
  {
    id: 'gehard',
    parent: null,
    name: 'Gehard bloed',
    desc: 'Je incasseert 15% minder schade van alles wat hapt, valt of brandt. De wortel van de hele talentenboom.',
  },
  {
    id: 'krachtige_slagen',
    parent: 'gehard',
    name: 'Krachtige slagen',
    desc: 'Je slagen met zwaard en bijl (en je boog) raken 25% harder. De pad-links-keuze.',
  },
  {
    id: 'rotsbenen',
    parent: 'krachtige_slagen',
    name: 'Rotsbenen',
    desc: 'Val je nog, dan voel je 60% van de valschade minder.',
  },
  {
    id: 'stuivende_longen',
    parent: 'krachtige_slagen',
    name: 'Stuivende longen',
    desc: 'Rennen en werpen putten je 35% minder uit.',
  },
  {
    id: 'lichtvoetig',
    parent: 'stuivende_longen',
    name: 'Lichtvoetig',
    desc: 'Je loopt 12% sneller (schuifsnelheid, dus ook rennen).',
  },
  {
    id: 'snelle_handen',
    parent: 'gehard',
    name: 'Snelle handen',
    desc: 'Maken en koken duurt 25% korter. De pad-rechts-keuze.',
  },
  {
    id: 'scherpe_koop',
    parent: 'snelle_handen',
    name: 'Scherpe koop',
    desc: 'De heks en de dorpskopers vragen 25% minder voor hun waar.',
  },
  {
    id: 'hekenvriend',
    parent: 'scherpe_koop',
    name: 'Hekenvriend',
    desc: 'De heks wordt half zo snel boos en daalt dubbel zo snel af.',
  },
  {
    id: 'vruchtbaar_land',
    parent: 'snelle_handen',
    name: 'Vruchtbaar land',
    desc: 'Je planting groeien 50% sneller.',
  },
];

/** Serializable state: the points in the pocket and the ids already bought. */
export interface PerkState {
  points: number;
  owned: string[];
}

export function newPerkState(): PerkState {
  return { points: 0, owned: [] };
}

export function perkDef(id: string): PerkDef | undefined {
  return PERKS.find((p) => p.id === id);
}

export function hasPerk(s: PerkState, id: string): boolean {
  return s.owned.includes(id);
}

/** Direct children of a perk (or the roots, when id is null). */
export function perkChildren(id: string | null): PerkDef[] {
  return PERKS.filter((p) => p.parent === id);
}

export interface BuyCheck {
  ok: boolean;
  /** Dutch reason shown as a toast when ok is false. */
  reason: string;
}

/** Why this perk cannot be bought RIGHT NOW (points, parent, already owned). */
export function canBuy(s: PerkState, id: string): BuyCheck {
  const def = perkDef(id);
  if (!def) return { ok: false, reason: 'Onbekend talent' };
  if (hasPerk(s, id)) return { ok: false, reason: 'Dat talent heb je al' };
  if (def.parent !== null && !hasPerk(s, def.parent)) {
    const p = perkDef(def.parent);
    return { ok: false, reason: `Eerst: ${p?.name ?? def.parent}` };
  }
  if (s.points < PERK_COST) return { ok: false, reason: 'Te weinig talentpunten' };
  return { ok: true, reason: '' };
}

/** Spend one point on `id`; false (and no change) when canBuy says no. */
export function buyPerk(s: PerkState, id: string): boolean {
  if (!canBuy(s, id).ok) return false;
  s.points -= PERK_COST;
  s.owned.push(id);
  return true;
}

/** Credit `n` levels of perk points (a level-up pays PERK_COST per level). */
export function grantPerkPoints(s: PerkState, levels: number): number {
  if (!Number.isFinite(levels) || levels <= 0) return 0;
  const gain = Math.floor(levels) * PERK_COST;
  s.points += gain;
  return gain;
}

/* ------------------------------------------------------------------------- *
 * Layout. Pure geometry for the HUD: walk the tree depth-first, give every
 * LEAF an equal slice of the width, and hang each parent over the middle of
 * its children. x is a 0..100 percentage, y is a depth row (0 = root row).
 * ------------------------------------------------------------------------- */

export interface PerkNodePos {
  id: string;
  name: string;
  desc: string;
  parent: string | null;
  x: number;
  y: number;
}

export function treeLayout(): PerkNodePos[] {
  const depthOf = (id: string): number => {
    let d = 0;
    let cur = perkDef(id);
    while (cur?.parent) {
      d++;
      cur = perkDef(cur.parent);
    }
    return d;
  };
  const out: PerkNodePos[] = [];
  let leafCursor = 0;
  let leafCount = 0;
  const countLeaves = (id: string): number => {
    const kids = perkChildren(id);
    if (!kids.length) return 1;
    return kids.reduce((n, k) => n + countLeaves(k.id), 0);
  };
  const total = PERKS.filter((p) => !perkChildren(p.id).length).length;
  leafCount = total;
  const walk = (def: PerkDef): number => {
    const kids = perkChildren(def.id);
    let x: number;
    if (!kids.length) {
      x = ((leafCursor + 0.5) / leafCount) * 100;
      leafCursor++;
    } else {
      const xs = kids.map(walk);
      x = xs.reduce((a, b) => a + b, 0) / xs.length;
    }
    out.push({
      id: def.id,
      name: def.name,
      desc: def.desc,
      parent: def.parent,
      x,
      y: depthOf(def.id),
    });
    return x;
  };
  for (const root of perkChildren(null)) walk(root);
  return out;
}

/* ------------------------------------------------------------------------- *
 * Effect multipliers. Every one of them is exactly 1 while the perk is
 * unowned, which is what keeps game.ts glue invisible to a fresh player.
 * ------------------------------------------------------------------------- */

const owned1 = (s: PerkState, id: string, value: number): number =>
  hasPerk(s, id) ? value : 1;

/** Damage taken from every source (×0.85 with Gehard bloed). */
export const damageTakenMul = (s: PerkState): number => owned1(s, 'gehard', 0.85);
/** Own melee/ranged damage (×1.25 with Krachtige slagen). */
export const meleeDamageMul = (s: PerkState): number => owned1(s, 'krachtige_slagen', 1.25);
/** Fall damage (×0.4 with Rotsbenen). */
export const fallDamageMul = (s: PerkState): number => owned1(s, 'rotsbenen', 0.4);
/** Craft/cook duration (×0.75 with Snelle handen — pass as the speed scale's divisor). */
export const craftTimeMul = (s: PerkState): number => owned1(s, 'snelle_handen', 0.75);
/** Shop/negotiation prices (×0.75 with Scherpe koop). */
export const shopPriceMul = (s: PerkState): number => owned1(s, 'scherpe_koop', 0.75);
/** Planter growth speed (×1.5 with Vruchtbaar land). */
export const farmGrowthMul = (s: PerkState): number => owned1(s, 'vruchtbaar_land', 1.5);
/** Walk/sprint speed (×1.12 with Lichtvoetig). */
export const moveSpeedMul = (s: PerkState): number => owned1(s, 'lichtvoetig', 1.12);
/** Stamina drain while sprinting/acting (×0.65 with Stuivende longen). */
export const staminaDrainMul = (s: PerkState): number => owned1(s, 'stuivende_longen', 0.65);
/** How fast the witch's anger RISES (×0.5 with Hekenvriend). */
export const witchAngerMul = (s: PerkState): number => owned1(s, 'hekenvriend', 0.5);
/** How fast the witch's anger DECAYS (×2 with Hekenvriend). */
export const witchDecayMul = (s: PerkState): number => owned1(s, 'hekenvriend', 2);

/* ------------------------------------------------------------------------- *
 * Save-file shape. `save.ts` stores this under `perks`. The validator here
 * only checks the SHAPE (known ids, no duplicates, sane points) — tree
 * logic is handled by prune, because a save whose parent chain got broken by
 * a later game update should lose that ONE perk, not the whole file.
 * ------------------------------------------------------------------------- */

const MAX_POINTS = 99;

export function isPerkState(v: unknown): v is PerkState {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.points !== 'number' || !Number.isInteger(o.points) || o.points < 0 || o.points > MAX_POINTS) {
    return false;
  }
  if (!Array.isArray(o.owned)) return false;
  const seen = new Set<string>();
  for (const id of o.owned as unknown[]) {
    if (typeof id !== 'string') return false;
    if (!perkDef(id) || seen.has(id)) return false; // unknown id or a duplicate purchase
    seen.add(id);
  }
  return true;
}

/**
 * Repair the tree AFTER a shape-valid load: a perk whose parent is missing
 * (possible when a game update rewires the tree under an old save) is
 * refunded and dropped, deepest first so a broken branch collapses fully.
 * Returns the number of perks that had to go.
 */
export function pruneOrphanPerks(s: PerkState): number {
  let dropped = 0;
  for (let pass = 0; pass < PERKS.length; pass++) {
    const bad = s.owned.find((id) => {
      const def = perkDef(id);
      return def !== undefined && def.parent !== null && !s.owned.includes(def.parent);
    });
    if (!bad) break;
    s.owned = s.owned.filter((x) => x !== bad);
    s.points += PERK_COST;
    dropped++;
  }
  return dropped;
}

export function snapshotPerks(s: PerkState): PerkState {
  return { points: s.points, owned: [...s.owned] };
}
