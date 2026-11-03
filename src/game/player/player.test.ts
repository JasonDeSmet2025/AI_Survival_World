import { describe, expect, it } from 'vitest';
import { Color3, Mesh, NullEngine, PBRMaterial, Scene, TransformNode } from '@babylonjs/core';
import { PlayerCharacter } from './player';
import type { SharedMaterials } from '../visual/materials';

/**
 * In Babylon 9.33 the first argument of `getChildMeshes` is
 * `directDescendantsOnly`, so `false` is required to reach the nested
 * body parts. (Classic Babylon used `includeDescendants` — the opposite.)
 */
const descendantMeshes = (char: PlayerCharacter): Mesh[] =>
  char.root.getChildMeshes(false) as Mesh[];

/** Every body part the character must always contain. */
const PARTS = [
  // torso + head
  'playerPart_torso',
  'playerPart_chest',
  'playerPart_waist',
  'playerPart_neck',
  'playerPart_head',
  'playerPart_hair',
  // backpack
  'playerPart_pack',
  'playerPart_flap',
  'playerPart_roll',
  // arms
  'playerPart_shoulderL',
  'playerPart_shoulderR',
  'playerPart_upperArmL',
  'playerPart_upperArmR',
  'playerPart_foreArmL',
  'playerPart_foreArmR',
  'playerPart_handL',
  'playerPart_handR',
  // legs + feet
  'playerPart_thighL',
  'playerPart_thighR',
  'playerPart_shinL',
  'playerPart_shinR',
  'playerPart_bootL',
  'playerPart_bootR',
] as const;

function makeTestMaterials(scene: Scene): SharedMaterials {
  const pbr = (name: string, color: Color3): PBRMaterial => {
    const m = new PBRMaterial(name, scene);
    m.albedoColor = color;
    m.roughness = 0.9;
    m.metallic = 0;
    return m;
  };
  return {
    playerBody: pbr('tBody', new Color3(0.4, 0.45, 0.5)),
    playerPants: pbr('tPants', new Color3(0.25, 0.25, 0.28)),
    playerBoots: pbr('tBoots', new Color3(0.3, 0.2, 0.12)),
    playerSkin: pbr('tSkin', new Color3(0.8, 0.65, 0.5)),
    playerHair: pbr('tHair', new Color3(0.15, 0.1, 0.06)),
    backpack: pbr('tPack', new Color3(0.45, 0.35, 0.2)),
    toolWood: pbr('tToolWood', new Color3(0.5, 0.35, 0.2)),
    toolStone: pbr('tToolStone', new Color3(0.5, 0.5, 0.5)),
  } as unknown as SharedMaterials;
}

function makeCharacter(): { scene: Scene; char: PlayerCharacter } {
  const scene = new Scene(new NullEngine());
  const char = new PlayerCharacter(scene, makeTestMaterials(scene));
  return { scene, char };
}

/** World-space Y of a named part (root kept at the feet, y = 0). */
function absoluteY(char: PlayerCharacter, name: string): number {
  char.root.computeWorldMatrix(true);
  const mesh = descendantMeshes(char).find((m) => m.name === name);
  expect(mesh, `part ${name} missing`).toBeTruthy();
  mesh!.computeWorldMatrix(true);
  return mesh!.getAbsolutePosition().y;
}

function partNames(char: PlayerCharacter): Set<string> {
  return new Set(descendantMeshes(char).map((m) => m.name));
}

