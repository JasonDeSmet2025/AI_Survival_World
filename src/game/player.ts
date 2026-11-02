import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';
import type { Collider } from './flora';
import { InputController } from './input';
import { TERRAIN_SIZE, terrainHeight } from './terrain';

const PLAYER_RADIUS = 0.45;
const WALK_SPEED = 7;
const SPRINT_SPEED = 12;
const PLAYER_HEIGHT = 1.8;

/**
 * Third-person player placeholder (capsule body + visor marker).
 * Movement is WASD/arrow keys relative to the camera yaw; the player is
 * kept on the terrain surface and pushed out of circular colliders.
 */
export class Player {
  readonly mesh: Mesh;
  private colliders: Collider[];

  constructor(scene: Scene, colliders: Collider[], start: { x: number; z: number }) {
    this.colliders = colliders;

    const body = MeshBuilder.CreateCapsule(
      'player',
      { radius: 0.45, height: PLAYER_HEIGHT },
      scene,
    );
    const mat = new StandardMaterial('playerMat', scene);
    mat.diffuseColor = new Color3(0.15, 0.35, 0.75);
    mat.specularColor = new Color3(0.2, 0.2, 0.25);
    body.material = mat;

    // Small visor so the player's facing direction is visible.
    const visor = MeshBuilder.CreateBox('playerVisor', { width: 0.42, height: 0.12, depth: 0.1 }, scene);
    const visorMat = new StandardMaterial('playerVisorMat', scene);
    visorMat.diffuseColor = new Color3(0.95, 0.9, 0.4);
    visor.material = visorMat;
    visor.parent = body;
    visor.position.set(0, 0.45, -0.42); // forward is -Z on the capsule

    this.mesh = body;
    this.mesh.position.set(start.x, terrainHeight(start.x, start.z) + PLAYER_HEIGHT / 2, start.z);
  }

  get position(): Vector3 {
    return this.mesh.position;
  }

  /** Advances the player by dt seconds based on current input and camera yaw. */
  update(dt: number, input: InputController, yaw: number): void {
    const forward = input.forward;
    const strafe = input.strafe;
    if (forward === 0 && strafe === 0) return;

    // Camera-relative unit directions (camera forward = -Z when yaw is 0).
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const fx = -sin;
    const fz = -cos; // forward
    const rx = cos;
    const rz = -sin; // right

    let dx = fx * forward + rx * strafe;
    let dz = fz * forward + rz * strafe;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;

    const speed = input.sprint ? SPRINT_SPEED : WALK_SPEED;
    const pos = this.mesh.position;
    let nx = pos.x + dx * speed * dt;
    let nz = pos.z + dz * speed * dt;

    // Keep the player on the island.
    const half = TERRAIN_SIZE / 2 - 2;
    nx = Math.max(-half, Math.min(half, nx));
    nz = Math.max(-half, Math.min(half, nz));

    // Push out of tree/rock/bush colliders.
    for (const c of this.colliders) {
      const ddx = nx - c.x;
      const ddz = nz - c.z;
      const dist = Math.hypot(ddx, ddz);
      const minDist = c.radius + PLAYER_RADIUS;
      if (dist < minDist && dist > 1e-4) {
        nx = c.x + (ddx / dist) * minDist;
        nz = c.z + (ddz / dist) * minDist;
      }
    }

    pos.x = nx;
    pos.z = nz;
    // Terrain collision: stick to the ground surface.
    pos.y = terrainHeight(nx, nz) + PLAYER_HEIGHT / 2;

    // Face the movement direction.
    this.mesh.rotation.y = Math.atan2(dx, dz);
  }
}
