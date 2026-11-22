import { describe, expect, it } from 'vitest';
import {
  type Bindings,
  ACTION_LABEL,
  ALTERNATES,
  ACTIONS,
  DEFAULT_BINDINGS,
  KEYBIND_GROUPS,
  SLOT_ACTIONS,
  alternatesFor,
  assign,
  clampMouseSens,
  codesFor,
  findConflict,
  isBindings,
  isReservedCode,
  isValidCode,
  keyLabel,
  mergeBindings,
  loadControls,
  saveControls,
  clearControls,
} from './keybinds';
import { CAM_DIST_DEFAULT, CAM_DIST_MAX } from './cameraRig';

/**
 * The key map is the layer between a pressed key and an action, so its rules
 * are the contract the settings menu and the input controller both rely on:
 * one key = one action, alternates always work, and a refused rebind changes
 * nothing at all.
 */

describe('key map shape', () => {
  it('binds every action to a real key', () => {
    for (const a of ACTIONS) {
      expect(isValidCode(DEFAULT_BINDINGS[a]), a).toBe(true);
    }
  });

  it('labels every action and gives every action at most one alternate set', () => {
    for (const a of ACTIONS) {
      expect(ACTION_LABEL[a].length, a).toBeGreaterThan(1);
      expect(alternatesFor(a).every(isValidCode), a).toBe(true);
    }
  });

  it('has no two actions sharing a bound key', () => {
    const seen = new Map<string, string>();
    for (const a of ACTIONS) {
      const prev = seen.get(DEFAULT_BINDINGS[a]);
      expect(prev, `${a} shares ${DEFAULT_BINDINGS[a]} with ${prev}`).toBeUndefined();
      seen.set(DEFAULT_BINDINGS[a], a);
    }
  });

  it('keeps the fixed alternates out of the default map', () => {
    // An alternate that is also someone's bound key would make the conflict
    // report ("staat altijd voor…") a lie.
    for (const [action, alts] of Object.entries(ALTERNATES)) {
      for (const alt of alts ?? []) {
        expect(DEFAULT_BINDINGS[action as (typeof ACTIONS)[number]], `${action}=${alt}`).not.toBe(alt);
        for (const other of ACTIONS) {
          if (other === action) continue;
          expect(DEFAULT_BINDINGS[other], `${other} claims alternate ${alt} of ${action}`).not.toBe(alt);
        }
      }
    }
  });

  it('shows every action in exactly one settings group', () => {
    const shown = KEYBIND_GROUPS.flatMap((g) => g.actions);
    expect(shown.length).toBe(ACTIONS.length);
    for (const a of ACTIONS) expect(shown.filter((x) => x === a).length, a).toBe(1);
    expect(KEYBIND_GROUPS.flatMap((g) => g.actions).filter((a) => SLOT_ACTIONS.includes(a)).length).toBe(8);
  });
});

describe('code validation', () => {
  it.each(['KeyW', 'Digit4', 'Space', 'Escape', 'PageUp', 'ArrowLeft', 'ShiftRight', 'F5', 'Comma', 'Mouse0', 'Mouse2'])(
    'accepts %s',
    (code) => expect(isValidCode(code)).toBe(true),
  );

  it.each(['', 'w', 'KEYW', 'ControlLeft', 'AltLeft', 'MetaLeft', 'Tab', 42, null, undefined])(
    'refuses %s',
    (code) => expect(isValidCode(code)).toBe(false),
  );

  it('refuses the keys a browser or the chat field owns', () => {
    // Ctrl/Alt/Meta combos are browser shortcuts; Tab would leave the panel.
    for (const code of ['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'Tab']) {
      expect(isValidCode(code), code).toBe(false);
    }
  });
});

describe('keyLabel', () => {
  it('reads like a key cap, not a KeyboardEvent', () => {
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('Digit3')).toBe('3');
    expect(keyLabel('Space')).toBe('Spatie');
    expect(keyLabel('Escape')).toBe('Esc');
    expect(keyLabel('ArrowUp')).toBe('↑');
    expect(keyLabel('Mouse0')).toBe('LMuisknop');
    expect(keyLabel('ShiftRight')).toBe('Shift (R)');
  });
});

