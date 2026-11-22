/**
 * Shared world clock (Multiplayer Agent scope).
 *
 * The day/night cycle used to be pure client state: every browser ran its
 * own timer, so two players in the same world stood in different skies, and
 * one player sleeping to 06:00 jumped only their own clock. This module makes
 * the clock a property of the WORLD: the server owns it, clients follow it.
 *
 * Time is expressed the same way as the client's `Lighting.timeOfDay`:
 * a fraction of a day, 0 = midnight, 0.25 = 06:00. One full day lasts
 * `dayLengthS` real seconds — 900 s, matching DAY_LENGTH in
 * src/game/visual/lighting.ts. Keeping that number in sync matters more than
 * it looks: a different rate makes the client's smooth local extrapolation
 * between server updates visibly drift.
 *
 * Pure logic: no timers, no I/O, clock injected. Unit-tested in
 * server/clock.test.mjs.
 */

/** Must match DAY_LENGTH in src/game/visual/lighting.ts. */
export const DAY_LENGTH_S = 900;
/** Must match REST_WAKE_TIME in src/game/systems/rest.ts (06:00). */
export const MORNING = 0.25;

/**
 * @param {object} [opts]
 * @param {number} [opts.dayLengthS] seconds per in-game day
 * @param {number} [opts.start] initial time of day (0..1)
 * @param {() => number} [opts.now] millisecond clock (injectable for tests)
 * @param {number} [opts.offsetS] persisted cycle-clock seconds since midnight
 */
export function createWorldClock({
  dayLengthS = DAY_LENGTH_S,
  start = MORNING,
  now = () => Date.now(),
  offsetS = null,
} = {}) {
  const length = dayLengthS > 0 ? dayLengthS : DAY_LENGTH_S;
  // Wall-clock instant the clock was (re)anchored, and the cycle time in
  // seconds at that instant. Everything else follows from these two numbers,
  // so a restart or a sleep-jump is just a new anchor.
  let anchorMs = now();
  let anchorS = offsetS !== null && Number.isFinite(offsetS)
    ? wrap(offsetS, length)
    : wrap(start * length, length);

  function wrap(v, len) {
    return ((v % len) + len) % len;
  }

  /** Seconds since midnight on the shared cycle clock, at instant `atMs`. */
  function elapsedAt(atMs = now()) {
    return wrap(anchorS + Math.max(0, (atMs - anchorMs) / 1000), length);
  }

  return {
    get dayLengthS() {
      return length;
    },
    /** Time of day (0..1) at instant `atMs`. Monotonic within a day. */
    time(atMs = now()) {
      return elapsedAt(atMs) / length;
    },
    /** Cycle seconds since midnight (for persisting across restarts). */
    offsetAt(atMs = now()) {
      return elapsedAt(atMs);
    },
    /** Force the clock to a time of day (0..1). Returns the new time. */
    setTime(t, atMs = now()) {
      const f = (Number.isFinite(t) ? ((t % 1) + 1) % 1 : 0);
      anchorMs = atMs;
      anchorS = wrap(f * length, length);
      return f;
    },
    /**
     * A player slept: the world wakes up at `wake` (06:00 by default).
     * Travel FORWARD only — never rewind, or a player could sleep backwards
     * into the same in-game hours again to farm the night.
     */
    advanceToMorning(wake = MORNING, atMs = now()) {
      const target = (Number.isFinite(wake) ? ((wake % 1) + 1) % 1 : MORNING) * length;
      const cur = elapsedAt(atMs);
      const delta = wrap(target - cur, length);
      // A whole day only makes sense if we are exactly on the target; then
      // a full night passing is the honest interpretation of "we all slept".
      anchorMs = atMs;
      anchorS = wrap(cur + (delta === 0 ? length : delta), length);
      return anchorS / length;
    },
    /**
     * Milliseconds until the clock reaches `t` (0..1) — used to schedule
     * exactly one broadcast per in-game hour instead of one per tick.
     */
    msUntil(t, atMs = now()) {
      const target = wrap((Number.isFinite(t) ? t : 0) * length, length);
      const cur = elapsedAt(atMs);
      return wrap(target - cur, length) * 1000;
    },
  };
}
