import {
  Color3,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Scene,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import { ITEMS } from '../core/items';
import { createTool } from './tools';
import type { SharedMaterials } from './materials';

/**
 * Held-item models: what the survivor actually CARRIES in the right hand.
 *
 * The detailed tool trio (axe / pickaxe / sword) lives in tools.ts and is
 * reused here; everything else — the bow the player asked about, every
 * resource, food, potion and building part — gets a small readable prop
 * built from primitives, tinted with the very colour the HUD swatch uses
 * (ITEMS[id].color), so the hand and the hotbar finally show the same thing.
 *
 * Pivot convention (same as tools.ts): the origin is the fist. Props reach
 * up +Y; anything that reads better laid out (bow, shield, planks) is
 * oriented around that pivot. Keep props under ~0.55 m so they do not clip
 * through the character's own head.
 */

const box = (scene: Scene, name: string, w: number, h: number, d: number, mat: PBRMaterial): Mesh => {
  const m = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene);
  m.material = mat;
  return m;
};

const rod = (
  scene: Scene,
  name: string,
  diameter: number,
  height: number,
  mat: PBRMaterial,
): Mesh => {
  const m = MeshBuilder.CreateCylinder(
    name,
    { height, diameterTop: diameter * 0.95, diameterBottom: diameter, tessellation: 8 },
    scene,
  );
  m.material = mat;
  return m;
};

const ball = (scene: Scene, name: string, diameter: number, mat: PBRMaterial): Mesh => {
  const m = MeshBuilder.CreateSphere(name, { diameter, segments: 8 }, scene);
  m.material = mat;
  return m;
};

const rock = (scene: Scene, name: string, size: number, mat: PBRMaterial): Mesh => {
  const m = MeshBuilder.CreatePolyhedron(name, { type: 4, size: size * 0.5 }, scene);
  m.material = mat;
  return m;
};

const ring = (scene: Scene, name: string, diameter: number, tube: number, mat: PBRMaterial): Mesh => {
  const m = MeshBuilder.CreateTorus(name, { diameter, thickness: tube, tessellation: 12 }, scene);
  m.material = mat;
  return m;
};

const disc = (scene: Scene, name: string, diameter: number, mat: PBRMaterial): Mesh => {
  const m = MeshBuilder.CreateCylinder(name, { diameter, height: 0.02, tessellation: 16 }, scene);
  m.material = mat;
  return m;
};

/**
 * Per-colour materials, cached per scene (two variants: plain and softly
 * glowing, the glow used for potions/elements/torch heads so they read as
 * "alive" even at night). The cache means a hundred pick-swap cycles never
 * allocate a material or recompile a shader — every prop shares the handful
 * of programs that the PBR feature set needs.
 */
const matCache = new WeakMap<Scene, Map<string, PBRMaterial>>();

function tintMat(scene: Scene, rgb: [number, number, number], glow = 0): PBRMaterial {
  let byScene = matCache.get(scene);
  if (!byScene) {
    byScene = new Map();
    matCache.set(scene, byScene);
  }
  const key = `${rgb.map((c) => Math.round(c * 997)).join(',')}@${glow}`;
  let m = byScene.get(key);
  if (!m) {
    m = new PBRMaterial(`held_${key}`, scene);
    m.albedoColor = new Color3(rgb[0], rgb[1], rgb[2]);
    m.roughness = 0.62;
    m.metallic = glow > 0 ? 0.25 : 0.06;
    if (glow > 0) {
      m.emissiveColor = new Color3(rgb[0] * glow, rgb[1] * glow, rgb[2] * glow);
    }
    byScene.set(key, m);
  }
  return m;
}

/** The item's HUD colour — the hand shows what the hotbar promises. */
function itemColor(itemId: string): [number, number, number] {
  return ITEMS[itemId]?.color ?? [0.7, 0.7, 0.7];
}

/** Tube along a curved path — used for the bow limb and rope coils. */
function tube(scene: Scene, name: string, path: Vector3[], radius: number, mat: PBRMaterial): Mesh {
  const m = MeshBuilder.CreateTube(name, { path, radius, tessellation: 6 }, scene);
  m.material = mat;
  return m;
}

function parentAll(root: TransformNode, meshes: Mesh[]): void {
  // setParent keeps the LOCAL transform. The `.parent` setter would preserve
  // world position and fight the authored local positions below.
  for (const m of meshes) m.setParent(root);
}