describe('codesFor', () => {
  it('answers to the bound key and its alternates', () => {
    expect(codesFor(DEFAULT_BINDINGS, 'forward')).toEqual(['KeyW', 'KeyZ', 'ArrowUp']);
    expect(codesFor(DEFAULT_BINDINGS, 'attack')).toEqual(['Mouse0']);
  });

  it('keeps the alternates after a rebind (the French keyboard does not disappear)', () => {
    const b = assign(DEFAULT_BINDINGS, 'forward', 'KeyG').bindings;
    expect(codesFor(b, 'forward')).toEqual(['KeyG', 'KeyZ', 'ArrowUp']);
  });

  it('a custom key drives the action and the old key is free again', () => {
    const b = assign(DEFAULT_BINDINGS, 'interact', 'KeyH').bindings;
    expect(codesFor(b, 'interact')).toContain('KeyH');
    expect(codesFor(b, 'interact')).not.toContain('KeyE');
  });
});

describe('findConflict', () => {
  it('names the action that already owns a bound key', () => {
    expect(findConflict(DEFAULT_BINDINGS, 'interact', 'KeyR')).toEqual({ action: 'consume', kind: 'binding' });
  });

  it('names the fixed alternate before a binding, so a real clash is never soft-pedalled', () => {
    // ArrowUp is always "vooruit"; nothing may claim it quietly.
    expect(findConflict(DEFAULT_BINDINGS, 'jump', 'ArrowUp')?.kind).toBe('alternate');
    expect(findConflict(DEFAULT_BINDINGS, 'jump', 'ArrowUp')?.action).toBe('forward');
  });

  it('reports no conflict for a free key', () => {
    expect(findConflict(DEFAULT_BINDINGS, 'interact', 'KeyH')).toBeNull();
  });

  it('an action never conflicts with itself', () => {
    expect(findConflict(DEFAULT_BINDINGS, 'interact', 'KeyE')).toBeNull();
    // Rebasing forward onto its own alternate is legitimate, not a conflict.
    expect(findConflict(DEFAULT_BINDINGS, 'forward', 'ArrowUp')).toBeNull();
  });

  it('the action being rebound is never the one in the way', () => {
    // Taking KeyE away from interact and giving it back must not self-block.
    const b = { ...DEFAULT_BINDINGS, interact: 'KeyH' };
    expect(findConflict(b, 'interact', 'KeyE')).toBeNull();
  });
});

describe('assign', () => {
  it('rebinds and leaves every other action alone', () => {
    const r = assign(DEFAULT_BINDINGS, 'interact', 'KeyH');
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.bindings.interact).toBe('KeyH');
    expect(r.bindings.forward).toBe(DEFAULT_BINDINGS.forward);
    expect(r.bindings).not.toBe(DEFAULT_BINDINGS); // never mutate the caller's map
  });

  it('refuses a key another action owns, naming it in the reason', () => {
    const r = assign(DEFAULT_BINDINGS, 'interact', 'KeyF');
    expect(r.ok).toBe(false);
    expect(r.bindings).toBe(DEFAULT_BINDINGS); // untouched, so no half-apply
    expect(r.reason).toContain('Oogsten');
  });

  it('refuses a key that always means something else', () => {
    const r = assign(DEFAULT_BINDINGS, 'harvest', 'ArrowLeft');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('staat altijd voor');
  });

  it('refuses keys that are not keys', () => {
    for (const code of ['', 'ControlLeft', 'Tab', 'w']) {
      const r = assign(DEFAULT_BINDINGS, 'interact', code);
      expect(r.ok, code).toBe(false);
      expect(r.bindings).toBe(DEFAULT_BINDINGS);
    }
  });

  it('a rebind chain cannot duplicate a key: the second move fails', () => {
    const first = assign(DEFAULT_BINDINGS, 'interact', 'KeyH');
    const second = assign(first.bindings, 'harvest', 'KeyH');
    expect(second.ok).toBe(false);
    expect(second.reason).toContain('Interactie');
  });

  it('freeing a key and handing it to another action works', () => {
    const freed = assign(DEFAULT_BINDINGS, 'interact', 'KeyH');
    const moved = assign(freed.bindings, 'harvest', 'KeyE');
    expect(moved.ok).toBe(true);
    expect(moved.bindings.harvest).toBe('KeyE');
    expect(moved.bindings.interact).toBe('KeyH');
  });

  it('an unknown action is refused', () => {
    const r = assign(DEFAULT_BINDINGS, 'nope' as (typeof ACTIONS)[number], 'KeyH');
    expect(r.ok).toBe(false);
  });
});

