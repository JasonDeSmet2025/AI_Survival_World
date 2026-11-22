/**
 * NPC persistent memory (AI Agent scope).
 *
 * Deterministic, LLM-free memory extraction so NPC memory works even when
 * the model is unreachable and adds zero latency to a conversation. The LLM
 * only ever READS these notes (fed to the server through ChatContext.events);
 * it never writes memory, so a hallucinating model can never corrupt durable
 * state.
 *
 * What is remembered from Dutch player speech:
 *  - the player's name            ("mijn naam is X", "ik heet X", "noem me X")
 *  - goals                        ("ik wil X", "ik zoek X", "mijn doel is X")
 *  - fears                        ("ik ben bang voor X")
 *  - tone of the exchange         (gruff vs. friendly wording -> relationship)
 * And from the game-state summary the client already sends each turn:
 *  - survival condition           ("grote dorst", "gewond", "had het koud")
 *  - progression milestones       ("niveau 3 bereikt")
 *  - possessions shown for the first time ("toonde je bijl")
 *
 * Notes are durable: Conversation serializes them into the player save
 * (see systems/save.ts), so an NPC still recognises you after a reload.
 */

export type MemoryKind =
  | 'name'
  | 'fear'
  | 'goal'
  | 'milestone'
  | 'condition'
  | 'possession'
  | 'tone';

export interface MemoryNote {
  /** Durable fact, e.g. "De speler heet Sam". */
  text: string;
  kind: MemoryKind;
  /** Conversation turn when this note was last confirmed. */
  turn: number;
  /** Eviction priority: low-salience notes are forgotten first. */
  salience: number;
}

/** Maximum durable notes per NPC. */
export const MEMORY_LIMIT = 12;
/** How many notes are fed into one LLM prompt. */
export const MAX_CONTEXT_NOTES = 5;
/** Relationship clamp range. */
export const RELATIONSHIP_LIMIT = 100;
/** Maximum number of item names tracked as "already shown to this NPC". */
export const SEEN_ITEM_LIMIT = 16;

const SALIENCE: Record<MemoryKind, number> = {
  name: 100,
  fear: 70,
  milestone: 55,
  goal: 50,
  condition: 40,
  possession: 25,
  tone: 20,
};

/** Words that may follow "ik ben ..." but are clearly not a name. */
const IK_BEN_STOPWORDS = new Set([
  'bang', 'moe', 'ziek', 'dood', 'hongerig', 'dorstig', 'koud', 'warm',
  'hier', 'daar', 'klaar', 'niet', 'alleen', 'onderweg', 'verliefd',
  'op', 'naar', 'bij', 'tegen', 'vrouws', 'man', 'mens', 'speler', 'even',
]);

const POSITIVE_WORDS = [
  'dank', 'bedankt', 'leuk', 'fijn', 'top', 'mooi', 'goed', 'cool',
  'grappig', 'lief', 'schattig', 'hartstikke', 'geweldig', 'goed gedaan',
];
const NEGATIVE_WORDS = [
  'idiot', 'idioot', 'dom', 'stom', 'irritant', 'belediging', 'weg met je',
  'laat me in rust', 'haat', 'slordig', 'klootzak', 'zwijg', 'houd je mond',
];

export interface MemorySnapshot {
  /** Legacy field: note texts only, oldest first (readable by old saves). */
  memory: string[];
  notes?: MemoryNote[];
  name?: string | null;
  rel?: number;
  turns?: number;
  seen?: number;
  level?: number;
  items?: string[];
}

