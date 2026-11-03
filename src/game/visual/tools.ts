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
 * grip and butt, a chipped stone head, and a wrapping band where the head
 * meets the haft. Each tool is a TransformNode whose origin sits at the
 * hand position, with the tool extending toward +Y.
 */

export type ToolKind = 'stone_axe' | 'stone_pick';

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

/** Wooden shaft: main grip + slightly thicker butt, subtle forward taper. */
function makeHandle(scene: Scene, wood: PBRMaterial, length: number, thickness = 0.045): TransformNode {
  const root = new TransformNode('handle', scene);
  const grip = box(scene, 'handleGrip', thickness, length * 0.62, thickness, wood);
  grip.position.y = -length * 0.31;
  const mid = box(scene, 'handleMid', thickness * 1.12, length * 0.4, thickness * 1.12, wood);
  mid.position.y = length * 0.02;
  const butt = box(scene, 'handleButt', thickness * 1.25, length * 0.1, thickness * 1.25, wood);
  butt.position.y = length * 0.22;
  grip.parent = root;
  mid.parent = root;
  butt.parent = root;
  return root;
}

/**
 * Stone axe: heavy chipped wedge with a beveled cutting edge, seated into
 * a short haft with a wrapping band.
 */
export function createAxe(scene: Scene, mats: SharedMaterials): TransformNode {
  const root = new TransformNode('tool_axe', scene);
  const L = 0.52;

  const handle = makeHandle(scene, mats.toolWood, L);
  handle.position.y = -0.06;
  handle.parent = root;

  // Head group at the top of the haft.
  const head = new TransformNode('axeHead', scene);
  head.parent = root;
  head.position.y = L * 0.24 - 0.06;
  head.rotation.z = -0.12; // wedge leans into the swing

  // Stone wedge: main body + wider cutting edge bevel.
  const stone = box(scene, 'axeStone', 0.16, 0.2, 0.055, mats.toolStone);
  stone.position.x = 0.085;
  stone.rotation.y = 0.16;
  head.addChild(stone);

  const edge = box(scene, 'axeEdge', 0.21, 0.05, 0.062, mats.toolStone);
  edge.position.set(0.1, 0.085, 0.004);
  edge.rotation.z = -0.22;
  head.addChild(edge);

  // Back (poll) of the head, slightly smaller than the edge.
  const poll = box(scene, 'axePoll', 0.19, 0.045, 0.05, mats.toolStone);
  poll.position.set(0.09, -0.095, 0);
  poll.rotation.z = 0.18;
  head.addChild(poll);

  // Haft band.
  const band = box(scene, 'axeBand', 0.075, 0.11, 0.075, mats.playerBoots);
  band.position.y = head.position.y;
  root.addChild(band);

  return root;
}

/**
 * Stone pickaxe: long shaft with a swept two-horn head — flat striking
 * faces plus curved tips, the classic miner's silhouette.
 */
export function createPickaxe(scene: Scene, mats: SharedMaterials): TransformNode {
  const root = new TransformNode('tool_pick', scene);
  const L = 0.78;

  const handle = makeHandle(scene, mats.toolWood, L, 0.042);
  handle.position.y = -0.05;
  handle.parent = root;

  const head = new TransformNode('pickHead', scene);
  head.parent = root;
  head.position.y = L * 0.24 - 0.05;

  // Center striking boss.
  const boss = box(scene, 'pickBoss', 0.13, 0.075, 0.05, mats.toolStone);
  head.addChild(boss);

  // Two horns sweeping up and out.
  for (const side of [-1, 1] as const) {
    const horn = new TransformNode(`pickHorn${side > 0 ? 'R' : 'L'}`, scene);
    horn.parent = head;
    horn.position.x = side * 0.06;
    horn.rotation.z = side * -0.62;

    const sweep1 = box(scene, `pickSweep${side}`, 0.17, 0.042, 0.045, mats.toolStone);
    sweep1.position.x = side * 0.085;
    horn.addChild(sweep1);

    const tip = box(scene, `pickTip${side}`, 0.09, 0.032, 0.04, mats.toolStone);
    tip.position.set(side * 0.21, side * 0.02, 0);
    tip.rotation.z = side * -0.35;
    horn.addChild(tip);
  }

  // Haft band.
  const band = box(scene, 'pickBand', 0.072, 0.1, 0.072, mats.playerBoots);
  band.position.y = head.position.y;
  root.addChild(band);

  return root;
}

/** Create a tool for the given inventory item id, or null. */
export function createTool(kind: ToolKind, scene: Scene, mats: SharedMaterials): TransformNode {
  return kind === 'stone_axe' ? createAxe(scene, mats) : createPickaxe(scene, mats);
}
