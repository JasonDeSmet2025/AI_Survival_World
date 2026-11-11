import { clamp } from '../core/noise';
import type { RestResult } from './rest';

export interface StatSnapshot {
  health: number;
  hunger: number;
  thirst: number;
  stamina: number;
  /** True while the player is exhausted and cannot sprint. */
  exhausted?: boolean;
  /** Degrees Celsius. */
  temperature: number;
  dead: boolean;
}

export interface Environment {
  sprinting: boolean;
  inWater: boolean;
  /**
   * Target-temperature contribution (°C) from the strongest lit campfire
   * nearby (0 = none). Computed by the campfire fuel system, which
   * handles distance falloff and per-fire fuel.
   */
  fireWarmth: number;
  /** 0 = deep night, 1 = midday. */
  dayFactor: number;
}

/**
 * Survival stats: health, hunger, thirst, stamina, temperature.
 * All rates chosen so a fresh player has ~15-25 min of comfortable play
 * before needing to eat/drink.
 */
export class SurvivalStats {
  health = 100;
  hunger = 100;
  thirst = 100;
  stamina = 100;
  temperature = 20;
  dead = false;

  /** True while the exhaustion lockout is active (no sprint, no stamina regen). */
  get exhausted(): boolean {
    return this.exhaustT > 0;
  }

  /**
   * Sprint gate for the movement controller. Sprinting is only allowed
   * while alive, not exhausted and with stamina remaining.
   */
  canSprint(): boolean {
    return !this.dead && !this.exhausted && this.stamina > 0;
  }

  private static readonly RATES = {
    hungerPerSec: 100 / (20 * 60), // ~20 min
    thirstPerSec: 100 / (12 * 60), // ~12 min
    sprintStamina: 14,
    regenStamina: 10,
    /** Sprinting to empty stamina triggers this recovery lockout. */
    exhaustSeconds: 4,
    starve: 4,
    dehydrate: 6,
    freeze: 2.5,
    heat: 2.5,
  };

  /** Remaining seconds of the exhaustion lockout (0 = not exhausted). */
  private exhaustT = 0;

  /**
   * Advance simulation. Returns the damage dealt this tick (for HUD flash).
   */
  update(dt: number, env: Environment): number {
    if (this.dead) return 0;

    // Hunger / thirst always drain; sprinting drains stamina + a bit of hunger.
    this.hunger -= SurvivalStats.RATES.hungerPerSec * dt * (env.sprinting ? 1.6 : 1);
    this.thirst -= SurvivalStats.RATES.thirstPerSec * dt * (env.sprinting ? 1.4 : 1);
    this.hunger = clamp(this.hunger, 0, 100);
    this.thirst = clamp(this.thirst, 0, 100);

    // Sprinting drains stamina; empty stamina during a sprint triggers
    // the exhaustion lockout. `env.sprinting` is only true when the
    // player is ACTUALLY sprinting (the controller applies the canSprint
    // gate, water and crouch exclusions), so holding Shift while blocked
    // never drains stamina.
    if (env.sprinting && !this.exhausted) {
      this.stamina = clamp(this.stamina - SurvivalStats.RATES.sprintStamina * dt, 0, 100);
      if (this.stamina <= 0) this.exhaustT = SurvivalStats.RATES.exhaustSeconds;
    } else if (this.exhausted) {
      // Exhausted: lockout counts down, no stamina recovery.
      this.exhaustT = Math.max(0, this.exhaustT - dt);
    } else {
      this.stamina = clamp(this.stamina + SurvivalStats.RATES.regenStamina * dt, 0, 100);
    }

    // Temperature: cold nights, warm days, fire warms, water chills.
    let target = 6 + env.dayFactor * 18; // night ~6..8, day ~24
    if (env.inWater) target -= 12;
    if (env.fireWarmth > 0) target = Math.max(target, env.fireWarmth);
    // Slow approach to target temperature.
    this.temperature += (target - this.temperature) * Math.min(1, dt * 0.08);

    // Damage from deprivation.
    let damage = 0;
    if (this.hunger <= 0) damage += SurvivalStats.RATES.starve * dt;
    if (this.thirst <= 0) damage += SurvivalStats.RATES.dehydrate * dt;
    if (this.temperature < 4) damage += SurvivalStats.RATES.freeze * dt * (4 - this.temperature) * 0.4;
    if (this.temperature > 34) damage += SurvivalStats.RATES.heat * dt;

    if (damage > 0) {
      this.health = clamp(this.health - damage, 0, 100);
      if (this.health <= 0) this.dead = true;
    } else if (this.hunger > 60 && this.thirst > 60) {
      // Slow regen when well fed.
      this.health = clamp(this.health + 0.6 * dt, 0, 100);
    }

    return damage;
  }

  /**
   * Apply an instant damage hit (e.g. a fall impact). Returns the amount
   * actually applied (0 for non-positive input or an already-dead player).
   * Sets `dead` when health reaches zero.
   */
  takeDamage(amount: number): number {
    if (this.dead || amount <= 0) return 0;
    const applied = Math.min(this.health, amount);
    this.health = clamp(this.health - amount, 0, 100);
    if (this.health <= 0) this.dead = true;
    return applied;
  }

  /**
   * Apply the outcome of a full rest in a bed (see systems/rest.ts).
   * Sets the slept-to stat values, restores stamina fully and clears
   * the sprint-exhaustion lockout. A fatal rest kills the player.
   */
  applyRest(r: RestResult): void {
    this.health = clamp(r.health, 0, 100);
    this.hunger = clamp(r.hunger, 0, 100);
    this.thirst = clamp(r.thirst, 0, 100);
    this.stamina = 100;
    this.exhaustT = 0;
    this.dead = r.died;
  }

  /** Eat food: returns true if applied. */
  eat(hunger: number, thirst: number): void {
    this.hunger = clamp(this.hunger + hunger, 0, 100);
    this.thirst = clamp(this.thirst + thirst, 0, 100);
  }

  drink(amount: number): void {
    this.thirst = clamp(this.thirst + amount, 0, 100);
  }

  respawn(): void {
    this.dead = false;
    this.health = 100;
    this.hunger = 70;
    this.thirst = 70;
    this.stamina = 100;
    this.temperature = 18;
    this.exhaustT = 0;
  }

  snapshot(): StatSnapshot {
    return {
      health: this.health,
      hunger: this.hunger,
      thirst: this.thirst,
      stamina: this.stamina,
      exhausted: this.exhausted,
      temperature: this.temperature,
      dead: this.dead,
    };
  }

  restore(s: StatSnapshot): void {
    this.health = s.health;
    this.hunger = s.hunger;
    this.thirst = s.thirst;
    this.stamina = s.stamina;
    this.temperature = s.temperature;
    this.dead = s.dead;
    // Pre-exhaustion saves predate the flag; treat missing as not exhausted.
    this.exhaustT = s.exhausted ? SurvivalStats.RATES.exhaustSeconds : 0;
  }
}
