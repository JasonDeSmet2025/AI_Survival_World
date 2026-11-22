import { describe, expect, it } from 'vitest';
import {
  chooseModel,
  createLlmClient,
  extractReply,
  isModelAccessError,
  LlmError,
  parseAllowedModels,
} from './llm.mjs';

const KEY = 'sk-secret-should-never-leak';
const MSGS = [{ role: 'user', content: 'hallo' }];

/** Gateway double: scripted completions, optional /models list. */
function gateway({ completions, models, onCall }) {
  const calls = [];
  let cn = 0;
  const impl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init?.method ?? 'GET', body, headers: init?.headers });
    onCall?.(calls.length, body?.model);
    if (url.endsWith('/models')) {
      return jsonResponse(200, (typeof models === 'function' ? models() : models) ?? { data: [] });
    }
    const step = completions[Math.min(cn, completions.length - 1)];
    cn += 1;
    if (typeof step === 'function') return step(body?.model);
    if (step?.error) return jsonResponse(step.status ?? 500, { error: { message: step.error } });
    return jsonResponse(200, { choices: [{ message: { content: step?.reply ?? '' } }] });
  };
  return { impl, calls };
}

function jsonResponse(status, payload) {
  const text = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => text,
  };
}

const DENIED = {
  error: {
    message:
      "key not allowed to access model. This key can only access models=['qwen3.8-flash-next']. Tried to access qwen3.8-27b",
  },
};

describe('parseAllowedModels / isModelAccessError / chooseModel', () => {
  it('reads the allowed list out of a LiteLLM error', () => {
    expect(parseAllowedModels(DENIED)).toEqual(['qwen3.8-flash-next']);
    expect(parseAllowedModels(JSON.stringify(DENIED))).toEqual(['qwen3.8-flash-next']);
    expect(parseAllowedModels({ error: { message: 'ongeldig bericht' } })).toEqual([]);
    expect(parseAllowedModels(undefined)).toEqual([]);
  });

  it('only treats model refusals as model errors', () => {
    expect(isModelAccessError(403, DENIED)).toBe(true);
    expect(isModelAccessError(404, { error: { message: 'model_not_found' } })).toBe(true);
    expect(isModelAccessError(401, { error: { message: 'Virtual Key expected' } })).toBe(false);
    expect(isModelAccessError(429, { error: { message: 'rate limit' } })).toBe(false);
    expect(isModelAccessError(500, { error: { message: 'model crashed' } })).toBe(false);
    expect(isModelAccessError(403, { error: { message: 'key not allowed' } })).toBe(false);
  });

  it('prefers the same model family and never the rejected one', () => {
    expect(chooseModel(['qwen3.8-flash-next', 'llama-3'], 'qwen3.8-27b')).toBe('qwen3.8-flash-next');
    expect(chooseModel(['llama-3', 'mistral'], 'qwen3.8-27b')).toBe('llama-3');
    expect(chooseModel(['qwen3.8-27b'], 'qwen3.8-27b')).toBeNull();
    expect(chooseModel([], 'qwen3.8-27b')).toBeNull();
    expect(chooseModel(['a', 'a', 5, null], 'x')).toBe('a');
  });
});

describe('extractReply', () => {
  it('handles OpenAI shapes and junk', () => {
    expect(extractReply({ choices: [{ message: { content: '  hallo  ' } }] })).toBe('hallo');
    expect(extractReply({ choices: [{ text: 'ibo' }] })).toBe('ibo');
    expect(extractReply({})).toBe('');
    expect(extractReply(null)).toBe('');
    expect(extractReply({ choices: [{ message: { content: 7 } }] })).toBe('');
  });
});