describe('storage shape', () => {
  it('recognises a sane map and rejects junk', () => {
    expect(isBindings(DEFAULT_BINDINGS)).toBe(true);
    expect(isBindings({ forward: 'KeyW' })).toBe(true); // partial is fine
    expect(isBindings({ forward: 'KeyG', back: 'KeyH' })).toBe(true);
    expect(isBindings(null)).toBe(false);
    expect(isBindings([])).toBe(false);
    expect(isBindings('KeyW')).toBe(false);
    expect(isBindings({ forward: 42 })).toBe(false);
    expect(isBindings({ forward: 'ControlLeft' })).toBe(false);
    expect(isBindings({ forward: 'ArrowUp' })).toBe(false); // always "vooruit"
    expect(isBindings({ forward: 'KeyF', harvest: 'KeyF' })).toBe(false);
  });

  it('merges a partial map over the defaults', () => {
    const m = mergeBindings({ interact: 'KeyH' });
    expect(m.interact).toBe('KeyH');
    expect(m.forward).toBe('KeyW');
    expect(m.settings).toBe('KeyO');
  });

  it('falls back to defaults for garbage', () => {
    for (const junk of [undefined, null, 'x', 7, [], { forward: 'nope' }]) {
      expect(mergeBindings(junk)).toEqual(DEFAULT_BINDINGS);
    }
  });

  it('refuses a map that puts two actions on one key', () => {
    // Hand-edited storage: KeyF on both. Two actions sharing a keystroke is
    // unplayable, so the whole map is refused instead of half-applied.
    expect(mergeBindings({ forward: 'KeyF', harvest: 'KeyF' })).toEqual(DEFAULT_BINDINGS);
  });

  it('refuses a stored key that always means something else', () => {
    // ArrowUp is permanently "vooruit"; a file cannot hand it to jump.
    expect(mergeBindings({ jump: 'ArrowUp' })).toEqual(DEFAULT_BINDINGS);
  });

  it('takes the right mouse button away from actions', () => {
    // RMB releases the cursor so the HUD can be clicked. If an action could
    // still own it, that gesture would be swallowed for exactly the players
    // who bound attack to it — and they would never guess why.
    expect(isReservedCode('Mouse2')).toBe(true);
    expect(isReservedCode('Mouse0')).toBe(false);
    expect(isReservedCode('KeyQ')).toBe(false);
    // Still a real, nameable button (the menu has to print its label).
    expect(isValidCode('Mouse2')).toBe(true);
    expect(keyLabel('Mouse2')).toBe('RMuisknop');
    const r = assign(DEFAULT_BINDINGS, 'attack', 'Mouse2');
    expect(r.ok).toBe(false);
    expect(r.bindings).toEqual(DEFAULT_BINDINGS);
    expect(r.reason).toMatch(/interface/i);
  });

  it('drops a stored action binding on the right button, keeps the rest', () => {
    // A file written before the reservation must not swallow the release
    // gesture forever — and must not throw the player's other choices away
    // either (one dropped binding, not one dropped map).
    const m = mergeBindings({ attack: 'Mouse2', interact: 'KeyH' });
    expect(m.attack).toBe(DEFAULT_BINDINGS.attack);
    expect(m.interact).toBe('KeyH');
  });

  it('applies a complete custom map unchanged', () => {
    const custom: Bindings = { ...DEFAULT_BINDINGS, interact: 'KeyH', craft: 'KeyJ', slot1: 'Numpad1' };
    expect(mergeBindings(custom)).toEqual(custom);
  });

  it('never leaves two actions on one key, whatever the input', () => {
    const hostile = {
      forward: 'KeyF', back: 'KeyF', left: 'KeyF', right: 'KeyF',
      jump: 'KeyF', sprint: 'KeyF', crouch: 'KeyF', interact: 'KeyF',
      harvest: 'KeyQ', craft: 'KeyQ', inventory: 'KeyQ',
    };
    const m = mergeBindings(hostile);
    const keys = ACTIONS.map((a) => m[a]);
    expect(new Set(keys).size).toBe(ACTIONS.length);
  });

  it('survives a round trip through JSON', () => {
    const changed = assign(DEFAULT_BINDINGS, 'attack', 'KeyH').bindings;
    expect(mergeBindings(JSON.parse(JSON.stringify(changed)))).toEqual(changed);
  });
});

