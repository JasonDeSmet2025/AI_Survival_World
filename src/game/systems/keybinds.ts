/**
 * Rebindable controls (Gameplay Agent scope) — pure data + pure functions,
 * so the whole key map is unit-testable and the HUD can render it without
 * knowing anything about the game.
 *
 * Two layers, on purpose:
 *  - `bindings`: what the PLAYER owns. Every action has exactly one key the
 *    settings menu (O) can change, saved per browser in localStorage.
 *  - `ALTERNATES`: what the GAME always accepts on top (AZERTY W→Z, the arrow
 *    keys, both Shift keys). These are not shown as rebindable and cannot be
 *    taken away: they exist so a French keyboard and a arrow-key hand work
 *    out of the box, which has nothing to do with personal preference.
 *
 * A key may drive only ONE action. Assigning a key that another action (or a
 * fixed alternate) already answers to is refused with the name of the action
 * in the way, instead of silently stealing it — two actions on one key is how
 * a control scheme becomes unplayable.
 *
 * Storage is device-level (like a browser's own settings), NOT part of the
 * world save: the same key map must survive a world reset, and in multiplayer
 * your controls are nobody else's business.
 */
// The camera distance is stored here (a device preference, like sensitivity)
// but its range belongs to the rig — importing the clamp keeps a settings file
// from ever containing a distance the camera code would then reject.
import { CAM_DIST_DEFAULT, clampCamDist } from './cameraRig';

export type Action =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'sprint'
  | 'crouch'
  | 'interact'
  | 'harvest'
  | 'craft'
  | 'inventory'
  | 'drop'
  | 'consume'
  | 'attack'
  | 'settings'
  | 'buildUp'
  | 'buildDown'
  | 'close'
  | 'slot1'
  | 'slot2'
  | 'slot3'
  | 'slot4'
  | 'slot5'
  | 'slot6'
  | 'slot7'
  | 'slot8';

/** One key per action — the part the player may change. */
export type Bindings = Record<Action, string>;

export const ACTIONS: Action[] = [
  'forward', 'back', 'left', 'right', 'jump', 'sprint', 'crouch',
  'interact', 'harvest', 'craft', 'inventory', 'drop', 'consume', 'attack',
  'settings', 'buildUp', 'buildDown', 'close',
  'slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6', 'slot7', 'slot8',
];

/** Hotbar actions, in slot order (the HUD draws them as one group). */
export const SLOT_ACTIONS: Action[] = [
  'slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6', 'slot7', 'slot8',
];

/**
 * The settings menu draws one section per group. Grouping lives here (pure
 * data) rather than in the HUD, so the menu order is part of the tested
 * contract and the HUD stays a renderer.
 */
export const KEYBIND_GROUPS: ReadonlyArray<{ title: string; actions: Action[] }> = [
  {
    title: 'Bewegen',
    actions: ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'crouch'],
  },
  {
    title: 'Acties',
    actions: ['interact', 'harvest', 'attack', 'consume', 'drop'],
  },
  {
    title: 'Vensters',
    actions: ['craft', 'inventory', 'settings', 'close', 'buildUp', 'buildDown'],
  },
  { title: 'Voorwerpkeuze', actions: SLOT_ACTIONS },
];

export const DEFAULT_BINDINGS: Bindings = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  sprint: 'ShiftLeft',
  crouch: 'KeyC',
  interact: 'KeyE',
  harvest: 'KeyF',
  craft: 'KeyB',
  inventory: 'KeyI',
  drop: 'KeyQ',
  consume: 'KeyR',
  attack: 'Mouse0',
  settings: 'KeyO',
  buildUp: 'PageUp',
  buildDown: 'PageDown',
  close: 'Escape',
  slot1: 'Digit1',
  slot2: 'Digit2',
  slot3: 'Digit3',
  slot4: 'Digit4',
  slot5: 'Digit5',
  slot6: 'Digit6',
  slot7: 'Digit7',
  slot8: 'Digit8',
};

/** Keys the game ALWAYS answers to, whatever the player bound. */
export const ALTERNATES: Partial<Record<Action, string[]>> = {
  forward: ['KeyZ', 'ArrowUp'],
  back: ['ArrowDown'],
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  sprint: ['ShiftRight'],
};

