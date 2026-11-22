/**
 * Client-side view of the server's world clock (Multiplayer Agent scope).
 *
 * The day/night cycle is world state: the server owns it, clients follow it.
 * But "follow" has to be done carefully:
 *  - snapping to every 2 s broadcast makes the sun stutter;
 *  - never snapping lets a long-running client drift visibly away from the
 *    other players in the same world.
 *
 * So the client runs the clock itself between updates and only ever moves
 * towards the server value: small errors ease away, a real desync (a laptop
 * that slept, a jump caused by someone else sleeping in a bed) snaps at once.
 *
 * Pure maths, clock injected — see time.test.ts.
 */

/** Must match DAY_LENGTH in src/game/visual/lighting.ts. */
export const DAY_LENGTH_S = 900;

/** Wrap into [0,1). */
export function wrapDay(t: number): number {
  return ((t % 1) + 1) % 1;
}

/** Shortest signed distance from `from` to `to` on the day circle (-0.5..0.5). */
export function dayDelta(from: number, to: number): number {
  let d = wrapDay(to) - wrapDay(from);
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return d;
}

export class ServerClock {
  /** Time of day (0..1) as of `anchorMs`. */
  private serverTime = 0;
  private anchorMs = 0;
  private have = false;
  readonly dayLengthS: number;

  constructor(dayLengthS = DAY_LENGTH_S) {
    this.dayLengthS = dayLengthS > 0 ? dayLengthS : DAY_LENGTH_S;
  }

  /** True once at least one `time`/`hello` message arrived. */
  get synced(): boolean {
    return this.have;
  }

  /** Adopt a server value (`hello.time` or a `time` broadcast). */
  sync(time: number, nowMs = Date.now()): void {
    if (!Number.isFinite(time)) return;
    this.serverTime = wrapDay(time);
    this.anchorMs = nowMs;
    this.have = true;
  }

  /** What the server thinks the time is right now (extrapolated). */
  expected(nowMs = Date.now()): number {
    if (!this.have) return 0;
    const elapsed = Math.max(0, (nowMs - this.anchorMs) / 1000);
    return wrapDay(this.serverTime + elapsed / this.dayLengthS);
  }

  /**
   * Advance the local clock by `dt` seconds of real time and pull it towards
   * the server. Returns the time of day to render.
   *
   * @param current local time of day (0..1)
   * @param driftPerS how hard to correct a small error (per second)
   * @param snapAbove correct instantly beyond this error (0.02 = ~18 game-minutes)
   */
  follow(
    current: number,
    dt: number,
    nowMs = Date.now(),
    driftPerS = 0.4,
    snapAbove = 0.02,
  ): number {
    const t = wrapDay(current + dt / this.dayLengthS);
    if (!this.have) return t;
    const err = dayDelta(t, this.expected(nowMs));
    if (Math.abs(err) > snapAbove) return wrapDay(t + err);
    return wrapDay(t + err * Math.min(1, Math.max(0, driftPerS * dt)));
  }
}
