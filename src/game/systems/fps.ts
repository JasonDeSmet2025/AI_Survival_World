/**
 * Honest FPS meter (Gameplay Agent scope).
 *
 * The game loop clamps the simulation timestep (`dt = min(rawDt, 0.05)`)
 * so physics stays stable in a stall — but the old HUD counter fed that
 * CLAMPED time into its own average, which structurally reported ~20 fps
 * no matter how badly the game actually ran (a 1 fps build displayed 20).
 * Every visual/performance judgement built on that number was worthless.
 *
 * This meter must be fed the UNCLAMPED real frame time. It is deliberately
 * trivial and dependency-free so it can be unit-tested: no engine, no DOM.
 */
export class FpsMeter {
  /** Number of seconds of real time between two HUD updates. */
  readonly windowSeconds: number;

  private frames = 0;
  private elapsed = 0;
  private value = 0;

  constructor(windowSeconds = 1) {
    this.windowSeconds = windowSeconds > 0 ? windowSeconds : 1;
  }

  /** Latest computed fps (0 before the first window completed). */
  get fps(): number {
    return this.value;
  }

  /** Frames counted in the current (partial) window. */
  get framesInWindow(): number {
    return this.frames;
  }

  /**
   * Feed ONE rendered frame with its REAL duration in seconds (never the
   * simulation-clamped dt). Returns true when the window completed and
   * `fps` was updated, so the caller knows when to push it to the HUD.
   * Non-positive or non-finite frame times are ignored (tab-switch noise
   * would otherwise average into the window).
   */
  tick(realDt: number): boolean {
    if (!Number.isFinite(realDt) || realDt <= 0) return false;
    this.frames++;
    this.elapsed += realDt;
    if (this.elapsed < this.windowSeconds) return false;
    this.value = Math.round(this.frames / this.elapsed);
    this.frames = 0;
    this.elapsed = 0;
    return true;
  }

  /** Reset the window (e.g. after a pause or a scene switch). */
  reset(): void {
    this.frames = 0;
    this.elapsed = 0;
    this.value = 0;
  }
}
