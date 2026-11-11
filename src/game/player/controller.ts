import { Vector3 } from '@babylonjs/core';
import type { InputController } from '../input';
import { clamp } from '../core/noise';
import { SEA_LEVEL, TERRAIN_SIZE } from '../world/terrain';
import { groundHeight } from './ground';
import type { Collider } from '../world/types';
import type { WallSegment } from '../systems/building';

const WALK_SPEED = 5.2;
const SPRINT_SPEED = 9.2;
const CROUCH_SPEED = 2.2;
const SWIM_SPEED = 3.0;
const JUMP_VELOCITY = 7.4;
const GRAVITY = 22;
/** Sprint speed ramps up over ~0.3 s (believable acceleration, no teleport feel). */
const SPEED_RAMP_UP = 8;
/** Speed drops back to walk speed faster than it ramps up. */
const SPEED_RAMP_DOWN = 16;
const PLAYER_RADIUS = 0.42;
/** Steeper uphill slopes than this (rise/run) cannot be climbed. */
const MAX_SLOPE = 1.15;
/**
 * Feet within this height of the ground still count as grounded, so tiny
 * per-frame numerical dips do not flicker the airborne state.
 */
const GROUND_EPS = 0.02;

export interface PlayerState {
  pos: Vector3; // feet position
  vel: Vector3;
  onGround: boolean;
  inWater: boolean;
  crouching: boolean;
  /** Horizontal speed in m/s (for animation + HUD). */
  speed: number;
  /** Movement direction in radians, NaN when idle. */
  moveDir: number;
  sprinting: boolean;
}

/**
 * A landing after a real airborne fall, reported once by the controller.
 * Distance is the peak-to-landing vertical drop (world units) — for a
 * jump this is the jump arc (~1.24 m), for a cliff the full drop.
 */
export interface LandingImpact {
  /** Vertical drop from the fall peak to the landing spot (world units). */
  distance: number;
  /** True when the player was crouching at the moment of impact. */
  crouching: boolean;
  /** Landing height (feet, world units). */
  y: number;
}

/**
 * Player physics: gravity, jumping, crouch, swimming, terrain stickiness
 * and circular collider push-out. Pure simulation — no rendering.
 */
export class PlayerController {
  pos: Vector3;
  vel = new Vector3(0, 0, 0);
  onGround = true;
  inWater = false;
  crouching = false;
  /**
   * True only this frame when the player is ACTUALLY moving at sprint
   * speed (Shift held, movement requested, canSprint gate passed, not in
   * water or crouched). The survival system uses this for stamina and
   * calorie drain, so holding Shift while blocked never drains stamina.
   */
  sprinting = false;
  speed = 0;
  moveDir = 0;
  private radius = PLAYER_RADIUS;
  /** Ramped horizontal speed (m/s) — approaches the mode's target speed. */
  private curSpeed = 0;

  /**
   * The most recent landing impact, consumed ONCE by the game shell via
   * `consumeImpact()` (fall damage + landing animation). Null when there
   * is nothing pending or it was already consumed.
   */
  impact: LandingImpact | null = null;
  /** Peak feet height since the current airborne phase began (world units). */
  private peakY = 0;
  /** True while the body is in free fall (neither grounded nor in water). */
  private airborne = false;

  constructor(start: { x: number; y: number; z: number }) {
    this.pos = new Vector3(start.x, start.y, start.z);
    this.peakY = start.y;
  }

  /** Take an unconsumed impact away (null when none is pending). */
  consumeImpact(): LandingImpact | null {
    const i = this.impact;
    this.impact = null;
    return i;
  }

  respawn(x: number, y: number, z: number): void {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.curSpeed = 0;
    this.sprinting = false;
    this.peakY = y;
    this.airborne = false;
    this.impact = null;
  }

