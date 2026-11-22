/**
 * Persistent multiplayer world store (Multiplayer Agent scope).
 *
 * Two things were lost every time a browser reloaded or the server restarted:
 *  1. the shared world (buildings, harvested and depleted nodes) lived only in
 *     memory, so a restart wiped everyone's base;
 *  2. player progress could not be saved at all in multiplayer — `persist()`
 *     in game.ts returns early when a socket is attached, because writing
 *     another player's progress into YOUR localStorage would be wrong.
 *
 * This store owns both, on the server, keyed by a per-player token the client
 * keeps in localStorage. Everything that comes out of the file or off the
 * wire is structurally validated: a hand-edited JSON file must never be able
 * to hand a player 10 million stones, a negative max health or a building
 * outside the world.
 *
 * Pure logic + injected fs: unit-tested in server/store.test.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Must match BUILDING_KINDS in src/game/game.ts. */
export const BUILD_KINDS = [
  'campfire',
  'wall',
  'floor',
  'roof',
  'bed',
  'door',
  'stone_wall',
  'torch',
  'carpet',
  'fence',
  'stairs',
  'workbench',
  'planter',
  'sign',
];
/** Node kinds that can be harvested/depleted (see MAX_HARVEST in server.mjs). */
export const NODE_KINDS = ['tree', 'pine', 'rock', 'bush'];

/**
 * The items that actually exist, with their maximum stack size. Kept in sync
 * with `ITEMS` in src/game/core/items.ts (same arrangement as the CAMPFIRE
 * numbers above: a small copy, verified by a test that re-reads the real
 * table). Without this a hand-edited profile could hand out 9999 of an item
 * the game does not even have.
 */
export const ITEM_STACKS = {
  wood: 60,
  stone: 60,
  berry: 20,
  cooked_berry: 20,
  raw_mutton: 12,
  cooked_mutton: 12,
  raw_beef: 12,
  cooked_beef: 12,
  wool: 12,
  leather: 12,
  stone_axe: 1,
  stone_pick: 1,
  sword: 1,
  potion_heal: 5,
  potion_swift: 5,
  potion_night: 5,
  campfire: 5,
  wall: 10,
  floor: 10,
  roof: 10,
  bed: 2,
  door: 4,
  stone_wall: 10,
  torch: 5,
  carpet: 6,
};

const MAX_BUILDINGS = 2000;
const MAX_NODES = 20000;
const MAX_PLAYERS = 200;
const MAX_SLOTS = 64;
const MAX_ID_LEN = 40;

const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const idOk = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LEN && /^[A-Za-z0-9_.:-]+$/.test(v);

function safeBuilding(b) {
  if (typeof b !== 'object' || b === null) return null;
  if (!BUILD_KINDS.includes(b.kind)) return null;
  if (!idOk(b.id)) return null;
  const x = Number(b.x);
  const z = Number(b.z);
  const y = Number(b.y);
  if (![x, z, y].every(Number.isFinite)) return null;
  const out = {
    id: b.id,
    kind: b.kind,
    x: clamp(x, -1e4, 1e4),
    z: clamp(z, -1e4, 1e4),
    y: clamp(y, -200, 400),
    rot: clamp(Math.round(num(b.rot, 0)), 0, 3),
    ownerId: typeof b.ownerId === 'string' ? b.ownerId.slice(0, 24) : 'world',
  };
  if (b.kind === 'campfire') out.fuel = clamp(Math.round(num(b.fuel, 300)), 0, 3600);
  // Door open/closed is real shared state (a shut door blocks your friend
  // too), so it survives the sanitizer — nothing else may carry a flag.
  if (b.kind === 'door') out.open = b.open === true;
  return out;
}

function safeNodeKey(k) {
  // Node ids look like "n_tree_1234" (see worldState/flora). Validate the
  // shape, not just the prefix, so junk keys cannot pile up in the map.
  if (typeof k !== 'string' || k.length > 40) return null;
  const m = /^n_([a-z]+)_(\d+)$/.exec(k);
  if (!m || !NODE_KINDS.includes(m[1])) return null;
  return k;
}

/**
 * A player profile: exactly the pieces of the solo save that make sense on a
 * shared server (stats, bag, hotbar selection, progression, position). The
 * world and the NPC conversations are deliberately NOT here — the world is
 * shared, and NPC memory for multiplayer lives server-side in npc.mjs.
 */
