/**
 * The second island: its bridge and its village — visuals for
 * world/villageIsle.ts (pure geometry, authored layout, no procedural mesh).
 *
 * The rule the tower set: every wall and every plank drawn here is the SAME
 * box/slab the player controller collides with (`villageWalls()`,
 * `bridgePlan().decks`), so what you see is what you bump into. Cottages have
 * a real doorway you can walk through, because the collision leaves the same
 * gap the door panel stands in.
 *
 * On top of the honest boxes sit the decorative layers: hip roofs, chimneys,
 * window panes that read warm at dusk, the arch rings under the deck, the
 * cobbled street and square, the well and the two boats hauled up the beach.
 *
 * Roofs are square-section cones (tessellation 4) rather than two slabs: a
 * hip roof has no gable ends, so there is no triangular gap to fudge, and one
 * mesh per roof beats three.
 */
import {
  Axis,
  Color3,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  PointLight,
  Scene,
  Space,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';
import {
  BOATS,
  BRIDGE_DECK_T,
  BRIDGE_RAIL_H,
  BRIDGE_WIDTH,
  BRIDGE_Z,
  CHURCH,
  FLOOR_LIFT,
  HOUSES,
  VILLAGE,
  VILLAGE_Y,
  WELL,
  churchDoor,
  houseDoor,
  villageFloors,
  villageWalls,
  type BridgePlan,
} from '../world/villageIsle';
import { terrainHeight } from '../world/heightfield';
import type { SharedMaterials } from './materials';
import type { Decor } from './decor';

/** Borrow a shared texture kit but give it its own mood (one kit, many moods). */
function tinted(
  scene: Scene,
  name: string,
  src: PBRMaterial,
  albedo: Color3,
  roughness: number,
  emissive: Color3,
): PBRMaterial {
  const m = new PBRMaterial(name, scene);
  m.albedoColor = albedo;
  m.roughness = roughness;
  m.metallic = 0;
  m.albedoTexture = src.albedoTexture;
  m.bumpTexture = src.bumpTexture;
  m.emissiveColor = emissive;
  return m;
}

/** Window glass: dark by day, and the emissive carries it at dusk. */
function glassMat(scene: Scene): StandardMaterial {
  const m = new StandardMaterial('villageGlass', scene);
  m.diffuseColor = new Color3(0.1, 0.09, 0.08);
  m.emissiveColor = new Color3(0.34, 0.21, 0.08);
  return m;
}

/**
 * Build the whole settlement. `bridge` is the same plan game.ts feeds to the
 * controller — the renderer must not invent a second geometry.
 */
export function buildVillageVisual(
  scene: Scene,
  mats: SharedMaterials,
  bridge: BridgePlan,
): { decor: Decor; shadowMeshes: Mesh[] } {
  const meshes: Mesh[] = [];
  const shadowMeshes: Mesh[] = [];

  const stone = tinted(scene, 'isleStone', mats.buildingStone, new Color3(0.62, 0.59, 0.54), 1, new Color3(0.03, 0.029, 0.027));
  const plaster = tinted(scene, 'islePlaster', mats.buildingStone, new Color3(0.85, 0.79, 0.67), 0.95, new Color3(0.045, 0.042, 0.035));
  const timber = tinted(scene, 'isleTimber', mats.buildingWood, new Color3(0.6, 0.42, 0.26), 0.9, new Color3(0.04, 0.028, 0.015));
  const thatch = tinted(scene, 'isleThatch', mats.buildingWood, new Color3(0.36, 0.29, 0.16), 1, new Color3(0.02, 0.016, 0.009));
  const slate = tinted(scene, 'isleSlate', mats.buildingStone, new Color3(0.3, 0.32, 0.37), 0.85, new Color3(0.018, 0.019, 0.022));
  const dark = tinted(scene, 'isleDark', mats.buildingWood, new Color3(0.19, 0.13, 0.09), 0.95, new Color3(0.01, 0.007, 0.005));
  const flag = tinted(scene, 'isleFlag', mats.buildingStone, new Color3(0.47, 0.45, 0.42), 0.95, new Color3(0.022, 0.021, 0.02));
  const glass = glassMat(scene);
  const candleGlow = new StandardMaterial('isleCandle', scene);
  candleGlow.diffuseColor = new Color3(1, 0.62, 0.2);
  candleGlow.emissiveColor = new Color3(1, 0.55, 0.14);

  const add = (m: Mesh, castShadow = false): Mesh => {
    m.freezeWorldMatrix();
    meshes.push(m);
    if (castShadow) shadowMeshes.push(m);
    return m;
  };
  /** Axis-aligned box from centre + size. */
  const box = (
    name: string,
    cx: number,
    cy: number,
    cz: number,
    sx: number,
    sy: number,
    sz: number,
    mat: PBRMaterial | StandardMaterial,
    castShadow = false,
  ): Mesh => {
    const m = MeshBuilder.CreateBox(name, { width: sx, height: sy, depth: sz }, scene);
    m.position.set(cx, cy, cz);
    m.material = mat;
    return add(m, castShadow);
  };
  /** A box that is turned about Y (yaw) — rotation BEFORE the world matrix is
   * frozen, which is why this is a separate helper from `box`. */
  const boxYaw = (
    name: string,
    cx: number,
    cy: number,
    cz: number,
    sx: number,
    sy: number,
    sz: number,
    yaw: number,
    mat: PBRMaterial | StandardMaterial,
    castShadow = false,
  ): Mesh => {
    const m = MeshBuilder.CreateBox(name, { width: sx, height: sy, depth: sz }, scene);
    m.rotation.y = yaw;
    m.position.set(cx, cy, cz);
    m.material = mat;
    return add(m, castShadow);
  };
  /**
   * Hip roof over a footprint: a 4-sided cone whose base square is 1×1, turned
   * so its sides face the axes and then stretched to the plot. One mesh, no
   * gable ends to fudge, and the overhang hides the wall tops.
   */
  const hipRoof = (
    name: string,
    cx: number,
    z: number,
    baseY: number,
    w: number,
    d: number,
    rise: number,
    mat: PBRMaterial,
  ): Mesh => {
    const m = MeshBuilder.CreateCylinder(
      name,
      { diameterTop: 0, diameterBottom: Math.SQRT2, height: rise, tessellation: 4 },
      scene,
    );
    m.rotate(Axis.Y, Math.PI / 4, Space.WORLD); // sides now face x/z
    m.scaling.set(w, 1, d);
    m.position.set(cx, baseY + rise / 2, z);
    m.material = mat;
    return add(m, true);
  };
  /** A door panel standing in the doorway the collision leaves open. */
  const doorPanel = (
    name: string,
    at: { x: number; z: number; yaw: number },
    baseY: number,
    w: number,
    h: number,
    mat: PBRMaterial,
  ): void => {
    // The panel sits in the wall's plane: half a wall thickness out along the
    // door's facing, which is `yaw` (0 faces +z).
    const fx = Math.sin(at.yaw);
    const fz = Math.cos(at.yaw);
    const m = MeshBuilder.CreateBox(name, { width: w, height: h, depth: 0.1 }, scene);
    m.position.set(at.x + fx * 0.12, baseY + h / 2, at.z + fz * 0.12);
    m.rotation.y = at.yaw;
    m.material = mat;
    add(m);
    // Frame: two posts + lintel, slightly wider and taller than the panel.
    for (const side of [-1, 1] as const) {
      box(
        `${name}Post${side}`,
        at.x + fx * 0.16 + Math.cos(at.yaw) * (side * (w / 2 + 0.09)),
        baseY + h / 2,
        at.z + fz * 0.16 - Math.sin(at.yaw) * (side * (w / 2 + 0.09)),
        0.16,
        h + 0.18,
        0.2,
        timber,
      );
    }
    box(
      `${name}Lintel`,
      at.x + fx * 0.16,
      baseY + h + 0.1,
      at.z + fz * 0.16,
      Math.abs(fx) > 0.5 ? 0.2 : w + 0.4,
      0.2,
      Math.abs(fx) > 0.5 ? w + 0.4 : 0.2,
      timber,
    );
  };

  // =========================================================================
  // The crossing — deck, stringers, piers, arches, rails
  // =========================================================================
  const half = BRIDGE_WIDTH / 2 + BRIDGE_DECK_T;
  const soffit = bridge.deckY - BRIDGE_DECK_T;

  for (const [i, d] of bridge.decks.entries()) {
    box(
      `isleDeck${i}`,
      (d.minX + d.maxX) / 2,
      bridge.deckY - BRIDGE_DECK_T / 2,
      BRIDGE_Z,
      d.maxX - d.minX - 0.04, // a hair short so the seams read as plank lines
      BRIDGE_DECK_T,
      half * 2,
      timber,
      true,
    );
  }
  // Two stringers running the whole span under the planks.
  for (const side of [-1, 1] as const) {
    box(
      `isleStringer${side}`,
      (bridge.xWest + bridge.xEast) / 2,
      soffit - 0.16,
      BRIDGE_Z + side * (BRIDGE_WIDTH / 2 - 0.1),
      bridge.length,
      0.32,
      0.3,
      dark,
    );
  }
  for (const [i, p] of bridge.piers.entries()) {
    box(
      `islePier${i}`,
      p.x,
      (p.top + p.bottom) / 2,
      p.z,
      p.w,
      p.top - p.bottom,
      p.d,
      stone,
      true,
    );
  }
  // Arch rings: a chain of voussoir stones, crown touching the soffit. The
  // water passes between the stones and the piers they spring from.
  for (const [ai, a] of bridge.arches.entries()) {
    const n = 9;
    const chord = (2 * a.r * Math.sin(Math.PI / (2 * n))) * 1.08;
    for (let i = 0; i < n; i++) {
      const phi = (Math.PI * (i + 0.5)) / n;
      const m = MeshBuilder.CreateBox(
        `isleArch${ai}_${i}`,
        { width: chord, height: 0.62, depth: half * 2 + 0.24 },
        scene,
      );
      m.position.set(a.x + a.r * Math.cos(phi), soffit - a.r * (1 - Math.sin(phi)), BRIDGE_Z);
      m.rotation.z = phi + Math.PI / 2; // local x along the ring's tangent
      m.material = stone;
      add(m);
    }
  }
  // Rails: posts every ~1.8 m plus a handrail beam. NOTE: the collision rail
  // (game.ts) is a full-height wall between the posts — you cannot step
  // through the gaps, which is what a railing is on a bridge over water.
  const railPost = (name: string, x: number, side: number): void => {
    box(name, x, bridge.deckY + BRIDGE_RAIL_H / 2, BRIDGE_Z + side * (half - 0.12), 0.13, BRIDGE_RAIL_H, 0.13, timber);
  };
  for (let x = bridge.xWest + 0.6; x < bridge.xEast - 0.4; x += 1.8) {
    railPost(`isleRailPostN${x.toFixed(1)}`, x, -1);
    railPost(`isleRailPostS${x.toFixed(1)}`, x, 1);
  }
  for (const side of [-1, 1] as const) {
    box(
      `isleHandrail${side}`,
      (bridge.xWest + bridge.xEast) / 2,
      bridge.deckY + BRIDGE_RAIL_H - 0.07,
      BRIDGE_Z + side * (half - 0.12),
      bridge.length,
      0.14,
      0.22,
      timber,
      true,
    );
  }

  // =========================================================================
  // Street + square: cobbles laid flush with the pad (they replace its top
  // skin rather than sitting on it, so nothing here is a trip hazard)
  // =========================================================================
  const gate = churchDoor();
  const streetFrom = bridge.xEast;
  box(
    'villageStreet',
    (streetFrom + gate.x) / 2,
    VILLAGE_Y - 0.15,
    BRIDGE_Z,
    gate.x - streetFrom,
    0.32,
    3.4,
    stone,
  );
  const square = MeshBuilder.CreateCylinder(
    'villageSquare',
    { diameter: 19, height: 0.32, tessellation: 20 },
    scene,
  );
  square.position.set(VILLAGE.x, VILLAGE_Y - 0.14, VILLAGE.z);
  square.material = stone;
  add(square);

  // Interior floors. These boxes are drawn from villageFloors() — the same
  // rectangles physics is told about — and their TOP is the standing height, so
  // the stone you see is the stone you stand on. Without them a house is a
  // wall on grass and the church is a field barn.
  for (const [i, f] of villageFloors().entries()) {
    const thick = 0.34;
    box(
      `villageFloor${i}`,
      (f.minX + f.maxX) / 2,
      f.top - thick / 2,
      (f.minZ + f.maxZ) / 2,
      f.maxX - f.minX,
      thick,
      f.maxZ - f.minZ,
      flag,
    );
  }

  // =========================================================================
  // The cottages — walls exactly as collision, then roofs and detail
  // =========================================================================
  const allWalls = villageWalls();
  for (const h of HOUSES) {
    const y0 = VILLAGE_Y;
    for (const [i, w] of allWalls.filter((v) => v.building === h.id).entries()) {
      box(
        `villageWall_${h.id}_${i}`,
        (w.minX + w.maxX) / 2,
        (w.baseY + w.topY) / 2,
        (w.minZ + w.maxZ) / 2,
        w.maxX - w.minX,
        w.topY - w.baseY,
        w.maxZ - w.minZ,
        plaster,
        true,
      );
    }
    hipRoof(`villageRoof_${h.id}`, h.x, h.z, y0 + h.wallH, h.w + 0.8, h.d + 0.8, h.ridge - h.wallH, thatch);

    const door = houseDoor(h);
    doorPanel(`villageDoor_${h.id}`, door, y0, 1.34, 2.05, dark);
    // A step at the threshold: the cobbles stop at the wall, so the door gets
    // its own stone doorstep.
    box(
      `villageStep_${h.id}`,
      door.x + Math.sin(door.yaw) * 0.55,
      y0 - 0.1,
      door.z + Math.cos(door.yaw) * 0.55,
      Math.abs(Math.sin(door.yaw)) > 0.5 ? 0.3 : 1.7,
      0.16,
      Math.abs(Math.sin(door.yaw)) > 0.5 ? 1.7 : 0.3,
      stone,
    );

    // Two windows on the faces beside the door. Panes are thin boxes rather
    // than planes: a box is solid from both sides, so there is no "which way
    // does a plane face" to get wrong.
    const sideFace = h.door === 'pz' || h.door === 'nz' ? 'x' : 'z';
    for (const side of [-1, 1] as const) {
      const wx = sideFace === 'x' ? h.x + side * (h.w / 2 + 0.02) : h.x + side * (h.w / 2 - 1.2);
      const wz = sideFace === 'x' ? h.z + side * (h.d / 2 - 1.2) : h.z + side * (h.d / 2 + 0.02);
      box(
        `villageWindow_${h.id}_${side}`,
        wx,
        y0 + h.wallH * 0.55,
        wz,
        sideFace === 'x' ? 0.06 : 0.9,
        0.75,
        sideFace === 'x' ? 0.9 : 0.06,
        glass,
      );
      // A timber frame around the pane, set into the wall behind it.
      box(
        `villageWindowFrame_${h.id}_${side}`,
        wx - (sideFace === 'x' ? side * 0.05 : 0),
        y0 + h.wallH * 0.55,
        wz - (sideFace === 'z' ? side * 0.05 : 0),
        sideFace === 'x' ? 0.06 : 1.12,
        0.98,
        sideFace === 'x' ? 1.12 : 0.06,
        dark,
      );
    }

    if (h.chimney) {
      const [cx, cz] = h.chimney;
      box(
        `villageChimney_${h.id}`,
        h.x + cx * (h.w / 2 - 0.55),
        y0 + h.ridge * 0.75,
        h.z + cz * (h.d / 2 - 0.55),
        0.62,
        h.ridge * 0.9 + 0.7,
        0.62,
        stone,
        true,
      );
    }
  }

  // =========================================================================
  // The church: the island's landmark, visible from the mainland
  // =========================================================================
  const nave = CHURCH.nave;
  const tower = CHURCH.tower;
  for (const [i, w] of allWalls.filter((v) => v.building === 'church').entries()) {
    box(
      `churchWall${i}`,
      (w.minX + w.maxX) / 2,
      (w.baseY + w.topY) / 2,
      (w.minZ + w.maxZ) / 2,
      w.maxX - w.minX,
      w.topY - w.baseY,
      w.maxZ - w.minZ,
      stone,
      true,
    );
  }
  // Inside: two rows of piers, an altar block and candles. The lights are what
  // make the nave enterable at all — a stone box this thick is a black room
  // otherwise, and a landmark you cannot walk into is scenery, not a building.
  const floorY = VILLAGE_Y + FLOOR_LIFT;
  for (const z of [167.5, 172.5]) {
    for (const x of [161, 165, 169]) {
      box(`churchPier${x}_${z}`, x, floorY + CHURCH.wallH / 2 - 0.3, z, 0.52, CHURCH.wallH - 0.6, 0.52, stone, true);
    }
  }
  box('churchAltar', nave.x1 - 1.5, floorY + 0.55, (nave.z0 + nave.z1) / 2, 0.8, 1.1, 2.2, plaster, true);
  const candles: Mesh[] = [];
  for (const [cx, cz] of [
    [163, 170],
    [167, 170],
    [(tower.x0 + tower.x1) / 2, CHURCH.door.z],
  ] as const) {
    box(`candleStick_${cx}_${cz}`, cx, floorY + 0.85, cz, 0.16, 1.7, 0.16, dark);
    const flame = MeshBuilder.CreateCylinder(
      `candleFlame_${cx}_${cz}`,
      { diameterTop: 0.01, diameterBottom: 0.11, height: 0.3, tessellation: 8 },
      scene,
    );
    flame.position.set(cx, floorY + 1.85, cz);
    flame.material = candleGlow;
    add(flame);
    candles.push(flame);
  }
  const naveLight = new PointLight(
    'churchNaveLight',
    new Vector3((nave.x0 + nave.x1) / 2, floorY + CHURCH.wallH - 2.2, (nave.z0 + nave.z1) / 2),
    scene,
  );
  naveLight.diffuse = new Color3(1, 0.66, 0.32);
  naveLight.specular = new Color3(0.6, 0.42, 0.24);
  naveLight.range = 26;
  naveLight.intensity = 1.5;
  const towerLight = new PointLight(
    'churchTowerLight',
    new Vector3((tower.x0 + tower.x1) / 2, floorY + 3.2, CHURCH.door.z),
    scene,
  );
  towerLight.diffuse = new Color3(1, 0.6, 0.28);
  towerLight.specular = new Color3(0.6, 0.4, 0.2);
  towerLight.range = 13;
  towerLight.intensity = 0.9;

  hipRoof(
    'churchRoof',
    (nave.x0 + nave.x1) / 2,
    (nave.z0 + nave.z1) / 2,
    VILLAGE_Y + CHURCH.wallH,
    nave.x1 - nave.x0 + 0.7,
    nave.z1 - nave.z0 + 0.7,
    CHURCH.ridge - CHURCH.wallH,
    slate,
  );
  // A parapet band and the spire: the thing you steer by from the sea.
  const towerTop = VILLAGE_Y + CHURCH.towerH;
  box(
    'churchParapet',
    (tower.x0 + tower.x1) / 2,
    towerTop - 0.25,
    (tower.z0 + tower.z1) / 2,
    tower.x1 - tower.x0 + 0.5,
    0.5,
    tower.z1 - tower.z0 + 0.5,
    slate,
    true,
  );
  const spire = MeshBuilder.CreateCylinder(
    'churchSpire',
    { diameterTop: 0.02, diameterBottom: Math.SQRT2, height: CHURCH.spire, tessellation: 4 },
    scene,
  );
  spire.rotate(Axis.Y, Math.PI / 4, Space.WORLD);
  const spireW = tower.x1 - tower.x0 + 0.45;
  spire.scaling.set(spireW, 1, tower.z1 - tower.z0 + 0.45);
  spire.position.set((tower.x0 + tower.x1) / 2, towerTop + CHURCH.spire / 2, (tower.z0 + tower.z1) / 2);
  spire.material = slate;
  add(spire, true);
  // Bell opening + the great door + a round window over it.
  for (const side of [-1, 1] as const) {
    box(
      `churchBell${side}`,
      tower.x0 - 0.05,
      towerTop - 1.9,
      (tower.z0 + tower.z1) / 2 + side * 1.1,
      0.12,
      1.7,
      0.7,
      dark,
    );
  }
  doorPanel('churchDoor', gate, VILLAGE_Y, CHURCH.door.width - 0.1, 3.1, dark);
  const rose = MeshBuilder.CreateCylinder('churchRose', { diameter: 1.5, height: 0.1, tessellation: 16 }, scene);
  rose.rotation.z = Math.PI / 2; // a coin standing on its edge, facing west
  rose.position.set(tower.x0 - 0.06, VILLAGE_Y + 5.4, CHURCH.door.z);
  rose.material = glass;
  add(rose);
  // Side doors along the nave's south wall.
  for (const [i, x] of CHURCH.sideDoors.entries()) {
    doorPanel(
      `churchSideDoor${i}`,
      { x, z: nave.z0, yaw: 0 },
      VILLAGE_Y,
      1.3,
      2.3,
      dark,
    );
  }

  // =========================================================================
  // The well in the square
  // =========================================================================
  const ring = MeshBuilder.CreateCylinder(
    'villageWell',
    { diameter: WELL.radius * 2, height: 0.86, tessellation: 14 },
    scene,
  );
  ring.position.set(WELL.x, VILLAGE_Y + 0.43, WELL.z);
  ring.material = stone;
  add(ring, true);
  const waterTop = MeshBuilder.CreateCylinder(
    'villageWellWater',
    { diameter: (WELL.radius - 0.22) * 2, height: 0.06, tessellation: 14 },
    scene,
  );
  waterTop.position.set(WELL.x, VILLAGE_Y + 0.7, WELL.z);
  waterTop.material = dark;
  add(waterTop);
  for (const side of [-1, 1] as const) {
    box(`villageWellPost${side}`, WELL.x + side * (WELL.radius - 0.1), VILLAGE_Y + 1.35, WELL.z, 0.14, 2.1, 0.14, timber);
  }
  hipRoof('villageWellRoof', WELL.x, WELL.z, VILLAGE_Y + 2.1, WELL.radius * 2.4, WELL.radius * 2.0, 0.7, thatch);
  box('villageWellWindlass', WELL.x, VILLAGE_Y + 1.85, WELL.z, 0.9, 0.16, 0.16, dark);

  // =========================================================================
  // Two boats hauled up the beach (the harbour is a beach, not a quay)
  // =========================================================================
  for (const [i, b] of BOATS.entries()) {
    const gy = terrainHeight(b.x, b.z);
    const fx = Math.sin(b.yaw);
    const fz = Math.cos(b.yaw);
    const at = (along: number, across: number): [number, number] => [
      b.x + fx * along + fz * across,
      b.z + fz * along - fx * across,
    ];
    const hullLen = 4.2;
    // Hull: a trough of three boards — a keel plus two sides raked inward.
    boxYaw(`boatKeel${i}`, b.x, gy + 0.22, b.z, 1.05, 0.34, hullLen, b.yaw, timber);
    for (const side of [-1, 1] as const) {
      const [sx, sz] = at(0, side * 0.62);
      boxYaw(`boatSide${i}_${side}`, sx, gy + 0.48, sz, 0.14, 0.6, hullLen, b.yaw, timber);
    }
    // A raked bow and stern close the ends off.
    for (const [along, yawOff] of [
      [hullLen / 2, 0.5],
      [-hullLen / 2, -0.5],
    ] as const) {
      const [bx, bz] = at(along, 0);
      boxYaw(`boatEnd${i}_${along}`, bx, gy + 0.4, bz, 0.9, 0.75, 0.9, b.yaw + yawOff, timber);
    }
    const [mx, mz] = at(-0.3, 0);
    box(`boatMast${i}`, mx, gy + 1.55, mz, 0.11, 2.4, 0.11, dark);
    const [sx2, sz2] = at(-0.3, 0.05);
    const sail = MeshBuilder.CreateCylinder(
      `boatSail${i}`,
      { diameter: 0.3, height: 2.1, tessellation: 8 },
      scene,
    );
    sail.rotation.z = Math.PI / 2; // laid along the boat, then turned to its yaw
    sail.rotation.y = -b.yaw;
    sail.position.set(sx2, gy + 2.2, sz2);
    sail.material = plaster;
    add(sail, true);
    const [bx2, bz2] = at(1.1, 0);
    box(`boatBench${i}`, bx2, gy + 0.55, bz2, 1.2, 0.1, 0.24, dark);
  }

  return {
    decor: {
      meshes,
      dispose: () => {
        naveLight.dispose();
        towerLight.dispose();
        for (const m of candles) m.dispose();
        for (const m of meshes) m.dispose();
        for (const m of [stone, plaster, timber, thatch, slate, dark, flag]) m.dispose();
        glass.dispose();
        candleGlow.dispose();
      },
    },
    shadowMeshes,
  };
}
