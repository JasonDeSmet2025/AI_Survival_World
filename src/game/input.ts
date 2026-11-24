/**
 * Keyboard + pointer-lock mouse input for the game.
 *
 * NOTHING HERE HARDCODES A KEY any more: every action is resolved through
 * systems/keybinds.ts, which the settings menu (O) can rebind and stores per
 * browser. What the player sees in that menu is exactly what this file
 * answers to — including the fixed alternates (AZERTY Z, arrow keys, both
 * Shifts) that stay available no matter what is bound.
 *
 * Default scheme:
 *  W/S/A/D + arrows  move · Space jump/swim · Shift sprint · C crouch (hold)
 *  E interact · F harvest (hold) · B craft menu · K perk tree · I/Esc bag · Q drop · R eat
 *  LMB attack/shoot · O settings · PgUp/PgDn build height · 1-8 hotbar
 *  Scrollwheel  zoom the camera (third person ↔ first person)
 *  RMB          let go of the mouse, so the cursor can click the HUD
 *
 * The two mouse devices are deliberately asymmetric: LMB belongs to an ACTION
 * (attack, rebindable), RMB belongs to the INTERFACE (reserved, never
 * bindable) because its whole job is to give the cursor back to the browser.
 */
import {
  DEFAULT_BINDINGS,
  SLOT_ACTIONS,
  codesFor,
  isReservedCode,
  type Action,
  type Bindings,
} from './systems/keybinds';
import { wheelNotches } from './systems/cameraRig';

/** Keys whose browser default (scrolling) must never fire mid-game. */
const PREVENT_DEFAULT = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'PageUp',
  'PageDown',
]);
/**
 * Hard cap on accumulated pointer delta consumed in a single frame (px per
 * axis). Browsers can deliver huge movement spikes (window refocus, focus
 * returning after an alt-tab, pointer-lock reacquire); without a cap one
 * frame would swing the camera violently. Normal gameplay deltas are far
 * below this value, so gameplay feel is unchanged.
 */
const MAX_FRAME_MOUSE_DELTA = 240;

/**
 * Movement axes from held keyboard codes. The action's own alternates stay
 * live next to the bound key, so a QWERTY/AZERTY player and an arrow-key
 * player both move even after rebinding something else.
 */
export function movementAxes(
  keys: ReadonlySet<string>,
  bindings: Bindings = DEFAULT_BINDINGS,
): { forward: number; strafe: number } {
  const has = (a: Action): number =>
    Number(codesFor(bindings, a).some((c) => keys.has(c)));
  const forward = has('forward') - has('back');
  const strafe = has('right') - has('left');
  return { forward, strafe };
}

export class InputController {
  private keys = new Set<string>();
  private canvas: HTMLCanvasElement;
  /** Live key map (the settings menu swaps this at runtime). */
  private bindings: Bindings = { ...DEFAULT_BINDINGS };

  private pendingMouseX = 0;
  private pendingMouseY = 0;
  /** Accumulated wheel notches since the last frame (see consumeWheelZoom). */
  private pendingWheel = 0;
  pointerLocked = false;

  /** Single-press flags, consumed by the game loop. */
  private pressed = new Set<string>();

  constructor(canvas: HTMLCanvasElement, bindings?: Bindings) {
    this.canvas = canvas;
    if (bindings) this.bindings = { ...bindings };
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    this.canvas.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('click', this.onClick);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  /** Swap the live key map (called by the settings menu, immediately). */
  setBindings(b: Bindings): void {
    this.bindings = { ...b };
  }

  get keyBindings(): Bindings {
    return { ...this.bindings };
  }

  /**
   * Forget every queued single-press. Used while the rebind capture is open:
   * the key you press to rebind must not also trigger the action it drives
   * (rebinding "eeten" to R must not make you eat your dinner).
   */
  clearPresses(): void {
    this.pressed.clear();
  }

  /**
   * Mouse buttons, split by who owns them.
   *
   * LMB (`Mouse0`) is an ACTION: only while the camera owns the mouse, because
   * an unlocked click is a HUD click. RMB (`Mouse2`) is INTERFACE: reported
   * whatever the lock state, since releasing the cursor is exactly what you
   * press while the cursor is still grabbed. `isReservedCode` is the single
   * place that decides this, and the settings menu refuses to bind it.
   */
  private onPointerDown = (e: PointerEvent): void => {
    if (isReservedCode(`Mouse${e.button}`)) {
      this.pressed.add(`Mouse${e.button}`);
      return;
    }
    // Only while the camera owns the mouse: an unlocked click is a UI
    // click (panel button) or the click that re-locks via onClick.
    if (!this.pointerLocked || e.button !== 0) return;
    this.pressed.add('Mouse0');
  };

  /**
   * The wheel drives the camera zoom. It is NOT a rebindable action: it is
   * continuous, has no key identity and is the one control every player
   * already tries without being told.
   *
   * Listening on the CANVAS (not the window) is the point: the craft list and
   * the bag are DOM panels, so a wheel gesture inside one of them never comes
   * here — the panel scrolls and the camera keeps its distance.
   */
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const notches = wheelNotches(e.deltaY, e.deltaMode);
    // Accumulate rather than overwrite: several notches can land inside one
    // frame, and dropping them makes a fast flick stop short of first person.
    this.pendingWheel += notches;
  };

