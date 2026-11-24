/**
 * Gold NEGOTIATION with the village traders — pure rules, no DOM, no LLM.
 *
 * This is deliberately NOT the witch's fixed-price barter (systems/shop.ts).
 * A villager walks into the deal with a price that is too high when selling
 * and too low when buying, a hidden walk-away limit, a finite patience and a
 * mood that reacts to how hard you push. Every haggle round moves their
 * number — sometimes by a lot, sometimes by nothing, never the same twice
 * (the rng is seeded per session from the world seed + session counter, so
 * tests and replays stay honest).
 *
 * Economics:
 *  - `sell` lines: the villager SELLS goods to the player (pay `gold`).
 *    They open at ask ≈ 1.3× value and can be haggled down towards a hidden
 *    limit near cost.
 *  - `buy` lines: the villager BUYS goods from the player (they pay `gold`
 *    out of a wallet with real limits — their `wealth`). They open low and
 *    are haggled UP towards a hidden ceiling, capped by wealth.
 *  - A gross lowball cools the mood; a good relationship opens warmer,
 *    concedes faster, has more patience and a fatter wallet.
 *
 * Currency is the `gold` item (core/items.ts): coins in your bag, not an
 * invisible counter — you can see them, drop them and lose them like
 * anything else you carry.
 */
import type { Inventory } from './inventory';
import type { Rng } from './chests';

/** The currency item id. */
export const GOLD = 'gold';

/** One catalogue entry, seen from the VILLAGER's side. */
export interface TradeGood {
  goods: string;
  /** Lot size per line (a villager trades in handfuls, not singlets). */
  qty: number;
  /** What the lot is worth at market (the negotiation gravitates here). */
  value: number;
}

export interface VendorCatalog {
  /** Goods the villager sells TO the player. */
  sells: TradeGood[];
  /** Goods the villager BUYS from the player. */
  buys: TradeGood[];
}

/**
 * What each trader deals in, and why: Mara the herb-wife buys spider silk
 * for bandages and sells the healer's stock; Tomas the builder-smith buys
 * leather and silk for straps and bowstrings and sells tools from his rack.
 */
export const VENDOR_CATALOGS: Record<string, VendorCatalog> = {
  mara: {
    sells: [
      { goods: 'cooked_mutton', qty: 2, value: 12 },
      { goods: 'arrow', qty: 6, value: 9 },
      { goods: 'rope', qty: 2, value: 9 },
      { goods: 'potion_heal', qty: 1, value: 17 },
    ],
    buys: [
      { goods: 'silk', qty: 1, value: 9 },
      { goods: 'raw_mutton', qty: 2, value: 8 },
      { goods: 'raw_beef', qty: 1, value: 7 },
      { goods: 'leather', qty: 1, value: 6 },
      { goods: 'wool', qty: 2, value: 5 },
    ],
  },
  tomas: {
    sells: [
      { goods: 'torch', qty: 3, value: 6 },
      { goods: 'arrow', qty: 6, value: 8 },
      { goods: 'shield', qty: 1, value: 21 },
      { goods: 'bow', qty: 1, value: 29 },
    ],
    buys: [
      { goods: 'silk', qty: 1, value: 8 },
      { goods: 'leather', qty: 2, value: 9 },
      { goods: 'raw_beef', qty: 2, value: 12 },
      { goods: 'wool', qty: 2, value: 4 },
    ],
  },
};

/** True when this npc id has a trade table at all. */
export function isVendor(npcId: string): boolean {
  return VENDOR_CATALOGS[npcId] !== undefined;
}

/** One tableable line on the trade sheet. */
export interface HaggleLine {
  /** `${side}:${goods}` — stable per session. */
  id: string;
  goods: string;
  qty: number;
  value: number;
  /** 'sell': villager → player (player pays). 'buy': player → villager (villager pays). */
  side: 'sell' | 'buy';
  /** The villager's CURRENT ask/bid — a deal now closes at this figure. */
  ask: number;
  /** Hidden: the figure they converge to under pressure (never shown). */
  limit: number;
  /** Remaining patience (0 = final number, take it or leave it). */
  patience: number;
  /** The player's current counter-offer shown on the row. */
  bid: number;
  /** False after the wallet ran dry (buy side) — the line is dead. */
  open: boolean;
  /** The villager's last remark (shown on the row). */
  say: string;
}

export interface Session {
  npcId: string;
  npcName: string;
  /** Gold the villager can actually pay out for `buy` lines. */
  wealth: number;
  /** 100 = charmed, 0 = done with you (drives concession size). */
  mood: number;
  lines: HaggleLine[];
}

