import { describe, expect, it } from 'vitest';
import {
  MEMORY_LIMIT,
  MAX_CONTEXT_NOTES,
  MemoryStore,
  RELATIONSHIP_LIMIT,
  SEEN_ITEM_LIMIT,
} from './memory';

const NO_CLOCK = 1_700_000_000_000;

function stateStr(o: Partial<{ honger: number; dorst: number; gezond: number; temp: number; uur: string; niveau: number; bezit: string }> = {}): string {
  const {
    honger = 70,
    dorst = 70,
    gezond = 100,
    temp = 18,
    uur = '12:30',
    niveau = 1,
    bezit = 'niets',
  } = o;
  return (
    `Honger ${honger}%, dorst ${dorst}%, gezonddend ${gezond}%, temperatuur ${temp}°C, ` +
    `uur ${uur}, niveau ${niveau}. Bezit: ${bezit}.`
  );
}

describe('MemoryStore — fact extraction', () => {
  it('learns the player name from the common Dutch phrasings', () => {
    const cases: Array<[string, string]> = [
      ['mijn naam is Sam', 'Sam'],
      ['Hallo, mijn naam is sam. Hoe gaat het?', 'Sam'],
      ['ik heet Vinky', 'Vinky'],
      ['noem me jan', 'Jan'],
      ['ik ben Sam', 'Sam'],
      ['ik ben Sam Visser', 'Sam Visser'],
    ];
    for (const [msg, name] of cases) {
      const s = new MemoryStore();
      s.absorbMessage(msg, '', NO_CLOCK);
      expect(s.playerName, msg).toBe(name);
      expect(s.notes.some((n) => n.text === `De speler heet ${name}.` && n.kind === 'name'), msg).toBe(true);
    }
  });

  it('does not mistake feelings or states for a name', () => {
    for (const msg of ['ik ben bang', 'ik ben moe', 'ik ben hier', 'ik ben niet klaar']) {
      const s = new MemoryStore();
      s.absorbMessage(msg, '', NO_CLOCK);
      expect(s.playerName, msg).toBeNull();
      expect(s.notes.some((n) => n.kind === 'name'), msg).toBe(false);
    }
  });

  it('a rename replaces the old name note instead of duplicating', () => {
    const s = new MemoryStore();
    s.absorbMessage('mijn naam is Sam', '', NO_CLOCK);
    s.absorbMessage('mijn naam is Vinky', '', NO_CLOCK);
    const nameNotes = s.notes.filter((n) => n.kind === 'name');
    expect(nameNotes.map((n) => n.text)).toEqual(['De speler heet Vinky.']);
  });

  it('remembers goals and fears', () => {
    const s = new MemoryStore();
    s.absorbMessage('ik wil een hut bouwen voor de nacht', '', NO_CLOCK);
    s.absorbMessage('ik zoek water', '', NO_CLOCK);
    s.absorbMessage('mijn doel is het eiland verlaten', '', NO_CLOCK);
    s.absorbMessage('ik ben bang voor het donker', '', NO_CLOCK);
    const texts = s.notes.map((n) => n.text);
    expect(texts).toContain('De speler wil: een hut bouwen voor de nacht.');
    expect(texts).toContain('De speler wil: water.');
    expect(texts).toContain('De speler wil: het eiland verlaten.');
    expect(texts).toContain('De speler is bang voor het donker.');
    expect(s.notes.find((n) => n.text === 'De speler is bang voor het donker.')?.kind).toBe('fear');
  });

  it('ignores one-word "ik wil x" noise and trailing punctuation', () => {
    const s = new MemoryStore();
    s.absorbMessage('ik wil dit', '', NO_CLOCK);
    expect(s.notes.some((n) => n.kind === 'goal')).toBe(false);
    s.absorbMessage('ik wil graag drinkbaar water uit het meer.', '', NO_CLOCK);
    const goal = s.notes.find((n) => n.kind === 'goal');
    expect(goal?.text).toBe('De speler wil: graag drinkbaar water uit het meer.');
  });

  it('cuts remembered phrases at clause boundaries instead of memorising whole sentences', () => {
    const s = new MemoryStore();
    s.absorbMessage('ik ben bang voor wolven en ik wil een hut bouwen', '', NO_CLOCK);
    const texts = s.notes.map((n) => n.text);
    expect(texts).toContain('De speler is bang voor wolven.');
    expect(texts).toContain('De speler wil: een hut bouwen.');

    const t = new MemoryStore();
    t.absorbMessage('Ik wil vanavond vissen, wat raden je aan?', '', NO_CLOCK);
    expect(t.notes.map((n) => n.text)).toContain('De speler wil: vanavond vissen.');

    const u = new MemoryStore();
    u.absorbMessage('ik ben bang voor de duisternis omdat ik niets zie', '', NO_CLOCK);
    expect(u.notes.map((n) => n.text)).toContain('De speler is bang voor de duisternis.');
  });

  it('keeps a coordinated object intact', () => {
    const s = new MemoryStore();
    s.absorbMessage('ik wil honger en dorst overleven', '', NO_CLOCK);
    expect(s.notes.map((n) => n.text)).toContain('De speler wil: honger en dorst overleven.');
  });

  it('stops at sentence boundaries inside one message', () => {
    const s = new MemoryStore();
    s.absorbMessage('Ik wil vanavond vissen. Wat raad je aan?', '', NO_CLOCK);
    expect(s.notes.map((n) => n.text)).toContain('De speler wil: vanavond vissen.');

    const t = new MemoryStore();
    t.absorbMessage('Ik ben bang voor wolven en ik wil vanavond vissen. Wat raad je aan?', '', NO_CLOCK);
    expect(t.notes.map((n) => n.text)).toEqual(
      expect.arrayContaining(['De speler is bang voor wolven.', 'De speler wil: vanavond vissen.']),
    );
    expect(t.notes.some((n) => /raad je aan/i.test(n.text))).toBe(false);
  });

  it('does not absorb clause words into the name', () => {
    for (const [msg, name] of [
      ['mijn naam is Sam en ik wil vissen', 'Sam'],
      ['mijn naam is Sam ik wil vissen', 'Sam'],
      ['mijn naam is Sam Visser en dank je', 'Sam Visser'],
    ] as const) {
      const s = new MemoryStore();
      s.absorbMessage(msg, '', NO_CLOCK);
      expect(s.playerName, msg).toBe(name);
    }
  });

  it('bumps turn and lastSeen once per message', () => {
    const s = new MemoryStore();
    s.absorbMessage('hallo', '', 1000);
    s.absorbMessage('hoe gaat het?', '', 2500);
    expect(s.turns).toBe(2);
    expect(s.lastSeen).toBe(2500);
  });

  it('stores nothing for an empty message but still counts the turn', () => {
    const s = new MemoryStore();
    s.absorbMessage('   ', '', 5);
    expect(s.turns).toBe(1);
    expect(s.notes).toHaveLength(0);
  });
});

