import { describe, expect, it } from 'vitest';
import { Color3, NullEngine, PBRMaterial, Scene, StandardMaterial, TransformNode } from '@babylonjs/core';
import { BuildingRenderer } from './buildingMeshes';
import type { SharedMaterials } from '../visual/materials';
import type { BuildingData } from '../world/types';

function makeScene(): Scene {
  return new Scene(new NullEngine());
}

function makeMats(scene: Scene): SharedMaterials {
  const pbr = (name: string, color: Color3): PBRMaterial => {
    const m = new PBRMaterial(name, scene);
    m.albedoColor = color;
    m.roughness = 0.9;
    m.metallic = 0;
    return m;
  };
  const ghost = new StandardMaterial('ghost', scene);
  ghost.alpha = 0.5;
  ghost.disableLighting = true;
  return {
    buildingWood: pbr('wood', new Color3(0.5, 0.38, 0.24)),
    buildingStone: pbr('stone', new Color3(0.55, 0.55, 0.52)),
    ghost,
  } as unknown as SharedMaterials;
}

function bed(x = 10, z = 10, rot = 0): BuildingData {
  return {
    id: `b_bed_${x}_${z}`,
    kind: 'bed',
    x,
    z,
    y: 2.0,
    rot,
    ownerId: 'test',
  };
}

describe('BuildingRenderer bed', () => {
  it.each(['wall', 'floor'] as const)('renders placed %s meshes with world-space bounds', (kind) => {
    const scene = makeScene();
    const mats = makeMats(scene);
    const r = new BuildingRenderer(scene, mats);
    const data: BuildingData = {
      id: `b_${kind}`,
      kind,
      x: 8,
      z: -6,
      y: 3,
      rot: 1,
      ownerId: 'test',
    };

    r.sync([data]);
    const meshes = r.getShadowCasters();
    expect(meshes.length).toBeGreaterThan(0);
    for (const mesh of meshes) {
      expect(mesh.isEnabled()).toBe(true);
      expect(mesh.isDisposed()).toBe(false);
      expect(mesh.material).toBe(mats.buildingWood);
      expect(mesh.receiveShadows).toBe(false);
      const bounds = mesh.getBoundingInfo().boundingBox;
      expect(bounds.minimumWorld.x).toBeGreaterThan(6);
      expect(bounds.maximumWorld.x).toBeLessThan(10);
      expect(bounds.minimumWorld.z).toBeGreaterThan(-8);
      expect(bounds.maximumWorld.z).toBeLessThan(-4);
    }
  });

  it('renders a bed as a full frame (legs, rails, planks, mattress, pillow)', () => {
    const scene = makeScene();
    const r = new BuildingRenderer(scene, makeMats(scene));
    r.sync([bed()]);

    const casters = r.getShadowCasters();
    // Legs(4) + side rails(2) + end rail(1) + headboard posts(2) + headboard top rail(1) + planks(4) + mattress(1) + pillow(1) = 16
    expect(casters.length).toBe(16);
    for (const m of casters) expect(m.isDisposed()).toBe(false);

    // Deterministic per-placement variation: a second bed at another spot
    // builds an identical part count (geometry is stable, not random).
    r.sync([bed(), bed(14, 10)]);
    expect(r.getShadowCasters().length).toBe(32);
  });

  it('ghost preview uses the ghost material and disposes cleanly', () => {
    const scene = makeScene();
    const mats = makeMats(scene);
    const r = new BuildingRenderer(scene, mats);
    const h = r.preview('bed', 3, 3, 2.0, 1);
    expect(h.meshes.length).toBe(16);
    for (const m of h.meshes) expect(m.material).toBe(mats.ghost);
    h.dispose();
    for (const m of h.meshes) expect(m.isDisposed()).toBe(true);
  });

  it('reuses and moves one preview instead of leaking a new ghost every frame', () => {
    const scene = makeScene();
    const r = new BuildingRenderer(scene, makeMats(scene));
    const first = r.preview('wall', 3, 4, 2, 0);
    const meshes = scene.meshes.filter((m) => m.name === 'ghost');
    expect(meshes.length).toBe(first.meshes.length);

    for (let frame = 0; frame < 120; frame++) {
      const current = r.preview('wall', frame, frame + 1, 2.5, frame % 4);
      expect(current).toBe(first);
    }

    expect(scene.meshes.filter((m) => m.name === 'ghost')).toHaveLength(meshes.length);
    const root = first.meshes[0].parent as TransformNode;
    expect(root.position.asArray()).toEqual([119, 2.5, 120]);
    expect(root.rotation.y).toBeCloseTo((3 / 4) * Math.PI * 2);

    r.clearPreview();
    for (const mesh of first.meshes) expect(mesh.isDisposed()).toBe(true);
    expect(scene.meshes.filter((m) => m.name === 'ghost')).toHaveLength(0);
  });

  it('replaces the ghost only when the selected building kind changes', () => {
    const scene = makeScene();
    const r = new BuildingRenderer(scene, makeMats(scene));
    const wall = r.preview('wall', 0, 0, 2, 0);
    const floor = r.preview('floor', 0, 0, 2, 0);
    expect(floor).not.toBe(wall);
    for (const mesh of wall.meshes) expect(mesh.isDisposed()).toBe(true);
    for (const mesh of floor.meshes) expect(mesh.isDisposed()).toBe(false);
  });

  it('removes a bed mesh when it leaves the world state', () => {
    const scene = makeScene();
    const r = new BuildingRenderer(scene, makeMats(scene));
    r.sync([bed()]);
    expect(r.getShadowCasters().length).toBe(16);
    r.sync([]);
    expect(r.getShadowCasters().length).toBe(0);
    const buildingMeshes = scene.meshes.filter((m) => m.name.startsWith('building_bed'));
    for (const m of buildingMeshes) expect(m.isDisposed()).toBe(true);
  });

  it('is idempotent: syncing the same bed twice does not double-render', () => {
    const scene = makeScene();
    const r = new BuildingRenderer(scene, makeMats(scene));
    const b = bed();
    r.sync([b]);
    r.sync([b]);
    r.sync([b]);
    expect(r.getShadowCasters().length).toBe(16);
  });
});