/** A little log laid across the forearm: the world's most carried object. */
function buildLog(scene: Scene, itemId: string): TransformNode {
  const root = new TransformNode('held_log', scene);
  const wood = tintMat(scene, itemColor(itemId));
  const log = rod(scene, 'logBody', 0.085, 0.34, wood);
  log.rotation.z = 1.35; // lie it across the arm, reads as "carried"
  log.position.set(0.02, 0.11, 0);
  const ringA = disc(scene, 'logEndA', 0.083, tintMat(scene, [0.74, 0.6, 0.4]));
  ringA.rotation.z = 1.35 - Math.PI / 2;
  ringA.position.set(-0.155, 0.055, 0);
  parentAll(root, [log, ringA]);
  return root;
}

/** Berries: a cluster of three, plus the little stalk they hang on. */
function buildBerries(scene: Scene, itemId: string): TransformNode {
  const root = new TransformNode('held_berries', scene);
  const skin = tintMat(scene, itemColor(itemId));
  const offsets: Array<[number, number, number]> = [
    [0, 0.095, 0],
    [-0.045, 0.06, 0.03],
    [0.04, 0.055, -0.03],
  ];
  const parts: Mesh[] = [];
  for (const [x, y, z] of offsets) {
    const b = ball(scene, 'berry', 0.055, skin);
    b.position.set(x, y, z);
    parts.push(b);
  }
  const stem = rod(scene, 'berryStem', 0.014, 0.09, tintMat(scene, [0.35, 0.5, 0.25]));
  stem.position.set(0, 0.13, 0);
  stem.rotation.z = 0.25;
  parts.push(stem);
  parentAll(root, parts);
  return root;
}

/** Joint of meat: a squashed rounded cut with a slimmer bone hint. */
function buildMeat(scene: Scene, itemId: string): TransformNode {
  const root = new TransformNode('held_meat', scene);
  const cut = ball(scene, 'meat', 0.17, tintMat(scene, itemColor(itemId)));
  cut.scaling.set(1, 0.55, 0.75);
  cut.position.y = 0.1;
  const bone = rod(scene, 'meatBone', 0.028, 0.13, tintMat(scene, [0.9, 0.87, 0.78]));
  bone.rotation.z = 1.2;
  bone.position.set(0.075, 0.09, 0);
  parentAll(root, [cut, bone]);
  return root;
}

/** Potion bottle: glass body + glowing core + cork. */
function buildBottle(scene: Scene, itemId: string): TransformNode {
  const root = new TransformNode('held_bottle', scene);
  const rgb = itemColor(itemId);
  const glass = tintMat(scene, [0.78, 0.85, 0.92]);
  const body = rod(scene, 'bottleBody', 0.075, 0.15, glass);
  body.position.y = 0.095;
  const shoulder = ball(scene, 'bottleShoulder', 0.06, glass);
  shoulder.position.y = 0.18;
  const neck = rod(scene, 'bottleNeck', 0.028, 0.05, glass);
  neck.position.y = 0.215;
  const cork = rod(scene, 'bottleCork', 0.03, 0.025, tintMat(scene, [0.6, 0.42, 0.24]));
  cork.position.y = 0.245;
  // The liquid: slightly narrower, glowing — the bottle reads as filled.
  const brew = rod(scene, 'bottleBrew', 0.058, 0.12, tintMat(scene, rgb, 0.7));
  brew.position.y = 0.09;
  parentAll(root, [body, shoulder, neck, cork, brew]);
  return root;
}

/**
 * The hunting bow the player could never see: a limb curved out of the
 * fist, silk string strung between the nocks, a leather grip mid-riser.
 * Held like a lantern — the plane of the bow faces outboard.
 */
