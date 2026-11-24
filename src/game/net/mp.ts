/**
 * Browser-side multiplayer client (Multiplayer Agent scope).
 * Connects to the Node WebSocket server; the server is authoritative for
 * shared world state (buildings, depleted resources) and relays positions.
 */
import type { BuildingData } from '../world/types';
import { playerToken, type KvStore } from './identity';

export interface RemotePlayer {
  id: string;
  name: string;
  p: [number, number, number];
  /** Facing yaw (radians) — remote avatars used to never turn. */
  r?: number;
}

/**
 * What the server keeps per player (server/store.mjs). Structural on purpose:
 * the net layer must not drag the inventory/stats classes into its imports,
 * and everything is re-validated by the store on the way in anyway.
 */
export interface MpProfile {
  name?: string | null;
  stats: {
    health: number; hunger: number; thirst: number; stamina: number;
    temperature: number; exhausted?: boolean; dead: boolean;
  };
  /** [id, count, durability?] — same shape as the solo save. */
  inventory: Array<[string, number, number?] | null>;
  selected: number;
  pos: { x: number; y: number; z: number };
  yaw: number;
  progress: { level: number; xp: number } | null;
  /** Perk tree (systems/perks.ts). Optional: older servers drop it. */
  perks?: { points: number; owned: string[] } | null;
}

export interface MpHello {
  t: 'hello';
  playerId: string;
  /** Durable identity token (echoed back so the client can store it). */
  token?: string;
  name: string;
  players: RemotePlayer[];
  seed: number;
  buildings: Array<{
    id: string; kind: 'campfire' | 'wall' | 'floor' | 'roof' | 'bed';
    x: number; z: number; y: number; rot: number; ownerId: string; fuel?: number;
  }>;
  depleted: string[];
  hp: Record<string, number>;
  /** Shared day/night clock (0..1, 0 = midnight). */
  time?: number;
  /** Join order — the client turns this into a spot on the camp ring. */
  spawnIndex?: number;
  /** This player's saved progress, or null on a first visit. */
  me?: MpProfile | null;
  npc_memory?: unknown;
}

export type MpMessage =
  | MpHello
  | { t: 'p'; id: string; p: [number, number, number]; r: number; h?: string }
  | { t: 'joined'; id: string; name: string; p?: [number, number, number]; r?: number; h?: string }
  | { t: 'left'; id: string }
  | { t: 'placed'; b: BuildingData }
  /**
   * Server-authoritative harvest result. `hp` is the ABSOLUTE remaining hp
   * (never a delta — applying it as a delta double-damaged for the
   * initiator), `amount` is the server-rolled yield and `by` is the
   * server-assigned id of the harvester (only that player adds the items).
   */
  | { t: 'harvested'; id: string; hp: number; amount?: number; by?: string }
  | { t: 'depleted'; id: string }
  /** Server-side bush regrowth: restore the node to `hp`. */
  | { t: 'regrow'; id: string; hp: number }
  | { t: 'reject'; msg: string }
  | { t: 'npc_reply'; npc: string; npcId?: string; text: string; model?: string; quest?: unknown; speaker?: string }
  | { t: 'npc_error'; npc: string; npcId?: string; reason?: string }
  /** Shared clock. `jump` = someone slept: snap immediately instead of easing. */
  | { t: 'time'; time: number; jump?: boolean }
  /** Shared campfire fuel (whoever stokes it feeds everyone). */
  | { t: 'fuel'; id: string; fuel: number; by?: string }
  /** A door swung open or shut (same shared-state pattern as fuel). */
  | { t: 'toggle'; id: string; open: boolean; by?: string }
  /**
   * A melee hit landed on a player. The server validates range/rate and
   * forwards; the VICTIM applies the damage to its own stats (each client
   * owns its health — same trust model as the rest of the MP layer).
   */
  | { t: 'hit'; id: string; by: string; dmg: number }
  /**
   * Wipe the SERVER-side world: buildings, harvests, node hp and every
   * saved profile. Every client (sender included) clears its local save
   * and reloads. `by` is who asked, shown in the others' toasts.
   */
  | { t: 'world-reset'; by: string }
  /** A player changed their display name. */
  | { t: 'renamed'; id: string; name: string }
  /** Ack of a progress upload. `dropped` = stacks the game does not know. */
  | { t: 'saved'; ok: boolean; at: number; dropped?: number };

export type MpStatus = 'disconnected' | 'connecting' | 'connected';

/**
 * Thin WebSocket wrapper with reconnection support.
 */
export class MultiplayerClient {
  private ws: WebSocket | null = null;
  private url: string;
  private name: string;
  private onMessageCb: (msg: MpMessage) => void;
  private onStatusCb: (status: MpStatus) => void;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wantConnected = false;
  private lastPlayerId: string | null = null;
  /** Server clock skew guard for position throttling. */
  private lastPosSent = 0;
  /** Durable identity — see net/identity.ts. */
  private token: string;