describe('createLlmClient', () => {
  it('completes with the preferred model and reports it', async () => {
    const g = gateway({ completions: [{ reply: 'Fijn dat je er bent.' }] });
    const llm = createLlmClient({ baseUrl: 'https://gw.test/v1', fetchImpl: g.impl, model: 'qwen3.8-27b' });
    const res = await llm.chat({ key: KEY, messages: MSGS });
    expect(res).toEqual({ reply: 'Fijn dat je er bent.', model: 'qwen3.8-27b' });
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0].url).toBe('https://gw.test/v1/chat/completions');
    expect(g.calls[0].body).toMatchObject({ model: 'qwen3.8-27b', stream: false, max_tokens: 300 });
    expect(g.calls[0].headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it('switches to an allowed model after a 403 and keeps using it', async () => {
    const g = gateway({
      completions: [
        { status: 403, error: DENIED.error.message },
        { reply: 'Vuur maken? Droog hout en geduld.' },
        { reply: 'Tweede regel.' },
      ],
    });
    const logs = [];
    const llm = createLlmClient({
      baseUrl: 'https://gw.test/v1',
      fetchImpl: g.impl,
      model: 'qwen3.8-27b',
      log: (m) => logs.push(m),
    });
    const first = await llm.chat({ key: KEY, messages: MSGS });
    expect(first).toEqual({ reply: 'Vuur maken? Droog hout en geduld.', model: 'qwen3.8-flash-next' });
    expect(llm.model()).toBe('qwen3.8-flash-next');
    // The switch is logged once, and the next call skips the rejected model.
    const second = await llm.chat({ key: KEY, messages: MSGS });
    expect(second.reply).toBe('Tweede regel.');
    expect(logs).toEqual(['[llm] model -> qwen3.8-flash-next']);
    expect(g.calls.map((c) => c.body.model)).toEqual(['qwen3.8-27b', 'qwen3.8-flash-next', 'qwen3.8-flash-next']);
  });

  it('asks GET /models when the error does not name the allowed models', async () => {
    const g = gateway({
      completions: [
        { status: 404, error: 'model_not_found' },
        { reply: 'Goed gevraagd.' },
      ],
      models: { data: [{ id: 'qwen3.8-mini' }, { id: 'gpt' }] },
    });
    const llm = createLlmClient({ baseUrl: 'https://gw.test/v1', fetchImpl: g.impl, model: 'qwen3.8-27b' });
    const res = await llm.chat({ key: KEY, messages: MSGS });
    expect(res.model).toBe('qwen3.8-mini');
    const listCall = g.calls.find((c) => c.url.endsWith('/models'));
    expect(listCall.method).toBe('GET');
    expect(listCall.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it('does not retry unrelated failures', async () => {
    const g = gateway({ completions: [{ status: 500, error: 'upstream exploded' }] });
    const llm = createLlmClient({ baseUrl: 'https://gw.test/v1', fetchImpl: g.impl });
    await expect(llm.chat({ key: KEY, messages: MSGS })).rejects.toThrow('llm http 500');
    expect(g.calls).toHaveLength(1);
  });

  it('never repeats a rejected model when no fallback exists', async () => {
    const g = gateway({
      completions: [{ status: 403, error: 'key not allowed to access model qwen3.8-27b' }],
      models: { data: [{ id: 'qwen3.8-27b' }] },
    });
    const llm = createLlmClient({ baseUrl: 'https://gw.test/v1', fetchImpl: g.impl, model: 'qwen3.8-27b' });
    await expect(llm.chat({ key: KEY, messages: MSGS })).rejects.toThrow(/not allowed and no fallback/);
    expect(g.calls.filter((c) => c.url.endsWith('chat/completions'))).toHaveLength(1);
    expect(llm.model()).toBe('qwen3.8-27b');
  });

  it('fails when the completion is empty, and does not leak the key', async () => {
    const g = gateway({ completions: [{ reply: '   ' }] });
    const llm = createLlmClient({ baseUrl: 'https://gw.test/v1', fetchImpl: g.impl });
    const err = await llm.chat({ key: KEY, messages: MSGS }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).not.toContain(KEY);
    expect(JSON.stringify({ m: err.message, p: err.preview })).not.toContain(KEY);
  });

  it('validates arguments before touching the network', async () => {
    const g = gateway({ completions: [{ reply: 'x' }] });
    const llm = createLlmClient({ baseUrl: 'https://gw.test/v1', fetchImpl: g.impl });
    await expect(llm.chat({ key: '', messages: MSGS })).rejects.toThrow('llm key missing');
    await expect(llm.chat({ key: KEY, messages: [] })).rejects.toThrow('messages required');
    expect(g.calls).toHaveLength(0);
    expect(() => createLlmClient({})).toThrow('baseUrl required');
  });

  it('exposes cache expiry for the resolved model', async () => {
    let clock = 1000;
    const g = gateway({
      completions: [{ status: 403, error: DENIED.error.message }, { reply: 'ja' }, { reply: 'ja' }],
    });
    const llm = createLlmClient({
      baseUrl: 'https://gw.test/v1',
      fetchImpl: g.impl,
      ttlMs: 50,
      now: () => clock,
    });
    expect(llm.cacheExpired()).toBe(false);
    await llm.chat({ key: KEY, messages: MSGS });
    expect(llm.cacheExpired()).toBe(false);
    clock += 51;
    expect(llm.cacheExpired()).toBe(true);
  });
});