function buildBow(scene: Scene): TransformNode {
  const root = new TransformNode('held_bow', scene);
  const wood = tintMat(scene, itemColor('bow'));
  const limbPts: Vector3[] = [];
  for (let i = 0; i <= 8; i++) {
    const a = -Math.PI / 2.4 + (i / 8) * (Math.PI / 1.2);
    limbPts.push(new Vector3(Math.cos(a) * 0.26 + 0.2, Math.sin(a) * 0.26, 0));
  }
  const limb = tube(scene, 'bowLimb', limbPts, 0.017, wood);
  // String: a straight silk line between the two limb tips.
  const tipA = limbPts[0];
  const tipB = limbPts[limbPts.length - 1];
  const str = tube(
    scene,
    'bowString',
    [new Vector3(tipA.x, tipA.y - 0.005, 0), new Vector3(tipB.x, tipB.y + 0.005, 0)],
    0.004,
    tintMat(scene, ITEMS.silk.color, 0.15),
  );
  const grip = box(scene, 'bowGrip', 0.07, 0.035, 0.035, tintMat(scene, [0.32, 0.22, 0.13]));
  grip.position.set(0.205, 0.0, 0);
  // A spare nocked arrow lies along the limb so the silhouette says BOW.
  const shaft = rod(scene, 'bowArrow', 0.012, 0.34, tintMat(scene, [0.75, 0.62, 0.4]));
  shaft.rotation.z = Math.PI / 2;
  shaft.position.set(0.31, 0.01, 0.012);
  const head = rock(scene, 'bowArrowHead', 0.03, tintMat(scene, [0.75, 0.76, 0.8]));
  head.position.set(0.47, 0.01, 0.012);
  parentAll(root, [limb, str, grip, shaft, head]);
  return root;
}

/** Round shield: planks, rim and a boss — carried face-out like a tray. */
function buildShield(scene: Scene): TransformNode {
  const root = new TransformNode('held_shield', scene);
  const face = disc(scene, 'shieldFace', 0.34, tintMat(scene, itemColor('shield')));
  face.rotation.x = Math.PI / 2;
  face.rotation.y = Math.PI / 2; // face outboard (+X)
  face.position.y = 0.16;
  const rim = ring(scene, 'shieldRim', 0.34, 0.022, tintMat(scene, [0.3, 0.2, 0.12]));
  rim.rotation.y = Math.PI / 2;
  rim.position.y = 0.16;
  const boss = rock(scene, 'shieldBoss', 0.07, tintMat(scene, [0.6, 0.6, 0.62]));
  boss.position.set(0.03, 0.16, 0);
  parentAll(root, [face, rim, boss]);
  return root;
}

/** Arrow held point-up: shaft, knapped head, fletching. */
function buildArrow(scene: Scene): TransformNode {
  const root = new TransformNode('held_arrow', scene);
  const shaft = rod(scene, 'arrowShaft', 0.012, 0.46, tintMat(scene, itemColor('arrow')));
  shaft.position.y = 0.2;
  const head = rock(scene, 'arrowHead', 0.035, tintMat(scene, [0.75, 0.76, 0.8]));
  head.position.y = 0.44;
  const fletchA = box(scene, 'fletchA', 0.05, 0.06, 0.006, tintMat(scene, [0.85, 0.8, 0.7]));
  fletchA.position.set(0.015, 0.035, 0);
  const fletchB = fletchA.clone('fletchB');
  fletchB.rotation.y = Math.PI / 2;
  fletchB.position.set(0, 0.035, 0.015);
  parentAll(root, [shaft, head, fletchA, fletchB]);
  return root;
}

/** Coil of rope: two stacked loops, classic lasso bundle. */
function buildRope(scene: Scene): TransformNode {
  const root = new TransformNode('held_rope', scene);
  const hemp = tintMat(scene, itemColor('rope'));
  const c1 = ring(scene, 'ropeA', 0.17, 0.035, hemp);
  c1.position.y = 0.09;
  const c2 = ring(scene, 'ropeB', 0.14, 0.032, hemp);
  c2.position.y = 0.125;
  c2.rotation.x = 0.15;
  parentAll(root, [c1, c2]);
  return root;
}

/** Standing torch: haft + glowing head (placement adds the real light). */
function buildTorch(scene: Scene): TransformNode {
  const root = new TransformNode('held_torch', scene);
  const haft = rod(scene, 'torchHaft', 0.03, 0.3, tintMat(scene, [0.45, 0.32, 0.18]));
  haft.position.y = 0.12;
  const head = ball(scene, 'torchFlame', 0.075, tintMat(scene, itemColor('torch'), 1.4));
  head.position.y = 0.31;
  parentAll(root, [haft, head]);
  return root;
}

/** Herb bundle: stem + a few leaves, tied. */
function buildHerb(scene: Scene): TransformNode {
  const root = new TransformNode('held_herb', scene);
  const green = tintMat(scene, itemColor('herb'));
  const stem = rod(scene, 'herbStem', 0.014, 0.22, tintMat(scene, [0.4, 0.55, 0.3]));
  stem.position.y = 0.14;
  const tie = ring(scene, 'herbTie', 0.05, 0.014, tintMat(scene, [0.7, 0.55, 0.35]));
  tie.position.y = 0.06;
  const parts: Mesh[] = [stem, tie];
  for (let i = 0; i < 3; i++) {
    const leaf = box(scene, `herbLeaf${i}`, 0.015, 0.09, 0.005, green);
    leaf.position.set(0.01 * (i - 1), 0.22 + 0.015 * i, 0.012 * (i - 1));
    leaf.rotation.z = 0.25 - i * 0.22;
    parts.push(leaf);
  }
  parentAll(root, parts);
  return root;
}

