/**
 * Scene decoration for the fixed world landmarks: cave interiors and the
 * witch's cottage (Visual Agent scope; no game logic lives here).
 *
 * Cave chambers are carved out of the height field (world/caves.ts), which
 * leaves them open at the top. `buildCaveInterior` closes each chamber with
 * a rock ceiling plug and dresses it with glowing crystals + one point
 * light, so stepping into the ravine reads as walking into a cave.
 *
 * The witch's cottage is a small dark cabin with a green-glowing cauldron
 * and a witch figure; the trade logic is elsewhere (systems/shop.ts).
 */
import {
  Color3,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  PointLight,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import type { CaveSite } from '../world/caves';
import { caveCeiling } from '../world/caves';
import type { SharedMaterials } from './materials';

/** Everything a builder produced, disposable in one call. */
export interface Decor {
  meshes: Mesh[];
  dispose(): void;
}

function glowMat(scene: Scene, name: string, r: number, g: number, b: number): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = new Color3(r, g, b);
  m.emissiveColor = new Color3(r, g, b);
  m.disableLighting = true;
  return m;
}

/**
 * Close a carved cave chamber: ceiling plug + glowing crystals + one warm
 * point light. The plug is a thick rock cylinder sunk into the ramped bowl
 * wall, so its rim is buried under real terrain and only its underside is
 * visible from inside.
 */
export function buildCaveInterior(scene: Scene, mats: SharedMaterials, site: CaveSite): Decor {
  const meshes: Mesh[] = [];
  const lights: PointLight[] = [];
  const { y: ceilY, radius } = caveCeiling(site);
  const floorY = site.surfaceH - site.depth;

  const dark = mats.rock.clone(`caveCeil_${site.id}`) as PBRMaterial;
  dark.albedoColor = new Color3(0.16, 0.155, 0.18);
  dark.roughness = 1;

  const plug = MeshBuilder.CreateCylinder(
    `caveCeil_${site.id}`,
    { diameter: radius * 2, height: 1.6, tessellation: 28 },
    scene,
  );
  plug.position.set(site.cx, ceilY + 0.8, site.cz);
  plug.material = dark;
  plug.freezeWorldMatrix();
  meshes.push(plug);

  // Glowing crystal clusters around the chamber wall.
  const crystal = glowMat(scene, `crystalMat_${site.id}`, 0.35, 0.75, 0.62);
  const n = 6;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.6;
    const rr = site.chamberR * 0.82;
    for (let k = 0; k < 3; k++) {
      const h = 0.28 + 0.18 * ((i * 3 + k) % 3);
      const c = MeshBuilder.CreateCylinder(
        `crystal_${site.id}_${i}_${k}`,
        { diameterTop: 0.02, diameterBottom: 0.12 + 0.05 * (k % 2), height: h, tessellation: 5 },
        scene,
      );
      c.position.set(
        site.cx + Math.cos(a) * rr + Math.cos(a + k) * 0.16,
        floorY + h * 0.5 + 0.02,
        site.cz + Math.sin(a) * rr + Math.sin(a + k) * 0.16,
      );
      c.rotation.z = Math.cos(a * 3 + k) * 0.28;
      c.rotation.x = Math.sin(a * 2 + k) * 0.2;
      c.material = crystal;
      c.freezeWorldMatrix();
      meshes.push(c);
    }
  }

  // One soft teal light per chamber — enough to navigate, dark at the edges.
  const light = new PointLight(
    `caveLight_${site.id}`,
    new Vector3(site.cx, floorY + 2.2, site.cz),
    scene,
  );
  light.diffuse = new Color3(0.45, 0.85, 0.72);
  light.specular = new Color3(0.3, 0.5, 0.45);
  light.range = 22;
  light.intensity = 1.4;
  lights.push(light);

  return {
    meshes,
    dispose: () => {
      for (const l of lights) l.dispose();
      for (const m of meshes) m.dispose();
      dark.dispose();
      crystal.dispose();
    },
  };
}

