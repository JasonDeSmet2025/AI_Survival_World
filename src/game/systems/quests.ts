/**
 * Quest log (Gameplay Agent scope).
 *
 * The LLM can only PROPOSE a quest (server/quests.mjs validates against a
 * fixed template table); this module is the deterministic truth about what
 * the player actually has, actually did and actually earned:
 *
 *  - every quest that reaches the client is re-validated against the real
 *    item/recipe/building tables (defense in depth: a buggy or compromised
 *    server cannot hand out a quest that references items that do not exist,
 *    nor a reward the game cannot pay);
 *  - progress advances ONLY from real game events (gathered/crafted/cooked/
 *    built/talked), counted here, never from chat text;
 *  - completion is detected exactly once; rewards (XP + items) travel with
 *    the quest object but are validated against the whitelists below — the
 *    server table can only ever say things the game can actually pay.
 *
 * Pure and clock-free: the Game wires events in and hands completed quests
 * to XP/inventory/toasts. Serialization goes through the existing autosave.
 */
import { ITEMS, RECIPES } from '../core/items';

export type QuestGoalType = 'gather' | 'craft' | 'build' | 'cook' | 'talk';

export interface QuestGoal {
  type: QuestGoalType;
  /** gather/craft/cook: item id. build: building kind. talk: npc id. */
  target: string;
  count: number;
}

export interface QuestDef {
  id: string;
  npc: string;
  title: string;
  desc: string;
  goal: QuestGoal;
  reward: { xp: number; items: Array<{ id: string; count: number }> };
}

/** A raw quest object arriving from the server (or a save file). */
export interface RawQuest {
  id?: unknown;
  npc?: unknown;
  title?: unknown;
  desc?: unknown;
  goal?: { type?: unknown; item?: unknown; kind?: unknown; npc?: unknown; target?: unknown; count?: unknown };
  reward?: { xp?: unknown; items?: unknown };
}

/** One step the player took, matched against active quest goals. */
export interface QuestEvent {
  type: QuestGoalType;
  /** item id (gather/craft/cook), building kind (build) or npc id (talk). */
  target: string;
  count?: number;
}

export interface ActiveQuest {
  quest: QuestDef;
  progress: number;
}

/** Building kinds the base game can place (mirrors game.ts BUILDING_KINDS). */
export const BUILDABLE = new Set([
  'campfire',
  'wall',
  'floor',
  'roof',
  'bed',
  'door',
  'stone_wall',
  'torch',
  'carpet',
  'fence',
  'stairs',
  'workbench',
  'planter',
  'sign',
]);

/**
 * Items a quest reward may pay out. Building items are craftable anyway.
 * `gold` is the witch's currency, `herb`/`salve` her tower goods: an NPC
 * may hand out anything the ITEMS registry actually contains.
 */
const REWARDABLE_ITEMS = new Set(['wood', 'stone', 'berry', 'cooked_berry', 'gold', 'herb', 'salve']);

const ID_RE = /^[a-z][a-z0-9_]{1,31}$/;

/**
 * Validate an untrusted quest object (server payload or save data) against
 * the real game tables. Returns null when anything is off — a quest the
 * game cannot verify or pay is not a quest.
 */
export function validateQuest(raw: RawQuest | null | undefined): QuestDef | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null;
  if (typeof raw.npc !== 'string' || !ID_RE.test(raw.npc)) return null;
  if (typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 80) return null;
  if (typeof raw.desc !== 'string' || raw.desc.length > 400) return null;

  const g = raw.goal;
  if (!g || typeof g.type !== 'string') return null;
  const count = g.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 20) return null;

  // Two shapes arrive here: the server wire format (item/kind/npc) and our
  // own normalized save format (target). Accept both, validate per type.
  const rawTarget =
    typeof g.item === 'string' ? g.item :
    typeof g.kind === 'string' ? g.kind :
    typeof g.npc === 'string' ? g.npc :
    typeof g.target === 'string' ? g.target : null;
  if (rawTarget === null) return null;

  let target: string | null = null;
  if (g.type === 'gather' || g.type === 'cook') {
    target = rawTarget in ITEMS ? rawTarget : null;
  } else if (g.type === 'craft') {
    target = RECIPES.some((r) => r.output.id === rawTarget) ? rawTarget : null;
  } else if (g.type === 'build') {
    target = BUILDABLE.has(rawTarget) ? rawTarget : null;
  } else if (g.type === 'talk') {
    target = ID_RE.test(rawTarget) ? rawTarget : null;
  }
  if (!target) return null;

  const xp = raw.reward?.xp;
  if (typeof xp !== 'number' || !Number.isFinite(xp) || xp < 0 || xp > 500) return null;
  const items: Array<{ id: string; count: number }> = [];
  const rawItems = Array.isArray(raw.reward?.items) ? raw.reward!.items : [];
  for (const it of rawItems.slice(0, 4)) {
    if (
      !it ||
      typeof it.id !== 'string' ||
      !REWARDABLE_ITEMS.has(it.id) ||
      typeof it.count !== 'number' ||
      !Number.isInteger(it.count) ||
      it.count < 1 ||
      it.count > 20
    ) {
      return null;
    }
    items.push({ id: it.id, count: it.count });
  }

  return {
    id: raw.id,
    npc: raw.npc,
    title: raw.title.trim(),
    desc: raw.desc,
    goal: { type: g.type as QuestGoalType, target, count },
    reward: { xp, items },
  };
}