/** Raw element: a glowing nugget of the stuff (powder, dew, feather, clod). */
function buildElement(scene: Scene, itemId: string): TransformNode {
  const root = new TransformNode('held_element', scene);
  const rgb = itemColor(itemId);
  if (itemId === 'element_air') {
    const feather = box(scene, 'featherSpine', 0.012, 0.26, 0.012, tintMat(scene, rgb, 0.35));
    feather.position.y = 0.15;
    feather.rotation.z = 0.12;
    const vane = box(scene, 'featherVane', 0.055, 0.16, 0.006, tintMat(scene, rgb, 0.5));
    vane.position.set(0.02, 0.2, 0);
    vane.rotation.z = 0.12;
    parentAll(root, [feather, vane]);
    return root;
  }
  if (itemId === 'element_water') {
    const dew = ball(scene, 'dew', 0.1, tintMat(scene, rgb, 0.55));
    dew.scaling.set(1, 1.25, 1); // teardrop
    dew.position.y = 0.12;
    parentAll(root, [dew]);
    return root;
  }
  const nug = rock(scene, 'element', 0.1, tintMat(scene, rgb, itemId === 'element_fire' ? 1.3 : 0.3));
  nug.position.y = 0.11;
  parentAll(root, [nug]);
  return root;
}

/** A plank-ish slab for every building item, with item-specific furniture. */
function buildPlank(scene: Scene, itemId: string): TransformNode {
  const root = new TransformNode('held_plank', scene);
  const wood = tintMat(scene, itemColor(itemId));
  const stone = tintMat(scene, itemColor('stone_wall'));
  switch (itemId) {
    case 'door': {
      const slab = box(scene, 'doorSlab', 0.16, 0.3, 0.03, wood);
      slab.position.y = 0.16;
      const knob = ball(scene, 'doorKnob', 0.025, tintMat(scene, [0.8, 0.62, 0.25]));
      knob.position.set(0.06, 0.16, 0.025);
      parentAll(root, [slab, knob]);
      break;
    }
    case 'workbench': {
      const top = box(scene, 'benchTop', 0.22, 0.03, 0.16, wood);
      top.position.y = 0.2;
      const parts: Mesh[] = [top];
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        const leg = rod(scene, 'benchLeg', 0.025, 0.18, wood);
        leg.position.set(sx * 0.09, 0.1, sz * 0.06);
        parts.push(leg);
      }
      parentAll(root, parts);
      break;
    }
    case 'bed': {
      const frame = box(scene, 'bedFrame', 0.2, 0.05, 0.34, wood);
      frame.position.y = 0.1;
      const mat = box(scene, 'bedMat', 0.17, 0.04, 0.3, tintMat(scene, [0.72, 0.3, 0.32]));
      mat.position.y = 0.145;
      parentAll(root, [frame, mat]);
      break;
    }
    case 'campfire': {
      const parts: Mesh[] = [];
      for (let i = 0; i < 3; i++) {
        const l = rod(scene, `cfLog${i}`, 0.035, 0.24, wood);
        l.rotation.z = Math.PI / 2.2;
        l.rotation.y = (i / 3) * Math.PI;
        l.position.y = 0.06 + i * 0.015;
        parts.push(l);
      }
      parentAll(root, parts);
      break;
    }
    case 'fence': {
      const parts: Mesh[] = [];
      for (const sx of [-1, 1] as const) {
        const post = rod(scene, `fencePost${sx}`, 0.028, 0.26, wood);
        post.position.set(0, 0.14, sx * 0.09);
        post.rotation.x = Math.PI / 2;
        post.rotation.z = Math.PI / 2;
        parts.push(post);
      }
      const rail = rod(scene, 'fenceRail', 0.02, 0.2, wood);
      rail.rotation.x = Math.PI / 2;
      rail.position.set(0, 0.16, 0);
      rail.rotation.z = Math.PI / 2;
      parts.push(rail);
      parentAll(root, parts);
      break;
    }
    case 'stairs': {
      const a = box(scene, 'stepA', 0.18, 0.05, 0.12, wood);
      a.position.set(0, 0.06, -0.05);
      const b = box(scene, 'stepB', 0.18, 0.05, 0.12, wood);
      b.position.set(0, 0.12, 0.05);
      parentAll(root, [a, b]);
      break;
    }
    case 'planter': {
      const pot = MeshBuilder.CreateCylinder(
        'pot',
        { diameterTop: 0.13, diameterBottom: 0.09, height: 0.1, tessellation: 10 },
        scene,
      );
      pot.material = tintMat(scene, [0.55, 0.34, 0.22]);
      pot.position.y = 0.07;
      const soil = disc(scene, 'soil', 0.115, tintMat(scene, [0.28, 0.2, 0.13]));
      soil.position.y = 0.122;
      const sprout = box(scene, 'sprout', 0.02, 0.07, 0.008, tintMat(scene, [0.4, 0.65, 0.3]));
      sprout.position.y = 0.16;
      parentAll(root, [pot, soil, sprout]);
      break;
    }
    case 'sign': {
      const post = rod(scene, 'signPost', 0.025, 0.26, wood);
      post.position.y = 0.12;
      const board = box(scene, 'signBoard', 0.2, 0.1, 0.02, tintMat(scene, [0.62, 0.46, 0.28]));
      board.position.y = 0.28;
      parentAll(root, [post, board]);
      break;
    }
    case 'roof': {
      const panel = box(scene, 'roofPanel', 0.24, 0.03, 0.2, tintMat(scene, itemColor('roof')));
      panel.position.y = 0.16;
      panel.rotation.z = 0.5;
      parentAll(root, [panel]);
      break;
    }
    case 'stone_wall': {
      const b = box(scene, 'stoneBlock', 0.2, 0.12, 0.06, stone);
      b.position.y = 0.11;
      const b2 = box(scene, 'stoneBlock2', 0.12, 0.06, 0.06, stone);
      b2.position.set(0.05, 0.2, 0);
      parentAll(root, [b, b2]);
      break;
    }
    case 'carpet': {
      const rug = box(scene, 'rug', 0.24, 0.015, 0.18, tintMat(scene, itemColor('carpet')));
      rug.position.y = 0.14;
      const fringe = rod(scene, 'rugFold', 0.03, 0.2, tintMat(scene, [0.8, 0.8, 0.75]));
      fringe.rotation.z = Math.PI / 2;
      fringe.position.set(0, 0.16, 0.07);
      parentAll(root, [rug, fringe]);
      break;
    }
    default: {
      // wall / floor and any future plank family: a carried board.
      const board = box(scene, 'board', 0.26, itemId === 'wall' ? 0.18 : 0.04, 0.05, wood);
      board.position.y = itemId === 'wall' ? 0.12 : 0.1;
      const cleat = box(scene, 'cleat', 0.18, 0.012, 0.014, tintMat(scene, [0.4, 0.3, 0.18]));
      cleat.position.set(0, board.position.y, 0.03);
      parentAll(root, [board, cleat]);
    }
  }
  return root;
}

