import { describe, expect, it } from 'vitest';
import { SharedWorldState } from './worldState';
import type { BuildingData, ResourceNode, WorldState } from './types';

const mkNode = (id: string, maxHp = 3, kind: ResourceNode['kind'] = 'tree'): ResourceNode => ({
  id,
  kind,
  x: 1,
  y: 2,
  z: 3,
  hp: maxHp,
  maxHp,
  radius: 1,
});

const mkBuilding = (id: string, kind: BuildingData['kind'] = 'campfire', x = 0, z = 0): BuildingData => ({
  id,
  kind,
  x,
  z,
  y: 0,
  rot: 0,
  ownerId: 'p1',
});

/** The id-index maps must never drift from the public arrays. */
function expectIndexConsistent(state: SharedWorldState) {
  for (const n of state.nodes) expect(state.node(n.id)).toBeDefined();
  for (const b of state.buildings) expect(state.building(b.id)).toBeDefined();
}

describe('SharedWorldState nodes', () => {
  it('registers nodes and initializes hp to maxHp', () => {
    const s = new SharedWorldState();
    const n = mkNode('n_tree_1', 3);
    s.registerNode(n);
    expect(s.node('n_tree_1')).toBe(n); // same object reference
    expect(s.hp['n_tree_1']).toBe(3);
    expectIndexConsistent(s);
  });

  it('keeps first-registration-wins semantics for duplicate ids (old find() behaviour)', () => {
    const s = new SharedWorldState();
    const first = mkNode('dup', 3);
    const second = mkNode('dup', 5);
    s.registerNode(first);
    s.registerNode(second);
    expect(s.node('dup')).toBe(first);
    expect(s.nodes.length).toBe(2);
    expectIndexConsistent(s);
  });

  it('damageNode decrements hp, depletes at zero and ignores unknown ids', () => {
    const s = new SharedWorldState();
    s.registerNode(mkNode('n_rock_1', 2, 'rock'));
    expect(s.damageNode('n_rock_1', 1)).toBe(1);
    expect(s.isDepleted('n_rock_1')).toBe(false);
    expect(s.damageNode('n_rock_1', 1)).toBe(0);
    expect(s.isDepleted('n_rock_1')).toBe(true);
    expect(s.damageNode('nope', 1)).toBe(0);
    expectIndexConsistent(s);
  });

  it('resolves every node id of a full-scale world (2000+ nodes)', () => {
    const s = new SharedWorldState();
    const kinds: ResourceNode['kind'][] = ['tree', 'pine', 'rock', 'bush'];
    for (let i = 0; i < 2397; i++) s.registerNode(mkNode(`n_${kinds[i % 4]}_${i}`, 3, kinds[i % 4]));
    for (let i = 0; i < 2397; i++) expect(s.node(`n_${kinds[i % 4]}_${i}`)).toBeDefined();
    expect(s.node('n_tree_99999')).toBeUndefined();
  });
});

describe('SharedWorldState buildings', () => {
  it('adds buildings once per id and indexes them', () => {
    const s = new SharedWorldState();
    const b = mkBuilding('b1');
    s.addBuilding(b);
    s.addBuilding(mkBuilding('b1', 'wall')); // duplicate id ignored
    expect(s.buildings.length).toBe(1);
    expect(s.building('b1')).toBe(b);
    expectIndexConsistent(s);
  });

  it('removes buildings and drops them from the index', () => {
    const s = new SharedWorldState();
    s.addBuilding(mkBuilding('b1'));
    s.addBuilding(mkBuilding('b2', 'wall', 5, 5));
    expect(s.removeBuilding('b1')).toBe(true);
    expect(s.removeBuilding('b1')).toBe(false);
    expect(s.building('b1')).toBeUndefined();
    expect(s.building('b2')).toBeDefined();
    expectIndexConsistent(s);
  });

  it('buildingAtKind matches kind and distance', () => {
    const s = new SharedWorldState();
    const fire = mkBuilding('c1', 'campfire', 2, 2);
    s.addBuilding(fire);
    s.addBuilding(mkBuilding('c2', 'campfire', 50, 50));
    s.addBuilding(mkBuilding('w1', 'wall', 1, 1));
    expect(s.buildingAtKind('campfire', 0, 0, 5)).toBe(fire);
    expect(s.buildingAtKind('campfire', 0, 0, 1)).toBeUndefined();
    expect(s.buildingAtKind('bed', 0, 0, 100)).toBeUndefined();
  });
});

