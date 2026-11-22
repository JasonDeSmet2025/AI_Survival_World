import { describe, expect, it } from 'vitest';
import {
  Color3,
  Matrix,
  Mesh,
  NullEngine,
  PBRMaterial,
  Scene,
  Vector3,
} from '@babylonjs/core';
import { HELD_TOOL_POSE, PlayerCharacter } from '../game/player/player';
import type { SharedMaterials } from '../game/visual/materials';

/**
 * Regression guard for the held-tool placement.
 *
 * Reported bug: the axe/sword/pick looked upside down and sat "inside the
 * arm". Root causes, both measured here:
 *  1. the tool models had their origin near the HEAD, so the whole haft hung
 *     below the fist and the head ended up at the knuckles;
 *  2. the tool was parented to the wrist with no offset — and the wrist's
 *     local +Y runs straight back up the forearm (elbow in wrist space is
 *     (0, 0.26, 0)), so the shaft was drawn *through* the arm.
 *
 * The check samples points along the right arm's bone axis and tests them
 * against each tool part's own box (in the part's local space), which is
 * exact for these box/cylinder primitives — unlike sphere or AABB
 * approximations, which both false-positive and false-negative.
 */

const KINDS = ['stone_axe', 'stone_pick', 'sword'] as const;
type Kind = (typeof KINDS)[number];
type Stance = 'idle' | 'walk' | 'windup' | 'strike' | 'slash' | 'carry';
const STANCES: Stance[] = ['idle', 'walk', 'windup', 'strike', 'slash', 'carry'];

/** The fist is allowed to touch the tool: samples closer than this to the wrist are ignored. */
const GRIP_RADIUS = 0.11;

function makeMats(scene: Scene): SharedMaterials {
  const pbr = (name: string, color: Color3): PBRMaterial => {
    const m = new PBRMaterial(name, scene);
    m.albedoColor = color;
    return m;
  };
  return {
    playerBody: pbr('b', new Color3(0.4, 0.45, 0.5)),
    playerPants: pbr('p', new Color3(0.25, 0.25, 0.28)),
    playerBoots: pbr('bo', new Color3(0.3, 0.2, 0.12)),
    playerSkin: pbr('s', new Color3(0.8, 0.65, 0.5)),
    playerHair: pbr('h', new Color3(0.15, 0.1, 0.06)),
    playerAccent: pbr('a', new Color3(0.62, 0.3, 0.13)),
    backpack: pbr('pk', new Color3(0.45, 0.35, 0.2)),
    toolWood: pbr('w', new Color3(0.5, 0.35, 0.2)),
    toolStone: pbr('st', new Color3(0.5, 0.5, 0.5)),
  } as unknown as SharedMaterials;
}

function refresh(scene: Scene, char: PlayerCharacter): void {
  char.root.computeWorldMatrix(true);
  for (const n of scene.transformNodes) n.computeWorldMatrix(true);
  for (const m of scene.meshes) m.computeWorldMatrix(true);
}

interface Measure {
  /** Name of the worst tool part found inside the arm ('' when clean). */
  inside: string;
  /** Highest tool part above the wrist (m). */
  headAbove: number;
  /** Angle (deg) between the tool axis and straight up. */
  tilt: number;
  /** Tool axis . world +Z (1 = pointing straight ahead of the character). */
  forward: number;
  /** How far the tool sticks out beyond the body side, m. */
  outboard: number;
}