/**
 * Build the prop for an inventory item id, or null for items that have no
 * hand model (the recipe notes). Delegates to the detailed tool models in
 * tools.ts for axe/pickaxe/sword.
 */
export function createHeldItem(itemId: string, scene: Scene, mats: SharedMaterials): TransformNode | null {
  const def = ITEMS[itemId];
  if (!def) return null;
  switch (itemId) {
    case 'stone_axe':
      return createTool('stone_axe', scene, mats);
    case 'stone_pick':
      return createTool('stone_pick', scene, mats);
    case 'sword':
      return createTool('sword', scene, mats);
    case 'bow':
      return buildBow(scene);
    case 'arrow':
      return buildArrow(scene);
    case 'shield':
      return buildShield(scene);
    case 'rope':
      return buildRope(scene);
    case 'torch':
      return buildTorch(scene);
    case 'herb':
      return buildHerb(scene);
    case 'wood':
      return buildLog(scene, itemId);
    case 'berry':
    case 'cooked_berry':
      return buildBerries(scene, itemId);
    case 'raw_mutton':
    case 'cooked_mutton':
    case 'raw_beef':
    case 'cooked_beef':
      return buildMeat(scene, itemId);
    case 'salve':
    case 'potion_heal':
    case 'potion_swift':
    case 'potion_night':
    case 'potion_fire':
    case 'potion_strength':
    case 'potion_tough':
      return buildBottle(scene, itemId);
    case 'element_fire':
    case 'element_water':
    case 'element_air':
    case 'element_earth':
      return buildElement(scene, itemId);
    case 'stone':
    case 'wool':
    case 'leather':
    case 'gold':
    case 'silk':
    case 'stew':
    case 'fiber':
      return buildLump(scene, itemId);
    default:
      // The building family: walls, floors, beds, workbenches, everything
      // you would carry to a build site.
      if (def.kind === 'building') return buildPlank(scene, itemId);
      return buildLump(scene, itemId);
  }
}