describe('PlayerCharacter geometry', () => {
  it('contains the full body: torso, head, arms, hands, legs, feet', () => {
    const { char } = makeCharacter();
    const names = partNames(char);
    for (const p of PARTS) expect(names.has(p), `missing part ${p}`).toBe(true);
    // Every part must carry a material (an unshaded part renders invisible).
    for (const m of descendantMeshes(char)) {
      expect(m.material, `part ${m.name} has no material`).toBeTruthy();
    }
    // The torso must be a direct child of the torso joint (never orphaned).
    const torso = descendantMeshes(char).find((m) => m.name === 'playerPart_torso');
    expect(torso!.parent?.name).toBe('playerTorso');
  });

  it('has human proportions (~1.7 m): feet at ground, head near 1.8 m', () => {
    const { char } = makeCharacter();
    // Let the idle pose settle.
    for (let i = 0; i < 60; i++) char.update(1 / 30, 0, true, false, false);
    expect(absoluteY(char, 'playerPart_bootL')).toBeCloseTo(0.04, 1);
    expect(absoluteY(char, 'playerPart_bootR')).toBeCloseTo(0.04, 1);
    const headY = absoluteY(char, 'playerPart_head');
    expect(headY).toBeGreaterThan(1.7);
    expect(headY).toBeLessThan(2.0);
    expect(absoluteY(char, 'playerPart_torso')).toBeGreaterThan(1.2);
    expect(absoluteY(char, 'playerPart_shoulderL')).toBeGreaterThan(1.25);
  });

  it('parents the arms under the torso so shoulders track the torso lean', () => {
    const { char } = makeCharacter();
    const armL = descendantMeshes(char).find((m) => m.name === 'playerPart_upperArmL');
    const pivot = armL!.parent as TransformNode;
    expect(pivot?.name).toBe('playerArmL');
    expect(pivot?.parent?.name).toBe('playerTorso');
    const armR = descendantMeshes(char).find((m) => m.name === 'playerPart_upperArmR');
    expect((armR!.parent as TransformNode)?.parent?.name).toBe('playerTorso');
  });

  it('keeps every body part visible and feet grounded through all poses', () => {
    const { char } = makeCharacter();
    for (let t = 0; t < 5; t += 1 / 30) {
      let speed = 0;
      let onGround = true;
      let inWater = false;
      let crouching = false;
      let harvesting = false;
      if (t < 1) speed = 0; // idle
      else if (t < 2) { speed = 3.2; harvesting = t > 1.5; } // walk (+harvest)
      else if (t < 3) speed = 8; // sprint
      else if (t < 3.5) { onGround = false; speed = 4; } // jump
      else if (t < 4) { crouching = true; speed = 0.3; } // crouch
      else inWater = true; // swim
      char.update(1 / 30, speed, onGround, inWater, crouching, harvesting);

      const names = partNames(char);
      for (const p of PARTS) expect(names.has(p), `part ${p} lost at t=${t.toFixed(2)}`).toBe(true);
      for (const p of ['playerPart_bootL', 'playerPart_bootR']) {
        const y = absoluteY(char, p);
        expect(Number.isFinite(y)).toBe(true);
        // Boots must never dig visibly into the ground in any pose.
        expect(y - 0.05, `boot clipped into ground at t=${t.toFixed(2)}`).toBeGreaterThan(-0.1);
      }
      // The torso must always stay between the waist and the head.
      const torsoY = absoluteY(char, 'playerPart_torso');
      expect(torsoY).toBeGreaterThan(0.5);
      expect(torsoY).toBeLessThan(2.2);
    }
  });

  it('crouch lowers the body while keeping the feet planted', () => {
    const { char } = makeCharacter();
    for (let i = 0; i < 60; i++) char.update(1 / 30, 0, true, false, false);
    const idleHead = absoluteY(char, 'playerPart_head');

    for (let i = 0; i < 180; i++) char.update(1 / 30, 0.2, true, false, true);
    const crouchHead = absoluteY(char, 'playerPart_head');
    const bootY = absoluteY(char, 'playerPart_bootL');

    expect(crouchHead).toBeLessThan(idleHead - 0.03); // body actually lowered
    expect(bootY).toBeGreaterThanOrEqual(-0.03); // ...but boots stay on the ground
    expect(bootY).toBeLessThan(0.2); // ...without floating
  });

  it('equipping a tool adds meshes; unequipping removes and disposes them', () => {
    const { char } = makeCharacter();
    const added: Mesh[] = [];
    const removed: Mesh[] = [];
    char.onToolShadows = (a, r) => {
      added.push(...a);
      removed.push(...r);
    };

    const before = descendantMeshes(char).length;
    char.setTool('stone_axe');
    expect(descendantMeshes(char).length).toBeGreaterThan(before);
    // The nested handle boxes must be in the shadow list too — with the
    // classic `getChildMeshes(true)` call only direct children would be.
    expect(added.length).toBeGreaterThanOrEqual(6);

    char.setTool(null);
    const after = partNames(char);
    for (const p of PARTS) expect(after.has(p), `missing part ${p} after unequip`).toBe(true);
    expect(removed.length).toBe(added.length);
    // Every tool part must be gone — the old `dispose(true)` (doNotRecurse
    // in Babylon 9.33) leaked all of them into the scene.
    for (const m of removed) expect(m.isDisposed(), `tool part ${m.name} leaked`).toBe(true);
    expect(descendantMeshes(char).length).toBe(before);
  });

  it('dispose removes every part from the scene', () => {
    const { scene, char } = makeCharacter();
    const meshes = scene.meshes.slice();
    expect(meshes.length).toBeGreaterThanOrEqual(PARTS.length);
    char.dispose();
    // Recursion must dispose every body part (Babylon 9.33: dispose(true)
    // would mean doNotRecurse and leak the whole character).
    expect(scene.meshes.length).toBe(0);
    for (const m of meshes) expect(m.isDisposed(), `part ${m.name} leaked`).toBe(true);
  });
});