  /**
   * Right-click would otherwise open the browser menu on top of the game —
   * both while locked and while the cursor is free. Suppressed here, so the
   * button is free to mean "let go of the mouse".
   */
  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (PREVENT_DEFAULT.has(e.code)) {
      e.preventDefault();
    }
    // Single-press events (ignored when the HUD text box is focused).
    const target = e.target as HTMLElement | null;
    if (target && target.tagName === 'INPUT') return;
    if (!this.keys.has(e.code)) this.pressed.add(e.code);
    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onBlur = (): void => {
    this.keys.clear();
  };

  private onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.canvas;
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.pointerLocked) return;
    this.pendingMouseX += e.movementX;
    this.pendingMouseY += e.movementY;
  };

  private onClick = (): void => {
    this.grabPointer();
  };

  /**
   * Take the mouse for the camera. Returns false when the browser refuses,
   * which is not a rare error but a documented rule: after the page RELEASES
   * the lock, Chrome ignores a new request for ~1.2 s (anti-hijack). Callers
   * must therefore treat a failed grab as "keep telling the player to click",
   * not as a broken control — which is why the HUD keeps its pointer chip up
   * until the lock is actually held.
   */
  grabPointer(): boolean {
    if (this.pointerLocked) return true;
    try {
      // requestPointerLock() returns a promise in current browsers; without
      // this catch a refused grab logs an unhandled rejection every click.
      const req = this.canvas.requestPointerLock() as unknown as
        | Promise<void>
        | undefined;
      if (req && typeof req.catch === 'function') req.catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  /** Give the mouse back to the browser (the RMB half of the pair). */
  releasePointer(): void {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  /** Held state for a rebindable action. */
  private held(action: Action): boolean {
    return codesFor(this.bindings, action).some((c) => this.keys.has(c));
  }

  get forward(): number {
    return movementAxes(this.keys, this.bindings).forward;
  }

  get strafe(): number {
    return movementAxes(this.keys, this.bindings).strafe;
  }

  get sprint(): boolean {
    return this.held('sprint');
  }

  get jump(): boolean {
    return this.held('jump');
  }

  /** Held state (physics uses this for continuous jump/swim-up). */
  get jumpHeld(): boolean {
    return this.held('jump');
  }

  get crouch(): boolean {
    return this.held('crouch');
  }

  get harvest(): boolean {
    return this.held('harvest');
  }

  get interact(): boolean {
    return this.held('interact');
  }

  /** True once per physical press of an action's key. */
  consumePress(action: Action): boolean {
    for (const code of codesFor(this.bindings, action)) {
      if (this.pressed.has(code)) {
        // Consume every code of the action so a second bound key cannot
        // fire the same action twice in one frame.
        for (const c of codesFor(this.bindings, action)) this.pressed.delete(c);
        return true;
      }
    }
    return false;
  }

  /**
   * True once per press of hotbar slot `i` (0-based). Slot keys are the one
   * group deliberately bound as a run, so they are matched as a run here too
   * instead of eight separate consumePress calls.
   */
  consumeSlotPress(): number {
    for (let i = 0; i < SLOT_ACTIONS.length; i++) {
      if (this.consumePress(SLOT_ACTIONS[i])) return i;
    }
    return -1;
  }

  consumeMouseDelta(): { x: number; y: number } {
    // Clamp spikes so a single frame can never rotate the camera wildly.
    const clampAxis = (v: number): number =>
      Math.max(-MAX_FRAME_MOUSE_DELTA, Math.min(MAX_FRAME_MOUSE_DELTA, v));
    const d = { x: clampAxis(this.pendingMouseX), y: clampAxis(this.pendingMouseY) };
    this.pendingMouseX = 0;
    this.pendingMouseY = 0;
    return d;
  }

  /** Wheel notches since the last frame (negative = zoom in). */
  consumeWheelZoom(): number {
    const w = this.pendingWheel;
    this.pendingWheel = 0;
    return w;
  }

  /**
   * True once per press of an interface mouse button (never a rebindable
   * action — see systems/keybinds.ts `isReservedCode`).
   */
  consumeInterfacePress(code: string): boolean {
    return this.pressed.delete(code);
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.canvas.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('click', this.onClick);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    if (document.pointerLockElement === this.canvas) {
      document.exitPointerLock();
    }
  }
}