/**
 * Generic "stuff in a sack" prop for the loose resources: gold coins, wool,
 * leather, a stone, a silk spool, a stew pot. Shape chosen by kind so each
 * family reads differently even before the tint.
 */
function buildLump(scene: Scene, itemId: string): TransformNode {
  const root = new TransformNode('held_lump', scene);
  const rgb = itemColor(itemId);
  switch (itemId) {
    case 'gold': {
      for (let i = 0; i < 3; i++) {
        const coin = disc(scene, `coin${i}`, 0.075 - i * 0.008, tintMat(scene, rgb, 0.25));
        coin.rotation.x = Math.PI / 2;
        coin.rotation.z = i * 0.5;
        coin.position.set(i * 0.012 - 0.012, 0.06 + i * 0.022, i * 0.008);
        coin.setParent(root);
      }
      return root;
    }
    case 'silk': {
      const spool = rod(scene, 'silkSpool', 0.09, 0.09, tintMat(scene, rgb, 0.1));
      spool.position.y = 0.1;
      const f1 = ring(scene, 'silkFlange1', 0.115, 0.014, tintMat(scene, [0.5, 0.38, 0.24]));
      f1.position.y = 0.055;
      const f2 = ring(scene, 'silkFlange2', 0.115, 0.014, tintMat(scene, [0.5, 0.38, 0.24]));
      f2.position.y = 0.145;
      parentAll(root, [spool, f1, f2]);
      return root;
    }
    case 'leather': {
      const hide = box(scene, 'hide', 0.19, 0.018, 0.15, tintMat(scene, rgb));
      hide.rotation.z = 0.1;
      hide.position.y = 0.1;
      const corner = box(scene, 'hideCorner', 0.06, 0.016, 0.05, tintMat(scene, [rgb[0] * 0.8, rgb[1] * 0.8, rgb[2] * 0.8]));
      corner.position.set(-0.07, 0.115, 0.04);
      corner.rotation.z = -0.35;
      parentAll(root, [hide, corner]);
      return root;
    }
    case 'wool': {
      // Two soft bolls read as fleece better than one hard sphere.
      const a = ball(scene, 'woolA', 0.14, tintMat(scene, rgb));
      a.position.y = 0.1;
      const b = ball(scene, 'woolB', 0.1, tintMat(scene, rgb));
      b.position.set(0.055, 0.15, -0.01);
      parentAll(root, [a, b]);
      return root;
    }
    case 'stew': {
      const pot = MeshBuilder.CreateCylinder(
        'stewPot',
        { diameterTop: 0.13, diameterBottom: 0.1, height: 0.1, tessellation: 12 },
        scene,
      );
      pot.material = tintMat(scene, [0.32, 0.32, 0.34]);
      pot.position.y = 0.08;
      const broth = disc(scene, 'stewBroth', 0.115, tintMat(scene, rgb, 0.2));
      broth.position.y = 0.13;
      const handle = ring(scene, 'stewHandle', 0.14, 0.01, tintMat(scene, [0.2, 0.2, 0.22]));
      handle.rotation.x = Math.PI / 2.4;
      handle.position.y = 0.12;
      parentAll(root, [pot, broth, handle]);
      return root;
    }
    case 'stone':
    case 'fiber':
    default: {
      // Loose rock / generic resource: a chunky nugget in the fist.
      const kind = ITEMS[itemId]?.kind;
      if (kind === 'food') {
        const bun = ball(scene, 'bun', 0.11, tintMat(scene, rgb));
        bun.scaling.set(1, 0.8, 1);
        bun.position.y = 0.1;
        bun.setParent(root);
        return root;
      }
      const chunk = rock(scene, 'chunk', 0.11, tintMat(scene, rgb));
      chunk.rotation.y = 0.7;
      chunk.position.y = 0.11;
      chunk.setParent(root);
      return root;
    }
  }
}