/**
 * The witch's cottage: dark log cabin, steep thatch cone, chimney, a green
 * cauldron out front and a ring of pale mushrooms. Returns the root node
 * (placed by the caller at the pad centre) plus its meshes.
 */
export function buildWitchHut(scene: Scene, mats: SharedMaterials): { root: TransformNode; decor: Decor } {
  const root = new TransformNode('witchHut', scene);
  const meshes: Mesh[] = [];

  const hutWood = mats.buildingWood.clone('hutWoodMat') as PBRMaterial;
  hutWood.albedoColor = new Color3(0.3, 0.21, 0.14);
  const thatch = mats.grass.clone('thatchMat') as PBRMaterial;
  thatch.albedoColor = new Color3(0.35, 0.3, 0.13);
  const cauldronGlow = glowMat(scene, 'cauldronGlowMat', 0.25, 0.85, 0.32);
  const shroom = glowMat(scene, 'shroomMat', 0.55, 0.8, 0.9);

  const add = (m: Mesh, x: number, y: number, z: number, rx = 0, rz = 0): Mesh => {
    m.position.set(x, y, z);
    m.rotation.x = rx;
    m.rotation.z = rz;
    m.parent = root;
    meshes.push(m);
    return m;
  };

  // Cabin body: octagonal-ish log drum + a slightly wider sill.
  const walls = MeshBuilder.CreateCylinder(
    'hutWalls',
    { diameter: 4.4, diameterTop: 3.9, height: 2.4, tessellation: 8 },
    scene,
  );
  add(walls, 0, 1.2, 0).material = hutWood;
  walls.freezeWorldMatrix();
  const sill = MeshBuilder.CreateCylinder('hutSill', { diameter: 4.9, height: 0.3, tessellation: 8 }, scene);
  add(sill, 0, 0.15, 0).material = mats.buildingStone;
  sill.freezeWorldMatrix();

  // Steep witchy cone roof + curled tip ornament.
  const roof = MeshBuilder.CreateCylinder(
    'hutRoof',
    { diameterTop: 0.14, diameterBottom: 6.4, height: 2.9, tessellation: 8 },
    scene,
  );
  add(roof, 0, 2.4 + 1.45, 0).material = thatch;
  roof.freezeWorldMatrix();
  const tip = MeshBuilder.CreateCylinder(
    'hutRoofTip',
    { diameterTop: 0.0, diameterBottom: 0.16, height: 0.7, tessellation: 6 },
    scene,
  );
  add(tip, 0.1, 2.4 + 2.9 + 0.2, 0.06, 0.35).material = thatch;
  tip.freezeWorldMatrix();

  // Door slab (dark, slightly ajar look) + crooked chimney.
  const door = MeshBuilder.CreateBox('hutDoor', { width: 0.9, height: 1.7, depth: 0.12 }, scene);
  add(door, 0, 0.85, 2.0, 0, 0.04).material = hutWood;
  door.freezeWorldMatrix();
  const chim = MeshBuilder.CreateBox('hutChimney', { width: 0.55, height: 1.8, depth: 0.55 }, scene);
  add(chim, -1.1, 2.4 + 1.6, -0.9, 0, -0.06).material = mats.buildingStone;
  chim.freezeWorldMatrix();

  // Window glow (warm, the only light inside).
  const win = MeshBuilder.CreateBox('hutWindow', { width: 0.7, height: 0.55, depth: 0.06 }, scene);
  add(win, 1.35, 1.35, 1.62, 0, 0.12).material = glowMat(scene, 'hutWindowMat', 0.9, 0.55, 0.18);
  win.freezeWorldMatrix();

  // Cauldron on three stones, green glow soup.
  const pot = MeshBuilder.CreateSphere(
    'cauldron',
    { diameter: 1.1, segments: 10, slice: 0.62 },
    scene,
  );
  add(pot, 1.9, 0.62, 3.1, Math.PI, 0).material = mats.buildingStone;
  pot.freezeWorldMatrix();
  const soup = MeshBuilder.CreateDisc('cauldronSoup', { radius: 0.4, tessellation: 14 }, scene);
  add(soup, 1.9, 0.72, 3.1, Math.PI / 2).material = cauldronGlow;
  soup.freezeWorldMatrix();
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const st = MeshBuilder.CreateSphere(`potStone${i}`, { diameter: 0.34, segments: 6 }, scene);
    add(st, 1.9 + Math.cos(a) * 0.5, 0.17, 3.1 + Math.sin(a) * 0.5).material = mats.rock;
    st.freezeWorldMatrix();
  }

  // Pale glowing mushrooms ring the clearing edge.
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 1.2;
    const rr = 4.6 + (i % 3) * 0.8;
    const stem = MeshBuilder.CreateCylinder(
      `shroomStem${i}`,
      { diameter: 0.08, height: 0.24, tessellation: 6 },
      scene,
    );
    add(stem, Math.cos(a) * rr, 0.12, Math.sin(a) * rr, 0, (i % 2) * 0.15 - 0.08).material = mats.playerSkin;
    stem.freezeWorldMatrix();
    const cap = MeshBuilder.CreateSphere(
      `shroomCap${i}`,
      { diameter: 0.26, segments: 6, slice: 0.55 },
      scene,
    );
    add(cap, Math.cos(a) * rr, 0.26, Math.sin(a) * rr).material = shroom;
    cap.freezeWorldMatrix();
  }

  const dispose = (): void => {
    root.dispose();
    hutWood.dispose();
    thatch.dispose();
    cauldronGlow.dispose();
    shroom.dispose();
  };
  return { root, decor: { meshes, dispose } };
}