describe('MemoryStore — relationship tone', () => {
  it('scores friendly and rude wording', () => {
    const s = new MemoryStore();
    expect(s.adjustTone('dank je, dat is fijn!')).toBe(10);
    expect(s.adjustTone('je bent een idioot')).toBe(-8);
    expect(s.relationship).toBe(2);
  });

  it('drifts slightly warmer on neutral engagement', () => {
    const s = new MemoryStore();
    expect(s.adjustTone('waar is vuur?')).toBe(1);
    expect(s.relationship).toBe(1);
  });

  it('clamps at both ends', () => {
    const s = new MemoryStore();
    for (let i = 0; i < 400; i++) s.adjustTone('dank je wel, hartstikke fijn, geweldig');
    expect(s.relationship).toBe(RELATIONSHIP_LIMIT);
    for (let i = 0; i < 400; i++) s.adjustTone('idiot stom slordig');
    expect(s.relationship).toBe(-RELATIONSHIP_LIMIT);
  });

  it('labels the relationship in bands', () => {
    const s = new MemoryStore();
    expect(s.relationshipLabel()).toBe('neutraal');
    s.relationship = 12;
    expect(s.relationshipLabel()).toBe('vriendelijk');
    s.relationship = 45;
    expect(s.relationshipLabel()).toBe('warm');
    s.relationship = -12;
    expect(s.relationshipLabel()).toBe('koel');
    s.relationship = -60;
    expect(s.relationshipLabel()).toBe('koel-voorzichtig');
  });

  it('remembers the tone of extreme exchanges', () => {
    const s = new MemoryStore();
    s.absorbMessage('dank je, hartstikke lief van je', '', NO_CLOCK);
    expect(s.notes.map((n) => n.text)).toContain('De speler was vriendelijk tegen je.');
    s.absorbMessage('houd je mond, idioot', '', NO_CLOCK);
    expect(s.notes.map((n) => n.text)).toContain('De speler was grof tegen je.');
  });
});

