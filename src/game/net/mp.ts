/**
 * Browser-side multiplayer client (Multiplayer Agent scope).
 * Connects to the Node WebSocket server; the server is authoritative for
 * shared world state (buildings, depleted resources) and relays positions.
 */
import type { BuildingData } from '../world/types';

export interface RemotePlayer {
  id: string;
  name: string;
  p: [number, number, number];
}

export interface MpHello {
  t: 'hello';
  playerId: string;
  name: string;
  players: RemotePlayer[];
  seed: number;
  buildings: Array<{
    id: string; kind: 'campfire' | 'wall' | 'floor' | 'roof';
    x: number; z: number; y: number; rot: number; ownerId: string; fuel?: number;
  }>;
  depleted: string[];
  hp: Record<string, number>;
}

export type MpMessage =
  | MpHello
  | { t: 'p'; id: string; p: [number, number, number]; r: number }
  | { t: 'joined'; id: string; name: string }
  | { t: 'left'; id: string }
  | { t: 'placed'; b: BuildingData }
  | { t: 'harvested'; id: string; hp: number }
  | { t: 'depleted'; id: string }
  | { t: 'reject'; msg: string }
  | { t: 'npc_reply'; npc: string; text: string }
  | { t: 'npc_error'; npc: string };

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

  constructor(url: string, name: string, onMessage: (msg: MpMessage) => void, onStatus: (s: MpStatus) => void) {
    this.url = url;
    this.name = name;
    this.onMessageCb = onMessage;
    this.onStatusCb = onStatus;
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
      const msg: Record<string, unknown> = { t: 'join', name: this.name };
      if (this.lastPlayerId) msg.playerId = this.lastPlayerId;
      ws.send(JSON.stringify(msg));
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(String(e.data)) as MpMessage;
        if (msg.t === 'hello') this.lastPlayerId = msg.playerId;
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

  /** Send player position + facing (throttled to ~10 Hz). */
  sendPos(x: number, y: number, z: number, r: number): void {
    if (this.status !== 'connected' || !this.ws) return;
    const now = Date.now();
    if (now - this.lastPosSent < 95) return;
    this.lastPosSent = now;
    this.ws.send(JSON.stringify({ t: 'pos', p: [x, y, z], r }));
  }

  sendHarvest(nodeId: string): void {
    this.send({ t: 'harvest', id: nodeId });
  }

  sendPlace(kind: string, x: number, z: number, y: number, rot: number, id: string): void {
    this.send({ t: 'place', kind, p: [x, z, y], rot, id });
  }

  sendChat(npc: { id: string; name: string; personality: string }, text: string, context?: object): void {
    this.send({ t: 'chat', npc, text, context });
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