/**
 * The witch figure: dark robe cone, pointed hat, pale face — deliberately
 * simple and readable at interact distance. Faces the cauldron by default.
 */
export function buildWitch(scene: Scene): { root: TransformNode; update(dt: number, t: number): void } {
  const root = new TransformNode('witch', scene);
  const robe = new StandardMaterial('witchRobeMat', scene);
  robe.diffuseColor = new Color3(0.14, 0.1, 0.2);
  robe.emissiveColor = new Color3(0.03, 0.02, 0.05);
  const hat = new StandardMaterial('witchHatMat', scene);
  hat.diffuseColor = new Color3(0.1, 0.07, 0.16);
  hat.emissiveColor = new Color3(0.025, 0.018, 0.04);
  const face = new StandardMaterial('witchFaceMat', scene);
  face.diffuseColor = new Color3(0.75, 0.66, 0.52);
  face.emissiveColor = new Color3(0.05, 0.042, 0.03);

  const body = MeshBuilder.CreateCylinder(
    'witchBody',
    { diameterTop: 0.3, diameterBottom: 0.85, height: 1.5, tessellation: 10 },
    scene,
  );
  body.position.y = 0.75;
  body.material = robe;
  body.parent = root;
  const head = MeshBuilder.CreateSphere('witchHead', { diameter: 0.34, segments: 10 }, scene);
  head.position.y = 1.62;
  head.material = face;
  head.parent = root;
  const brim = MeshBuilder.CreateCylinder('witchBrim', { diameter: 0.62, height: 0.03, tessellation: 12 }, scene);
  brim.position.y = 1.8;
  brim.material = hat;
  brim.parent = root;
  const cone = MeshBuilder.CreateCylinder(
    'witchHatCone',
    { diameterTop: 0.01, diameterBottom: 0.34, height: 0.72, tessellation: 8 },
    scene,
  );
  cone.position.set(0.03, 2.14, 0);
  cone.rotation.z = -0.14;
  cone.material = hat;
  cone.parent = root;

  // Slow idle: gentle bob + sway, like she is stirring the air.
  const update = (dt: number, t: number): void => {
    void dt;
    root.position.y = Math.sin(t * 1.1) * 0.03;
    root.rotation.y += Math.sin(t * 0.4) * 0.0004;
  };
  const origDispose = root.dispose.bind(root);
  root.dispose = (): boolean => {
    robe.dispose();
    hat.dispose();
    face.dispose();
    origDispose();
    return true;
  };
  return { root, update };
}