describe('MemoryStore — game-state observations', () => {
  it('derives notable conditions from the player-state summary', () => {
    const s = new MemoryStore();
    s.observeState(stateStr({ honger: 12, dorst: 8, gezond: 30, temp: 4, uur: '23:10' }));
    const texts = s.notes.map((n) => n.text);
    expect(texts).toContain('De speler had grote honger.');
    expect(texts).toContain('De speler had grote dorst.');
    expect(texts).toContain('De speler was zwaar gewond.');
    expect(texts).toContain('De speler had het koud.');
    expect(texts).toContain('De speler zocht je op in het donker.');
  });

  it('stays quiet for comfortable conditions', () => {
    const s = new MemoryStore();
    s.observeState(stateStr());
    // Only the first-seen level is stored; nothing is made of healthy stats.
    expect(s.notes.filter((n) => n.kind === 'condition')).toHaveLength(0);
    expect(s.notes.map((n) => n.text)).toEqual(['De speler heeft niveau 1 bereikt.']);
  });

  it('refreshes one condition note instead of flooding memory with percentages', () => {
    const s = new MemoryStore();
    for (let thirst = 25; thirst >= 1; thirst--) s.observeState(stateStr({ dorst: thirst }));
    const dorst = s.notes.filter((n) => n.text === 'De speler had grote dorst.');
    expect(dorst).toHaveLength(1);
    expect(s.notes.filter((n) => n.kind === 'condition')).toHaveLength(1);
  });

  it('records level milestones only when the level rises', () => {
    const s = new MemoryStore();
    s.observeState(stateStr({ niveau: 3 }));
    s.observeState(stateStr({ niveau: 2 }));
    s.observeState(stateStr({ niveau: 3 }));
    expect(s.notes.filter((n) => n.kind === 'milestone').map((n) => n.text)).toEqual([
      'De speler heeft niveau 3 bereikt.',
    ]);
    s.observeState(stateStr({ niveau: 7 }));
    expect(s.level).toBe(7);
    expect(s.notes.filter((n) => n.kind === 'milestone')).toHaveLength(2);
  });

  it('remembers an item only the first time it is shown', () => {
    const s = new MemoryStore();
    s.observeState(stateStr({ bezit: 'bijl, bes' }));
    s.observeState(stateStr({ bezit: 'bijl, bes' }));
    expect(s.notes.filter((n) => n.kind === 'possession')).toHaveLength(2);
    expect(s.seenItems).toEqual(['bijl', 'bes']);
    s.observeState(stateStr({ bezit: 'niets' }));
    expect(s.notes.filter((n) => n.kind === 'possession')).toHaveLength(2);
  });

  it('caps the tracked item list and keeps it consistent with the notes', () => {
    const s = new MemoryStore();
    const many = Array.from({ length: SEEN_ITEM_LIMIT + 6 }, (_, i) => `ding${i}`).join(', ');
    s.observeState(stateStr({ bezit: many }));
    expect(s.seenItems.length).toBeLessThanOrEqual(Math.min(SEEN_ITEM_LIMIT, MEMORY_LIMIT));
    expect(s.notes.length).toBeLessThanOrEqual(MEMORY_LIMIT);
    // Whatever it still tracks must still be a memory, and vice versa.
    for (const item of s.seenItems) {
      expect(s.notes.some((n) => n.text === `De speler toonde je ${item}.`)).toBe(true);
    }
    for (const note of s.notes.filter((n) => n.kind === 'possession')) {
      expect(s.seenItems).toContain(note.text.match(/toonde je (.+)\.$/)![1]);
    }
  });

  it('absorbs state even when the player says nothing', () => {
    const s = new MemoryStore();
    s.absorbMessage('...', stateStr({ honger: 5 }), NO_CLOCK);
    expect(s.notes.map((n) => n.text)).toContain('De speler had grote honger.');
  });
});