describe('mouse sensitivity', () => {
  it('keeps the shipped feel at 1', () => {
    expect(clampMouseSens(undefined)).toBe(1);
    expect(clampMouseSens('nonsense')).toBe(1);
  });

  it('clamps into the usable range and keeps two decimals', () => {
    expect(clampMouseSens(0)).toBe(0.2);
    expect(clampMouseSens(99)).toBe(3);
    expect(clampMouseSens('1.5')).toBe(1.5);
    expect(clampMouseSens(1.234)).toBe(1.23);
    expect(clampMouseSens(-3)).toBe(0.2);
  });
});

/**
 * The controls file lives in localStorage, which does not exist in a Node
 * test run — hence a stub, and a `finally` that removes it again so no other
 * suite inherits a fake storage.
 */
function withStorage(run: () => void): void {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  try {
    run();
  } finally {
    delete (globalThis as Record<string, unknown>).localStorage;
  }
}

describe('stored controls', () => {
  it('remembers the zoomed camera between sessions', () => {
    withStorage(() => {
      expect(saveControls({ bindings: DEFAULT_BINDINGS, mouseSens: 1, camDist: 0 })).toBe(true);
      // Zoomed to first person yesterday → standing in your own eyes today.
      expect(loadControls().camDist).toBe(0);
      expect(saveControls({ bindings: DEFAULT_BINDINGS, mouseSens: 1, camDist: 400 })).toBe(true);
      // A hand-edited file cannot park the camera 400 m behind the player.
      expect(loadControls().camDist).toBe(CAM_DIST_MAX);
    });
  });

  it('gives the shipped view to a file written before the zoom existed', () => {
    withStorage(() => {
      // Exactly what every player has in their browser right now: keys and a
      // sensitivity, no camera distance at all.
      localStorage.setItem('asw_controls_v1', JSON.stringify({ bindings: { interact: 'KeyH' }, mouseSens: 1.4 }));
      const c = loadControls();
      expect(c.camDist).toBe(CAM_DIST_DEFAULT);
      expect(c.mouseSens).toBe(1.4);
      expect(c.bindings.interact).toBe('KeyH');
      // Junk instead of a number must not mean "first person" either.
      localStorage.setItem('asw_controls_v1', JSON.stringify({ camDist: 'ver' }));
      expect(loadControls().camDist).toBe(CAM_DIST_DEFAULT);
      localStorage.setItem('asw_controls_v1', JSON.stringify({ camDist: null }));
      expect(loadControls().camDist).toBe(CAM_DIST_DEFAULT);
      clearControls();
      expect(loadControls().camDist).toBe(CAM_DIST_DEFAULT);
    });
  });

  it('refuses to store an action on the reserved right button', () => {
    withStorage(() => {
      // Written by a build that still allowed it: the load must clean it.
      localStorage.setItem(
        'asw_controls_v1',
        JSON.stringify({ bindings: { ...DEFAULT_BINDINGS, attack: 'Mouse2' }, mouseSens: 1 }),
      );
      expect(loadControls().bindings.attack).toBe(DEFAULT_BINDINGS.attack);
    });
  });
});