/** Dutch labels in the settings menu, in menu order. */
export const ACTION_LABEL: Record<Action, string> = {
  forward: 'Vooruit',
  back: 'Achteruit',
  left: 'Links',
  right: 'Rechts',
  jump: 'Springen / zwemmen',
  sprint: 'Sprinten',
  crouch: 'Hurken',
  interact: 'Interactie (praten, bouwen, eten)',
  harvest: 'Oogsten (houden)',
  craft: 'Craft-menu',
  inventory: 'Rugzak',
  drop: '1 item gooien',
  consume: 'Eten / drinken',
  attack: 'Aanvallen / schieten',
  settings: 'Instellingen',
  buildUp: 'Bouwhoogte omhoog',
  buildDown: 'Bouwhoogte omlaag',
  close: 'Venster sluiten',
  slot1: 'Hotbar 1',
  slot2: 'Hotbar 2',
  slot3: 'Hotbar 3',
  slot4: 'Hotbar 4',
  slot5: 'Hotbar 5',
  slot6: 'Hotbar 6',
  slot7: 'Hotbar 7',
  slot8: 'Hotbar 8',
};

/** Mouse look multiplier: 1 = the shipped feel, range 0.2 .. 3. */
export const DEFAULT_MOUSE_SENS = 1;
export const MOUSE_SENS_MIN = 0.2;
export const MOUSE_SENS_MAX = 3;

export function clampMouseSens(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_MOUSE_SENS;
  return Math.min(MOUSE_SENS_MAX, Math.max(MOUSE_SENS_MIN, Math.round(n * 100) / 100));
}

const CODE_RE = /^(Key[A-Z]|Digit[0-9]|Arrow(Up|Down|Left|Right)|Shift(Left|Right)|Space|Escape|PageUp|PageDown|Backspace|Minus|Equal|Comma|Period|Slash|BracketLeft|BracketRight|Semicolon|Quote|Backslash|Backquote|Insert|Delete|Home|End|F([1-9]|1[0-2])|Numpad[0-9])$/;

/**
 * True when `code` is a KeyboardEvent.code (or mouse button) we allow.
 * Deliberately excludes Tab (moves focus through the panel) and every
 * Ctrl/Alt/Meta key (browser and OS shortcuts the page never sees). */
export function isValidCode(code: unknown): boolean {
  if (typeof code !== 'string') return false;
  if (code === 'Mouse0' || code === 'Mouse1' || code === 'Mouse2') return true;
  return CODE_RE.test(code);
}

/**
 * Codes the INTERFACE owns and no action may ever take.
 *
 * `isValidCode` answers "is this a key we can name and store"; this answers
 * "may the player hand it to an action". They are deliberately different
 * questions: the right button is a real, labelable button (the settings menu
 * must still print `RMuisknop` when an old save used it) but it now belongs to
 * the shell, because its only job is to give the cursor back so the HUD can be
 * clicked. A button that both releases the cursor and swings a sword would
 * make the HUD unclickable for anyone who happened to bind attack to it.
 *
 * `assign` refuses these, and `mergeBindings` drops them out of a save file
 * written before the reservation — otherwise a stale binding would silently
 * swallow the release gesture.
 */
export function isReservedCode(code: unknown): boolean {
  return code === 'Mouse2';
}

/** Human-readable key name for the settings menu. */
export function keyLabel(code: string): string {
  if (code === 'Mouse0') return 'LMuisknop';
  if (code === 'Mouse1') return 'Middelste muisknop';
  if (code === 'Mouse2') return 'RMuisknop';
  if (code === 'Space') return 'Spatie';
  if (code === 'Escape') return 'Esc';
  if (code === 'ShiftLeft') return 'Shift (L)';
  if (code === 'ShiftRight') return 'Shift (R)';
  if (code === 'PageUp') return 'PgUp';
  if (code === 'PageDown') return 'PgDn';
  if (code === 'ArrowUp') return '↑';
  if (code === 'ArrowDown') return '↓';
  if (code === 'ArrowLeft') return '←';
  if (code === 'ArrowRight') return '→';
  if (code === 'Tab') return 'Tab';
  if (code === 'Backspace') return 'Backspace';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `${code.slice(6)} (num)`;
  return code;
}

/** Every code an action answers to: the bound key plus its alternates. */
export function codesFor(b: Bindings, action: Action): string[] {
  const out = [b[action]];
  for (const alt of ALTERNATES[action] ?? []) if (!out.includes(alt)) out.push(alt);
  return out.filter((c) => typeof c === 'string' && c.length > 0);
}

/** The fixed alternates of an action (shown as "ook: …" in the menu). */
export function alternatesFor(action: Action): string[] {
  return ALTERNATES[action] ?? [];
}

/**
 * Which action already answers to `code` (bound key OR fixed alternate),
 * ignoring the action currently being rebound. Null when the key is free.
 * `binding` wins over `alternate` in the report, so a real conflict is never
 * downgraded to a note about the arrow keys.
 */