export interface HaggleResult {
  say: string;
  /** Set when the villager accepted: the closing price per lot. */
  deal: number | null;
  /** True when this offer cost the player goodwill. */
  insulted: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Open a negotiation table. Relationship (the -60..60 band of the NPC
 * memory score) warms the opening prices, the walk-away limits, the
 * patience and the wallet — being on good terms with the village literally
 * pays, and the effect is remembered per trader.
 */
export function openSession(npcId: string, npcName: string, relationship: number, rng: Rng): Session {
  const catalog = VENDOR_CATALOGS[npcId];
  if (!catalog) return { npcId, npcName, wealth: 0, mood: 80, lines: [] };
  const warm = clamp(relationship, -60, 60) / 60; // -1 .. 1
  const wealth = 40 + Math.round(rng() * 45 + warm * 20);
  const mood = Math.round(clamp(70 + warm * 25, 25, 95));
  const lines: HaggleLine[] = [];
  for (const g of catalog.sells) {
    const ask = Math.max(2, Math.round(g.value * (1.3 + rng() * 0.4 - warm * 0.18)));
    const limit = Math.max(1, Math.round(g.value * (0.62 + rng() * 0.16 + warm * 0.1)));
    lines.push({
      id: `sell:${g.goods}`,
      goods: g.goods,
      qty: g.qty,
      value: g.value,
      side: 'sell',
      ask,
      limit,
      patience: warm > 0.3 ? 4 : 3,
      bid: Math.max(1, Math.round(ask * 0.6)),
      open: true,
      say: 'Eerlijk bedrag, hoor.',
    });
  }
  for (const g of catalog.buys) {
    const ask = Math.max(1, Math.round(g.value * (0.42 + rng() * 0.2 + warm * 0.1)));
    const limit = Math.max(ask, Math.round(Math.min(g.value * 1.1, g.value * (0.78 + rng() * 0.2 + warm * 0.12))));
    lines.push({
      id: `buy:${g.goods}`,
      goods: g.goods,
      qty: g.qty,
      value: g.value,
      side: 'buy',
      ask,
      limit,
      patience: warm > 0.3 ? 4 : 3,
      bid: Math.min(g.value, ask + 1),
      open: true,
      say: 'Kan er wat mee, maar niet voor veel.',
    });
  }
  return { npcId, npcName, wealth, mood, lines };
}

/** Final-number remark once patience is spent. */
function finalSay(line: HaggleLine): string {
  return line.side === 'sell'
    ? `Laatste aanbod: ${line.ask} goud. Neem het of laat het.`
    : `Meer dan ${line.ask} goud ga ik er niet voor geven.`;
}

/**
 * One haggle round: the player puts `offer` on the table (what they will PAY
 * for a `sell` lot, what they DEMAND to be PAID for a `buy` lot). The
 * villager either takes it, counters closer to their hidden limit, or tells
 * you where the road ends.
 */
export function haggle(session: Session, lineId: string, offer: number, rng: Rng): HaggleResult {
  const line = session.lines.find((l) => l.id === lineId);
  if (!line || !line.open) return { say: 'Die deal is er niet meer.', deal: null, insulted: false };
  line.bid = Math.max(0, Math.round(offer));
  const o = line.bid;
  let insulted = false;

  if (line.side === 'sell') {
    if (o >= line.ask) return { say: 'Afgesproken!', deal: line.ask, insulted: false };
    if (o >= line.limit) return { say: 'Goed, goed... voor jou.', deal: o, insulted: false };
    if (o < Math.max(1, Math.round(line.limit * 0.55))) {
      // A gross lowball: no concession this round, and it stings.
      session.mood = Math.max(0, session.mood - Math.round(6 + rng() * 7));
      line.patience = Math.max(0, line.patience - 1);
      insulted = true;
      return { say: 'Blijf niet beledigen — het is waar het is.', deal: null, insulted };
    }
    if (line.patience <= 0) return { say: finalSay(line), deal: null, insulted: false };
    // Normal counter: they step towards their limit; a good mood steps more.
    const moodMul = 0.55 + (session.mood / 100) * 0.75;
    const step = (line.ask - line.limit) * (0.16 + rng() * 0.3) * moodMul;
    line.ask = Math.max(line.limit, line.ask - Math.round(step));
    line.patience -= 1;
    if (line.patience <= 0) return { say: finalSay(line), deal: null, insulted: false };
    return {
      say: rng() < 0.5 ? `Nou... voor ${line.ask} goud doe ik het.` : `Van ${line.ask} goud doe ik geen handjes meer.`,
      deal: null,
      insulted,
    };
  }

  // --- buy side: the villager is PAYING, numbers climb ----------------------
  if (session.wealth < 1) {
    line.open = false;
    return { say: 'Ik ben zelf aan het geld — sorry.', deal: null, insulted: false };
  }
  if (o <= line.ask) {
    // The player demands LESS than the villager already offered: they pay
    // their own figure, not the player's (honest both ways).
    return { say: 'Zo meer dan tevreden!', deal: line.ask, insulted: false };
  }
  const cap = Math.min(line.limit, session.wealth);
  if (o <= cap) return { say: 'Verdorie, fine.', deal: o, insulted: false };
  if (o > line.limit * 1.6) {
    session.mood = Math.max(0, session.mood - Math.round(5 + rng() * 6));
    line.patience = Math.max(0, line.patience - 1);
    insulted = true;
    return { say: 'Droom verder — zoveel is het niet waard.', deal: null, insulted };
  }
  if (line.patience <= 0) return { say: finalSay(line), deal: null, insulted: false };
  const moodMul = 0.55 + (session.mood / 100) * 0.75;
  const step = (cap - line.ask) * (0.16 + rng() * 0.3) * moodMul;
  line.ask = Math.max(line.ask + 1, Math.min(cap, line.ask + Math.round(step)));
  line.patience -= 1;
  if (line.patience <= 0) return { say: finalSay(line), deal: null, insulted: false };
  return {
    say: rng() < 0.5 ? `Toe, toe... ${line.ask} goud.` : `Ik kan tot ${line.ask} goud gaan.`,
    deal: null,
    insulted,
  };
}

/** Outcome of closing a line: what changed in whose pocket. */
export interface DealResult {
  ok: boolean;
  /** Why a deal failed — the caller turns it into a toast verbatim. */
  reason: 'no-gold' | 'no-goods' | 'no-room' | 'gone' | null;
  goods: string;
  qty: number;
  price: number;
  say: string;
}

/**
 * Close a line at the villager's CURRENT figure (their ask). The inventory
 * is the only authority: coins leave/enter the `gold` stack, goods move the
 * other way, and the villager's wallet is debited for purchases — a trader
 * who spent their last coin genuinely cannot buy more this session.
 */
export function closeDeal(session: Session, lineId: string, inv: Inventory): DealResult {
  const line = session.lines.find((l) => l.id === lineId);
  const fail = (reason: DealResult['reason'], goods: string, qty: number, say: string): DealResult => ({
    ok: false,
    reason,
    goods,
    qty,
    price: 0,
    say,
  });
  if (!line || !line.open) return fail('gone', '', 0, 'Die deal is er niet meer.');
  const price = line.ask;
  if (line.side === 'sell') {
    if (inv.count(GOLD) < price) return fail('no-gold', line.goods, line.qty, `Je hebt ${price} goud niet.`);
    if (!inv.canAdd(line.goods, line.qty)) return fail('no-room', line.goods, line.qty, 'Geen ruimte in je rugzak.');
    inv.remove(GOLD, price);
    inv.add(line.goods, line.qty);
    session.wealth += price;
    line.say = 'Afgehandeld!';
    return { ok: true, reason: null, goods: line.goods, qty: line.qty, price, say: line.say };
  }
  if (inv.count(line.goods) < line.qty) {
    return fail('no-goods', line.goods, line.qty, `Je hebt ${line.qty}× niet — kom met meer ${line.goods}.`);
  }
  const pay = Math.min(price, session.wealth);
  if (pay < 1) return fail('gone', line.goods, line.qty, 'De dorpeling is zelf aan het geld.');
  inv.remove(line.goods, line.qty);
  inv.add(GOLD, pay);
  session.wealth -= pay;
  if (session.wealth < 1) line.open = false;
  line.say = 'Afgehandeld!';
  return { ok: true, reason: null, goods: line.goods, qty: line.qty, price: pay, say: line.say };
}

/** Closing remark after a finished deal — good deals warm the table. */
export function dealWrap(session: Session, dealt: boolean): string {
  if (dealt) {
    session.mood = Math.min(100, session.mood + 4);
    return 'Goede zaak. Kom morgen terug, dan zijn de koersen veranderd.';
  }
  return 'Misschien de andere keer.';
}
