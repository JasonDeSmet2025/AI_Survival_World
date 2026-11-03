import { describe, expect, it } from 'vitest';
import { Color3, NullEngine, PBRMaterial, Scene } from '@babylonjs/core';
import {
  FLORA_VARIANTS,
  genPlacements,
  forestMask,
  populateFlora,
} from './flora';
import { SharedWorldState } from './worldState';
import type { Collider } from './types';
import { SEA_LEVEL, terrainSlope } from './terrain';
import type { SharedMaterials } from '../visual/materials';

const countBy = (placements: ReturnType<typeof genPlacements>, kind: string) =>
  placements.filter((p) => p.kind === kind).length;

describe('forestMask', () => {
  it('is deterministic and bounded', () => {
    const a = forestMask(12.3, -40.7);
    expect(forestMask(12.3, -40.7)).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
  });
});

describe('genPlacements', () => {
  const placements = genPlacements();

  it('is deterministic for the world seed', () => {
    expect(JSON.stringify(genPlacements())).toBe(JSON.stringify(placements));
  });

  it('produces every flora kind in reasonable numbers', () => {
    const counts = {
      tree: countBy(placements, 'tree'),
      pine: countBy(placements, 'pine'),
      rock: countBy(placements, 'rock'),
      bush: countBy(placements, 'bush'),
      grass: countBy(placements, 'grass'),
      flower: countBy(placements, 'flower'),
      plant: countBy(placements, 'plant'),
    };
    expect(counts.tree).toBeGreaterThan(120);
    expect(counts.tree).toBeLessThan(700);
    expect(counts.pine).toBeGreaterThan(40);
    expect(counts.pine).toBeLessThan(1500);
    expect(counts.rock).toBeGreaterThan(20);
    expect(counts.rock).toBeLessThan(700);
    expect(counts.bush).toBeGreaterThan(40);
    expect(counts.bush).toBeLessThan(500);
    expect(counts.grass).toBeGreaterThan(600);
    expect(counts.flower).toBeGreaterThan(40);
    expect(counts.plant).toBeGreaterThan(100);
  });

  it('is clustered, not uniform (forest mask drives density)', () => {
    // Dense-forest cells should contain far more trees than clearing cells.
    const trees = placements.filter((p) => p.kind === 'tree');
    let dense = 0;
    let clearing = 0;
    let denseCount = 0;
    let clearingCount = 0;
    for (let x = -150; x <= 150; x += 10) {
      for (let z = -150; z <= 150; z += 10) {
        const m = forestMask(x, z);
        const inCell = trees.filter((t) => Math.abs(t.x - x) <= 5 && Math.abs(t.z - z) <= 5).length;
        if (m > 0.65) {
          dense++;
          denseCount += inCell;
        } else if (m < 0.4) {
          clearing++;
          clearingCount += inCell;
        }
      }
    }
    expect(dense).toBeGreaterThan(40);
    expect(clearing).toBeGreaterThan(40);
    const denseAvg = denseCount / dense;
    const clearingAvg = clearingCount / clearing;
    expect(denseAvg).toBeGreaterThan(0.2);
    expect(denseAvg).toBeGreaterThan(clearingAvg * 2);
  });

  it('keeps harvestable flora off lakes and within sane height/slope bands', () => {
    for (const p of placements) {
      switch (p.kind) {
        case 'tree':
          expect(p.y).toBeGreaterThanOrEqual(0.75);
          expect(p.y).toBeLessThanOrEqual(14);
          expect(terrainSlope(p.x, p.z)).toBeLessThanOrEqual(1.0 + 1e-9);
          expect(Math.hypot(p.x + 46, p.z + 58)).toBeGreaterThanOrEqual(26 - 4);
          break;
        case 'pine':
          expect(p.y).toBeGreaterThanOrEqual(4);
          break;
        case 'rock':
          expect(p.y).toBeGreaterThanOrEqual(0.4);
          break;
        case 'bush':
          expect(p.y).toBeGreaterThanOrEqual(0.6);
          break;
        case 'grass':
          expect(p.y).toBeGreaterThanOrEqual(SEA_LEVEL + 0.35 - 1e-6);
          break;
        default:
          break;
      }
      expect(p.scale).toBeGreaterThan(0.3);
      expect(p.scale).toBeLessThan(2.0);
      expect(p.variant).toBeGreaterThanOrEqual(0);
      expect(p.variant).toBeLessThan(FLORA_VARIANTS[p.kind]);
    }
  });

  it('respects keepOut circles', () => {
    const keepOut = [
      { x: 0, z: 20, r: 6 },
      { x: -30, z: -20, r: 10 },
    ];
    const placements = genPlacements(keepOut);
    for (const p of placements) {
      for (const k of keepOut) {
        expect(Math.hypot(p.x - k.x, p.z - k.z)).toBeGreaterThanOrEqual(k.r - 0.5);
      }
    }
  });
});