function rig(kind: Kind, stance: Stance): { scene: Scene; char: PlayerCharacter; measure: () => Measure } {
  const scene = new Scene(new NullEngine());
  const char = new PlayerCharacter(scene, makeMats(scene));
  const settle = (s: Stance): void => {
    // windup/strike sample the harvest cycle, slash the melee overlay.
    const frames = s === 'windup' ? 9 : s === 'strike' ? 13 : s === 'slash' ? 6 : 40;
    if (s === 'slash') char.startSwing();
    for (let i = 0; i < frames; i++) {
      char.update(1 / 30, s === 'walk' ? 4 : 0, true, false, false, s === 'windup' || s === 'strike');
    }
  };
  settle('idle');
  char.setTool(kind);
  settle(stance);

  return {
    scene,
    char,
    measure: (): Measure => {
      refresh(scene, char);
      const node = (n: string) => scene.getTransformNodeByName(n)!.getAbsolutePosition();
      const shoulder = node('playerArmR');
      const elbow = node('playerElbowR');
      const wrist = node('playerWristR');
      const parts = (char.root.getChildMeshes(false) as Mesh[]).filter(
        (m) => !m.name.startsWith('playerPart_'),
      );

      // Bone samples along shoulder -> elbow -> wrist, excluding the fist.
      const samples: Vector3[] = [];
      for (const [a, b] of [[shoulder, elbow], [elbow, wrist]] as const) {
        const len = b.subtract(a).length();
        const steps = Math.max(2, Math.ceil(len / 0.02));
        for (let i = 0; i <= steps; i++) {
          const p = Vector3.Lerp(a, b, i / steps);
          if (p.subtract(wrist).length() >= GRIP_RADIUS) samples.push(p);
        }
      }

      let inside = '';
      let outboard = -10;
      let head = wrist.clone();
      for (const t of parts) {
        const bb = t.getBoundingInfo().boundingBox;
        const inv = Matrix.Invert(t.getWorldMatrix());
        for (const p of samples) {
          const lp = Vector3.TransformCoordinates(p, inv);
          if (
            Math.abs(lp.x) <= bb.maximum.x &&
            Math.abs(lp.y) <= bb.maximum.y &&
            Math.abs(lp.z) <= bb.maximum.z
          ) {
            inside = `${t.name} @ ${p.asArray().map((v) => v.toFixed(2)).join(',')}`;
          }
        }
        const wp = t.getAbsolutePosition();
        if (wp.y > head.y) head = wp;
        outboard = Math.max(outboard, wp.x);
      }
      const axis = head.subtract(wrist).normalize();
      return {
        inside,
        headAbove: head.y - wrist.y,
        tilt: (Math.acos(Math.max(-1, Math.min(1, axis.y))) * 180) / Math.PI,
        forward: axis.z,
        outboard,
      };
    },
  };
}

describe('held tool sits outside the arm', () => {
  for (const kind of KINDS) {
    for (const stance of STANCES) {
      it(`${kind} clears the arm while ${stance}`, () => {
        const r = rig(kind, stance);
        const m = r.measure();
        r.scene.dispose();
        expect(m.inside, `${kind} while ${stance}: part ${m.inside} is inside the arm`).toBe('');
      });
    }
  }
});

describe('held tool is gripped the right way round', () => {
  for (const kind of KINDS) {
    it(`${kind} head sits above the fist, haft roughly vertical in idle`, () => {
      const r = rig(kind, 'idle');
      const m = r.measure();
      r.scene.dispose();
      expect(m.headAbove, `${kind}: head must sit well above the wrist`).toBeGreaterThan(0.15);
      expect(m.tilt, `${kind}: haft must not lie across the arm`).toBeLessThan(60);
      expect(m.outboard, `${kind}: tool must stay outboard of the torso`).toBeGreaterThan(0.35);
      expect(m.forward, `${kind}: tool must point ahead, not back up the arm`).toBeGreaterThan(0.3);
    });
  }

  it('tool returns to its grip pose after a slash (no wrist drift)', () => {
    const scene = new Scene(new NullEngine());
    const char = new PlayerCharacter(scene, makeMats(scene));
    for (let i = 0; i < 10; i++) char.update(1 / 30, 0, true, false, false);
    char.setTool('stone_axe');
    const tool = scene.getTransformNodeByName('tool_axe')!;
    expect(tool.rotation.x).toBeCloseTo(HELD_TOOL_POSE.rotationX, 5);
    // Three slashes back to back: the pose must not creep away from base.
    for (let round = 0; round < 3; round++) {
      char.startSwing();
      for (let i = 0; i < 20; i++) char.update(1 / 30, 0, true, false, false);
      expect(tool.rotation.x, `round ${round} ended away from the grip pose`).toBeCloseTo(
        HELD_TOOL_POSE.rotationX,
        5,
      );
    }
    scene.dispose();
  });
});