describe('MemoryStore — capacity and prompt shaping', () => {
  it('never exceeds the note limit', () => {
    const s = new MemoryStore();
    for (let i = 0; i < MEMORY_LIMIT + 12; i++) s.remember(`Feit nummer ${i} over de speler`, 'possession');
    expect(s.notes.length).toBe(MEMORY_LIMIT);
  });

  it('forgets the least important notes first and never forgets the name', () => {
    const s = new MemoryStore();
    s.absorbMessage('mijn naam is Sam', '', NO_CLOCK);
    s.absorbMessage('ik ben bang voor de wolf', '', NO_CLOCK);
    for (let i = 0; i < MEMORY_LIMIT + 5; i++) s.remember(`Willekeurig bezitsfeit ${i}`, 'possession');
    expect(s.notes.length).toBe(MEMORY_LIMIT);
    expect(s.playerName).toBe('Sam');
    expect(s.notes.some((n) => n.text === 'De speler heet Sam.')).toBe(true);
    expect(s.notes.some((n) => n.text === 'De speler is bang voor de wolf.')).toBe(true);
  });

  it('drops the possession tracking entry when its note is forgotten', () => {
    const s = new MemoryStore();
    s.observeState(stateStr({ bezit: 'bijl' }));
    expect(s.seenItems).toContain('bijl');
    for (let i = 0; i < MEMORY_LIMIT + 4; i++) s.remember(`Willekeurig bezitsfeit ${i}`, 'possession');
    expect(s.notes.some((n) => n.text === 'De speler toonde je bijl.')).toBe(false);
    expect(s.seenItems).not.toContain('bijl');
  });

  it('feeds a capped, ordered context to the LLM', () => {
    const s = new MemoryStore();
    s.absorbMessage('mijn naam is Sam', '', NO_CLOCK);
    for (let i = 0; i < MEMORY_LIMIT + 3; i++) s.remember(`Laat feit ${i} voor de context`, 'goal');
    const lines = s.contextLines();
    expect(lines.length).toBeLessThanOrEqual(MAX_CONTEXT_NOTES + 1);
    expect(lines[lines.length - 1]).toMatch(/^Relatie met de speler: .*spreksrondes\)\.$/);
    expect(lines.slice(0, -1).every((l) => !l.startsWith('Relatie'))).toBe(true);
  });

  it('omits the relationship line before the first conversation', () => {
    const s = new MemoryStore();
    s.remember('De speler staat naast het vuur.', 'condition');
    expect(s.contextLines()).toEqual(['De speler staat naast het vuur.']);
  });
});

describe('MemoryStore — persistence', () => {
  it('round-trips through JSON without losing kinds or relationship', () => {
    const s = new MemoryStore();
    s.absorbMessage('mijn naam is Sam, ik wil een hut bouwen', stateStr({ niveau: 4, bezit: 'bijl' }), NO_CLOCK);
    s.absorbMessage('dank je, fijn', stateStr({ niveau: 4, bezit: 'bijl' }), NO_CLOCK + 1000);
    const restored = new MemoryStore();
    restored.restore(JSON.parse(JSON.stringify(s.serialize())));
    expect(restored.serialize()).toEqual(s.serialize());
    expect(restored.playerName).toBe('Sam');
    expect(restored.relationship).toBe(s.relationship);
  });

  it('restores legacy saves that only stored memory strings', () => {
    const s = new MemoryStore();
    s.restore({
      memory: ['De speler heet Sam.', 'De speler is bang voor de wolf.', 'De speler had grote honger.'],
    });
    expect(s.notes).toHaveLength(3);
    expect(s.playerName).toBe('Sam');
    expect(s.notes.map((n) => n.kind)).toEqual(['name', 'fear', 'condition']);
    expect(s.turns).toBe(0);
  });

  it('survives corrupt snapshots without throwing or producing junk notes', () => {
    const s = new MemoryStore();
    s.restore({
      memory: [null, 42, 'oké feit', 'x'],
      rel: Number.NaN,
      turns: -5,
      seen: 'gisteren',
      level: 1.7,
      items: ['bijl', 7],
    } as unknown as Parameters<MemoryStore['restore']>[0]);
    expect(s.relationship).toBe(0);
    expect(s.turns).toBe(0);
    expect(s.lastSeen).toBe(0);
    expect(s.level).toBe(1);
    expect(s.seenItems).toEqual(['bijl']);
    expect(s.notes.map((n) => n.text)).toEqual(['oké feit']);
  });

  it('ignores notes with an unknown kind but keeps the text', () => {
    const s = new MemoryStore();
    s.restore({ notes: [{ text: 'De speler bouwde een hut.', kind: 'castle', turn: 3 }] } as unknown as Parameters<MemoryStore['restore']>[0]);
    expect(s.notes).toHaveLength(1);
    expect(s.notes[0].kind).toBe('goal');
    expect(s.notes[0].salience).toBeGreaterThan(0);
  });

  it('restore of null/undefined leaves an empty store', () => {
    const s = new MemoryStore();
    s.restore(null);
    s.restore(undefined);
    expect(s.serialize().memory).toEqual([]);
    expect(s.relationship).toBe(0);
  });

  it('is deterministic: identical input produces an identical snapshot', () => {
    const run = () => {
      const s = new MemoryStore();
      s.absorbMessage('mijn naam is Sam en ik wil vissen', stateStr({ niveau: 2, bezit: 'bijl, bes' }), 42);
      s.absorbMessage('ik ben bang voor spinnen', stateStr({ niveau: 3, dorst: 10 }), 43);
      return JSON.stringify(s.serialize());
    };
    expect(run()).toBe(run());
  });
});
