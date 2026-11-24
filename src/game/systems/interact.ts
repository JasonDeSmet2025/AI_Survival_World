/**
 * Interaction picking: raycasts from the camera against interactable
 * targets (resource nodes, NPCs, buildings, water). Pure math.
 *
 * Performance: this runs EVERY frame against ~2400 resource-node targets
 * plus NPCs and buildings. The implementation is therefore allocation-
 * free per target (scalar math instead of Vector3 temporaries) and only
 * allocates the result Vector3 for the single winning target. Semantics
 * are unchanged and pinned by interact.test.ts against a reference
 * vector implementation.
 */
import { Vector3 } from '@babylonjs/core';

export type InteractTarget =
  | { kind: 'node'; id: string; x: number; y: number; z: number; radius: number }
  | { kind: 'npc'; id: string; x: number; y: number; z: number; radius: number }
  | { kind: 'campfire'; id: string; x: number; y: number; z: number; radius: number }
  | { kind: 'bed'; id: string; x: number; y: number; z: number; radius: number }
  /** A huntable herd animal (see systems/fauna.ts + ai/animals.ts). */
  | { kind: 'animal'; id: string; x: number; y: number; z: number; radius: number }
  /** A placed door — E swings it open or shut. */
  | { kind: 'door'; id: string; x: number; y: number; z: number; radius: number }
  /** A placed planter — E picks the ripe crop (see systems/farm.ts). */
  | { kind: 'planter'; id: string; x: number; y: number; z: number; radius: number }
  /**
   * The player's OWN tekentafel (workbench) — E opens the station menu, the
   * place where every non-field recipe can be made (systems/crafting.ts).
   */
  | { kind: 'workbench'; id: string; x: number; y: number; z: number; radius: number }
  | { kind: 'witch'; x: number; y: number; z: number; radius: number }
  /** A loot chest in a world landmark (systems/chests.ts + world/volcano.ts). */
  | { kind: 'chest'; id: string; x: number; y: number; z: number; radius: number }
  /** A hostile den spider — the sword answers it (ai/spiders.ts). */
  | { kind: 'spider'; id: string; x: number; y: number; z: number; radius: number }
  | { kind: 'player'; id: string; x: number; y: number; z: number; radius: number }
  | { kind: 'water'; x: number; y: number; z: number; radius: number };

export interface TargetPick {
  target: InteractTarget;
  point: Vector3;
  distance: number;
}

/**
 * Finds the closest target whose sphere the ray hits, with the hit
 * distance clamped to `maxRange`. `dir` is assumed normalized (camera
 * forward rays are). A target whose sphere entry point is behind the
 * origin (camera inside the sphere) is skipped, matching the original
 * behaviour.
 */
export function raycastTarget(
  origin: Vector3,
  dir: Vector3,
  targets: InteractTarget[],
  maxRange = 6,
): TargetPick | null {
  const ox = origin.x;
  const oy = origin.y;
  const oz = origin.z;
  const dx = dir.x;
  const dy = dir.y;
  const dz = dir.z;

  let best: InteractTarget | null = null;
  let bestDist = 0;
  let bestX = 0;
  let bestY = 0;
  let bestZ = 0;

  for (const t of targets) {
    const sx = t.x - ox;
    const sy = t.y - oy;
    const sz = t.z - oz;
    const tca = sx * dx + sy * dy + sz * dz;
    if (tca < 0) continue;
    const r = t.radius;
    const d2 = sx * sx + sy * sy + sz * sz - tca * tca;
    const r2 = r * r;
    if (d2 > r2) continue;
    const t1 = tca - Math.sqrt(r2 - d2);
    if (t1 < 0) continue;
    const dist = t1 < maxRange ? t1 : maxRange;
    if (best === null || dist < bestDist) {
      best = t;
      bestDist = dist;
      bestX = ox + dx * dist;
      bestY = oy + dy * dist;
      bestZ = oz + dz * dist;
    }
  }

  if (best === null) return null;
  return { target: best, point: new Vector3(bestX, bestY, bestZ), distance: bestDist };
}
