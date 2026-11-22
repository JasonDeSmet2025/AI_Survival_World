import { describe, expect, it } from 'vitest';
import { Color3, Mesh, NullEngine, PBRMaterial, Scene } from '@babylonjs/core';
import { Npc, NPC_PROFILES } from './npc';
import type { SharedMaterials } from '../visual/materials';

/**
 * Babylon 9: getChildMeshes(directDescendantsOnly) — false reaches the
 * nested body parts under the joint nodes.
 */
const meshesOf = (npc: Npc): Mesh[] => npc.root.getChildMeshes(false) as Mesh[];

function makeMaterials(scene: Scene): SharedMaterials {
  const pbr = (name: string, c: Color3) => {
    const m = new PBRMaterial(name, scene);
    m.albedoColor = c;
    return m;
  };
  return {
    playerAccent: pbr('accent', new Color3(0.8, 0.7, 0.3)),
    buildingWood: pbr('wood', new Color3(0.5, 0.35, 0.2)),
  } as unknown as SharedMaterials;
}

function makeNpc(id: string): { scene: Scene; npc: Npc } {
  const scene = new Scene(new NullEngine());
  const profile = NPC_PROFILES.find((p) => p.id === id)!;
  const npc = new Npc(scene, profile, { x: 0, z: 0, y: 0 }, 1234, makeMaterials(scene));
  return { scene, npc };
}

const NAMES = [
  'torso', 'chest', 'waist', 'belt', 'buckle',
  'neck', 'head', 'hair', 'eyeL', 'eyeR', 'browL', 'browR', 'earL', 'earR', 'nose',
  'shoulderPartL', 'shoulderPartR', 'upperArmL', 'upperArmR', 'foreArmL', 'foreArmR',
  'handL', 'handR', 'thighL', 'thighR', 'shinL', 'shinR', 'bootL', 'bootR',
];

describe('Npc model', () => {
  it('builds the full humanoid body for every profile', () => {
    for (const profile of NPC_PROFILES) {
      const { scene, npc } = makeNpc(profile.id);
      const names = new Set(meshesOf(npc).map((m) => m.name));
      for (const part of NAMES) {
        expect(names.has(`npcPart_${profile.id}_${part}`), `${profile.id} part ${part}`).toBe(true);
      }
      scene.dispose();
    }
  });

  it('has villager-specific silhouette details', () => {
    const mara = new Set(meshesOf(makeNpc('mara').npc).map((m) => m.name));
    expect(mara.has('npcPart_mara_ponytail')).toBe(true);
    expect(mara.has('npcPart_mara_skirt')).toBe(true);
    const tomas = new Set(meshesOf(makeNpc('tomas').npc).map((m) => m.name));
    expect(tomas.has('npcPart_tomas_beard')).toBe(true);
    expect(tomas.has('npcPart_tomas_cap')).toBe(true);
  });

  it('stands upright: boots on the ground, head near 1.8 m', () => {
    const { scene, npc } = makeNpc('mara');
    // The route start sits at the real terrain height of the camp — pin
    // the root to y=0 so the envelope is measured against the feet.
    npc.root.position.y = 0;
    npc.root.computeWorldMatrix(true);
    let minY = Infinity;
    let maxY = -Infinity;
    for (const m of meshesOf(npc)) {
      m.computeWorldMatrix(true);
      const box = m.getBoundingInfo().boundingBox;
      for (const corner of [box.minimumWorld, box.maximumWorld]) {
        minY = Math.min(minY, corner.y);
        maxY = Math.max(maxY, corner.y);
      }
    }
    // Feet touch the ground plane (small float allowed), total height
    // in a believable adult envelope — NOT the old blob (~1.1 m).
    expect(minY).toBeGreaterThanOrEqual(-0.01);
    expect(minY).toBeLessThan(0.06);
    expect(maxY).toBeGreaterThan(1.6);
    expect(maxY).toBeLessThan(1.95);
    scene.dispose();
  });

  it('walks the route with an animated gait and frozen idle while talking', () => {
    const { scene, npc } = makeNpc('tomas');
    const start = { x: npc.position.x, z: npc.position.z };
    // Frozen while in conversation: no movement at all.
    for (let i = 0; i < 30; i++) npc.update(0.05, true);
    expect(npc.position.x).toBe(start.x);
    // Unfrozen long enough to reach a waypoint at least once.
    let moved = false;
    for (let i = 0; i < 600; i++) {
      npc.update(0.05, false);
      if (Math.hypot(npc.position.x - start.x, npc.position.z - start.z) > 1) moved = true;
    }
    expect(moved).toBe(true);
    scene.dispose();
  });

  it('stays glued to the rendered ground surface', async () => {
    const { scene, npc } = makeNpc('mara');
    for (let i = 0; i < 400; i++) npc.update(0.05, false);
    // groundSurfaceHeight at the NPC position must match root.y closely.
    const { groundSurfaceHeight } = await import('../world/groundSurface');
    expect(Math.abs(npc.position.y - groundSurfaceHeight(npc.position.x, npc.position.z))).toBeLessThan(0.6);
    scene.dispose();
  });
});