function clampNumber(v: unknown, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Per-NPC durable memory + relationship state. Pure logic, no Babylon,
 * no network, no clock of its own (a clock can be injected) so it is fully
 * unit-testable and deterministic.
 */
export class MemoryStore {
  notes: MemoryNote[] = [];
  /** Cached player name so the NPC can address the player. */
  playerName: string | null = null;
  /** Relationship score in [-100, 100]; 0 = neutral. */
  relationship = 0;
  /** Total player messages seen by this NPC. */
  turns = 0;
  /** Epoch ms of the last interaction; 0 = never. */
  lastSeen = 0;
  /** Highest player level this NPC has witnessed. */
  level = 0;
  /** Item names this NPC has already been shown. */
  seenItems: string[] = [];

  /**
   * Remember a fact. Identical text refreshes recency instead of
   * duplicating. Returns true when something was stored.
   */
  remember(text: string, kind: MemoryKind = 'goal', turn = this.turns): boolean {
    const clean = normalize(text);
    if (clean.length < 4) return false;
    if (kind === 'name') {
      // A rename replaces the previous name note.
      this.notes = this.notes.filter((n) => n.kind !== 'name');
      this.playerName = nameFromNote(clean) ?? clean;
    }
    const existing = this.notes.find((n) => n.text === clean);
    if (existing) {
      existing.turn = turn;
      this.notes.push(this.notes.splice(this.notes.indexOf(existing), 1)[0]);
      return true;
    }
    this.notes.push({ text: clean, kind, turn, salience: SALIENCE[kind] });
    this.evict();
    return true;
  }

  /** Drop the least important note; "name" notes are never forgotten. */
  private evict(): void {
    while (this.notes.length > MEMORY_LIMIT) {
      let idx = -1;
      for (let i = 0; i < this.notes.length; i++) {
        const n = this.notes[i];
        if (n.kind === 'name') continue;
        if (idx === -1) { idx = i; continue; }
        const cur = this.notes[idx];
        if (n.salience < cur.salience || (n.salience === cur.salience && n.turn < cur.turn)) idx = i;
      }
      if (idx === -1) return;
      const dropped = this.notes.splice(idx, 1)[0];
      if (dropped.kind === 'possession') {
        const item = dropped.text.match(/toonde je (.+)\.$/)?.[1];
        if (item) this.seenItems = this.seenItems.filter((i) => i !== item);
      }
    }
  }

  /** Newest notes, oldest first (capped) — prompt order. */
  recents(n = MAX_CONTEXT_NOTES): MemoryNote[] {
    return this.notes.slice(-n);
  }

  /**
   * Compact LLM context lines: remembered facts first, relationship summary
   * last, so the relational cue sits closest to the player's message.
   */
  contextLines(): string[] {
    const lines = this.recents().map((n) => n.text);
    if (this.turns > 0) {
      lines.push(
        `Relatie met de speler: ${this.relationshipLabel()}` +
          ` (score ${this.relationship}, ${this.turns} gespreksrondes).`,
      );
    }
    return lines;
  }

  relationshipLabel(): string {
    if (this.relationship >= 30) return 'warm';
    if (this.relationship >= 10) return 'vriendelijk';
    if (this.relationship <= -30) return 'koel-voorzichtig';
    if (this.relationship <= -10) return 'koel';
    return 'neutraal';
  }

  /**
   * Score the tone of a player message and accumulate it.
   * Returns the delta applied this turn (exposed for tests and debugging).
   */
  adjustTone(message: string): number {
    const lower = ` ${message.toLowerCase()} `;
    let delta = 0;
    for (const w of POSITIVE_WORDS) if (lower.includes(w)) delta += 5;
    for (const w of NEGATIVE_WORDS) if (lower.includes(w)) delta -= 8;
    // Any message at all is engagement, so a long neutral conversation
    // drifts slowly warmer instead of staying frozen at 0.
    if (delta === 0) delta = 1;
    this.relationship = Math.max(-RELATIONSHIP_LIMIT, Math.min(RELATIONSHIP_LIMIT, this.relationship + delta));
    if (delta >= 10) this.remember('De speler was vriendelijk tegen je.', 'tone');
    else if (delta <= -8) this.remember('De speler was grof tegen je.', 'tone');
    return delta;
  }

  /**
   * Absorb one player message: bump counters, extract durable facts and
   * score the tone. `now` is injectable so tests never read the clock.
   * Returns the notes that were newly stored or refreshed.
   */
  absorbMessage(message: string, playerState = '', now = Date.now()): MemoryNote[] {
    this.turns += 1;
    this.lastSeen = now;
    const text = normalize(message);

    if (playerState) this.observeState(playerState);
    if (!text) return [];

    const beforeTurn = new Map(this.notes.map((n) => [n.text, n.turn]));
    const name = extractName(text);
    if (name) this.remember(`De speler heet ${name}.`, 'name');

    const fear = firstMatch(text, [/ik\s+ben\s+bang\s+voor\s+(.{2,40})/i, /angst(?:en)?\s+voor\s+(.{2,40})/i]);
    if (fear) this.remember(`De speler is bang voor ${fear}.`, 'fear');

    const goal = firstMatch(text, [
      /ik\s+wil\s+(.{3,48})/i,
      /ik\s+ga\s+(.{3,48})/i,
      /ik\s+zoek\s+(.{3,48})/i,
      /mijn\s+doel\s+is\s+(.{3,48})/i,
    ]);
    if (goal && !isNameLike(goal)) this.remember(`De speler wil: ${goal}.`, 'goal');

    this.adjustTone(text);
    // A note counts as absorbed when it is new or when it was refreshed.
    return this.notes.filter((n) => beforeTurn.get(n.text) !== n.turn);
  }

  /**
   * Derive durable observations from the client's player-state summary
   * (game.ts `playerStateSummary()`: "Honger 30%, dorst 12%, ... Bezit: a, b").
   * Only *notable* conditions become notes, and their text carries no
   * numbers, so repeated checking refreshes one note instead of flooding
   * memory with "dorst 12%", "dorst 11%", ...
   */
  observeState(summary: string): void {
    const pct = (label: string): number | null => {
      const m = summary.toLowerCase().match(new RegExp(label + '\\s*(\\d+)\\s*%', 'i'));
      return m ? Number(m[1]) : null;
    };
    const hunger = pct('honger');
    const thirst = pct('dorst');
    const health = pct('gezonddend');
    if (hunger !== null && hunger <= 25) this.remember('De speler had grote honger.', 'condition');
    if (thirst !== null && thirst <= 25) this.remember('De speler had grote dorst.', 'condition');
    if (health !== null && health <= 40) this.remember('De speler was zwaar gewond.', 'condition');

    const temp = summary.match(/temperatuur\s*(-?\d+(?:[.,]\d+)?)\s*°?c/i);
    if (temp) {
      const c = Number(temp[1].replace(',', '.'));
      if (Number.isFinite(c)) {
        if (c <= 8) this.remember('De speler had het koud.', 'condition');
        else if (c >= 30) this.remember('De speler had het te warm.', 'condition');
      }
    }

    const hour = summary.match(/uur\s*(\d{1,2}):(\d{2})/i);
    if (hour) {
      const h = Number(hour[1]);
      if (h >= 22 || h < 5) this.remember('De speler zocht je op in het donker.', 'condition');
    }

    const lvl = summary.match(/niveau\s*(\d+)/i);
    if (lvl) {
      const l = Math.max(0, Math.floor(Number(lvl[1]) || 0));
      if (l > this.level) {
        this.level = l;
        this.remember(`De speler heeft niveau ${l} bereikt.`, 'milestone');
      } else if (l > 0) {
        this.level = Math.max(this.level, l);
      }
    }

    const bezit = summary.match(/bezit:\s*([\s\S]*?)\.?\s*$/i);
    if (bezit) {
      const items = bezit[1]
        .split(',')
        .map((s) => normalize(s).replace(/\.$/, ''))
        .filter((s) => s && s.toLowerCase() !== 'niets' && s.length <= 24);
      for (const item of items) {
        if (this.seenItems.includes(item)) continue;
        if (this.remember(`De speler toonde je ${item}.`, 'possession')) {
          this.seenItems.push(item);
          if (this.seenItems.length > SEEN_ITEM_LIMIT) this.seenItems.shift();
        }
      }
    }
  }

  serialize(): MemorySnapshot {
    return {
      // Legacy shape, kept so pre-memory saves and tools still parse.
      memory: this.notes.map((n) => n.text),
      notes: this.notes.map((n) => ({ ...n })),
      name: this.playerName,
      rel: this.relationship,
      turns: this.turns,
      seen: this.lastSeen,
      level: this.level,
      items: [...this.seenItems],
    };
  }

  /**
   * Restore from a save. Accepts the full snapshot and the legacy
   * `{ memory: string[] }` shape written by older versions of the game.
   */
  restore(data: Partial<MemorySnapshot> | null | undefined): void {
    if (!data) return;
    const legacy = data as { memory?: unknown };
    if (Array.isArray(data.notes) && data.notes.length) {
      const notes: MemoryNote[] = [];
      for (const raw of data.notes.slice(-MEMORY_LIMIT)) {
        if (!raw || typeof raw.text !== 'string') continue;
        const text = normalize(raw.text);
        if (!text) continue;
        const kind: MemoryKind = isKind(raw.kind) ? raw.kind : 'goal';
        notes.push({
          text,
          kind,
          turn: Math.max(0, Math.floor(Number(raw.turn) || 0)),
          salience: typeof raw.salience === 'number' && Number.isFinite(raw.salience) ? raw.salience : SALIENCE[kind],
        });
      }
      this.notes = notes;
    } else if (Array.isArray(legacy.memory)) {
      this.notes = (legacy.memory as unknown[])
        .filter((m): m is string => typeof m === 'string')
        .slice(-MEMORY_LIMIT)
        .map((text, i) => ({ text: normalize(text), kind: guessKind(text), turn: i + 1, salience: SALIENCE[guessKind(text)] }))
        .filter((n) => n.text.length >= 4);
    }
    const name = data.name;
    this.playerName =
      typeof name === 'string' && name.trim() ? normalize(name) : this.notes.find((n) => n.kind === 'name')?.text.replace(/^De speler heet\s+|\.$/gi, '') ?? null;
    this.relationship = clampNumber(data.rel, -RELATIONSHIP_LIMIT, RELATIONSHIP_LIMIT);
    this.turns = Math.max(0, Math.floor(Number(data.turns) || 0));
    this.lastSeen = Math.max(0, Math.floor(Number(data.seen) || 0));
    this.level = Math.max(0, Math.floor(Number(data.level) || 0));
    const items = data.items;
    this.seenItems = Array.isArray(items) ? items.filter((i): i is string => typeof i === 'string').slice(-SEEN_ITEM_LIMIT) : [];
  }
}

/** Extracts the bare name out of a stored name note. */
function nameFromNote(text: string): string | null {
  const m = text.match(/^De speler heet\s+(.+?)\.?$/i);
  return m ? normalize(m[1]) : null;
}

function isKind(k: unknown): k is MemoryKind {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(SALIENCE, k);
}

/** Reconstruct a kind for notes written before kinds existed. */
function guessKind(text: string): MemoryKind {
  if (/^De speler heet /i.test(text)) return 'name';
  if (/bang voor/i.test(text)) return 'fear';
  if (/niveau \d+ bereikt/i.test(text)) return 'milestone';
  if (/toonde je /i.test(text)) return 'possession';
  if (/tegen je\.$/i.test(text)) return 'tone';
  if (/^(De speler had|De speler was zwaar|De speler zocht)/i.test(text)) return 'condition';
  return 'goal';
}

function isNameLike(phrase: string): boolean {
  const words = phrase.split(/\s+/);
  return words.length === 1 && words[0].length < 5;
}

function extractName(text: string): string | null {
  const cased = (raw: string): string => cleanNamePhrase(raw)
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  let m = text.match(/\bmijn naam is\s+([a-zà-ÿ'][a-zà-ÿ'0-9]*(?:\s+[a-zà-ÿ'][a-zà-ÿ'0-9]*)?)/i);
  if (m) { const n = cased(m[1]); return n || null; }
  m = text.match(/\bik heet\s+([a-zà-ÿ'][a-zà-ÿ'0-9]{2,20})/i);
  if (m) return cased(m[1]);
  m = text.match(/\bnoem me\s+([a-zà-ÿ'][a-zà-ÿ'0-9]{2,20})/i);
  if (m) return cased(m[1]);
  // "ik ben Sam" only counts when the message is nothing but that.
  m = text.match(/^ik ben\s+([a-zà-ÿ'][a-zà-ÿ'0-9]{2,20})(?:\s+([a-zà-ÿ'][a-zà-ÿ'0-9]{2,20}))?\s*[.!]*$/i);
  if (m) {
    if (IK_BEN_STOPWORDS.has(m[1].toLowerCase())) return null;
    const n = cased((m[1] + (m[2] ? ' ' + m[2] : '')).trim());
    return n || null;
  }
  return null;
}

/** Words that end a name and start the next clause ("Sam en ik wil ..."). */
const NAME_STOP = new Set([
  'ik', 'je', 'jij', 'we', 'wij', 'ze', 'hij', 'zij', 'jullie', 'het', 'er',
  'niet', 'wil', 'zal', 'zou', 'kan', 'ben', 'was', 'ook', 'maar', 'en', 'dat', 'dit', 'heel',
]);

/** Keep only the actual name words out of a captured phrase. */
function cleanNamePhrase(raw: string): string {
  const words = normalize(raw).split(' ').filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    if (out.length && NAME_STOP.has(w.toLowerCase())) break;
    out.push(w);
  }
  return out.join(' ');
}

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) {
      const v = trimClause(m[1]);
      if (v.length >= 3) return v;
    }
  }
  return null;
}

