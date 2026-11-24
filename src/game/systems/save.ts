/**
 * Local save/load (localStorage). Solo mode persistence:
 * stats, inventory, camera orientation, day time, shared world state
 * and NPC conversation memory.
 */
import type { Inventory } from './inventory';
import type { StatSnapshot } from './stats';
import type { WorldState } from '../world/types';
import type { SerializedConversation } from '../ai/chat';
import { isPerkState, type PerkState } from './perks';

const KEY = 'asw_save_v1';

/**
 * Structural validation for anything arriving from localStorage. `optional`
 * fields (progress, npcs) are only rejected when PRESENT and malformed — a
 * save from before those systems existed must keep loading.
 */
function isSaveData(d: unknown): d is SaveData {
  if (typeof d !== 'object' || d === null) return false;
  const s = d as Record<string, unknown>;
  if (s.v !== 1) return false;
  if (typeof s.savedAt !== 'number' || !Number.isFinite(s.savedAt)) return false;
  if (typeof s.stats !== 'object' || s.stats === null) return false;
  if (!Array.isArray(s.inventory)) return false;
  if (typeof s.selected !== 'number') return false;
  const pos = s.pos as Record<string, unknown> | undefined;
  if (typeof pos !== 'object' || pos === null) return false;
  if (!['x', 'y', 'z'].every((k) => Number.isFinite((pos as Record<string, unknown>)[k]))) return false;
  if (!Number.isFinite(s.yaw) || !Number.isFinite(s.pitch) || !Number.isFinite(s.elapsed)) return false;
  const w = s.world as Record<string, unknown> | undefined;
  if (typeof w !== 'object' || w === null) return false;
  if (!Array.isArray(w.depleted) || !Array.isArray(w.buildings)) return false;
  if (typeof w.hp !== 'object' || w.hp === null) return false;
  if ('progress' in s && s.progress != null) {
    const p = s.progress as Record<string, unknown>;
    if (typeof p !== 'object' || !Number.isFinite(p.level) || !Number.isFinite(p.xp)) return false;
  }
  if ('npcs' in s && s.npcs != null) {
    if (typeof s.npcs !== 'object' || Array.isArray(s.npcs)) return false;
  }
  if ('quests' in s && s.quests != null) {
    // Shallow shape check only; QuestLog.restore re-validates every single
    // quest against the real item/recipe/building tables and drops junk.
    const q = s.quests as Record<string, unknown>;
    if (typeof q !== 'object' || Array.isArray(q)) return false;
    if (!Array.isArray(q.offered) || !Array.isArray(q.active) || !Array.isArray(q.completed)) return false;
  }
  if ('witchAnger' in s) {
    // The witch's mood is a plain number (systems/witch.ts). Absent = calm
    // in every older save; present-but-garbage — including null, which is
    // what JSON makes of a NaN — must not boot a furious witch (or a NaN
    // anger, which would compare false against every threshold forever).
    if (typeof s.witchAnger !== 'number' || !Number.isFinite(s.witchAnger)) return false;
  }
  if ('perks' in s) {
    // The perk tree validates ITSELF (chain, ids, points): a save that
    // claims a tier-3 without its chain is as broken as a negative total —
    // and a present-but-null perks field is the same JSON alias for a bug
    // as a null witchAnger, so it goes too.
    if (!isPerkState(s.perks)) return false;
  }
  return true;
}

export interface SaveData {
  v: 1;
  savedAt: number;
  stats: StatSnapshot;
  /** [id, count, durability?] — third element only present for tools. */
  inventory: Array<[string, number, number?] | null>;
  selected: number;
  pos: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  elapsed: number; // day-cycle clock
  world: WorldState;
  /** Player progression (level + XP). Absent in pre-progression saves. */
  progress?: { level: number; xp: number };
  /** Per-NPC conversation history + durable memory (see ai/chat.ts). */
  npcs?: Record<string, SerializedConversation>;
  /** Quest log snapshot (see systems/quests.ts). Absent in pre-quest saves. */
  quests?: unknown;
  /** Ids of loot chests already emptied this world (see systems/chests.ts). */
  chests?: string[];
  /** Ids of den spiders already killed (see ai/spiders.ts + world/volcano.ts). */
  spidersDead?: string[];
  /** The witch's anger 0..100 (systems/witch.ts). Absent = calm. */
  witchAnger?: number;
  /** Perk tree (systems/perks.ts): points left + ids bought. Absent = no points yet. */
  perks?: PerkState;
}

export const Save = {
  toSaveData(
    stats: StatSnapshot,
    inv: Inventory,
    pos: { x: number; y: number; z: number },
    yaw: number,
    pitch: number,
    elapsed: number,
    world: WorldState,
    progress?: { level: number; xp: number },
  ): SaveData {
    return {
      v: 1,
      savedAt: Date.now(),
      stats,
      inventory: inv.serialize(),
      selected: inv.selected,
      pos: { x: pos.x, y: pos.y, z: pos.z },
      yaw,
      pitch,
      elapsed,
      world,
      ...(progress ? { progress } : {}),
    };
  },

  write(data: SaveData): boolean {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Reads the save. Returns null when there is none, when it was written by
   * an incompatible version, or when the JSON parses to something that is
   * structurally NOT a save (truncated localStorage, an older/partial
   * shape): restoring such an object would throw inside the game boot and
   * leave the player with a black screen instead of a fresh world.
   */
  read(): SaveData | null {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const data = JSON.parse(raw) as SaveData;
      if (!isSaveData(data)) return null;
      return data;
    } catch {
      return null;
    }
  },

  clear(): void {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* noop */
    }
  },
};