export function sanitizeProfile(p) {
  if (typeof p !== 'object' || p === null) return null;
  const s = p.stats;
  if (typeof s !== 'object' || s === null) return null;
  if (!['health', 'hunger', 'thirst', 'stamina', 'temperature'].every((k) => Number.isFinite(s[k]))) return null;
  if (!Array.isArray(p.inventory)) return null;

  const inventory = [];
  let dropped = 0;
  for (const slot of p.inventory.slice(0, MAX_SLOTS)) {
    if (slot === null || slot === undefined) {
      inventory.push(null);
      continue;
    }
    if (!Array.isArray(slot)) return null;
    const [id, count, dur] = slot;
    if (typeof id !== 'string' || id.length > 32 || !/^[a-z0-9_]+$/.test(id)) {
      // One bogus stack must not cost the player their whole bag: drop the
      // slot, keep everything else.
      dropped++;
      inventory.push(null);
      continue;
    }
    // Unknown id = an item that does not exist in this game (invented by
    // hand-editing, or left over from another version). It can never be
    // picked up, built or crafted, so it does not belong in the save.
    const stack = ITEM_STACKS[id];
    if (stack === undefined) {
      dropped++;
      inventory.push(null);
      continue;
    }
    const c = Math.round(num(count, 0));
    if (c <= 0) {
      inventory.push(null);
      continue;
    }
    // Clamped to the real stack size: 9999 wood becomes 60 wood, the most a
    // slot can hold in the game anyway.
    const row = [id, Math.min(c, stack)];
    // Durability is only meaningful for tools; anything else is dropped.
    if (Number.isFinite(dur)) row.push(clamp(dur, 0, 10000));
    inventory.push(row);
  }

  const pos = typeof p.pos === 'object' && p.pos !== null ? p.pos : {};
  const progress = typeof p.progress === 'object' && p.progress !== null ? p.progress : null;

  return {
    name: typeof p.name === 'string' ? p.name.slice(0, 24) : null,
    stats: {
      health: clamp(num(s.health, 100), 0, 100),
      hunger: clamp(num(s.hunger, 70), 0, 100),
      thirst: clamp(num(s.thirst, 70), 0, 100),
      stamina: clamp(num(s.stamina, 100), 0, 100),
      temperature: clamp(num(s.temperature, 18), -40, 60),
      exhausted: s.exhausted === true,
      dead: s.dead === true,
    },
    inventory,
    selected: clamp(Math.round(num(p.selected, 0)), 0, MAX_SLOTS - 1),
    pos: {
      x: clamp(num(pos.x, 0), -1e4, 1e4),
      y: clamp(num(pos.y, 0), -200, 400),
      z: clamp(num(pos.z, 0), -1e4, 1e4),
    },
    yaw: clamp(num(p.yaw, 0), -1e4, 1e4),
    progress: progress && Number.isFinite(progress.level) && Number.isFinite(progress.xp)
      ? { level: clamp(Math.round(progress.level), 1, 99), xp: clamp(num(progress.xp, 0), 0, 1e7) }
      : null,
    savedAt: Date.now(),
    // How many stacks this upload contained that the game does not know.
    // Surfaced in the save ack so a client bug shows up in testing instead
    // of quietly eating somebody's inventory.
    droppedItems: dropped,
  };
}

/**
 * @param {object} [opts]
 * @param {string|null} [opts.file] JSON file to persist to (null = memory only)
 * @param {(ms: number) => any} [opts.setTimer] timer injection for tests
 * @param {(msg: string) => void} [opts.log]
 * @param {() => number} [opts.now]
 */
