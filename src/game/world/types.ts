/** Shared world types used across systems. */
export interface TerrainHandle {
  mesh: import('@babylonjs/core').GroundMesh;
  material: import('@babylonjs/core').ShaderMaterial;
}

/** Circular collision volume (trees, rocks, walls, fire...). */
export interface Collider {
  x: number;
  z: number;
  radius: number;
}

/** A gatherable world object tracked by the world state. */
export interface ResourceNode {
  id: string;
  kind: 'tree' | 'pine' | 'rock' | 'bush';
  x: number;
  y: number;
  z: number;
  /** Remaining harvests before the node is depleted. */
  hp: number;
  maxHp: number;
  /** Interaction sphere radius. */
  radius: number;
}

/** A player-placed building tracked by the world state. */
export interface BuildingData {
  id: string;
  kind: 'campfire' | 'wall' | 'floor' | 'roof' | 'bed';
  x: number;
  z: number;
  y: number;
  rot: number; // 0..1 quarter turns
  ownerId: string;
  /** Fuel seconds left (campfire only). */
  fuel?: number;
}

/** Serializable shared world state (save file + MP snapshot). */
export interface WorldState {
  version: 1;
  seed: number;
  depleted: string[]; // depleted resource node ids
  hp: Record<string, number>; // current hp for partially harvested nodes
  buildings: BuildingData[];
}
