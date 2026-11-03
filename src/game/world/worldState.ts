import type { BuildingData, ResourceNode, WorldState } from './types';

/**
 * Shared, serializable world state. Pure logic (no Babylon) so it is
 * unit-testable and usable by both the save system and the MP server.
 */
export class SharedWorldState {
  nodes: ResourceNode[] = [];
  buildings: BuildingData[] = [];
  depleted: Set<string> = new Set();
  hp: Record<string, number> = {};

  /** Registers gatherable nodes (called by flora generation). */
  registerNode(node: ResourceNode): void {
    this.nodes.push(node);
    if (!(node.id in this.hp)) this.hp[node.id] = node.maxHp;
  }

  node(id: string): ResourceNode | undefined {
    return this.nodes.find((n) => n.id === id);
  }

  /** Returns remaining hp after damage, or 0 when depleted/unknown. */
  damageNode(id: string, amount: number): number {
    const node = this.node(id);
    if (!node) return 0;
    this.hp[id] = Math.max(0, (this.hp[id] ?? node.maxHp) - amount);
    if (this.hp[id] <= 0) this.depleted.add(id);
    return this.hp[id];
  }

  isDepleted(id: string): boolean {
    return this.depleted.has(id);
  }

  addBuilding(b: BuildingData): void {
    if (this.buildings.some((x) => x.id === b.id)) return;
    this.buildings.push(b);
  }

  removeBuilding(id: string): boolean {
    const i = this.buildings.findIndex((b) => b.id === id);
    if (i < 0) return false;
    this.buildings.splice(i, 1);
    return true;
  }

  buildingAtKind(kind: BuildingData['kind'], x: number, z: number, maxDist: number): BuildingData | undefined {
    return this.buildings.find(
      (b) => b.kind === kind && Math.hypot(b.x - x, b.z - z) <= maxDist,
    );
  }

  serialize(): WorldState {
    return {
      version: 1,
      seed: 0,
      depleted: [...this.depleted],
      hp: { ...this.hp },
      buildings: this.buildings.map((b) => ({ ...b })),
    };
  }

  /** Applies a serialized state (save file or MP server snapshot). */
  apply(state: WorldState, seed?: number): void {
    if (seed !== undefined) state.seed = seed;
    this.depleted = new Set(state.depleted);
    this.hp = { ...state.hp };
    for (const n of this.nodes) {
      if (!(n.id in this.hp)) this.hp[n.id] = n.maxHp;
    }
    this.buildings = state.buildings.map((b) => ({ ...b }));
  }
}
