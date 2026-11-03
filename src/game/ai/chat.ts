import type { NpcProfile } from './npc';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatContext {
  /** Short world-event notes appended to the NPC's knowledge. */
  events?: string[];
  /** Player-visible summary of player state (e.g. low thirst). */
  playerState?: string;
}

/**
 * AI backend client (AI Agent scope).
 *
 * Talks to the game server's /api/chat endpoint, which proxies to the
 * Qwen model through the existing LiteLLM gateway. The API key never
 * reaches the browser. When the server or model is unavailable the
 * client degrades to deterministic canned dialogue so NPCs stay alive.
 *
 * NOTE: routine NPC behaviour never touches this module — only
 * conversation does.
 */
export class ChatClient {
  private cache = new Map<string, string>();
  private endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  /**
   * Send a player message and return the NPC reply.
   */
  async send(
    persona: NpcProfile,
    history: ChatMessage[],
    playerMessage: string,
    context: ChatContext = {},
  ): Promise<{ reply: string; source: 'llm' | 'fallback' }> {
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Server keys personas by their id (see server.mjs NPC_PERSONAS).
          npc: persona.id,
          history: history.slice(-12),
          message: playerMessage,
          context,
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`chat http ${res.status}`);
      const data = (await res.json()) as { reply?: string };
      if (!data.reply) throw new Error('bad chat payload');
      return { reply: data.reply, source: 'llm' };
    } catch {
      return { reply: this.fallback(persona, history.length), source: 'fallback' };
    }
  }

  /** Deterministic fallback reply (no LLM needed). */
  private fallback(persona: NpcProfile, turn: number): string {
    const key = persona.id + ':' + (turn % persona.fallbackLines.length);
    const line =
      this.cache.get(key) ??
      persona.fallbackLines[turn % persona.fallbackLines.length];
    this.cache.set(key, line);
    return line;
  }
}

/**
 * Conversation manager: per-NPC history + persistent memory notes.
 * Memory notes are durable (survive reloads) and feed the LLM context.
 */
export class Conversation {
  history: ChatMessage[] = [];
  /** Durable memory notes about the player (persisted with save). */
  memory: string[] = [];
  private client: ChatClient;
  private persona: NpcProfile;
  private busy = false;

  constructor(persona: NpcProfile, endpoint: string) {
    this.persona = persona;
    this.client = new ChatClient(endpoint);
  }

  get personaId(): string {
    return this.persona.id;
  }

  async send(playerMessage: string, context: ChatContext = {}): Promise<{ reply: string; source: 'llm' | 'fallback' }> {
    if (this.busy) return { reply: '...', source: 'fallback' };
    this.busy = true;
    try {
      this.history.push({ role: 'user', content: playerMessage });
      const ctx: ChatContext = {
        ...context,
        events: [
          ...(context.events ?? []),
          ...(this.memory.length ? ['Remember: ' + this.memory.slice(-4).join('; ')] : []),
        ],
      };
      const { reply, source } = await this.client.send(this.persona, this.history, playerMessage, ctx);
      this.history.push({ role: 'assistant', content: reply });
      if (this.history.length > 30) this.history.splice(0, this.history.length - 30);
      return { reply, source };
    } finally {
      this.busy = false;
    }
  }

  addMemory(note: string): void {
    if (this.memory.includes(note)) return;
    this.memory.push(note);
    if (this.memory.length > 10) this.memory.shift();
  }

  serialize(): { history: ChatMessage[]; memory: string[] } {
    return { history: this.history, memory: this.memory };
  }

  restore(data: { history?: ChatMessage[]; memory?: string[] }): void {
    if (data?.history) this.history = data.history;
    if (data?.memory) this.memory = data.memory;
  }
}