/** Subordinating conjunctions always start a new clause in Dutch. */
const SUBORDINATE = /\s+(?:omdat|want|terwijl|aangezien)\b/i;
/** "en/maar/dus" only end a phrase when a new subject follows ("en ik …"). */
const NEW_CLAUSE = /\s+(?:en|maar|dus|daarom|daardoor)\s+(?:ik|je|jij|jullie|we|wij|ze|hij|zij|men|er)\b/i;

/**
 * Keep a remembered phrase short and truthful: stop at the first clause
 * boundary instead of swallowing the rest of a compound sentence.
 */
function trimClause(raw: string): string {
  let v = normalize(raw).replace(/[.!?]+$/, '').trim();
  let cut = -1;
  for (const re of [SUBORDINATE, NEW_CLAUSE]) {
    const i = v.search(re);
    if (i > 2 && (cut === -1 || i < cut)) cut = i;
  }
  const punct = v.search(/[,;]/);
  if (punct > 2 && (cut === -1 || punct < cut)) cut = punct;
  // Also stop at a sentence boundary: "vissen. Wat raad je aan" -> "vissen".
  const stop = v.search(/\.(?:\s|$)/);
  if (stop > 2 && (cut === -1 || stop < cut)) cut = stop;
  if (cut > 2) v = v.slice(0, cut).trim();
  return v.replace(/[,;:\s]+$/, '').trim();
}