export function findConflict(
  b: Bindings,
  action: Action,
  code: string,
): { action: Action; kind: 'binding' | 'alternate' } | null {
  if (!isValidCode(code)) return null;
  let altHit: { action: Action; kind: 'binding' | 'alternate' } | null = null;
  for (const other of ACTIONS) {
    if (other === action) continue;
    if (b[other] === code) return { action: other, kind: 'binding' };
    if ((ALTERNATES[other] ?? []).includes(code)) altHit = altHit ?? { action: other, kind: 'alternate' };
  }
  return altHit;
}

export interface AssignResult {
  bindings: Bindings;
  ok: boolean;
  /** Why it was refused (also shown inline in the settings menu). */
  reason: string | null;
}

/**
 * Bind `code` to `action`. Refused when the code is not a real key or when
 * another action already uses it — the existing map is returned unchanged so
 * a refused rebind can never half-apply.
 */
export function assign(b: Bindings, action: Action, code: string): AssignResult {
  if (!ACTIONS.includes(action)) return { bindings: b, ok: false, reason: 'Onbekende actie' };
  if (isReservedCode(code)) return { bindings: b, ok: false, reason: 'RMuisknop is van de interface (muis vrijgeven)' };
  if (!isValidCode(code)) return { bindings: b, ok: false, reason: 'Die toets kan ik niet gebruiken' };
  const clash = findConflict(b, action, code);
  if (clash) {
    return {
      bindings: b,
      ok: false,
      reason:
        clash.kind === 'binding'
          ? `${keyLabel(code)} doet al: ${ACTION_LABEL[clash.action]}`
          : `${keyLabel(code)} staat altijd voor: ${ACTION_LABEL[clash.action]}`,
    };
  }
  return { bindings: { ...b, [action]: code }, ok: true, reason: null };
}

/**
 * Structural check for anything arriving from localStorage. A map that puts
 * one key on two actions — or steals a key that always means another action —
 * is rejected whole: partial, internally consistent maps are fine, but a file
 * that would leave two actions sharing a keystroke is worse than no file at
 * all, so the caller falls back to the shipped scheme.
 */
export function isBindings(raw: unknown): raw is Bindings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const o = raw as Record<string, unknown>;
  const seen = new Set<string>();
  for (const a of ACTIONS) {
    if (!(a in o)) continue;
    const code = o[a];
    if (!isValidCode(code)) return false;
    if (seen.has(code as string)) return false;
    // A stored map may not claim an always-key, not even for the action that
    // owns it: ArrowUp already means "vooruit", so writing it down as a
    // binding is a redundant file, not a choice — fall back to the defaults.
    // (Inside the settings menu this stays legal, see findConflict.)
    for (const other of ACTIONS) {
      if ((ALTERNATES[other] ?? []).includes(code as string)) return false;
    }
    seen.add(code as string);
  }
  return true;
}

/** Merge a stored (possibly partial / older) map over the defaults. */
export function mergeBindings(raw: unknown): Bindings {
  const out: Bindings = { ...DEFAULT_BINDINGS };
  if (!isBindings(raw)) return out;
  for (const a of ACTIONS) {
    if (!(a in raw)) continue;
    // A save written before the right button became interface-owned would
    // otherwise swallow the release gesture forever. Drop that ONE binding,
    // keep everything else the player chose.
    if (isReservedCode(raw[a])) continue;
    out[a] = raw[a] as string;
  }
  return out;
}

/**
 * The complete device-level control setup.
 *
 * All three are "this machine, this body" preferences rather than progress:
 * the key map, how hard the mouse turns the camera, and how far the camera
 * hangs behind the player. A player who zoomed to first person yesterday
 * should be standing in their own eyes today.
 */
export interface Controls {
  bindings: Bindings;
  mouseSens: number;
  camDist: number;
}

const KEY = 'asw_controls_v1';

/**
 * Read the saved controls. Returns defaults when nothing is stored, the JSON
 * is broken or it holds keys this build does not know (never boot into dead
 * movement because a settings file got corrupted).
 */
export function loadControls(): Controls {
  const fallback: Controls = {
    bindings: { ...DEFAULT_BINDINGS },
    mouseSens: DEFAULT_MOUSE_SENS,
    camDist: CAM_DIST_DEFAULT,
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback;
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data !== 'object' || data === null) return fallback;
    return {
      bindings: mergeBindings(data.bindings),
      mouseSens: clampMouseSens(data.mouseSens),
      // Absent in every file written before the zoom existed → the shipped
      // shoulder-cam, not first person at 0 m.
      camDist: clampCamDist(data.camDist),
    };
  } catch {
    return fallback;
  }
}

export function saveControls(c: Controls): boolean {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        bindings: mergeBindings(c.bindings),
        mouseSens: clampMouseSens(c.mouseSens),
        camDist: clampCamDist(c.camDist),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearControls(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}