describe('SharedWorldState serialization', () => {
  it('serialize() deep-copies buildings and hp', () => {
    const s = new SharedWorldState();
    s.registerNode(mkNode('n_tree_1', 3));
    s.addBuilding(mkBuilding('b1'));
    s.damageNode('n_tree_1', 1);
    const out = s.serialize();
    out.buildings[0].x = 999;
    out.hp['n_tree_1'] = 999;
    expect(s.building('b1')!.x).not.toBe(999);
    expect(s.hp['n_tree_1']).toBe(2);
  });

  it('apply() restores depleted/hp/buildings and rebuilds the building index', () => {
    const s = new SharedWorldState();
    s.registerNode(mkNode('n_bush_1', 2, 'bush'));
    s.registerNode(mkNode('n_tree_1', 3));
    const saved: WorldState = {
      version: 1,
      seed: 7,
      depleted: ['n_bush_1'],
      hp: { n_bush_1: 0, n_tree_1: 1 },
      buildings: [mkBuilding('b1'), mkBuilding('b2', 'bed', 3, 4)],
    };
    s.apply(saved, 7);
    expect(s.isDepleted('n_bush_1')).toBe(true);
    expect(s.hp['n_tree_1']).toBe(1);
    expect(s.building('b1')).toBeDefined();
    expect(s.building('b2')!.kind).toBe('bed');
    // Nodes registered after apply() still get default hp and stay resolvable.
    s.registerNode(mkNode('n_rock_1', 2, 'rock'));
    expect(s.hp['n_rock_1']).toBe(2);
    expectIndexConsistent(s);
  });

  it('apply() fills missing hp from maxHp for already-registered nodes', () => {
    const s = new SharedWorldState();
    s.registerNode(mkNode('n_pine_1', 3, 'pine'));
    s.apply({ version: 1, seed: 0, depleted: [], hp: {}, buildings: [] });
    expect(s.hp['n_pine_1']).toBe(3);
    expectIndexConsistent(s);
  });

  it('round-trips through serialize/apply with the index intact', () => {
    const s = new SharedWorldState();
    for (let i = 0; i < 20; i++) s.registerNode(mkNode(`n_tree_${i}`, 3));
    for (let i = 0; i < 5; i++) s.addBuilding(mkBuilding(`b${i}`, 'wall', i, i));
    s.damageNode('n_tree_3', 3);
    const t = new SharedWorldState();
    for (let i = 0; i < 20; i++) t.registerNode(mkNode(`n_tree_${i}`, 3));
    t.apply(s.serialize(), 42);
    expect(t.isDepleted('n_tree_3')).toBe(true);
    expect(t.hp['n_tree_5']).toBe(3);
    expect(t.buildings.length).toBe(5);
    expect(t.building('b4')!.x).toBe(4);
    expectIndexConsistent(t);
  });
});

describe('SharedWorldState.setNodeHp (server-authoritative sync)', () => {
  it('applies hp absolutely and is idempotent under replay', () => {
    const s = new SharedWorldState();
    s.registerNode(mkNode('n_tree_1', 3));
    expect(s.setNodeHp('n_tree_1', 2)).toBe(2);
    // Replaying the same server message (the initiator also receives the
    // broadcast) must NOT damage the node a second time.
    expect(s.setNodeHp('n_tree_1', 2)).toBe(2);
    expect(s.hp['n_tree_1']).toBe(2);
    expect(s.isDepleted('n_tree_1')).toBe(false);
  });

  it('depletes at 0 and un-depletes on regrow', () => {
    const s = new SharedWorldState();
    s.registerNode(mkNode('n_bush_1', 2, 'bush'));
    s.setNodeHp('n_bush_1', 0);
    expect(s.isDepleted('n_bush_1')).toBe(true);
    // A stale regrow arriving twice restores the same absolute value.
    s.setNodeHp('n_bush_1', 2);
    expect(s.isDepleted('n_bush_1')).toBe(false);
    expect(s.hp['n_bush_1']).toBe(2);
    s.setNodeHp('n_bush_1', 2);
    expect(s.hp['n_bush_1']).toBe(2);
  });

  it('clamps garbage input into [0, maxHp] and ignores unknown nodes', () => {
    const s = new SharedWorldState();
    s.registerNode(mkNode('n_rock_1', 2, 'rock'));
    expect(s.setNodeHp('n_rock_1', 999)).toBe(2); // never above maxHp
    expect(s.setNodeHp('n_rock_1', -5)).toBe(0);
    expect(s.setNodeHp('n_rock_1', NaN)).toBe(0);
    expect(s.setNodeHp('n_rock_1', 1.7)).toBe(1); // integer hp only
    expect(s.setNodeHp('n_missing_1', 5)).toBe(0);
    expect(s.hp['n_missing_1']).toBeUndefined();
    expectIndexConsistent(s);
  });
});
