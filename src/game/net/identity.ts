/**
 * Multiplayer identity + join helpers (Multiplayer Agent scope).
 *
 * Three things a browser has to answer before it can be "a second player":
 *  - Which world do I join? (`resolveMpUrl`)
 *  - Who am I? (`playerToken` + `playerName`)
 *  - Where do I stand so I don't overlap the player already there?
 *    (`spawnOffset`)
 *
 * The token is the durable identity: it survives reloads and is what the
 * server keys saved progress on. It is deliberately NOT the display name —
 * names are cosmetic, may collide and can be changed at any time.
 *
 * Pure logic, no Babylon, localStorage injected (the game runs in a browser,
 * the tests run in Node).
 */

/** Storage subset (so tests can pass a Map-backed fake). */
export interface KvStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const TOKEN_KEY = 'asw_mp_token';
const NAME_KEY = 'asw_mp_name';
const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

function randomToken(): string {
  const c: Crypto | undefined = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '');
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

/** Stable per-browser identity token (created on first use). */
export function playerToken(store?: KvStore | null): string {
  if (!store) return randomToken();
  let t: string | null = null;
  try {
    t = store.getItem(TOKEN_KEY);
  } catch {
    return randomToken(); // private mode: storage throws, stay anonymous
  }
  if (t && TOKEN_RE.test(t)) return t;
  t = randomToken();
  try {
    store.setItem(TOKEN_KEY, t);
  } catch {
    /* ignore: an anonymous session is still a playable session */
  }
  return t;
}

/**
 * Display name rules — must stay in step with `sanitizeName` in
 * server/store.mjs, so the client never sends something the server rejects
 * and the input never accepts a name that silently becomes someone else's.
 */
export function sanitizeName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const clean = name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
  return clean.length >= 1 ? clean : null;
}

export function defaultName(token: string): string {
  return `Speler-${token.slice(0, 4)}`;
}

/** The name this browser plays under (created + persisted on first use). */
export function playerName(store?: KvStore | null, token = playerToken(store)): string {
  const stored = (() => {
    try {
      return store ? store.getItem(NAME_KEY) : null;
    } catch {
      return null;
    }
  })();
  const clean = sanitizeName(stored);
  if (clean) return clean;
  const name = defaultName(token);
  setPlayerName(name, store);
  return name;
}

/** Persist a name; returns the sanitised value actually stored (null = rejected). */
export function setPlayerName(name: unknown, store?: KvStore | null): string | null {
  const clean = sanitizeName(name);
  if (!clean || !store) return clean;
  try {
    store.setItem(NAME_KEY, clean);
  } catch {
    /* ignore */
  }
  return clean;
}

/**
 * Where to connect.
 *
 * Multiplayer is ON by default whenever the page came from a server: a second
 * person only has to open the same URL, they do not have to know a query flag
 * exists (this used to be the whole "multiplayer is broken" complaint —
 * without `?mp` every player was silently in a private world).
 *
 *   ?solo=1 / ?mp=0   stay offline (solo + localStorage save)
 *   ?mp               ws(s)://<host>/ws
 *   ?mp=wss://host/ws connect there instead (tunnel / separate box)
 *   file://           no multiplayer (a local double-click has no server)
 */
export function resolveMpUrl(locationLike: { protocol: string; host: string; search: string }): string | null {
  const params = new URLSearchParams(locationLike.search);
  const flag = params.get('mp');
  const solo = params.get('solo');
  if (solo === '1' || solo === '' || flag === '0' || flag === 'off' || flag === 'false') return null;
  if (flag && /^wss?:\/\//i.test(flag)) return flag;
  if (locationLike.protocol !== 'http:' && locationLike.protocol !== 'https:') return null;
  const scheme = locationLike.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${locationLike.host}/ws`;
}

/**
 * A ring around the camp, one spot per join order. Golden-angle spacing so
 * eight people joining at once spread out instead of stacking in pairs.
 * Returns an offset in world XZ metres; the caller adds the ground height.
 */
export function spawnOffset(index: number, radius = 3.5, spacing = 1.15): { x: number; z: number } {
  const i = Number.isFinite(index) && index > 0 ? Math.floor(index) : 0;
  if (i === 0) return { x: 0, z: 0 };
  const angle = i * 2.399963229728653; // golden angle
  const r = Math.min(24, radius + Math.sqrt(i) * spacing);
  return { x: Math.cos(angle) * r, z: Math.sin(angle) * r };
}
