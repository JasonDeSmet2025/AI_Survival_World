import {
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Scene,
  TransformNode,
} from '@babylonjs/core';
import type { SharedMaterials } from './materials';

/**
 * Hand tool models (Visual Agent scope).
 *
 * Real multi-part models, not colored boxes: a shaped wooden handle with a
 * grip and butt (turned-cylinder silhouette), a chipped stone head, and a
 * wrapping band where the head meets the haft. Each tool is a TransformNode
 * whose origin sits at the centre of the fist that grips it, with the haft
 * running from just below the fist (butt) up to the head at +Y.
 *
 * That pivot convention matters: the rig parents the tool to the right
 * wrist, so geometry reaching far below the origin hangs out of the fist and
 * leaves the head next to the knuckles — which reads as an upside-down tool
 * buried in the arm. Keep heads/blades ABOVE the origin and only a short
 * butt BELOW it.
 */

export type ToolKind = 'stone_axe' | 'stone_pick' | 'sword';

const box = (
  scene: Scene,
  name: string,
  w: number,
  h: number,
  d: number,
  mat: PBRMaterial,
): Mesh => {
  const m = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene);
  m.material = mat;
  return m;
};

/** Turned wooden segment (cylinder with 8 facets reads as round at haft size). */
const rod = (
  scene: Scene,
  name: string,
  diameter: number,
  height: number,
  mat: PBRMaterial,
): Mesh => {
  const m = MeshBuilder.CreateCylinder(
    name,
    { height, diameterTop: diameter * 0.94, diameterBottom: diameter, tessellation: 8 },
    scene,
  );
  m.material = mat;
  return m;
};

/**
 * Wooden shaft running from y = 0 (butt, just below the fist) to y = length
 * (top, where the head sits): main grip + slightly thicker butt.
 */
function makeHandle(scene: Scene, wood: PBRMaterial, length: number, thickness = 0.045): TransformNode {
  const root = new TransformNode('handle', scene);
  const butt = rod(scene, 'handleButt', thickness * 1.25, length * 0.14, wood);
  const grip = rod(scene, 'handleGrip', thickness, length * 0.5, wood);
  const mid = rod(scene, 'handleMid', thickness * 1.1, length * 0.36, wood);
  // PARENT FIRST, then position: in this Babylon build ANY re-parenting
  // (`.parent =`, `addChild`, even `setParent`) preserves the WORLD transform
  // and rewrites the local numbers. A part positioned before parenting gets
  // its local y silently rewritten to -(parent height) — the axe/pick heads
  // "sank" out of the haft and hung below the fist (the upside-down tool the
  // user saw). Parenting while the child is still at the world origin makes
  // the world-preserving no-op, and the authored local offsets survive.
  grip.parent = root;
  grip.position.y = length * 0.39;
  mid.parent = root;
  mid.position.y = length * 0.82;
  butt.parent = root;
  butt.position.y = length * 0.07;
  return root;
}

/** How far above the butt the fist grips the haft (m). */
const GRIP_FROM_BUTT = 0.09;

/**
 * Stone axe: heavy chipped wedge with a beveled cutting edge, seated into
 * a short haft with a wrapping band.
 */
export function createAxe(scene: Scene, mats: SharedMaterials): TransformNode {
  const root = new TransformNode('tool_axe', scene);
  const L = 0.5;

  const handle = makeHandle(scene, mats.toolWood, L);
  handle.parent = root;
  handle.position.y = -GRIP_FROM_BUTT;

  // Head group at the top of the haft.
  const head = new TransformNode('axeHead', scene);
  head.parent = root;
  head.position.y = L - GRIP_FROM_BUTT - 0.03;
  head.rotation.z = -0.12; // wedge leans into the swing

  // Stone wedge: main body + wider cutting edge bevel.
  const stone = box(scene, 'axeStone', 0.16, 0.2, 0.055, mats.toolStone);
  stone.parent = head;
  stone.position.x = 0.085;
  stone.rotation.y = 0.16;

  const edge = box(scene, 'axeEdge', 0.21, 0.05, 0.062, mats.toolStone);
  edge.parent = head;
  edge.position.set(0.1, 0.085, 0.004);
  edge.rotation.z = -0.22;

  // Back (poll) of the head, slightly smaller than the edge.
  const poll = box(scene, 'axePoll', 0.19, 0.045, 0.05, mats.toolStone);
  poll.parent = head;
  poll.position.set(0.09, -0.095, 0);
  poll.rotation.z = 0.18;

  // Haft band.
  const band = box(scene, 'axeBand', 0.075, 0.11, 0.075, mats.playerBoots);
  band.parent = root;
  band.position.y = head.position.y;

  return root;
}