/** Dutch one-liner for the HUD, using real item names where possible. */
export function describeGoal(quest: QuestDef, progress = quest.goal.count): string {
  const p = Math.min(progress, quest.goal.count);
  const goalName = (q: QuestDef): string => {
    switch (q.goal.type) {
      case 'gather':
        return `Verzamel ${ITEMS[q.goal.target]?.name ?? q.goal.target}`;
      case 'craft':
        return `Maak ${ITEMS[q.goal.target]?.name ?? q.goal.target}`;
      case 'cook':
        return `Kook ${ITEMS[q.goal.target]?.name ?? q.goal.target}`;
      case 'build':
        return `Bouw ${q.goal.target}`;
      case 'talk':
        return `Praat met ${q.goal.target === 'mara' ? 'Mara' : q.goal.target === 'tomas' ? 'Tomas' : q.goal.target === 'heks' ? 'de heks' : q.goal.target}`;
    }
  };
  return `${goalName(quest)} — ${p}/${quest.goal.count}`;
}

export interface QuestLogSnapshot {
  offered: QuestDef[];
  active: Array<{ quest: QuestDef; progress: number }>;
  completed: string[];
}

/**
 * offered  → shown in chat, awaiting accept/decline
 * active   → counting real events
 * completed→ never offered/completed again (id-only, cheap to save)
 */
export class QuestLog {
  private offered: QuestDef[] = [];
  private active = new Map<string, { quest: QuestDef; progress: number }>();
  private completed = new Set<string>();

  get offeredList(): readonly QuestDef[] {
    return this.offered;
  }

  get completedIds(): string[] {
    return [...this.completed];
  }

  activeIds(): string[] {
    return [...this.active.keys()];
  }

  list(): ActiveQuest[] {
    return [...this.active.values()].map(({ quest, progress }) => ({ quest, progress }));
  }

  /**
   * Accept a validated offer from an NPC. A quest the player completed or
   * already runs is refused (returns null) — the NPC prompt tries to avoid
   * offering those, but the log is the truth, not the model.
   */
  offer(quest: QuestDef | null): QuestDef | null {
    if (!quest) return null;
    if (this.completed.has(quest.id) || this.active.has(quest.id)) return null;
    if (this.offered.some((q) => q.id === quest.id)) return null;
    this.offered.push(quest);
    return quest;
  }

  accept(id: string): QuestDef | null {
    const idx = this.offered.findIndex((q) => q.id === id);
    if (idx < 0) return null;
    const [quest] = this.offered.splice(idx, 1);
    if (this.completed.has(quest.id)) return null;
    this.active.set(quest.id, { quest, progress: 0 });
    return quest;
  }

  decline(id: string): QuestDef | null {
    const idx = this.offered.findIndex((q) => q.id === id);
    if (idx < 0) return null;
    const [quest] = this.offered.splice(idx, 1);
    return quest;
  }

  /**
   * Advance matching active quests with one real game event.
   * Returns the quests that reached their goal (and were removed from the
   * active set) — the caller pays XP/items exactly once per returned quest.
   */
  progress(event: QuestEvent): QuestDef[] {
    const done: QuestDef[] = [];
    for (const [id, state] of this.active) {
      if (state.quest.goal.type !== event.type || state.quest.goal.target !== event.target) continue;
      state.progress = Math.min(
        state.quest.goal.count,
        state.progress + Math.max(0, Math.floor(event.count ?? 1)),
      );
      if (state.progress >= state.quest.goal.count) {
        this.active.delete(id);
        this.completed.add(id);
        done.push(state.quest);
      }
    }
    return done;
  }

  serialize(): QuestLogSnapshot {
    return {
      offered: this.offered,
      active: [...this.active.values()].map(({ quest, progress }) => ({ quest, progress })),
      completed: [...this.completed],
    };
  }

  /** Re-validate every restored quest: old/tampered saves simply drop it. */
  restore(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const d = data as Partial<QuestLogSnapshot>;
    this.offered = [];
    this.active = new Map();
    this.completed = new Set();
    if (Array.isArray(d.offered)) {
      for (const raw of d.offered) {
        const q = validateQuest(raw as RawQuest);
        if (q) this.offered.push(q);
      }
    }
    if (Array.isArray(d.active)) {
      for (const row of d.active) {
        const q = validateQuest(row?.quest as RawQuest);
        const p = row?.progress;
        if (q) {
          this.active.set(q.id, {
            quest: q,
            progress: typeof p === 'number' && Number.isFinite(p) ? Math.max(0, Math.min(p, q.goal.count)) : 0,
          });
        }
      }
    }
    if (Array.isArray(d.completed)) {
      for (const id of d.completed) {
        if (typeof id === 'string' && ID_RE.test(id)) this.completed.add(id);
      }
    }
  }
}
