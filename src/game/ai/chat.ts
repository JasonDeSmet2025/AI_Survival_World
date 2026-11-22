import type { NpcProfile } from './npc';
import { MemoryStore, type MemorySnapshot } from './memory';
import { sanitizeReply } from './reply';
import { validateQuest, type QuestDef, type RawQuest } from '../systems/quests';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatContext {
  /** Short world-event notes appended to the NPC's knowledge. */
  events?: string[];
  /** Player-visible summary of player state (e.g. low thirst). */
  playerState?: string;
  /**
   * Quest ids the player already has in progress / already finished. The
   * server only ever uses these to SUPPRESS duplicate quest offers — a
   * client cannot complete or create a quest by lying here (the QuestLog
   * only advances on real game events).
   */
  quests?: { active: string[]; completed: string[] };
}

export type ReplySource = 'llm' | 'fallback';

/** What a Conversation persists through the autosave (see systems/save.ts). */
export interface SerializedConversation extends MemorySnapshot {
  history: ChatMessage[];
}

/** Request tuning (AI Agent scope). */
export const CHAT_TIMEOUT_MS = 20000;
export const CHAT_MAX_ATTEMPTS = 2;
export const CHAT_RETRY_DELAY_MS = 400;
/** Turns of dialog kept in the prompt and in the save. */
export const HISTORY_LIMIT = 30;
/** Messages sent to the model per request. */
export const PROMPT_HISTORY_LIMIT = 12;

/** Errors that are worth retrying once. */
export class ChatUnavailableError extends Error {}

export interface ChatClientOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  /** Injectable fetch (tests) — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable wait (tests) — defaults to setTimeout. */
  wait?: (ms: number) => Promise<void>;
}

interface ChatResponse {
  reply?: unknown;
  error?: string;
  /** Server-validated quest offer (see server/quests.mjs), if any. */
  quest?: RawQuest | null;
}

/**
 * AI backend client (AI Agent scope).
 *
 * Talks to the game server's /api/chat endpoint, which proxies NPC
 * conversation to the Qwen model through the existing LiteLLM gateway. The
 * API key never reaches the browser. When the server or model is unavailable
 * the client degrades to deterministic canned dialogue, so NPCs stay alive
 * offline and latency spikes never freeze the chat HUD.
 *
 * Resilience: transient failures (network, timeout, 5xx, empty or unusable
 * reply) are retried once after a short delay; 4xx answers a request the
 * server deliberately rejected and is never retried.
 *
 * NOTE: routine NPC behaviour never touches this module — only conversation
 * does, and only once per player message.
 */
export class ChatClient {
  private cache = new Map<string, string>();
  private endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly doFetch: typeof fetch;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(endpoint: string, options: ChatClientOptions = {}) {
    this.endpoint = endpoint;
    this.timeoutMs = options.timeoutMs ?? CHAT_TIMEOUT_MS;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? CHAT_MAX_ATTEMPTS);
    this.retryDelayMs = options.retryDelayMs ?? CHAT_RETRY_DELAY_MS;
    this.doFetch = options.fetchImpl ?? ((...args) => fetch(...args));
    this.wait = options.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Send a player message and return the NPC reply. `history` must contain
   * only PRIOR turns: the current message travels as `playerMessage`, so the
   * model never sees the same user turn twice.
   */
  async send(
    persona: NpcProfile,
    history: ChatMessage[],
    playerMessage: string,
    context: ChatContext = {},
  ): Promise<{ reply: string; source: ReplySource; quest: QuestDef | null }> {
    const message = playerMessage.replace(/\s+/g, ' ').trim();
    if (!message) return { reply: this.fallback(persona, history.length), source: 'fallback', quest: null };

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await this.request(persona, history, message, context);
      } catch (err) {
        lastError = err;
        // A 4xx is a definitive rejection (bad npc id, empty message):
        // retrying cannot fix it, so stop immediately.
        if (err instanceof ChatHttpError && err.status >= 400 && err.status < 500) break;
        if (attempt < this.maxAttempts) await this.wait(this.retryDelayMs * attempt);
      }
    }
    void lastError;
    return { reply: this.fallback(persona, history.length), source: 'fallback', quest: null };
  }

  private async request(
    persona: NpcProfile,
    history: ChatMessage[],
    message: string,
    context: ChatContext,
  ): Promise<{ reply: string; source: ReplySource; quest: QuestDef | null }> {
    const res = await this.doFetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Server keys personas by their id (see server.mjs NPC_PERSONAS).
        npc: persona.id,
        history: history.slice(-PROMPT_HISTORY_LIMIT),
        message,
        context,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new ChatHttpError(res.status);
    const data = (await res.json()) as ChatResponse;
    // Validate before showing: markdown, runaway length or assistant-speak
    // are treated as a failed reply, which retries and then falls back.
    const clean = sanitizeReply(data.reply);
    if (!clean) throw new ChatUnavailableError('unusable reply');
    // Defense in depth: the server already validated the quest against its
    // template table; we re-validate against the REAL item/build/recipe
    // tables before the QuestLog ever sees it.
    return { reply: clean, source: 'llm', quest: validateQuest(data.quest) };
  }

  /** Deterministic fallback reply (no LLM needed). */
  private fallback(persona: NpcProfile, turn: number): string {
    const key = persona.id + ':' + (turn % persona.fallbackLines.length);
    const line = this.cache.get(key) ?? persona.fallbackLines[turn % persona.fallbackLines.length];
    this.cache.set(key, line);
    return line;
  }
}

class ChatHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`chat http ${status}`);
    this.status = status;
  }
}

/**
 * Conversation manager: per-NPC history plus persistent, structured memory.
 * Memory is extracted deterministically (see memory.ts), survives reloads
 * through the player save, and is fed to the model as read-only context.
 */
export class Conversation {
  history: ChatMessage[] = [];
  /** Durable per-NPC memory: facts, condition, milestones, relationship. */
  readonly memory: MemoryStore;
  private client: ChatClient;
  private persona: NpcProfile;
  private busy = false;

  constructor(persona: NpcProfile, endpoint: string, options: ChatClientOptions = {}) {
    this.persona = persona;
    this.memory = new MemoryStore();
    this.client = new ChatClient(endpoint, options);
  }

  get personaId(): string {
    return this.persona.id;
  }

  /** Convenience accessor for the remembered player name. */
  get playerName(): string | null {
    return this.memory.playerName;
  }

  get relationship(): number {
    return this.memory.relationship;
  }

  async send(
    playerMessage: string,
    context: ChatContext = {},
    now: number = Date.now(),
  ): Promise<{ reply: string; source: ReplySource; quest: QuestDef | null }> {
    const text = playerMessage.replace(/\s+/g, ' ').trim();
    if (!text) return { reply: this.persona.fallbackLines[0], source: 'fallback', quest: null };
    if (this.busy) return { reply: '...', source: 'fallback', quest: null };
    this.busy = true;
    try {
      // Memory first (no network): what the NPC remembers shapes how it asks.
      this.memory.absorbMessage(text, context.playerState ?? '', now);

      const prior = this.history.slice();
      const ctx: ChatContext = {
        ...context,
        events: [
          ...(context.events ?? []),
          ...this.memory.contextLines().map((line) => 'Herinnering: ' + line),
        ],
      };

      this.history.push({ role: 'user', content: text });
      const { reply, source, quest } = await this.client.send(this.persona, prior, text, ctx);
      // The client sanitizes, but keep the HUD safe even if a caller
      // constructs a Conversation with a custom transport.
      const safe = sanitizeReply(reply) ?? this.persona.fallbackLines[0];
      this.history.push({ role: 'assistant', content: safe });
      if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
      return { reply: safe, source, quest };
    } finally {
      this.busy = false;
    }
  }

  /** Add a durable note by hand (game events, scripted moments). */
  addMemory(note: string): boolean {
    return this.memory.remember(note, 'milestone');
  }

  /**
   * Absorb a notable game event without a chat turn, e.g. from the
   * gameplay layer when the player builds next to the camp.
   */
  absorbEvent(text: string, now: number = Date.now()): boolean {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return false;
    this.memory.lastSeen = now;
    return this.memory.remember(clean, 'milestone');
  }

  serialize(): SerializedConversation {
    return { history: this.history, ...this.memory.serialize() };
  }

  /** Restore history + memory. Accepts current and pre-memory save shapes. */
  restore(data: (Partial<SerializedConversation> & { history?: ChatMessage[] }) | null | undefined): void {
    if (!data) return;
    if (Array.isArray(data.history)) {
      this.history = data.history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map((m) => ({ role: m.role, content: m.content }));
    }
    this.memory.restore(data);
  }
}