/**
 * Stone pickaxe: long shaft with a swept two-horn head — flat striking
 * faces plus curved tips, the classic miner's silhouette.
 */
export function createPickaxe(scene: Scene, mats: SharedMaterials): TransformNode {
  const root = new TransformNode('tool_pick', scene);
  const L = 0.62;

  const handle = makeHandle(scene, mats.toolWood, L, 0.042);
  handle.parent = root;
  handle.position.y = -GRIP_FROM_BUTT;

  const head = new TransformNode('pickHead', scene);
  head.parent = root;
  head.position.y = L - GRIP_FROM_BUTT - 0.03;

  // Center striking boss.
  const boss = box(scene, 'pickBoss', 0.13, 0.075, 0.05, mats.toolStone);
  boss.parent = head;

  // Two horns sweeping up and out.
  for (const side of [-1, 1] as const) {
    const horn = new TransformNode(`pickHorn${side > 0 ? 'R' : 'L'}`, scene);
    horn.parent = head;
    horn.position.x = side * 0.06;
    horn.rotation.z = side * -0.62;

    const sweep1 = box(scene, `pickSweep${side}`, 0.17, 0.042, 0.045, mats.toolStone);
    sweep1.parent = horn;
    sweep1.position.x = side * 0.085;

    const tip = box(scene, `pickTip${side}`, 0.09, 0.032, 0.04, mats.toolStone);
    tip.parent = horn;
    tip.position.set(side * 0.21, side * 0.02, 0);
    tip.rotation.z = side * -0.35;
  }

  // Haft band.
  const band = box(scene, 'pickBand', 0.072, 0.1, 0.072, mats.playerBoots);
  band.parent = root;
  band.position.y = head.position.y;

  return root;
}

/**
 * Stone sword: a chipped flint blade (tapered spine + lighter cutting
 * edge), a leather-wrapped grip and a small wood guard — the same knapped
 * look as the other stone tools, balanced for a one-handed swing.
 */
export function createSword(scene: Scene, mats: SharedMaterials): TransformNode {
  const root = new TransformNode('tool_sword', scene);

  // Grip: short turned rod, pommel cap at the base.
  const grip = rod(scene, 'swordGrip', 0.035, 0.16, mats.toolWood);
  grip.parent = root;
  grip.position.y = -0.06;
  const pommel = box(scene, 'swordPommel', 0.05, 0.03, 0.05, mats.playerBoots);
  pommel.parent = root;
  pommel.position.y = -0.145;

  // Guard across the blade base.
  const guard = box(scene, 'swordGuard', 0.14, 0.028, 0.045, mats.playerBoots);
  guard.parent = root;
  guard.position.y = 0.035;

  // Blade: main body tapering forward, plus a lighter edge line.
  const blade = box(scene, 'swordBlade', 0.055, 0.42, 0.018, mats.toolStone);
  blade.parent = root;
  blade.position.y = 0.27;
  const tip = box(scene, 'swordTip', 0.04, 0.1, 0.017, mats.toolStone);
  tip.parent = root;
  tip.position.y = 0.52;
  tip.rotation.z = 0.5;
  const edge = box(scene, 'swordEdge', 0.02, 0.4, 0.021, mats.playerAccent);
  edge.parent = root;
  edge.position.set(0.028, 0.27, 0);

  return root;
}

/** Create a tool for the given inventory item id, or null. */
export function createTool(kind: ToolKind, scene: Scene, mats: SharedMaterials): TransformNode {
  return kind === 'stone_axe'
    ? createAxe(scene, mats)
    : kind === 'stone_pick'
      ? createPickaxe(scene, mats)
      : createSword(scene, mats);
}
