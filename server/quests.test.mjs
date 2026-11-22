/**
 * Quest-proposal parsing tests (node:test). Run with:
 *   node --test server/quests.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QUEST_TEMPLATES,
  questsForNpc,
  questInstruction,
  parseQuestOffer,
  cleanQuestIds,
} from './quests.mjs';

test('templates only use goals the game can verify', () => {
  const goalTypes = new Set(['gather', 'craft', 'build', 'cook', 'talk']);
  for (const [id, q] of Object.entries(QUEST_TEMPLATES)) {
    assert.equal(q.id, id, 'id key matches');
    assert.ok(['mara', 'tomas'].includes(q.npc), `${id} belongs to a known npc`);
    assert.ok(goalTypes.has(q.goal.type), `${id} has a verifiable goal`);
    assert.ok(Number.isInteger(q.goal.count) && q.goal.count >= 1 && q.goal.count <= 20);
    assert.ok(Number.isFinite(q.reward.xp) && q.reward.xp > 0 && q.reward.xp <= 200);
    assert.ok(Array.isArray(q.reward.items));
    for (const it of q.reward.items) {
      assert.ok(['wood', 'stone', 'berry', 'cooked_berry'].includes(it.id), `${id} rewards real items`);
    }
  }
});

test('questsForNpc partitions the table', () => {
  const mara = questsForNpc('mara').map((q) => q.id);
  const tomas = questsForNpc('tomas').map((q) => q.id);
  assert.ok(mara.length > 0 && tomas.length > 0);
  for (const id of mara) assert.ok(!tomas.includes(id));
  assert.deepEqual(questsForNpc('nobody'), []);
});

test('questInstruction lists open quests and hides done ones', () => {
  const all = questInstruction('mara');
  assert.match(all, /mara_bessen/);
  assert.match(all, /MISSIE:/);
  assert.match(all, /vraag/i, 'roleplay instruction tells the NPC to ask questions');
  const someDone = questInstruction('mara', ['mara_bessen']);
  assert.ok(!someDone.includes('mara_bessen ('), 'completed quest is not listed as an option');
  assert.ok(someDone.includes('mara_kook ('), 'other quests stay available');
  const noneLeft = questInstruction('mara', Object.keys(QUEST_TEMPLATES));
  assert.match(noneLeft, /geef geen nieuwe missie/i);
});

test('parseQuestOffer accepts a valid marker', () => {
  const r = parseQuestOffer('Mooi zo! Doe je dat voor me?\nMISSIE:mara_bessen', { npcId: 'mara' });
  assert.deepEqual(r.quest, QUEST_TEMPLATES.mara_bessen);
  assert.doesNotMatch(r.text, /MISSIE/, 'marker stripped from the reply');
  assert.match(r.text, /Mooi zo/);
});

test('parseQuestOffer rejects unknown, foreign and duplicate ids', () => {
  const cases = [
    ['MISSIE:hack_me', { npcId: 'mara' }, 'unknown id'],
    ['MISSIE:tomas_hout', { npcId: 'mara' }, 'other npc quest'],
    ['MISSIE:mara_bessen', { npcId: 'mara', active: ['mara_bessen'] }, 'already active'],
    ['MISSIE:mara_bessen', { npcId: 'mara', completed: ['mara_bessen'] }, 'already completed'],
    ['MISSIE:mara_bessen', { npcId: 'mara', offered: ['mara_bessen'] }, 'already offered'],
  ];
  for (const [text, v, why] of cases) {
    const r = parseQuestOffer(text, v);
    assert.equal(r.quest, null, why);
    assert.doesNotMatch(r.text, /MISSIE/i, `${why}: marker stripped even when rejected`);
  }
});

test('parseQuestOffer passes normal replies through untouched', () => {
  const r = parseQuestOffer('Gewoon een sappig stuk tekst.', { npcId: 'mara' });
  assert.equal(r.quest, null);
  assert.equal(r.text, 'Gewoon een sappig stuk tekst.');
  const empty = parseQuestOffer(undefined, { npcId: 'mara' });
  assert.equal(empty.quest, null);
});

test('only the first marker counts, casing is forgiving', () => {
  const r = parseQuestOffer('Ja! missie: tomAs_Steen en nog eens MISSIE:tomas_hout', { npcId: 'tomas' });
  assert.equal(r.quest, QUEST_TEMPLATES.tomas_steen);
  assert.doesNotMatch(r.text, /MISSIE/i);
});

test('cleanQuestIds sanitizes client input', () => {
  assert.deepEqual(
    cleanQuestIds(['mara_bessen', '  tomas_hout ', 'bad id!', 42, null, 'x'.repeat(50)]),
    ['mara_bessen', 'tomas_hout'],
  );
  assert.deepEqual(cleanQuestIds('not-a-list'), []);
  assert.deepEqual(cleanQuestIds(undefined), []);
  assert.equal(cleanQuestIds(new Array(30).fill('mara_bessen'), 8).length, 8);
});
