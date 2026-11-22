import type { BuildingData, ResourceNode, WorldState } from './types';

/**
 * Shared, serializable world state. Pure logic (no Babylon) so it is
 * unit-testable and usable by both the save system and the MP server.
 *
 * Lookup performance: the `nodes`/`buildings` arrays are the source of
 * truth (stable order, iteration-friendly, serialized as-is), while
 * private id-index maps give O(1) `node(id)`/`building(id)` lookups.
 * The world has ~2400 harvestable nodes and several of them are resolved
 * every frame (gathering, prompts, MP harvest messages), so a linear
 * `Array.find` per lookup was measurable on the frame budget.
 *
 * Invariant: after every mutation the id maps contain exactly one entry
 * per id (the FIRST registration wins, matching the previous
 * `find`-semantics) and every mapped object is present in its array.
 */
export class SharedWorldState {
  nodes: ResourceNode[] = [];
  buildings: BuildingData[] = [];
  depleted: Set<string> = new Set();
  hp: Record<string, number> = {};

  private nodeIndex: Map<string, ResourceNode> = new Map();
  private buildingIndex: Map<string, BuildingData> = new Map();

  /** Registers gatherable nodes (called by flora generation). */
  registerNode(node: ResourceNode): void {
    this.nodes.push(node);
    // Duplicate ids keep the first registration (previous find() semantics).
    if (!this.nodeIndex.has(node.id)) this.nodeIndex.set(node.id, node);
    if (!(node.id in this.hp)) this.hp[node.id] = node.maxHp;
  }

  node(id: string): ResourceNode | undefined {
    return this.nodeIndex.get(id);
  }

  /** Returns remaining hp after damage, or 0 when depleted/unknown. */
  damageNode(id: string, amount: number): number {
    const node = this.nodeIndex.get(id);
    if (!node) return 0;
    this.hp[id] = Math.max(0, (this.hp[id] ?? node.maxHp) - amount);
    if (this.hp[id] <= 0) this.depleted.add(id);
    return this.hp[id];
  }

  /**
   * Sets a node's hp to an ABSOLUTE value (server-authoritative sync).
   * Unlike damageNode this is idempotent: replaying the same value (or
   * receiving it twice — e.g. the initiator of a harvest also seeing the
   * broadcast) cannot drift the world. Also un-depletes on regrow.
   * Returns the applied hp (0 for unknown nodes).
   */
  setNodeHp(id: string, hp: number): number {
    const node = this.nodeIndex.get(id);
    if (!node) return 0;
    const v = Math.max(0, Math.min(node.maxHp, Math.floor(Number(hp)) || 0));
    this.hp[id] = v;
    if (v <= 0) this.depleted.add(id);
    else this.depleted.delete(id);
    return v;
  }

  isDepleted(id: string): boolean {
    return this.depleted.has(id);
  }

  addBuilding(b: BuildingData): void {
    if (this.buildingIndex.has(b.id)) return;
    this.buildings.push(b);
    this.buildingIndex.set(b.id, b);
  }

  removeBuilding(id: string): boolean {
    const i = this.buildings.findIndex((b) => b.id === id);
    if (i < 0) return false;
    this.buildings.splice(i, 1);
    this.buildingIndex.delete(id);
    return true;
  }

  /** O(1) building lookup by id. */
  building(id: string): BuildingData | undefined {
    return this.buildingIndex.get(id);
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
    this.rebuildBuildingIndex();
  }

  /**
   * Rebuilds the building id-index (first id wins, matching addBuilding's
   * duplicate rule). Used after bulk assignments like apply().
   */
  private rebuildBuildingIndex(): void {
    this.buildingIndex.clear();
    for (const b of this.buildings) {
      if (!this.buildingIndex.has(b.id)) this.buildingIndex.set(b.id, b);
    }
  }
}