describe('populateFlora', () => {
  it('builds instanced visuals and registers gatherable nodes (NullEngine)', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    // Lightweight PBR materials for NullEngine tests.
    // Production materials and procedural textures remain unchanged.
    const makeTestMaterial = (name: string, color: Color3) => {
      const material = new PBRMaterial(name, scene);
      material.albedoColor = color;
      material.roughness = 0.9;
      material.metallic = 0;
      return material;
    };

    const mats = {
      bark: makeTestMaterial('testBark', new Color3(0.3, 0.2, 0.12)),
      leaf: makeTestMaterial('testLeaf', new Color3(0.3, 0.45, 0.2)),
      pineLeaf: makeTestMaterial('testPineLeaf', new Color3(0.15, 0.3, 0.17)),
      rock: makeTestMaterial('testRock', new Color3(0.45, 0.45, 0.43)),
      bushLeaf: makeTestMaterial('testBushLeaf', new Color3(0.25, 0.4, 0.18)),
      berry: makeTestMaterial('testBerry', new Color3(0.6, 0.1, 0.12)),
      grass: makeTestMaterial('testGrass', new Color3(0.35, 0.45, 0.2)),
      flower: makeTestMaterial('testFlower', new Color3(0.8, 0.7, 0.5)),
    } as unknown as SharedMaterials;
    const state = new SharedWorldState();
    const colliders: Collider[] = [];

    const keepOut = [{ x: 0, z: 20, r: 5 }];
    const handle = populateFlora(scene, mats, state, colliders, keepOut);
    const placements = genPlacements(keepOut);
    const harvestable = placements.filter(
      (p) => p.kind === 'tree' || p.kind === 'pine' || p.kind === 'rock' || p.kind === 'bush',
    );

    // Every harvestable placement becomes a registered node.
    expect(handle.nodeCount).toBe(harvestable.length);
    expect(state.nodes.length).toBe(harvestable.length);
    const ids = new Set(state.nodes.map((n) => n.id));
    expect(ids.size).toBe(state.nodes.length); // unique ids

    // Nodes keep the harvest interface (kind, radius, hp).
    for (const n of state.nodes) {
      expect(['tree', 'pine', 'rock', 'bush']).toContain(n.kind);
      expect(n.maxHp).toBeGreaterThan(0);
      expect(n.hp).toBe(n.maxHp);
      expect(n.radius).toBeGreaterThan(0);
    }

    // Rocks contribute circular colliders.
    const rockCount = placements.filter((p) => p.kind === 'rock').length;
    expect(colliders.length).toBe(rockCount);

    // Instanced meshes exist for every placement (one instance per placement).
    const instances = scene.meshes.filter((m) => /^[a-z]+_\d+_\d+$/.test(m.name));
    expect(instances.length).toBe(placements.length);

    // Initial state: everything enabled and full scale after applyState.
    handle.applyState();
    for (const m of scene.meshes) {
      if (!m.name.endsWith('_proto')) expect(m.isEnabled()).toBe(true);
    }

    // Depleted nodes hide their instance; partial damage shrinks it.
    const someRock = state.nodes.find((n) => n.kind === 'rock')!;
    const someTree = state.nodes.find((n) => n.kind === 'tree')!;
    state.damageNode(someTree.id, 1); // partial
    state.damageNode(someRock.id, 99); // depleted
    handle.applyState();

    const rockInst = scene.meshes.find((m) => m.name.startsWith('rock_') && m.isEnabled() === false);
    expect(rockInst).toBeDefined();
    const treeInst = scene.meshes.find(
      (m) => m.name.startsWith('tree_') && m.isEnabled() && m.scaling.x < 1.4,
    );
    expect(treeInst).toBeDefined();

    engine.dispose();
  });
});
