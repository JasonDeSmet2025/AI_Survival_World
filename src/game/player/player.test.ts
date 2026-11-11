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
  'playerPart_eyeL',
  'playerPart_eyeR',
  'playerPart_nose',
  'playerPart_earL',
  'playerPart_earR',
  // backpack
  'playerPart_pack',
  'playerPart_flap',
  'playerPart_roll',
  'playerPart_packStrapL',
  'playerPart_packStrapR',
  'playerPart_packPouchL',
  'playerPart_packPouchR',
  'playerPart_packPatch',
  // clothing details
  'playerPart_collarL',
  'playerPart_collarR',
  'playerPart_pocketL',
  'playerPart_pocketR',
  'playerPart_pocketFlapL',
  'playerPart_pocketFlapR',
  'playerPart_zipper',
  'playerPart_belt',
  'playerPart_buckle',
  'playerPart_kneePadL',
  'playerPart_kneePadR',
  'playerPart_toeCapL',
  'playerPart_toeCapR',
  // arms
  'playerPart_shoulderL',
  'playerPart_shoulderR',
  'playerPart_upperArmL',
  'playerPart_upperArmR',
  'playerPart_foreArmL',
  'playerPart_foreArmR',
  'playerPart_cuffL',
  'playerPart_cuffR',
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
    playerAccent: pbr('tAccent', new Color3(0.62, 0.3, 0.13)),
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

  it('connects the jacket torso to the trouser waist without a visible gap', () => {
    const { char } = makeCharacter();
    for (let i = 0; i < 60; i++) char.update(1 / 30, 0, true, false, false);
    char.root.computeWorldMatrix(true);

    const parts = new Map(descendantMeshes(char).map((mesh) => [mesh.name, mesh]));
    const torso = parts.get('playerPart_torso')!;
    const waist = parts.get('playerPart_waist')!;
    torso.computeWorldMatrix(true);
    waist.computeWorldMatrix(true);
    expect(torso.getBoundingInfo().boundingBox.minimumWorld.y)
      .toBeLessThan(waist.getBoundingInfo().boundingBox.maximumWorld.y);
  });

  it('uses contrasting materials for the jacket, trousers, and survival-gear accents', () => {
    const { char } = makeCharacter();
    const parts = new Map(descendantMeshes(char).map((mesh) => [mesh.name, mesh]));
    expect(parts.get('playerPart_torso')!.material).not.toBe(parts.get('playerPart_waist')!.material);
    expect(parts.get('playerPart_buckle')!.material).not.toBe(parts.get('playerPart_belt')!.material);
    expect(parts.get('playerPart_packPatch')!.material).not.toBe(parts.get('playerPart_pack')!.material);
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

  it('sleep blend lays the body down on its back and back up again', () => {
    const { char } = makeCharacter();
    // Settle the idle pose first.
    for (let i = 0; i < 60; i++) char.update(1 / 30, 0, true, false, false);
    const headIdle = absoluteY(char, 'playerPart_head');

    // Lie down.
    for (let i = 0; i < 90; i++) {
      char.update(1 / 30, 0, true, false, false, false, false, false, true);
    }
    expect(char.sleepPivot.rotation.x).toBeCloseTo(-Math.PI / 2, 2);
    const headLying = absoluteY(char, 'playerPart_head');
    // The head drops from ~1.8 m to body-thickness height (the body has no
    // vertical extent while lying: its centre line sits at the root height).
    expect(headLying).toBeLessThan(headIdle - 1.0);
    expect(headLying).toBeGreaterThan(-0.2);
    // ...while the feet (boots) stay at the root (the bed's foot end).
    expect(absoluteY(char, 'playerPart_bootL')).toBeCloseTo(0.04, 1);
    expect(absoluteY(char, 'playerPart_bootR')).toBeCloseTo(0.04, 1);

    // The body must lie along the ground axis, not stand up: the head is
    // far from the hips along local -Z (world Z here) at the same height.
    const headMesh = descendantMeshes(char).find((m) => m.name === 'playerPart_head')!;
    headMesh.computeWorldMatrix(true);
    const headLyingZ = headMesh.getAbsolutePosition().z;
    const hipsMesh = descendantMeshes(char).find((m) => m.name === 'playerPart_waist')!;
    hipsMesh.computeWorldMatrix(true);
    const hipsPos = hipsMesh.getAbsolutePosition();
    expect(Math.abs(headLying - hipsPos.y)).toBeLessThan(0.25);
    expect(Math.abs(hipsPos.z - headLyingZ)).toBeGreaterThan(0.8);
    // The face points up: nothing of the body sinks below the back plane
    // (margins account for the part radii around the centre line).
    expect(headLying).toBeGreaterThan(-0.3);

    // Sit back up: the blend fully recovers the standing height.
    for (let i = 0; i < 120; i++) char.update(1 / 30, 0, true, false, false);
    expect(char.sleepPivot.rotation.x).toBeCloseTo(0, 3);
    expect(absoluteY(char, 'playerPart_head')).toBeCloseTo(headIdle, 1);
  });

  it('sleeping rotates in the character local frame (follows the root yaw)', () => {
    const { char } = makeCharacter();
    char.root.rotation.y = Math.PI / 2; // facing +X
    for (let i = 0; i < 90; i++) {
      char.update(1 / 30, 0, true, false, false, false, false, false, true);
    }
    char.root.computeWorldMatrix(true);
    const head = descendantMeshes(char).find((m) => m.name === 'playerPart_head')!;
    head.computeWorldMatrix(true);
    const headPos = head.getAbsolutePosition();
    // Feet at the root (origin); the body lies along local -Z, which at
    // yaw π/2 maps to world -X. It must extend horizontally, not upright.
    expect(Math.abs(headPos.y)).toBeLessThan(1.0);
    expect(Math.abs(headPos.x) + Math.abs(headPos.z)).toBeGreaterThan(1.0);
  });

  it('landing dip lowers the body and keeps the boots on the ground, then fully recovers', () => {
    const { char } = makeCharacter();
    // Settle the idle pose.
    for (let i = 0; i < 60; i++) char.update(1 / 30, 0, true, false, false);
    const headIdle = absoluteY(char, 'playerPart_head');
    const bootIdle = absoluteY(char, 'playerPart_bootL');

    // Landing window (the game shell passes landing=true for ~0.3 s after
    // an impact, here 12 frames = 0.4 s at 30 fps for full blend-in).
    for (let i = 0; i < 12; i++) {
      char.update(1 / 30, 0, true, false, false, false, false, false, false, true);
    }
    const headDip = absoluteY(char, 'playerPart_head');
    const bootDip = absoluteY(char, 'playerPart_bootL');
    // The whole body dips (hips drive head + boots)...
    expect(headDip).toBeLessThan(headIdle - 0.025);
    // ...but the boots stay on the ground (the knee flex absorbs the dip).
    expect(bootDip).toBeGreaterThanOrEqual(-0.02);
    expect(bootDip).toBeLessThan(bootIdle - 0.01);

    // Recovery: the standing pose is fully restored once the window ends.
    for (let i = 0; i < 120; i++) char.update(1 / 30, 0, true, false, false);
    expect(absoluteY(char, 'playerPart_head')).toBeCloseTo(headIdle, 2);
    expect(absoluteY(char, 'playerPart_bootL')).toBeCloseTo(bootIdle, 2);
  });

  it('landing dip works while walking (pose-independent additive blend)', () => {
    const { char } = makeCharacter();
    for (let i = 0; i < 60; i++) char.update(1 / 30, 4.5, true, false, false);
    for (let i = 0; i < 12; i++) {
      char.update(1 / 30, 4.5, true, false, false, false, false, false, false, true);
    }
    const bootDip = absoluteY(char, 'playerPart_bootL');
    expect(bootDip).toBeGreaterThanOrEqual(-0.04); // no visible boot clip
    for (let i = 0; i < 90; i++) char.update(1 / 30, 4.5, true, false, false);
  });

  it('landing dip is suppressed while sleeping', () => {
    const { char } = makeCharacter();
    for (let i = 0; i < 60; i++) char.update(1 / 30, 0, true, false, false);
    const headIdle = absoluteY(char, 'playerPart_head');
    // Sleeping + a (stale) landing flag at the same time: no dip.
    for (let i = 0; i < 30; i++) {
      char.update(1 / 30, 0, true, false, false, false, false, false, true, true);
    }
    expect(char.sleepPivot.rotation.x).toBeCloseTo(-Math.PI / 2, 2);
    // The head height is governed by the lie-down pivot only: a standing
    // dip on top of it would show as an extra drop — check the hips dip
    // component is zero by comparing against a pure-sleep control.
    const { char: control } = makeCharacter();
    for (let i = 0; i < 30; i++) control.update(1 / 30, 0, true, false, false, false, false, false, true, false);
    expect(absoluteY(char, 'playerPart_head')).toBeCloseTo(absoluteY(control, 'playerPart_head'), 3);
    expect(headIdle).toBeGreaterThan(absoluteY(char, 'playerPart_head'));
  });
});

