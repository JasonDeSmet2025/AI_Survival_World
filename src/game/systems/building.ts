/**
 * Pure building logic (Gameplay scope): placement validation and wall
 * geometry (for collision). No Babylon imports so it can be unit-tested
 * in Node.
 */

export type BuildingKind = 'campfire' | 'wall' | 'floor' | 'roof';

export interface BuildingData {
  id: string;
  kind: BuildingKind;
  x: number;
  z: number;
  y: number;
  /** rotation in quarter turns (0..3) */
  rot: number;
  ownerId: string;
  /** campfire seconds of remaining fuel */
  fuel?: number;
}

export const BUILDING_SIZE: Record<BuildingKind, number> = {
  campfire: 1.6,
  wall: 2.4,
  floor: 2.0,
  roof: 2.4,
};

export interface WallSegment {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
}

export function wallSegment(b: BuildingData): WallSegment {
  const half = BUILDING_SIZE.wall / 2;
  const thick = 0.15; // half wall thickness
  const swapped = b.rot % 2 === 1;
  const dx = swapped ? thick : half;
  const dz = swapped ? half : thick;
  return {
    minX: b.x - dx,
    maxX: b.x + dx,
    minZ: b.z - dz,
    maxZ: b.z + dz,
    height: 2.4,
  };
}

/** Validate a placement; returns null when allowed, else a reason. */
export function validatePlacement(
  kind: BuildingKind,
  x: number,
  z: number,
  y: number,
  existing: BuildingData[],
  playerPos: { x: number; z: number },
  terrainHeightAt: (x: number, z: number) => number,
  seaLevel = 0,
): string | null {
  const groundY = terrainHeightAt(x, z);
  if (Math.abs(groundY - y) > 1.2) return 'not on a valid platform';
  if (groundY < seaLevel - 0.3 && kind !== 'floor') return 'cannot build underwater';
  // no stacking on the same cell (except roof over floor).
  for (const b of existing) {
    if (Math.abs(b.x - x) < 0.5 && Math.abs(b.z - z) < 0.5) {
      if (b.kind === kind) return 'a building already occupies this spot';
      if (kind === 'roof' && b.kind === 'floor') return 'roof needs an open spot';
      if (b.kind === 'floor' && kind !== 'roof') return 'a floor already occupies this spot';
    }
  }
  // campfire must not be placed on top of the player.
  if (kind === 'campfire' && Math.hypot(playerPos.x - x, playerPos.z - z) < 1.2) {
    return 'too close to you';
  }
  return null;
}
