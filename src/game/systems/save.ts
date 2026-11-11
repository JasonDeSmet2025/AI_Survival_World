/**
 * Local save/load (localStorage). Solo mode persistence:
 * stats, inventory, camera orientation, day time, shared world state
 * and NPC conversation memory.
 */
import type { Inventory } from './inventory';
import type { StatSnapshot } from './stats';
import type { WorldState } from '../world/types';
import type { ChatMessage } from '../ai/chat';

const KEY = 'asw_save_v1';

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
  npcs?: Record<string, { history: ChatMessage[]; memory: string[] }>;
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

  read(): SaveData | null {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const data = JSON.parse(raw) as SaveData;
      if (data.v !== 1) return null;
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