  /**
   * Simulate one step.
   * @param canSprint gate (stamina > 0) — sprinting drains stamina elsewhere.
   */
  update(
    dt: number,
    input: InputController,
    yaw: number,
    colliders: Collider[],
    canSprint: boolean,
    walls: WallSegment[] = [],
    /**
     * When false the player cannot move or jump (used while a timed
     * craft is in progress). Vertical physics (gravity, landing, water
     * buoyancy) keep running, so a player working at a cliff edge still
     * falls if the ground is absent.
     */
    allowMove = true,
  ): void {
    const forward = allowMove ? input.forward : 0;
    const strafe = allowMove ? input.strafe : 0;

    // Crouch toggle handled by key edge in the game shell; state here.
    const moving = forward !== 0 || strafe !== 0;
    const wantSprint = input.sprint && canSprint && moving && !this.inWater && !this.crouching;
    this.sprinting = wantSprint;

    // Water check based on the rendered ground under the player.
    const groundH = groundHeight(this.pos.x, this.pos.z);
    this.inWater = groundH < SEA_LEVEL - 0.35 && this.pos.y < SEA_LEVEL + 0.4;

    const startX = this.pos.x;
    const startZ = this.pos.z;

    let speed: number;
    if (this.inWater) speed = SWIM_SPEED;
    else if (this.crouching) speed = CROUCH_SPEED;
    else if (wantSprint) speed = SPRINT_SPEED;
    else speed = WALK_SPEED;

    // Camera-relative movement basis.
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    let dx = -sin * forward + cos * strafe;
    let dz = -cos * forward - sin * strafe;
    const len = Math.hypot(dx, dz);
    if (len > 1e-4) {
      dx /= len;
      dz /= len;
    } else {
      dx = 0;
      dz = 0;
    }

    // Ramp the horizontal speed toward the mode's target so sprinting and
    // crouching accelerate believably instead of switching instantly.
    // Steady-state values equal the constants above, so gameplay balance
    // is unchanged; only the transition is smoothed.
    const targetSpeed = moving ? speed : 0;
    const ramp = targetSpeed > this.curSpeed ? SPEED_RAMP_UP : SPEED_RAMP_DOWN;
    this.curSpeed += (targetSpeed - this.curSpeed) * Math.min(1, dt * ramp);
    if (Math.abs(this.curSpeed - targetSpeed) < 1e-3) this.curSpeed = targetSpeed;

    const nx = this.pos.x + dx * this.curSpeed * dt;
    const nz = this.pos.z + dz * this.curSpeed * dt;

    // Island bounds.
    const half = TERRAIN_SIZE / 2 - 2;
    const cx = clamp(nx, -half, half);
    const cz = clamp(nz, -half, half);

    // Slope gate: refuse to step up a wall.
    const targetH = groundHeight(cx, cz);
    const stepHyp = Math.hypot(cx - this.pos.x, cz - this.pos.z);
    if (this.onGround && stepHyp > 1e-4 && (targetH - this.pos.y) / stepHyp > MAX_SLOPE) {
      // Blocked by a steep slope: keep x, try sliding in z only, then x only.
      const zH = groundHeight(this.pos.x, cz);
      if ((zH - this.pos.y) / Math.max(1e-4, Math.abs(cz - this.pos.z)) <= MAX_SLOPE) {
        this.pos.z = cz;
      } else {
        const xH = groundHeight(cx, this.pos.z);
        if ((xH - this.pos.y) / Math.max(1e-4, Math.abs(cx - this.pos.x)) <= MAX_SLOPE) {
          this.pos.x = cx;
        }
      }
    } else {
      this.pos.x = cx;
      this.pos.z = cz;
    }

    // Collider push-out (trees, rocks, buildings).
    for (const c of colliders) {
      const ddx = this.pos.x - c.x;
      const ddz = this.pos.z - c.z;
      const dist = Math.hypot(ddx, ddz);
      const minDist = c.radius + this.radius;
      if (dist < minDist && dist > 1e-4) {
        this.pos.x = c.x + (ddx / dist) * minDist;
        this.pos.z = c.z + (ddz / dist) * minDist;
      }
    }

    // Wall collision: push the player circle out of wall AABBs.
    for (const w of walls) {
      const px = clamp(this.pos.x, w.minX, w.maxX);
      const pz = clamp(this.pos.z, w.minZ, w.maxZ);
      const ddx = this.pos.x - px;
      const ddz = this.pos.z - pz;
      const dist = Math.hypot(ddx, ddz);
      if (dist < this.radius) {
        if (dist > 1e-4) {
          this.pos.x = px + (ddx / dist) * this.radius;
          this.pos.z = pz + (ddz / dist) * this.radius;
        } else {
          // Center inside the wall: push out along the thinnest axis.
          const pushX = Math.min(this.pos.x - w.minX, w.maxX - this.pos.x);
          const pushZ = Math.min(this.pos.z - w.minZ, w.maxZ - this.pos.z);
          const centerX = (w.minX + w.maxX) / 2;
          const centerZ = (w.minZ + w.maxZ) / 2;
          if (pushX < pushZ) this.pos.x = this.pos.x < centerX ? w.minX - this.radius : w.maxX + this.radius;
          else this.pos.z = this.pos.z < centerZ ? w.minZ - this.radius : w.maxZ + this.radius;
        }
      }
    }

    // Distance actually covered this frame (after slope gate and
    // colliders) — used to tell "walking down the surface" from "airborne".
    const moved = Math.hypot(this.pos.x - startX, this.pos.z - startZ);

    // Vertical physics.
    const jump = allowMove && input.jumpHeld;
    if (this.inWater) {
      // Buoyant swimming.
      const swimUp = jump && this.pos.y < SEA_LEVEL + 0.2;
      this.vel.y += (swimUp ? 14 : -5) * dt;
      this.vel.y *= Math.pow(0.02, dt); // water drag
      if (this.pos.y > SEA_LEVEL + 0.6) this.vel.y = Math.min(this.vel.y, 0);
    } else if (jump && this.onGround) {
      this.vel.y = JUMP_VELOCITY;
      this.onGround = false;
    } else {
      this.vel.y -= GRAVITY * dt;
    }

    this.pos.y += this.vel.y * dt;

    // Ground contact against the RENDERED surface (mesh-exact).
    const gY = groundHeight(this.pos.x, this.pos.z);
    if (this.inWater) {
      this.onGround = this.pos.y <= SEA_LEVEL + 0.3 && this.vel.y <= 0;
      if (this.pos.y < gY) this.pos.y = gY;
      if (this.pos.y > SEA_LEVEL + 0.9) {
        this.pos.y = SEA_LEVEL + 0.9;
        this.vel.y = Math.min(this.vel.y, 0);
      }
    } else if (this.pos.y <= gY + GROUND_EPS && this.vel.y <= 0) {
      // Standing, landing or walking up: snap exactly onto the visible
      // ground so the player can never sink into the terrain mesh.
      // A landing after a genuine airborne fall is reported once for
      // fall damage + the landing animation (water landings never get
      // here — the inWater branch above absorbs the fall).
      if (this.airborne && this.peakY - gY > 0.1) {
        this.impact = { distance: this.peakY - gY, crouching: this.crouching, y: gY };
        this.airborne = false;
      }
      this.pos.y = gY;
      this.vel.y = 0;
      this.onGround = true;
    } else if (this.onGround && this.pos.y - gY <= moved * MAX_SLOPE + 0.01) {
      // Walking DOWN a slope: the surface drops faster than gravity can
      // follow. Stick to the ground instead of floating, bouncing or
      // flickering the airborne state. A real ledge drop (larger than the
      // climbable-slope allowance for this step) falls through to the
      // airborne branch below.
      this.pos.y = gY;
      this.vel.y = Math.min(this.vel.y, 0);
    } else if (this.pos.y > gY + GROUND_EPS) {
      // Airborne: jump in flight or walked off a ledge.
      this.onGround = false;
    }

    // Fall tracking (peak height of the airborne phase). While grounded
    // the peak resets to the feet each frame, so a ledge drop is always
    // measured from the ledge the player left — never from a previous
    // high point further uphill.
    if (this.inWater || this.onGround) {
      this.airborne = false;
      this.peakY = this.pos.y;
    } else {
      this.airborne = true;
      this.peakY = Math.max(this.peakY, this.pos.y);
    }

    this.speed = this.curSpeed;
    if (dx !== 0 || dz !== 0) this.moveDir = Math.atan2(dx, dz);
  }
}
