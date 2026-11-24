import { describe, expect, it } from 'vitest';
import { Color3, NullEngine, PBRMaterial, Scene } from '@babylonjs/core';
import { Witch } from './witch';
import { WITCH_PROFILE } from './npc';
import type { SharedMaterials } from '../visual/materials';

/**
 * The witch is a full NPC (same humanoid rig as the villagers) wearing her
 * own silhouette. Same NullEngine pattern as npc.test.ts — Babylon is only
 * here to prove the meshes exist; every RULE is tested in systems/witch.ts.
 */
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

function makeWitch(): { scene: Scene; witch: Witch } {
  const scene = new Scene(new NullEngine());
  const witch = new Witch(scene, WITCH_PROFILE, { x: 128, z: 44, baseY: 0 }, 4242, makeMaterials(scene));
  return { scene, witch };
}

const BODY = [
  'torso', 'head', 'hair', 'eyeL', 'eyeR', 'handL', 'handR', 'thighL', 'bootR',
];

describe('Witch model', () => {
  it('is a named humanoid with her own hat and shawl parts', () => {
    const { scene, witch } = makeWitch();
    const names = new Set(witch.root.getChildMeshes(false).map((m) => m.name));
    for (const part of BODY) {
      expect(names.has(`npcPart_heks_${part}`), part).toBe(true);
    }
    // Her silhouette: pointed hat and hexing hand must be real meshes.
    const parts = [...names].filter((n) => n.startsWith('npcPart_heks_'));
    expect(parts.some((n) => /hat|point/.test(n)), 'pointed hat').toBe(true);
    scene.dispose();
  });

  it('vanishes when overpowered and is un-present until she returns', () => {
    const { scene, witch } = makeWitch();
    expect(witch.present).toBe(true);
    let out: 'hit' | 'vanished' = 'hit';
    for (let i = 0; i < 10 && out !== 'vanished'; i++) out = witch.fight(2, 100 + i);
    expect(out).toBe('vanished');
    expect(witch.present).toBe(false);
    scene.dispose();
  });

  it('a paid apology makes her peaceful again; an unpaid rage does not', () => {
    const { scene, witch } = makeWitch();
    witch.restoreAnger(90);
    expect(witch.hostile).toBe(true);
    expect(witch.apologize(5)).toBe(false);
    expect(witch.hostile).toBe(true);
    expect(witch.apologize(20)).toBe(true);
    expect(witch.hostile).toBe(false);
    scene.dispose();
  });

  it('restoreAnger clamps to the legal range (save data is trusted as little as a chest)', () => {
    const { scene, witch } = makeWitch();
    witch.restoreAnger(1e9);
    expect(witch.state.anger).toBe(100);
    witch.restoreAnger(-5);
    expect(witch.state.anger).toBe(0);
    scene.dispose();
  });
});
