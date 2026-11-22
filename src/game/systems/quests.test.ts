import { describe, expect, it } from 'vitest';
import { QuestLog, validateQuest, describeGoal, type RawQuest } from './quests';

const BASE: RawQuest = {
  id: 'mara_bessen',
  npc: 'mara',
  title: 'Bessen plukken',
  desc: 'Pluk 4 bessen.',
  goal: { type: 'gather', item: 'berry', count: 4 },
  reward: { xp: 15, items: [] },
};

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

const mk = (id: string, over: Partial<RawQuest> = {}) =>
  validateQuest({ ...BASE, id, ...over })!;

describe('validateQuest', () => {
  it('accepts a well-formed quest', () => {
    const q = validateQuest(BASE);
    expect(q).not.toBeNull();
    expect(q!.goal).toEqual({ type: 'gather', target: 'berry', count: 4 });
  });

  it('rejects junk, unknown items and impossible goals', () => {
    expect(validateQuest(null)).toBeNull();
    expect(validateQuest({})).toBeNull();
    expect(validateQuest('x' as unknown as RawQuest)).toBeNull();

    const badItem = clone(BASE);
    (badItem.goal as Record<string, unknown>).item = 'tnt';
    expect(validateQuest(badItem)).toBeNull();

    const badType = clone(BASE);
    (badType.goal as Record<string, unknown>).type = 'kill_dragon';
    expect(validateQuest(badType)).toBeNull();

    const badKind = clone(BASE);
    badKind.goal = { type: 'build', kind: 'death_star', count: 1 } as never;
    expect(validateQuest(badKind)).toBeNull();

    const huge = clone(BASE);
    (huge.goal as Record<string, unknown>).count = 9999;
    expect(validateQuest(huge)).toBeNull();
  });

  it('rejects rewards the game cannot pay', () => {
    const rich = clone(BASE);
    rich.reward = { xp: 999999, items: [] };
    expect(validateQuest(rich)).toBeNull();

    const gold = clone(BASE);
    gold.reward = { xp: 10, items: [{ id: 'diamond', count: 1 }] };
    expect(validateQuest(gold)).toBeNull();
  });

  it('accepts every goal type the game can verify', () => {
    expect(validateQuest({ ...BASE, goal: { type: 'craft', item: 'campfire', count: 1 } })).not.toBeNull();
    expect(validateQuest({ ...BASE, goal: { type: 'cook', item: 'cooked_berry', count: 1 } })).not.toBeNull();
    expect(validateQuest({ ...BASE, goal: { type: 'build', kind: 'wall', count: 1 } })).not.toBeNull();
    expect(validateQuest({ ...BASE, goal: { type: 'talk', npc: 'tomas', count: 1 } })).not.toBeNull();
  });
});

describe('QuestLog lifecycle', () => {
  it('offer → accept → progress → complete exactly once', () => {
    const log = new QuestLog();
    const q = mk('tomas_hout', { goal: { type: 'gather', item: 'wood', count: 3 } });
    expect(log.offer(q)).toBe(q);
    expect(log.offer(q)).toBeNull(); // no double offer
    expect(log.accept('tomas_hout')).toBe(q);
    expect(log.list()[0].progress).toBe(0);

    expect(log.progress({ type: 'gather', target: 'wood', count: 2 })).toEqual([]);
    expect(log.list()[0].progress).toBe(2);
    const done = log.progress({ type: 'gather', target: 'wood', count: 1 });
    expect(done.map((d) => d.id)).toEqual(['tomas_hout']);
    // completed once: a third wood event pays nothing again
    expect(log.progress({ type: 'gather', target: 'wood', count: 5 })).toEqual([]);
    expect(log.completedIds).toEqual(['tomas_hout']);
    // a completed quest can never be re-offered or re-accepted
    expect(log.offer(mk('tomas_hout'))).toBeNull();
  });

  it('only advances quests whose type AND target match', () => {
    const log = new QuestLog();
    log.offer(mk('mara_bessen'));
    log.accept('mara_bessen');
    expect(log.progress({ type: 'gather', target: 'wood', count: 9 })).toEqual([]);
    expect(log.progress({ type: 'craft', target: 'berry', count: 9 })).toEqual([]);
    expect(log.list()[0].progress).toBe(0);
    expect(log.progress({ type: 'gather', target: 'berry', count: 1 }).length).toBe(0);
    expect(log.list()[0].progress).toBe(1);
  });

  it('decline removes the offer but allows a later re-offer', () => {
    const log = new QuestLog();
    const q = mk('mara_klets');
    log.offer(q);
    expect(log.decline('mara_klets')).toBe(q);
    expect(log.offer(mk('mara_klets'))).not.toBeNull();
  });

  it('accept only works on offered quests', () => {
    const log = new QuestLog();
    expect(log.accept('mara_bessen')).toBeNull();
  });

  it('talk quests complete on a real conversation event', () => {
    const log = new QuestLog();
    log.offer(mk('mara_klets', { goal: { type: 'talk', npc: 'tomas', count: 1 } }));
    log.accept('mara_klets');
    const done = log.progress({ type: 'talk', target: 'tomas' });
    expect(done.map((d) => d.id)).toEqual(['mara_klets']);
  });
});

describe('QuestLog persistence', () => {
  it('survives a serialize/restore round trip', () => {
    const log = new QuestLog();
    log.offer(mk('tomas_steen', { goal: { type: 'gather', item: 'stone', count: 4 } }));
    log.accept('tomas_steen');
    log.progress({ type: 'gather', target: 'stone', count: 2 });
    log.offer(mk('mara_kook'));

    const copy = new QuestLog();
    copy.restore(log.serialize());
    expect(copy.activeIds()).toEqual(['tomas_steen']);
    expect(copy.list()[0].progress).toBe(2);
    expect(copy.offeredList.map((q) => q.id)).toEqual(['mara_kook']);

    // continuing on the restored log completes the quest normally
    const done = copy.progress({ type: 'gather', target: 'stone', count: 2 });
    expect(done.map((q) => q.id)).toEqual(['tomas_steen']);
  });

  it('drops corrupt or tampered save entries instead of trusting them', () => {
    const log = new QuestLog();
    log.restore({
      offered: [{ id: 'hack', goal: { type: 'gather', item: 'diamond', count: 1 } }, mk('mara_kook')],
      active: [{ quest: mk('tomas_hout'), progress: 5 }, { quest: 'not-a-quest', progress: 0 }],
      completed: ['tomas_vuur', 42, '../etc'],
    });
    expect(log.offeredList.map((q) => q.id)).toEqual(['mara_kook']);
    expect(log.activeIds()).toEqual(['tomas_hout']);
    expect(log.completedIds).toEqual(['tomas_vuur']);
  });

  it('restore(null) is a no-op', () => {
    const log = new QuestLog();
    expect(() => log.restore(null)).not.toThrow();
    expect(log.activeIds()).toEqual([]);
  });
});

describe('describeGoal', () => {
  it('uses real item names and clamped progress', () => {
    const q = validateQuest(BASE)!;
    expect(describeGoal(q, 0)).toContain('Verzamel');
    expect(describeGoal(q, 0)).toContain('Berries'); // ITEMS.berry name
    expect(describeGoal(q, 99)).toContain('4/4');
  });
});
