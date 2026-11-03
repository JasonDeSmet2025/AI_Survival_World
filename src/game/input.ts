/**
 * Keyboard + pointer-lock mouse input for the game.
 * Key map:
 *  WASD / arrows  move
 *  Space          jump / swim up
 *  Shift          sprint
 *  C (hold)       crouch
 *  E              interact (talk, drink, cook, pickup)
 *  F (hold)       harvest
 *  B              toggle crafting menu
 *  1-8            select hotbar slot
 */
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
    let f = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) f += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) f -= 1;
    return f;
  }

  get strafe(): number {
    let s = 0;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) s += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) s -= 1;
    return s;
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
    const d = { x: this.pendingMouseX, y: this.pendingMouseY };
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
