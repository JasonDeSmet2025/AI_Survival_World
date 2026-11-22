/**
 * Completing one harvest (Gameplay Agent scope).
 *
 * This is the single place that decides what a finished gathering swing
 * gives the player: the rolled yield (core/items YIELDS), the effective
 * tool bonus, how much of it actually fits in the bag, the XP it pays and
 * whether the node may be damaged at all.
 *
 * Before this module existed, `game.ts` ignored the return value of
 * `Inventory.add()` — which is the number of units that did NOT fit. In a
 * full bag the resources simply vanished while the node was still damaged
 * and the XP still paid: invisible progress and silently destroyed gameplay
 * state. The resolution below makes the transaction honest:
 *
 * - nothing fits at all  -> status 'blocked': the swing does NOT finish,
 *   the node keeps its hp and no XP is paid (the player has to make room);
 * - only part fits       -> that part is granted, the shortfall is reported
 *   so the HUD can tell the player, and XP scales with what was received.
 *
 * Pure logic (no Babylon, no DOM) and the RNG is injectable, so the whole
 * chain is unit-testable and reproducible.
 */
import { ITEMS, YIELDS, toolForNode } from '../core/items';
import { gatherXp } from './progress';
import type { Inventory } from './inventory';

/** Injectable random source in [0, 1). */
export type Rng = () => number;

export type HarvestStatus =
  /** Items were stored; the caller may damage the node. */
  | 'gathered'
  /** The bag has no room for this item at all: nothing was taken. */
  | 'blocked'
  /** The node kind has no yield definition: nothing was taken. */
  | 'unknown';

export interface HarvestOutcome {
  status: HarvestStatus;
  /** Item the node produces (null for an unknown kind). */
  itemId: string | null;
  /** Units the roll produced, tool bonus included (0 when not rolled). */
  rolled: number;
  /** Units actually put into the inventory. */
  granted: number;
  /** Units that did not fit (`rolled - granted`, reported, never hidden). */
  lost: number;
  /** Tool bonus that was applied (1 when the right tool was in hand). */
  bonus: number;
  /** XP the caller should grant for THIS harvest. */
  xp: number;
  /** True when the effective tool was in hand (drives tool wear in the caller). */
  usedTool: boolean;
}

export interface HarvestRequest {
  /** Resource-node kind: 'tree' | 'pine' | 'rock' | 'bush' | ... */
  kind: string;
  inventory: Inventory;
  /** The item currently selected in the hotbar (the tool in use). */
  toolId: string | null;
  /** Random source for the yield roll; defaults to Math.random. */
  rng?: Rng;
}

/**
 * Resolve a finished gathering swing. Does NOT damage the node — the
 * caller only damages it when `status === 'gathered'`.
 */
export function resolveHarvest(req: HarvestRequest): HarvestOutcome {
  const yieldDef = YIELDS[req.kind];
  if (!yieldDef) {
    return { status: 'unknown', itemId: null, rolled: 0, granted: 0, lost: 0, bonus: 0, xp: 0, usedTool: false };
  }

  const rng = req.rng ?? Math.random;
  const span = Math.max(0, yieldDef.max - yieldDef.min);
  const toolId = req.toolId ?? null;
  const bonus = toolForNode(req.kind) === toolId && toolId !== null ? 1 : 0;
  const rolled = yieldDef.min + Math.floor(rng() * (span + 1)) + bonus;

  // A bag with zero room for this item aborts the harvest: the swing simply
  // never completes, so no resource and no node hp is wasted.
  const room = req.inventory.roomFor(yieldDef.itemId);
  if (room <= 0) {
    return {
      status: 'blocked',
      itemId: yieldDef.itemId,
      rolled: 0,
      granted: 0,
      lost: 0,
      bonus,
      xp: 0,
      usedTool: bonus > 0,
    };
  }

  // `add` returns what did NOT fit.
  const leftover = req.inventory.add(yieldDef.itemId, rolled);
  const stored = rolled - leftover;
  const full = gatherXp(req.kind);
  const xp = stored >= rolled ? full : stored > 0 ? Math.max(1, Math.round((full * stored) / rolled)) : 0;

  return {
    status: 'gathered',
    itemId: yieldDef.itemId,
    rolled,
    granted: stored,
    lost: rolled - stored,
    bonus,
    xp,
    usedTool: bonus > 0,
  };
}

/** Human-readable result line for the HUD toast (Dutch, like the rest). */
export function harvestToast(outcome: HarvestOutcome): string | null {
  if (outcome.status !== 'gathered' || !outcome.itemId) return null;
  const name = ITEMS[outcome.itemId]?.name ?? outcome.itemId;
  const base = `+${outcome.granted} ${name}`;
  return outcome.lost > 0 ? `${base} — rugzak vol (${outcome.lost} gemist)` : base;
}