  constructor(
    url: string,
    name: string,
    onMessage: (msg: MpMessage) => void,
    onStatus: (s: MpStatus) => void,
    opts: { token?: string; storage?: KvStore | null } = {},
  ) {
    this.url = url;
    this.name = name;
    this.onMessageCb = onMessage;
    this.onStatusCb = onStatus;
    this.token = opts.token ?? playerToken(opts.storage ?? (typeof localStorage !== 'undefined' ? localStorage : null));
  }

  get status(): MpStatus {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return 'connected';
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return 'connecting';
    return 'disconnected';
  }

  connect(): void {
    this.wantConnected = true;
    this.open();
  }

  private open(): void {
    if (!this.wantConnected) return;
    this.onStatusCb('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.onStatusCb('connected');
      ws.send(JSON.stringify(this.joinMessage()));
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(String(e.data)) as MpMessage;
        if (msg.t === 'hello') {
          this.lastPlayerId = msg.playerId;
          if (typeof msg.token === 'string' && msg.token) this.token = msg.token;
        }
        this.onMessageCb(msg);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      this.onStatusCb('disconnected');
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      try { ws.close(); } catch { /* ignore */ }
    };
  }

  private scheduleReconnect(): void {
    if (!this.wantConnected || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, 3000);
  }

  /**
   * The join frame. `token` is what makes a page refresh the SAME player
   * (same saved bag, same level, same spot in the world) instead of a new
   * anonymous one, which is what multiplayer used to do on every reload.
   */
  private joinMessage(): Record<string, unknown> {
    const msg: Record<string, unknown> = { t: 'join', name: this.name, token: this.token };
    if (this.lastPlayerId) msg.playerId = this.lastPlayerId;
    return msg;
  }

  /** Change the display name (the server de-duplicates it for us). */
  setName(name: string): void {
    this.name = name;
    this.send({ t: 'name', name });
  }

  /** Upload this player's progress (stats, bag, level, position). */
  sendSave(profile: MpProfile): void {
    this.send({ t: 'save', profile });
  }

  /** The player slept: the WORLD's clock jumps to morning. */
  sendSleep(): void {
    this.send({ t: 'sleep' });
  }

  /** Campfire fuel changed locally (a log was added): share it. */
  sendFuel(id: string, fuel: number): void {
    this.send({ t: 'fuel', id, fuel });
  }

  /** Share a door open/close with everyone in the world. */
  sendToggle(id: string, open: boolean): void {
    this.send({ t: 'toggle', id, open });
  }

  /** Land a melee hit on another player (server validates, victim applies). */
  sendHit(id: string, dmg: number): void {
    if (this.status !== 'connected' || !id) return;
    this.send({ t: 'hit', id, dmg });
  }

  /** Ask the server to wipe the shared world (settings panel, double-click confirm). */
  sendReset(): void {
    this.send({ t: 'reset' });
  }

  /** The token this browser plays under (for the HUD/identity plumbing). */
  get identityToken(): string {
    return this.token;
  }

  /** Force a clean rejoin (used after a rename that must reach the server). */
  rejoin(): void {
    if (!this.ws) return;
    try {
      if (this.status === 'connected') this.ws.send(JSON.stringify(this.joinMessage()));
    } catch {
      /* the reconnect loop will send it */
    }
  }

  /** Send player position + facing + held item (throttled to ~10 Hz). */
  sendPos(x: number, y: number, z: number, r: number, held?: string): void {
    if (this.status !== 'connected' || !this.ws) return;
    const now = Date.now();
    if (now - this.lastPosSent < 95) return;
    this.lastPosSent = now;
    // `h` is what the OTHER survivors see in your fist (item id or '').
    this.ws.send(JSON.stringify({ t: 'pos', p: [x, y, z], r, h: held ?? '' }));
  }

  sendHarvest(nodeId: string, bonus = 0): void {
    // The server rolls the base yield itself; the client may only flag the
    // +1 effective-tool bonus (clamped server-side to 0/1).
    this.send({ t: 'harvest', id: nodeId, bonus: bonus > 0 ? 1 : 0 });
  }

  sendPlace(kind: string, x: number, z: number, y: number, rot: number, id: string): void {
    this.send({ t: 'place', kind, p: [x, z, y], rot, id });
  }

  sendChat(
    npc: { id: string; name: string; personality: string },
    text: string,
    context?: object,
    history?: unknown[],
  ): void {
    // While multiplayer is connected the server is the ONLY chat route: it
    // performs the single LLM call, echoes npc_reply to the sender and
    // broadcasts it, so a message can no longer trigger two gateway calls
    // and two HUD bubbles (client POST /api/chat + WS chat).
    this.send({ t: 'chat', npc, text, context, history: history ?? [] });
  }

  private send(obj: object): void {
    if (this.status !== 'connected' || !this.ws) return;
    this.ws.send(JSON.stringify(obj));
  }

  disconnect(): void {
    this.wantConnected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.onStatusCb('disconnected');
  }
}
