/**
 * Keyboard + pointer-lock mouse input for the game.
 * Key map:
 *  WASD / ZS / arrows  move
 *  Space          jump / swim up
 *  Shift          sprint
 *  C (hold)       crouch
 *  E              interact (talk, drink, cook, pickup)
 *  F (hold)       harvest
 *  B              toggle crafting menu
 *  I / Esc        toggle full inventory panel (Esc only while open)
 *  Q              drop one selected item (or from the inventory cursor)
 *  R              eat/drink the selected consumable
 *  1-8            select hotbar slot
 */
/**
 * Hard cap on accumulated pointer delta consumed in a single frame (px per
 * axis). Browsers can deliver huge movement spikes (window refocus, focus
 * returning after an alt-tab, pointer-lock reacquire); without a cap one
 * frame would swing the camera violently. Normal gameplay deltas are far
 * below this value, so gameplay feel is unchanged.
 */
const MAX_FRAME_MOUSE_DELTA = 240;

/** Movement axes from held keyboard codes (supports both QWERTY and AZERTY). */
export function movementAxes(keys: ReadonlySet<string>): { forward: number; strafe: number } {
  const forward = Number(keys.has('KeyW') || keys.has('KeyZ') || keys.has('ArrowUp'))
    - Number(keys.has('KeyS') || keys.has('ArrowDown'));
  const strafe = Number(keys.has('KeyD') || keys.has('ArrowRight'))
    - Number(keys.has('KeyA') || keys.has('ArrowLeft'));
  return { forward, strafe };
}

export class InputController {
  private keys = new Set<string>();
  private canvas: HTMLCanvasElement;

  private pendingMouseX = 0;
  private pendingMouseY = 0;
  pointerLocked = false;

  /** Single-press flags, consumed by the game loop. */
  private pressed = new Set<string>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    this.canvas.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('click', this.onClick);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (
      e.code === 'ArrowUp' ||
      e.code === 'ArrowDown' ||
      e.code === 'ArrowLeft' ||
      e.code === 'ArrowRight' ||
      e.code === 'Space'
    ) {
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
    if (!this.pointerLocked) {
      this.canvas.requestPointerLock();
    }
  };

  get forward(): number {
    return movementAxes(this.keys).forward;
  }

  get strafe(): number {
    return movementAxes(this.keys).strafe;
  }

  get sprint(): boolean {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  get jump(): boolean {
    return this.keys.has('Space');
  }

  /** Held state (physics uses this for continuous jump/swim-up). */
  get jumpHeld(): boolean {
    return this.keys.has('Space');
  }

  get crouch(): boolean {
    return this.keys.has('KeyC');
  }

  get harvest(): boolean {
    return this.keys.has('KeyF');
  }

  get interact(): boolean {
    return this.keys.has('KeyE');
  }

  /** True once per physical press. */
  consumePress(code: string): boolean {
    if (this.pressed.has(code)) {
      this.pressed.delete(code);
      return true;
    }
    return false;
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

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.canvas.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('click', this.onClick);
    if (document.pointerLockElement === this.canvas) {
      document.exitPointerLock();
    }
  }
}
