/**
 * Interaction picking: raycasts from the camera against interactable
 * targets (resource nodes, NPCs, buildings, water). Pure math.
 */
import { Vector3 } from '@babylonjs/core';

export type InteractTarget =
  | { kind: 'node'; id: string; x: number; y: number; z: number; radius: number }
  | { kind: 'npc'; id: string; x: number; y: number; z: number; radius: number }
  | { kind: 'campfire'; id: string; x: number; y: number; z: number; radius: number }
  | { kind: 'bed'; id: string; x: number; y: number; z: number; radius: number }
  | { kind: 'water'; x: number; y: number; z: number; radius: number };

export function raycastTarget(
  origin: Vector3,
  dir: Vector3,
  targets: InteractTarget[],
  maxRange = 6,
): { target: InteractTarget; point: Vector3; distance: number } | null {
  let best: { target: InteractTarget; point: Vector3; distance: number } | null = null;
  for (const t of targets) {
    const sphere = new Vector3(t.x, t.y, t.z);
    const toSphere = sphere.subtract(origin);
    const tca = toSphere.dot(dir);
    if (tca < 0) continue;
    const d2 = toSphere.lengthSquared() - tca * tca;
    const r = t.radius;
    if (d2 > r * r) continue;
    const thc = Math.sqrt(r * r - d2);
    const t1 = tca - thc;
    if (t1 < 0) continue;
    const dist = Math.min(t1, maxRange);
    if (!best || dist < best.distance) {
      best = { target: t, point: origin.add(dir.scale(dist)), distance: dist };
    }
  }
  return best;
}
