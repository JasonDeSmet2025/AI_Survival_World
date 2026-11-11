/**
 * Sleep / rest math (Gameplay Agent scope).
 * Pure logic — no rendering, no Babylon, testable in isolation.
 *
 * Sleeping in a bed fast-forwards the day/night clock to REST_WAKE_TIME
 * (early morning) and produces a single RestResult describing how the
 * player's survival stats change over the slept interval:
 *
 * - Hunger/thirst drain at SLEEP rates (slower than awake: the body
 *   recovers while sleeping, so a full night costs less than the same
 *   time spent awake).
 * - If hunger or thirst runs out DURING the sleep, the player takes
 *   deprivation damage for each game-hour spent at zero (they can even
 *   die in their sleep — resting does not cure starvation).
 * - A well-fed sleep regenerates a small amount of health.
 * - Stamina is always fully restored and the sprint-exhaustion lockout
 *   is cleared (applied by SurvivalStats.applyRest, not here).
 *
 * Sleeping near the wake time simply takes the long way around the clock
 * (going to bed at 06:10 means sleeping until the NEXT 06:00) — the
 * player gets a long, expensive sleep and has to live with it.
 */
import { clamp } from '../core/noise';

/** The time of day (0..1, 0 = midnight) the player always wakes at. 0.25 = 06:00. */
export const REST_WAKE_TIME = 0.25;

export const REST = {
  /**
   * Hunger points lost per game-hour of sleep. ≈10 % of the awake drain
   * (the awake rate is 30 /game-hour at the 900 s day cycle), so an 8 h
   * night costs ~20 hunger — sleep recovers, it does not free-lunch.
   */
  hungerPerGameHour: 2.5,
  /** Thirst points lost per game-hour of sleep (≈10 % of the awake rate). */
  thirstPerGameHour: 3.3,
  /** Health lost per game-hour that hunger/thirst sat at zero. */
  deprivationPerGameHour: 2.0,
  /** Health gained per game-hour when both hunger and thirst last the whole sleep. */
  regenPerGameHour: 0.6,
} as const;

export interface RestInputs {
  /** Time of day when the sleep starts, 0..1 (0 = midnight). */
  timeOfDay: number;
  health: number;
  hunger: number;
  thirst: number;
}

export interface RestResult {
  /** Time of day to wake at (always REST_WAKE_TIME). */
  wakeTime: number;
  /** Game-hours slept (0..24). */
  gameHoursSlept: number;
  hunger: number;
  thirst: number;
  health: number;
  /** True when deprivation damage killed the player in their sleep. */
  died: boolean;
}

/** Compute the stats outcome of sleeping from `input.timeOfDay` until the morning. */
export function computeRest(input: RestInputs): RestResult {
  const from = ((input.timeOfDay % 1) + 1) % 1;
  let elapsed = REST_WAKE_TIME - from;
  if (elapsed <= 0) elapsed += 1; // past midnight → the next morning
  const hours = elapsed * 24;

  const hunger = clamp(input.hunger - REST.hungerPerGameHour * hours, 0, 100);
  const thirst = clamp(input.thirst - REST.thirstPerGameHour * hours, 0, 100);

  // Deprivation damage: game-hours spent at zero hunger/thirst.
  let damage = 0;
  const hungerRunsOut = input.hunger / REST.hungerPerGameHour;
  const thirstRunsOut = input.thirst / REST.thirstPerGameHour;
  if (hungerRunsOut < hours) damage += REST.deprivationPerGameHour * (hours - hungerRunsOut);
  if (thirstRunsOut < hours) damage += REST.deprivationPerGameHour * (hours - thirstRunsOut);

  // A well-fed sleep heals a little; a starved sleep only hurts.
  const health = clamp(
    input.health - damage + (damage > 0 ? 0 : REST.regenPerGameHour * hours),
    0,
    100,
  );

  return {
    wakeTime: REST_WAKE_TIME,
    gameHoursSlept: hours,
    hunger,
    thirst,
    health,
    died: health <= 0,
  };
}