describe('cooking pose', () => {
  /** World-space position of a named part (cloned — Babylon reuses the returned vector). */
  function pos(char: PlayerCharacter, name: string) {
    char.root.computeWorldMatrix(true);
    const m = descendantMeshes(char).find((x) => x.name === name)!;
    m.computeWorldMatrix(true);
    return m.getAbsolutePosition().clone();
  }

  it('extends both hands forward-up over the fire and leans the torso', () => {
    const { char } = makeCharacter();
    for (let i = 0; i < 60; i++) char.update(1 / 30, 0, true, false, false);
    const handR0 = pos(char, 'playerPart_handR');
    const handL0 = pos(char, 'playerPart_handL');
    const head0 = pos(char, 'playerPart_head');

    // Cooking = 11th update parameter.
    for (let i = 0; i < 90; i++) {
      char.update(1 / 30, 0, true, false, false, false, false, false, false, false, true);
    }

    // The character faces local +Z at yaw 0, so "over the fire" means
    // forward (+z) and up to fire level from the idle hang-down position.
    // (Measured on the NullEngine: hand z 0.08 -> 0.33, y 0.76 -> 0.84.)
    const handR = pos(char, 'playerPart_handR');
    const handL = pos(char, 'playerPart_handL');
    const head = pos(char, 'playerPart_head');
    expect(handR.z).toBeGreaterThan(handR0.z + 0.15);
    expect(handL.z).toBeGreaterThan(handL0.z + 0.15);
    expect(handR.y).toBeGreaterThan(handR0.y + 0.03);
    expect(handL.y).toBeGreaterThan(handL0.y + 0.03);
    // The torso leans forward: the head swings toward the fire and drops
    // a little (lean, not a jump).
    expect(head.z).toBeGreaterThan(head0.z + 0.1);
    expect(head.y).toBeLessThan(head0.y + 0.02);

    // Recovery: once cooking stops the idle hand positions return.
    for (let i = 0; i < 120; i++) char.update(1 / 30, 0, true, false, false);
    const handR1 = pos(char, 'playerPart_handR');
    expect(handR1.z).toBeCloseTo(handR0.z, 1);
    expect(handR1.y).toBeCloseTo(handR0.y, 1);
  });

  it('the eat pose wins the overlap with the cook pose', () => {
    const { char } = makeCharacter();
    for (let i = 0; i < 60; i++) char.update(1 / 30, 0, true, false, false);
    // Cooking AND eating at the same time (the ~0.7 s eat window after a
    // finished cook): the right hand goes to the mouth, not the fire.
    for (let i = 0; i < 45; i++) {
      char.update(1 / 30, 0, true, false, false, false, true, false, false, false, true);
    }
    expect(pos(char, 'playerPart_handR').y).toBeGreaterThan(1.1);
  });
});
