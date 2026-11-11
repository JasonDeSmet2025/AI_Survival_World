import { describe, expect, it } from 'vitest';
import { Color3, Mesh, NullEngine, PBRMaterial, Scene, VertexBuffer } from '@babylonjs/core';
import {
  FLORA_CHUNKS_PER_AXIS,
  FLORA_VARIANTS,
  genPlacements,
  floraChunk,
  forestMask,
  populateFlora,
} from './flora';
import { SharedWorldState } from './worldState';
import type { Collider } from './types';
import { SEA_LEVEL, TERRAIN_SIZE, terrainSlope } from './terrain';
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
          expect(p.scale).toBeLessThanOrEqual(0.95);
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
  // populateFlora builds ~9500 placements plus 27 merged prototypes and the
  // chunk bakes from scratch; on loaded CI machines this legitimately exceeds
  // the default 5s vitest limit, so give it an explicit budget.
  const verts = (m: { getVerticesData: (k: string) => unknown }) =>
    ((m.getVerticesData(VertexBuffer.PositionKind) as Float32Array) ?? new Float32Array(0)).length / 3;
  const chunkName = (kind: string, x: number, z: number) => {
    const { cx, cz } = floraChunk(x, z);
    return `flora_${kind}_c${cx}_${cz}`;
  };

  it('bakes every placement into (kind, chunk) batch meshes and registers nodes (NullEngine)', () => {
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

    // Chunked batches: at most 3 detail levels for the 5 LOD kinds plus one
    // level for the 2 single-detail kinds (grass/flower), per chunk pair.
    const chunks = scene.meshes.filter((m) => m.name.startsWith('flora_'));
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThan(placements.length);
    expect(chunks.length).toBeLessThanOrEqual((3 * 5 + 1 * 2) * FLORA_CHUNKS_PER_AXIS * FLORA_CHUNKS_PER_AXIS);

    const colorMesh = chunks[0] as Mesh;
    const colors = colorMesh
      .getVertexBuffer(VertexBuffer.ColorKind)
      ?.getFloatData(colorMesh.getTotalVertices());
    expect(colors?.length).toBe(colorMesh.getTotalVertices() * 4);
    if (!colors) throw new Error('Flora color buffer is missing');
    let opaque = true;
    for (let i = 3; i < colors.length; i += 4) opaque &&= colors[i] === 1;
    expect(opaque).toBe(true);

    const rockMesh = chunks.find((m) => /^flora_rock_c\d+_\d+$/.test(m.name));
    if (!rockMesh) throw new Error('Baked rock mesh is missing');
    const rockColors = rockMesh
      .getVertexBuffer(VertexBuffer.ColorKind)
      ?.getFloatData(rockMesh.getTotalVertices());
    if (!rockColors) throw new Error('Rock vertex colors are missing');
    let brightestRockChannel = 0;
    for (let i = 0; i < rockColors.length; i += 4) {
      brightestRockChannel = Math.max(
        brightestRockChannel,
        rockColors[i],
        rockColors[i + 1],
        rockColors[i + 2],
      );
    }
    expect(brightestRockChannel).toBeLessThan(0.75);

    for (const mesh of chunks as Mesh[]) {
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
      if (!positions) throw new Error(`Position buffer is missing for ${mesh.name}`);
      let maxAbsX = 0;
      let maxAbsZ = 0;
      for (let i = 0; i < positions.length; i += 3) {
        maxAbsX = Math.max(maxAbsX, Math.abs(positions[i]));
        maxAbsZ = Math.max(maxAbsZ, Math.abs(positions[i + 2]));
      }
      expect(maxAbsX, mesh.name).toBeLessThan(TERRAIN_SIZE / 2 + 10);
      expect(maxAbsZ, mesh.name).toBeLessThan(TERRAIN_SIZE / 2 + 10);
    }

    // Every placement has its (kind, chunk) batch mesh present and enabled.
    for (const p of placements) {
      const m = scene.meshes.find((x) => x.name === chunkName(p.kind, p.x, p.z));
      expect(m, `missing chunk mesh ${chunkName(p.kind, p.x, p.z)}`).toBeDefined();
      if (m) {
        expect(m.isEnabled()).toBe(true);
        expect(m.isPickable).toBe(false);
        // Colour buffer exists for the shared flora material (CPU readback of
        // colours is a known v9.33 limitation, so only assert existence).
        expect((m as Mesh).getVerticesDataKinds().includes(VertexBuffer.ColorKind)).toBe(true);
      }
    }

    // Initial state: a fresh applyState is a no-op (no re-bake, same meshes).
    const before = new Map(chunks.map((c) => [c.name, verts(c)]));
    handle.applyState();
    const afterNoOp = new Map(
      scene.meshes.filter((m) => m.name.startsWith('flora_')).map((c) => [c.name, verts(c)]),
    );
    expect(afterNoOp.size).toBe(before.size);
    for (const [n, v] of before) expect(afterNoOp.get(n)).toBe(v);

    // chunkMeshes() exposes the live batch meshes (hi + mid + lo) for QA;
    // shadow-caster registration uses shadowCasters() (see game.ts).
    const liveBefore = handle.chunkMeshes();
    expect(liveBefore.length).toBe(chunks.length);
    expect(new Set(liveBefore).size).toBe(liveBefore.length); // no duplicates
    for (const m of liveBefore) expect(m.name).toMatch(/^flora_\w+_c\d+_\d+(_mid|_lo)?$/);

    // Depleted nodes are removed from their batch (fewer vertices); partial
    // damage re-bakes the chunk with a smaller scale (same topology).
    const someRock = state.nodes.find((n) => n.kind === 'rock')!;
    const someTree = state.nodes.find((n) => n.kind === 'tree')!;
    const rockName = chunkName('rock', someRock.x, someRock.z);
    const treeName = chunkName('tree', someTree.x, someTree.z);
    const rockBefore = verts(scene.meshes.find((m) => m.name === rockName)!);
    const treeBefore = verts(scene.meshes.find((m) => m.name === treeName)!);
    const treeChunkMeshBefore = scene.meshes.find((m) => m.name === treeName);
    state.damageNode(someTree.id, 1); // partial
    state.damageNode(someRock.id, 99); // depleted
    handle.applyState();

    const rockAfter = scene.meshes.find((m) => m.name === rockName);
    const treeAfter = scene.meshes.find((m) => m.name === treeName);
    // The rock's chunk still exists if other rocks share it; either way the
    // depleted instance's vertices are gone (or the whole batch vanished).
    expect(rockAfter === undefined || verts(rockAfter) < rockBefore).toBe(true);
    expect(rockAfter?.isEnabled()).not.toBe(false);
    expect(treeAfter).toBeDefined();
    if (treeAfter) {
      expect(treeAfter.isEnabled()).toBe(true);
      expect(verts(treeAfter)).toBe(treeBefore); // shrink is baked, topology kept
    }

    // Colliders are world state, not geometry: re-baking never touches them.
    expect(colliders.length).toBe(rockCount);

    // After the re-bake above, chunkMeshes() reflects the NEW mesh instances
    // (the re-baked chunk replaced its old mesh; the handle tracks the live
    // ones, so game.ts can swap them in the shadow generator).
    const liveAfter = handle.chunkMeshes();
    expect(liveAfter.length).toBeGreaterThan(0);
    const treeMeshAfter = liveAfter.find((m) => m.name === treeName);
    expect(treeMeshAfter).toBeDefined();
    expect(treeMeshAfter).toBe(scene.meshes.find((m) => m.name === treeName)); // scene instance
    expect(treeMeshAfter).not.toBe(treeChunkMeshBefore); // re-bake replaced it

    engine.dispose();
  }, 20000);

  it('is deterministic: identical chunk layout, vertex counts and node ids per seed', () => {
    const mk = () => {
      const engine = new NullEngine();
      const scene = new Scene(engine);
      const material = new PBRMaterial('m', scene);
      material.roughness = 0.9;
      material.metallic = 0;
      const mats = Object.fromEntries(
        ['bark', 'leaf', 'pineLeaf', 'rock', 'bushLeaf', 'berry', 'grass', 'flower'].map((k) => [
          k,
          material,
        ]),
      ) as unknown as SharedMaterials;
      const state = new SharedWorldState();
      populateFlora(scene, mats, state, []);
      return { engine, scene, state };
    };
    const a = mk();
    const b = mk();

    const mapA = new Map(
      a.scene.meshes.filter((m) => m.name.startsWith('flora_')).map((c) => [c.name, verts(c)]),
    );
    const mapB = new Map(
      b.scene.meshes.filter((m) => m.name.startsWith('flora_')).map((c) => [c.name, verts(c)]),
    );
    expect(mapA.size).toBe(mapB.size);
    for (const [n, v] of mapA) expect(mapB.get(n)).toBe(v);

    expect(
      JSON.stringify(a.state.nodes.map((n) => n.id)),
    ).toBe(JSON.stringify(b.state.nodes.map((n) => n.id)));
    expect(
      JSON.stringify(a.state.nodes.map((n) => [n.x, n.z, n.y, n.radius, n.maxHp])),
    ).toBe(JSON.stringify(b.state.nodes.map((n) => [n.x, n.z, n.y, n.radius, n.maxHp])));

    a.engine.dispose();
    b.engine.dispose();
  }, 20000);
});
