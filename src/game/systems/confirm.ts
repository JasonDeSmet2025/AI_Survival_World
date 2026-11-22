/**
 * Two-step destructive action confirmation (Gameplay Agent scope).
 *
 * "Start a new world?" used to be a `window.confirm()` INSIDE the render
 * loop: the modal blocks the browser thread, so the game froze (and the
 * Babylon render loop stopped) for as long as the dialog was open. Players
 * who walked away from the keyboard came back to a frozen screen.
 *
 * This replaces it with a timed, in-world arming flow: the first key press
 * arms the action (the HUD says so), a second press within the window
 * confirms, and the arm expires by itself. Pure logic + an injectable clock,
 * so the timing is unit-testable.
 */
export type ConfirmStep = 'armed' | 'confirmed';

export class ConfirmFlow {
  /** Seconds a press stays armed before it expires. */
  readonly windowSeconds: number;

  /** Monotonic time (seconds) at which the current arm expires, 0 = idle. */
  private expiresAt = 0;

  constructor(windowSeconds = 5) {
    this.windowSeconds = windowSeconds > 0 ? windowSeconds : 5;
  }

  /** Whether an arm is currently pending (not yet expired). */
  isArmed(now: number): boolean {
    return this.expiresAt > 0 && now < this.expiresAt;
  }

  /** Remaining seconds of the current arm (0 when idle). */
  remaining(now: number): number {
    if (!this.isArmed(now)) return 0;
    // Clamped to the window so a clock that moves backwards (tab suspend,
    // performance.now() reset) can never report an endless countdown.
    return Math.max(0, Math.min(this.windowSeconds, this.expiresAt - now));
  }

  /**
   * Handle a press at monotonic time `now` (seconds):
   * - idle/expired -> arms and returns 'armed' (nothing was done yet);
   * - already armed -> disarms and returns 'confirmed'.
   */
  press(now: number): ConfirmStep {
    if (this.isArmed(now)) {
      this.cancel();
      return 'confirmed';
    }
    this.expiresAt = now + this.windowSeconds;
    return 'armed';
  }

  /** Drop any pending arm. */
  cancel(): void {
    this.expiresAt = 0;
  }
}
