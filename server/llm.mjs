/**
 * LLM gateway access for NPC conversation (AI Agent scope).
 *
 * Both chat entry points of the game server (POST /api/chat for solo play
 * and the WebSocket "chat" message for multiplayer) talk to the LiteLLM
 * gateway through this module, so persona building, model selection and
 * error handling live in exactly one place.
 *
 * Why the model is resolved at runtime: the gateway key decides which models
 * it may use, and that list changes without warning. When the configured
 * model is no longer allowed the gateway answers
 * "key not allowed to access model. This key can only access
 * models=['qwen3.8-flash-next']". Hard-coding a model name therefore bricks
 * every NPC conversation until someone reads the log. This module instead
 * reads the allowed list out of the error (or asks GET /models) and retries
 * once with a suitable replacement, then remembers it.
 *
 * Credentials: the key is only ever used as a Bearer header here. It is never
 * logged, never returned, and never sent to the browser.
 */

/** Preferred model; overridden at runtime when the gateway rejects it. */
export const DEFAULT_MODEL = process.env.VIVES_MODEL || 'qwen3.8-27b';

/** How long a resolved model name may be reused before re-checking. */
export const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;

/** Maximum characters of gateway error text we keep for the logs. */
export const MAX_ERROR_PREVIEW = 400;

const QWEN = /qwen/i;

/** Pull the allowed model list out of a LiteLLM error payload. */
export function parseAllowedModels(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});
  const m = text.match(/models=\[([^\]]*)\]/i);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

/** True when the gateway refused *this model* (not the key, not the request). */
export function isModelAccessError(status, payload) {
  if (status !== 400 && status !== 403 && status !== 404 && status !== 422) return false;
  const text = (typeof payload === 'string' ? payload : JSON.stringify(payload ?? {})).toLowerCase();
  if (!text.includes('model')) return false;
  return /(not allowed to access model|only access models|does not exist|no such model|invalid model|model_not_found|unsupported model)/.test(
    text,
  );
}

/**
 * Pick a replacement model: stay with the same model family when possible,
 * and never pick the model that was just rejected.
 */
export function chooseModel(allowed, preferred = DEFAULT_MODEL) {
  const list = [...new Set((Array.isArray(allowed) ? allowed : []).filter((m) => typeof m === 'string' && m))];
  if (!list.length) return null;
  const candidates = list.filter((m) => m !== preferred);
  if (!candidates.length) return null;
  const sameFamily = candidates.find((m) => QWEN.test(m) && QWEN.test(preferred));
  return sameFamily ?? candidates[0] ?? null;
}

/** Extract the assistant text out of an OpenAI-style completion payload. */
export function extractReply(payload) {
  const choice = payload?.choices?.[0];
  const text = choice?.message?.content ?? choice?.text ?? '';
  return typeof text === 'string' ? text.trim() : '';
}

async function readErrorText(res) {
  try {
    const t = await res.text();
    return (t || '').slice(0, MAX_ERROR_PREVIEW);
  } catch {
    return '';
  }
}

export class LlmError extends Error {
  constructor(message, { status = 0, model = '', preview = '' } = {}) {
    super(message);
    this.status = status;
    this.model = model;
    // Never include headers or the request body: those carry the key.
    this.preview = (preview || '').slice(0, MAX_ERROR_PREVIEW);
  }
}

/**
 * Create a chat runner.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl      LiteLLM base, e.g. https://host/v1
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string} [opts.model]      preferred model
 * @param {(msg: string) => void} [opts.log]
 * @param {number} [opts.timeoutMs]  completion timeout
 * @param {number} [opts.listTimeoutMs] model-list timeout
 */
export function createLlmClient({
  baseUrl,
  fetchImpl = fetch,
  model = DEFAULT_MODEL,
  ttlMs = MODEL_CACHE_TTL_MS,
  timeoutMs = 30000,
  listTimeoutMs = 8000,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  if (!baseUrl) throw new Error('llm baseUrl required');
  let current = model;
  let resolvedAt = 0;

  async function completeWith(m, key, messages, maxTokens, temperature) {
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: m, messages, stream: false, max_tokens: maxTokens, temperature }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { error: { status: res.status, preview: await readErrorText(res) }, model: m };
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      return { error: { status: 0, preview: 'malformed json' }, model: m };
    }
    const reply = extractReply(payload);
    if (!reply) return { error: { status: 0, preview: 'empty completion' }, model: m };
    return { reply, model: m };
  }

  async function listModels(key) {
    try {
      const res = await fetchImpl(`${baseUrl}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(listTimeoutMs),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (Array.isArray(data?.data) ? data.data : []).map((m) => m?.id).filter(Boolean);
    } catch {
      return [];
    }
  }

  return {
    model: () => current,
    modelResolvedAt: () => resolvedAt,
    setModel(m) {
      if (typeof m === 'string' && m && m !== current) {
        log(`[llm] model -> ${m}`);
        current = m;
        resolvedAt = now();
      }
    },

    /**
     * Ask the model for one NPC reply.
     * Returns { reply, model }. Throws LlmError when nothing usable came back.
     */
    async chat({ key, messages, maxTokens = 300, temperature = 0.8 }) {
      if (!key) throw new LlmError('llm key missing');
      if (!Array.isArray(messages) || !messages.length) throw new LlmError('llm messages required');
      let attempt = await completeWith(current, key, messages, maxTokens, temperature);
      if (attempt.reply) return { reply: attempt.reply, model: attempt.model };

      const err = attempt.error;
      if (isModelAccessError(err.status, err.preview)) {
        let allowed = parseAllowedModels(err.preview);
        if (!allowed.length) allowed = await listModels(key);
        const next = chooseModel(allowed, current);
        if (next) {
          this.setModel(next);
          attempt = await completeWith(next, key, messages, maxTokens, temperature);
          if (attempt.reply) return { reply: attempt.reply, model: attempt.model };
          throw new LlmError(`llm http ${attempt.error?.status || err.status}`, {
            status: attempt.error?.status ?? err.status,
            model: next,
            preview: attempt.error?.preview ?? err.preview,
          });
        }
        throw new LlmError(`llm model ${current} not allowed and no fallback available`, {
          status: err.status,
          model: current,
          preview: err.preview,
        });
      }
      throw new LlmError(`llm http ${err.status || 0}`, { status: err.status, model: current, preview: err.preview });
    },

    /** True when the cached model switch is stale and may be re-resolved. */
    cacheExpired: () => resolvedAt > 0 && now() - resolvedAt > ttlMs,
  };
}