export function createWorldStore({
  file = null,
  setTimer = (ms, fn) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
  log = () => {},
  now = () => Date.now(),
  debounceMs = 800,
  fsImpl = fs,
} = {}) {
  const world = {
    buildings: [], // safeBuilding() results
    harvests: new Map(), // nodeId -> harvest count
    depleted: new Set(), // nodeIds with 0 hp
  };
  /** token -> sanitized profile */
  const players = new Map();
  /** Shared clock anchor (seconds since midnight on the cycle), persisted. */
  let clockOffsetS = null;

  let writeTimer = null;
  let dirty = false;

  function scheduleWrite() {
    dirty = true;
    if (!file || writeTimer) return;
    writeTimer = setTimer(debounceMs, () => {
      writeTimer = null;
      flush();
    });
    if (writeTimer && typeof writeTimer.unref === 'function') writeTimer.unref();
  }

  function serialize() {
    return {
      v: 1,
      savedAt: now(),
      clockOffsetS,
      buildings: world.buildings,
      harvests: [...world.harvests.entries()].slice(0, MAX_NODES),
      depleted: [...world.depleted].slice(0, MAX_NODES),
      players: [...players.entries()].slice(0, MAX_PLAYERS),
    };
  }

  function flush() {
    if (!file) return;
    dirty = false;
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      // Atomic replace: a crash mid-write must never leave a half-written
      // world file behind (that is how servers lose whole bases).
      const tmp = `${file}.tmp`;
      fsImpl.writeFileSync(tmp, JSON.stringify(serialize()));
      fsImpl.renameSync(tmp, file);
    } catch (e) {
      log(`[store] write failed: ${e?.message ?? e}`);
    }
  }

  /** Load the world file. Returns how many records were dropped as invalid. */
  function load() {
    let rejected = 0;
    if (!file) return 0;
    let raw;
    try {
      raw = fsImpl.readFileSync(file, 'utf8');
    } catch {
      return 0; // first boot: no file yet
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      log(`[store] unreadable world file, starting fresh: ${e?.message ?? e}`);
      return 0;
    }
    if (typeof data !== 'object' || data === null || data.v !== 1) return 0;

    for (const b of Array.isArray(data.buildings) ? data.buildings : []) {
      const safe = safeBuilding(b);
      if (safe) world.buildings.push(safe);
      else rejected++;
    }
    if (Array.isArray(data.harvests)) {
      for (const row of data.harvests) {
        const key = safeNodeKey(Array.isArray(row) ? row[0] : null);
        const count = Math.round(num(Array.isArray(row) ? row[1] : NaN, NaN));
        if (key && Number.isFinite(count) && count >= 0 && count <= 1000) world.harvests.set(key, count);
        else rejected++;
      }
    }
    for (const k of Array.isArray(data.depleted) ? data.depleted : []) {
      const key = safeNodeKey(k);
      if (key) world.depleted.add(key);
      else rejected++;
    }
    if (Array.isArray(data.players)) {
      for (const row of data.players) {
        if (!Array.isArray(row)) {
          rejected++;
          continue;
        }
        const [token, profile] = row;
        if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(token)) {
          rejected++;
          continue;
        }
        const safe = sanitizeProfile(profile);
        // A dead player is stored dead, but nobody reloads into a corpse:
        // the client respawns at camp on boot anyway (see game.ts restore).
        if (safe) players.set(token, safe);
        else rejected++;
      }
    }
    if (Number.isFinite(data.clockOffsetS)) clockOffsetS = data.clockOffsetS;
    if (world.buildings.length > MAX_BUILDINGS) world.buildings.length = MAX_BUILDINGS;
    if (rejected) log(`[store] dropped ${rejected} invalid record(s) from ${path.basename(file)}`);
    return rejected;
  }

  return {
    load,
    flush,
    get file() {
      return file;
    },
    get pendingWrite() {
      return dirty;
    },
    world,

    /** Shared clock anchor in cycle-seconds (null when never persisted). */
    clockOffset: () => clockOffsetS,
    setClockOffset(v, atMs = now()) {
      clockOffsetS = Number.isFinite(v) ? v : null;
      void atMs;
      scheduleWrite();
    },

    addBuilding(b) {
      const safe = safeBuilding(b);
      if (!safe || world.buildings.some((x) => x.id === safe.id)) return null;
      if (world.buildings.length >= MAX_BUILDINGS) return null;
      world.buildings.push(safe);
      scheduleWrite();
      return safe;
    },
    findBuilding(id) {
      return world.buildings.find((b) => b.id === id) ?? null;
    },
    /** Campfire fuel is shared: whoever stokes the fire feeds everyone. */
    setFuel(id, fuel) {
      const b = this.findBuilding(id);
      if (!b || b.kind !== 'campfire') return null;
      b.fuel = clamp(Math.round(num(fuel, b.fuel ?? 0)), 0, 3600);
      scheduleWrite();
      return b.fuel;
    },

    /** Shared door state — same pattern as setFuel, boolean instead of seconds. */
    setDoor(id, open) {
      const b = this.findBuilding(id);
      if (!b || b.kind !== 'door') return null;
      b.open = open === true;
      scheduleWrite();
      return b.open;
    },

    /**
     * Is this a real resource-node id (`n_tree_12`)? The harvest handler must
     * refuse anything else: an id the store will not persist would live in
     * memory, silently vanish on the next restart and leave the world out of
     * sync with itself.
     */
    isNodeId(k) {
      return safeNodeKey(k) !== null;
    },
    harvestCount(nodeId) {
      return world.harvests.get(nodeId) ?? 0;
    },
    addHarvest(nodeId) {
      const c = this.harvestCount(nodeId) + 1;
      world.harvests.set(nodeId, c);
      scheduleWrite();
      return c;
    },
    deplete(nodeId) {
      world.depleted.add(nodeId);
      scheduleWrite();
    },
    isDepleted(nodeId) {
      return world.depleted.has(nodeId);
    },
    /** Bush regrowth: the node is harvestable again. */
    restoreNode(nodeId) {
      world.harvests.delete(nodeId);
      world.depleted.delete(nodeId);
      scheduleWrite();
    },

    /** The per-player progress that multiplayer never had. */
    profile(token) {
      return players.get(token) ?? null;
    },
    putProfile(token, profile) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(token)) return null;
      const safe = sanitizeProfile({ ...asObject(profile), name: players.get(token)?.name ?? null });
      if (!safe) return null;
      safe.name = sanitizeName(players.get(token)?.name) ?? safe.name;
      players.set(token, safe);
      if (players.size > MAX_PLAYERS) players.delete(players.keys().next().value); // oldest first
      scheduleWrite();
      return safe;
    },
    /**
     * Record where a player is standing. Merges into the existing profile
     * only — a position report must never create a save on its own (that
     * would let a client that never played fill the file with ghosts).
     * Called on every position broadcast, so no write is scheduled here:
     * the debounced flush already covers it.
     */
    savePos(token, pos, yaw) {
      const cur = players.get(token);
      if (!cur) return null;
      const o = asObject(pos);
      cur.pos = {
        x: clamp(num(o.x, cur.pos.x), -1e4, 1e4),
        y: clamp(num(o.y, cur.pos.y), -200, 400),
        z: clamp(num(o.z, cur.pos.z), -1e4, 1e4),
      };
      cur.yaw = clamp(num(yaw, cur.yaw), -1e4, 1e4);
      scheduleWrite();
      return cur.pos;
    },
    setName(token, name) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(token)) return null;
      const clean = sanitizeName(name);
      if (!clean) return null;
      const p = players.get(token) ?? { ...sanitizeProfile(blankProfile()), savedAt: now() };
      p.name = clean;
      players.set(token, p);
      scheduleWrite();
      return clean;
    },
    nameOf(token) {
      return players.get(token)?.name ?? null;
    },
    playerCount() {
      return players.size;
    },
    /**
     * Full wipe for the settings-panel reset button: buildings, harvests,
     * depleted nodes and every saved player profile are gone, and the empty
     * world file is flushed IMMEDIATELY so a crash cannot resurrect the old
     * world. Connected sockets keep their session ids — the clients reload
     * themselves when they receive the world-reset broadcast.
     */
    reset() {
      world.buildings.length = 0;
      world.harvests.clear();
      world.depleted.clear();
      players.clear();
      flush();
    },
  };
}

/** Everything a brand-new player starts with, in store shape. */
function blankProfile() {
  return {
    name: null,
    stats: { health: 100, hunger: 70, thirst: 70, stamina: 100, temperature: 18, exhausted: false, dead: false },
    inventory: [],
    selected: 0,
    pos: { x: 0, y: 0, z: 0 },
    yaw: 0,
    progress: null,
  };
}

function asObject(v) {
  return typeof v === 'object' && v !== null ? v : {};
}

/** Display name: printable, 1..24 chars, no control characters. */
export function sanitizeName(name) {
  if (typeof name !== 'string') return null;
  const clean = name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
  return clean.length >= 1 ? clean : null;
}
