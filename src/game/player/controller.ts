import { Vector3 } from '@babylonjs/core';
import type { InputController } from '../input';
import { clamp } from '../core/noise';
import { SEA_LEVEL, TERRAIN_SIZE, terrainHeight } from '../world/terrain';
import type { Collider } from '../world/types';
import type { WallSegment } from '../systems/building';

const WALK_SPEED = 5.2;
const SPRINT_SPEED = 9.2;
const CROUCH_SPEED = 2.2;
const SWIM_SPEED = 3.0;
const JUMP_VELOCITY = 7.4;
const GRAVITY = 22;
const PLAYER_RADIUS = 0.42;
/** Steeper uphill slopes than this (rise/run) cannot be climbed. */
const MAX_SLOPE = 1.15;

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
 * Player physics: gravity, jumping, crouch, swimming, terrain stickiness
 * and circular collider push-out. Pure simulation — no rendering.
 */
export class PlayerController {
  pos: Vector3;
  vel = new Vector3(0, 0, 0);
  onGround = true;
  inWater = false;
  crouching = false;
  speed = 0;
  moveDir = 0;
  private radius = PLAYER_RADIUS;

  constructor(start: { x: number; y: number; z: number }) {
    this.pos = new Vector3(start.x, start.y, start.z);
  }

  respawn(x: number, y: number, z: number): void {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
  }

  /**
   * Simulate one step.
   * @param canSprint gate (stamina > 0) — sprinting drains stamina elsewhere.
   */
  update(dt: number, input: InputController, yaw: number, colliders: Collider[], canSprint: boolean, walls: WallSegment[] = []): void {
    const forward = input.forward;
    const strafe = input.strafe;

    // Crouch toggle handled by key edge in the game shell; state here.
    const wantSprint = input.sprint && canSprint && (forward !== 0 || strafe !== 0);

    // Water check based on terrain under the player.
    const groundH = terrainHeight(this.pos.x, this.pos.z);
    this.inWater = groundH < SEA_LEVEL - 0.35 && this.pos.y < SEA_LEVEL + 0.4;

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

    const nx = this.pos.x + dx * speed * dt;
    const nz = this.pos.z + dz * speed * dt;

    // Island bounds.
    const half = TERRAIN_SIZE / 2 - 2;
    const cx = clamp(nx, -half, half);
    const cz = clamp(nz, -half, half);

    // Slope gate: refuse to step up a wall.
    const targetH = terrainHeight(cx, cz);
    const stepHyp = Math.hypot(cx - this.pos.x, cz - this.pos.z);
    if (this.onGround && stepHyp > 1e-4 && (targetH - this.pos.y) / stepHyp > MAX_SLOPE) {
      // Blocked by a steep slope: keep x, try sliding in z only, then x only.
      const zH = terrainHeight(this.pos.x, cz);
      if ((zH - this.pos.y) / Math.max(1e-4, Math.abs(cz - this.pos.z)) <= MAX_SLOPE) {
        this.pos.z = cz;
      } else {
        const xH = terrainHeight(cx, this.pos.z);
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

    // Vertical physics.
    if (this.inWater) {
      // Buoyant swimming.
      const swimUp = input.jumpHeld && this.pos.y < SEA_LEVEL + 0.2;
      this.vel.y += (swimUp ? 14 : -5) * dt;
      this.vel.y *= Math.pow(0.02, dt); // water drag
      if (this.pos.y > SEA_LEVEL + 0.6) this.vel.y = Math.min(this.vel.y, 0);
    } else if (input.jumpHeld && this.onGround) {
      this.vel.y = JUMP_VELOCITY;
      this.onGround = false;
    } else {
      this.vel.y -= GRAVITY * dt;
    }

    this.pos.y += this.vel.y * dt;

    const gY = terrainHeight(this.pos.x, this.pos.z);
    if (!this.inWater && this.pos.y <= gY && this.vel.y <= 0) {
      this.pos.y = gY;
      this.vel.y = 0;
      this.onGround = true;
    } else if (this.inWater) {
      this.onGround = this.pos.y <= SEA_LEVEL + 0.3 && this.vel.y <= 0;
      if (this.pos.y < gY) this.pos.y = gY;
      if (this.pos.y > SEA_LEVEL + 0.9) {
        this.pos.y = SEA_LEVEL + 0.9;
        this.vel.y = Math.min(this.vel.y, 0);
      }
    }

    this.speed = Math.hypot(dx, dz) * speed;
    if (dx !== 0 || dz !== 0) this.moveDir = Math.atan2(dx, dz);
  }
}
