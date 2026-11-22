import { describe, expect, it } from 'vitest';
import {
  CHAT_RETRY_DELAY_MS,
  Conversation,
  HISTORY_LIMIT,
  PROMPT_HISTORY_LIMIT,
  ChatClient,
} from './chat';
import { NPC_PROFILES } from './npc';
import { MEMORY_LIMIT } from './memory';

const MARA = NPC_PROFILES[0];

interface Sent {
  body: {
    npc: string;
    message: string;
    history: { role: string; content: string }[];
    context: { events?: string[]; playerState?: string; quests?: { active: string[]; completed: string[] } };
  };
}

type FakeResult = { status: number; reply?: unknown; quest?: unknown };

/** Fake gateway: records requests and answers with a scripted result list. */
function fakeFetch(results: FakeResult[]) {
  const sent: Sent[] = [];
  let calls = 0;
  const impl = (async (_url: unknown, init: RequestInit) => {
    const record: Sent = { body: JSON.parse(String(init.body)) as Sent['body'] };
    sent.push(record);
    const result = results[Math.min(calls, results.length - 1)];
    calls += 1;
    return {
      ok: result.status === 200,
      status: result.status,
      json: async () =>
        result.reply === undefined
          ? { error: 'boom' }
          : { reply: result.reply, ...(result.quest !== undefined ? { quest: result.quest } : {}) },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, sent, calls: () => calls };
}

function client(results: FakeResult[], waits: number[] = []) {
  const f = fakeFetch(results);
  const c = new ChatClient('/api/chat', {
    fetchImpl: f.impl,
    retryDelayMs: 10,
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  return { c, f, waits };
}

function conversation(results: FakeResult[], waits: number[] = []) {
  const f = fakeFetch(results);
  const conv = new Conversation(MARA, '/api/chat', {
    fetchImpl: f.impl,
    retryDelayMs: 10,
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  return { conv, f, waits };
}

describe('ChatClient', () => {
  it('returns a sanitized LLM reply', async () => {
    const { c } = client([{ status: 200, reply: '**Vuur?** Zoek droog hout. `makkelijk`' }]);
    const res = await c.send(MARA, [], 'Hoe maak ik vuur?');
    expect(res.source).toBe('llm');
    expect(res.reply).toBe('Vuur? Zoek droog hout. makkelijk');
  });

  it('passes a server-validated quest offer through, drops an invalid one', async () => {
    const quest = {
      id: 'mara_bessen',
      npc: 'mara',
      title: 'Bessen plukken',
      desc: 'Pluk 4 bessen.',
      goal: { type: 'gather', item: 'berry', count: 4 },
      reward: { xp: 15, items: [] },
    };
    const ok = client([{ status: 200, reply: 'Leuk!', quest }]);
    const res = await ok.c.send(MARA, [], 'Heb je werk voor me?');
    expect(res.quest).toEqual({
      id: 'mara_bessen',
      npc: 'mara',
      title: 'Bessen plukken',
      desc: 'Pluk 4 bessen.',
      goal: { type: 'gather', target: 'berry', count: 4 },
      reward: { xp: 15, items: [] },
    });
    // A quest pointing at a nonexistent item must never reach the log.
    const bad = client([{ status: 200, reply: 'Leuk!', quest: { ...quest, goal: { type: 'gather', item: 'uranium', count: 4 } } }]);
    expect((await bad.c.send(MARA, [], 'x')).quest).toBeNull();
    // nor a reward the game cannot pay
    const rich = client([{ status: 200, reply: 'Leuk!', quest: { ...quest, reward: { xp: 15, items: [{ id: 'sword', count: 1 }] } } }]);
    expect((await rich.c.send(MARA, [], 'x')).quest).toBeNull();
  });

  it('sends quest context so the server can suppress duplicate offers', async () => {
    const { c, f } = client([{ status: 200, reply: 'ok' }]);
    await c.send(MARA, [], 'x', { quests: { active: ['mara_bessen'], completed: [] } });
    expect(f.sent[0].body.context.quests).toEqual({ active: ['mara_bessen'], completed: [] });
  });

  it('sends only PRIOR history plus the current message (no duplicated turn)', async () => {
    const { c, f } = client([{ status: 200, reply: 'Fijn dat je er bent.' }]);
    const prior = [
      { role: 'user' as const, content: 'Hoi Mara' },
      { role: 'assistant' as const, content: 'Hoi.' },
    ];
    await c.send(MARA, prior, 'Ik heb honger');
    const body = f.sent[0].body;
    expect(body.npc).toBe('mara');
    expect(body.message).toBe('Ik heb honger');
    expect(body.history.map((m) => m.content)).toEqual(['Hoi Mara', 'Hoi.']);
    expect(body.history.some((m) => m.content === 'Ik heb honger')).toBe(false);
  });

  it('caps the prompt history it sends', async () => {
    const { c, f } = client([{ status: 200, reply: 'ok' }]);
    const long = Array.from({ length: 40 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `regel ${i}`,
    }));
    await c.send(MARA, long, 'nieuws');
    expect(f.sent[0].body.history).toHaveLength(PROMPT_HISTORY_LIMIT);
    expect(f.sent[0].body.history[PROMPT_HISTORY_LIMIT - 1].content).toBe('regel 39');
  });

  it('retries once after a transient 5xx and then succeeds', async () => {
    const waits: number[] = [];
    const { c, f } = client([{ status: 503 }, { status: 200, reply: 'Alles goed nu.' }], waits);
    const res = await c.send(MARA, [], 'Hoi');
    expect(res).toEqual({ reply: 'Alles goed nu.', source: 'llm', quest: null });
    expect(f.calls()).toBe(2);
    expect(waits).toEqual([10]);
  });

  it('gives up to canned dialogue when every attempt fails', async () => {
    const waits: number[] = [];
    const { c, f } = client([{ status: 500 }], waits);
    const res = await c.send(MARA, [], 'Hoi');
    expect(res.source).toBe('fallback');
    expect(MARA.fallbackLines).toContain(res.reply);
    expect(f.calls()).toBe(2);
    expect(waits.length).toBe(1);
  });

  it('never retries a 4xx rejection', async () => {
    const { c, f } = client([{ status: 400 }]);
    const res = await c.send(MARA, [], 'Hoi');
    expect(res.source).toBe('fallback');
    expect(f.calls()).toBe(1);
  });

  it('treats an unusable reply (markdown junk / assistant-speak) as a failure', async () => {
    const waits: number[] = [];
    const { c, f } = client([{ status: 200, reply: '```json\n{ "x": 1 }\n```' }, { status: 200, reply: 'as an AI language model, nee' }], waits);
    const res = await c.send(MARA, [], 'Hoi');
    expect(f.calls()).toBe(2);
    expect(res.source).toBe('fallback');
    expect(waits).toEqual([10]);
  });

  it('skips the network entirely for a blank message', async () => {
    const { c, f } = client([{ status: 200, reply: 'never' }]);
    const res = await c.send(MARA, [], '   \n  ');
    expect(res.source).toBe('fallback');
    expect(f.calls()).toBe(0);
  });

  it('backs off between attempts when configured to', async () => {
    const waits: number[] = [];
    const f = fakeFetch([{ status: 500 }]);
    const c = new ChatClient('/api/chat', {
      fetchImpl: f.impl,
      maxAttempts: 3,
      retryDelayMs: CHAT_RETRY_DELAY_MS,
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    await c.send(MARA, [], 'Hoi');
    expect(f.calls()).toBe(3);
    expect(waits).toEqual([CHAT_RETRY_DELAY_MS, CHAT_RETRY_DELAY_MS * 2]);
  });
});

describe('Conversation — memory integration', () => {
  it('learns the player name even when the LLM is down', async () => {
    const { conv, f } = conversation([{ status: 500 }]);
    const res = await conv.send('Mijn naam is Sam, ik wil een hut bouwen');
    expect(res.source).toBe('fallback');
    expect(conv.playerName).toBe('Sam');
    expect(conv.memory.notes.map((n) => n.text)).toContain('De speler wil: een hut bouwen.');
    // The remembered facts still reach the model on the next attempt.
    await conv.send('Hoi');
    const events = f.sent[1].body.context.events ?? [];
    expect(events.some((e) => e.startsWith('Herinnering: De speler heet Sam.'))).toBe(true);
    expect(events.some((e) => e.startsWith('Herinnering: Relatie met de speler:'))).toBe(true);
  });

  it('forwards player state and merges it into memory', async () => {
    const { conv, f } = conversation([{ status: 200, reply: 'Drink water uit het meer.' }]);
    await conv.send('Ik heb geen water', {
      playerState: 'Honger 60%, dorst 9%, gezonddend 100%, temperatuur 18°C, uur 12:00, niveau 1. Bezit: niets.',
    });
    expect(f.sent[0].body.context.playerState).toContain('dorst 9%');
    expect(conv.memory.notes.map((n) => n.text)).toContain('De speler had grote dorst.');
  });

  it('keeps the conversation turn out of the prompt history', async () => {
    const { conv, f } = conversation([{ status: 200, reply: 'Fijn.' }]);
    await conv.send('Hallo Mara');
    expect(f.sent[0].body.history).toEqual([]);
    await conv.send('Hoe gaat het?');
    expect(f.sent[1].body.history.map((m) => m.content)).toEqual(['Hallo Mara', 'Fijn.']);
    expect(f.sent[1].body.message).toBe('Hoe gaat het?');
  });

  it('trims history but keeps memory within its limit', async () => {
    const { conv } = conversation([{ status: 200, reply: 'Prima.' }]);
    for (let i = 0; i < HISTORY_LIMIT; i++) await conv.send(`Bericht ${i} met wat extra tekst`);
    expect(conv.history).toHaveLength(HISTORY_LIMIT);
    expect(conv.memory.notes.length).toBeLessThanOrEqual(MEMORY_LIMIT);
    expect(conv.history[conv.history.length - 1]).toEqual({ role: 'assistant', content: 'Prima.' });
  });

  it('rejects only whitespace and never calls the model', async () => {
    const { conv, f } = conversation([{ status: 200, reply: 'x' }]);
    const res = await conv.send('  \t ');
    expect(res.source).toBe('fallback');
    expect(res.reply).toBe(MARA.fallbackLines[0]);
    expect(f.calls()).toBe(0);
    expect(conv.history).toHaveLength(0);
  });

  it('answers a second simultaneous message with a busy notice', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const impl = (async () => {
      await gate;
      return { ok: true, status: 200, json: async () => ({ reply: 'Laat antwoord.' }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const conv = new Conversation(MARA, '/api/chat', { fetchImpl: impl });
    const first = conv.send('Eerste bericht');
    const second = await conv.send('Tweede bericht');
    expect(second).toEqual({ reply: '...', source: 'fallback', quest: null });
    release();
    expect(await first).toEqual({ reply: 'Laat antwoord.', source: 'llm', quest: null });
  });

  it('sanitizes a hostile reply before it reaches history', async () => {
    const { conv } = conversation([{ status: 200, reply: 'as an AI language model: ```code```' }]);
    const res = await conv.send('Hoi');
    expect(res.source).toBe('fallback');
    expect(conv.history[1].content).toBe(MARA.fallbackLines[0]);
    expect(conv.history[1].content).not.toMatch(/AI/i);
  });

  it('addMemory and absorbEvent store scripted game moments without an LLM turn', async () => {
    const { conv, f } = conversation([{ status: 200, reply: 'Mooi zo.' }]);
    expect(conv.addMemory('De speler heeft een hut naast het kamp gebouwd.')).toBe(true);
    expect(conv.addMemory('De speler heeft een hut naast het kamp gebouwd.')).toBe(true); // refresh
    expect(conv.memory.notes.filter((n) => n.text.includes('hut'))).toHaveLength(1);
    expect(conv.absorbEvent('De speler overleefde de eerste nacht.', 999)).toBe(true);
    expect(conv.absorbEvent('   ')).toBe(false);
    expect(conv.memory.lastSeen).toBe(999);
    expect(conv.memory.turns).toBe(0);
    await conv.send('Hoi');
    expect(f.calls()).toBe(1);
  });
});

describe('Conversation — persistence', () => {
  it('round-trips through a JSON save including memory and relationship', async () => {
    const { conv } = conversation([{ status: 200, reply: 'Vuur maken is simpel.' }]);
    await conv.send('Mijn naam is Sam, ik ben bang voor wolven', {
      playerState: 'Honger 20%, dorst 20%, gezonddend 100%, temperatuur 16°C, uur 09:00, niveau 2. Bezit: bijl.',
    });
    const json = JSON.parse(JSON.stringify(conv.serialize()));

    const revived = new Conversation(MARA, '/api/chat', { fetchImpl: fakeFetch([{ status: 200, reply: 'x' }]).impl });
    revived.restore(json);
    expect(revived.history).toEqual(conv.history);
    expect(revived.playerName).toBe('Sam');
    expect(revived.relationship).toBe(conv.relationship);
    expect(revived.memory.serialize().notes).toEqual(conv.memory.serialize().notes);
    expect(revived.memory.level).toBe(2);
    expect(revived.memory.seenItems).toEqual(['bijl']);
  });

  it('restores pre-memory saves that only stored history and memory strings', () => {
    const { conv } = conversation([{ status: 200, reply: 'x' }]);
    conv.restore({
      history: [{ role: 'user', content: 'Toen ik je sprak' }],
      memory: ['De speler heet Sam.'],
    });
    expect(conv.history).toHaveLength(1);
    expect(conv.playerName).toBe('Sam');
    expect(conv.memory.notes[0].kind).toBe('name');
    expect(conv.relationship).toBe(0);
  });

  it('drops malformed history entries on restore', () => {
    const { conv } = conversation([{ status: 200, reply: 'x' }]);
    conv.restore({
      history: [
        { role: 'user', content: 'goed' },
        { role: 'wizard', content: 'nep' },
        { role: 'assistant', content: 42 },
        null,
      ] as unknown as { role: 'user' | 'assistant'; content: string }[],
    });
    expect(conv.history).toEqual([{ role: 'user', content: 'goed' }]);
  });

  it('tolerates null saves', () => {
    const { conv } = conversation([{ status: 200, reply: 'x' }]);
    expect(() => conv.restore(null)).not.toThrow();
    expect(() => conv.restore(undefined)).not.toThrow();
    expect(conv.history).toEqual([]);
  });

  it('keeps NPC conversations independent', async () => {
    const a = conversation([{ status: 200, reply: 'A' }]);
    const b = conversation([{ status: 200, reply: 'B' }]);
    await a.conv.send('Mijn naam is Sam');
    expect(b.conv.playerName).toBeNull();
    expect(b.conv.memory.turns).toBe(0);
    expect(a.conv.memory.turns).toBe(1);
  });
});
