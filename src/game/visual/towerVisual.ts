/**
 * The witch's tower — visuals for world/tower.ts (pure geometry).
 *
 * Every box here is the SAME box the player controller collides with:
 * the stone shell is drawn from `towerWalls()`, the floor rims from
 * `towerSlabs()`, and the switchback staircase from `towerStairs()`. What
 * you see is what you bump into (the same rule the caves follow).
 *
 * On top of the honest collision boxes sit three purely decorative layers:
 * a corbel ring under each floor, a blocky parapet crown, and the crooked
 * shingle spire that makes the tower readable above the treeline — a witch
 * without a pointy hat on her tower is just a silo.
 */
import { Color3, Mesh, MeshBuilder, PBRMaterial, Scene, StandardMaterial } from '@babylonjs/core';
import {
  TOWER_FLOORS,
  TOWER_OUTER,
  towerFloorY,
  towerSlabs,
  towerStairs,
  towerWalls,
  towerWallTopY,
  type TowerSite,
} from '../world/tower';
import type { SharedMaterials } from './materials';
import type { Decor } from './decor';

/** A tower torch is a flame ball, not a PointLight — three of these must
 * not triple the dynamic-light budget (the volcano shrine taught us). */
function flameMat(scene: Scene): StandardMaterial {
  const m = new StandardMaterial('towerFlame', scene);
  m.diffuseColor = new Color3(0.6, 0.45, 1);
  m.emissiveColor = new Color3(0.45, 0.3, 0.9);
  m.disableLighting = true;
  return m;
}

/** Mossy tower stone: the shared building stone texture and bump, tinted
 * cold and a decade dirtier than a player's house (one texture, two moods). */
function towerStoneMat(scene: Scene, mats: SharedMaterials): PBRMaterial {
  const m = new PBRMaterial('towerStoneMat', scene);
  m.albedoColor = new Color3(0.42, 0.42, 0.46);
  m.roughness = 1;
  m.metallic = 0;
  m.albedoTexture = mats.buildingStone.albedoTexture;
  m.bumpTexture = mats.buildingStone.bumpTexture;
  m.emissiveColor = new Color3(0.02, 0.02, 0.026);
  return m;
}

/**
 * Build the whole tower. Returns the shared Decor bundle (mesh list +
 * dispose) plus the meshes worth registering as sun-shadow casters (the
 * shell and the spire — the parapet trinkets would only cost draw calls).
 */
export function buildTowerVisual(
  scene: Scene,
  mats: SharedMaterials,
  site: TowerSite,
): { decor: Decor; shadowMeshes: Mesh[] } {
  const meshes: Mesh[] = [];
  const stone = towerStoneMat(scene, mats);
  const wood = mats.buildingWood;
  const flame = flameMat(scene);

  const add = (m: Mesh): Mesh => {
    m.freezeWorldMatrix();
    meshes.push(m);
    return m;
  };
  /** Box from centre + size. */
  const box = (
    name: string,
    cx: number,
    cy: number,
    cz: number,
    sx: number,
    sy: number,
    sz: number,
    mat: PBRMaterial | StandardMaterial,
  ): Mesh => {
    const m = MeshBuilder.CreateBox(name, { width: sx, height: sy, depth: sz }, scene);
    m.position.set(cx, cy, cz);
    m.material = mat;
    return add(m);
  };

  // --- the stone shell: exactly the collision walls -----------------------
  const shadowMeshes: Mesh[] = [];
  for (const [i, w] of towerWalls(site).entries()) {
    const m = box(
      `towerWall${i}`,
      (w.minX + w.maxX) / 2,
      (w.baseY + w.topY) / 2,
      (w.minZ + w.maxZ) / 2,
      w.maxX - w.minX,
      w.topY - w.baseY,
      w.maxZ - w.minZ,
      stone,
    );
    shadowMeshes.push(m);
  }

  // --- floor rims + corbels (decorative bands on the OUTSIDE of the shell)
  for (let k = 1; k < TOWER_FLOORS; k++) {
    const y = towerFloorY(site, k);
    const rim = box(
      `towerRim${k}`,
      site.x,
      y - 0.12,
      site.z,
      (TOWER_OUTER + 0.35) * 2,
      0.24,
      (TOWER_OUTER + 0.35) * 2,
      wood,
    );
    void rim;
    if (k === TOWER_FLOORS - 1) shadowMeshes.push(rim);
  }
  for (let k = 1; k < TOWER_FLOORS; k++) {
    const y = towerFloorY(site, k) - 0.55;
    for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      box(
        `towerCorbel${k}_${dx}_${dz}`,
        site.x + dx * (TOWER_OUTER + 0.18),
        y,
        site.z + dz * (TOWER_OUTER + 0.18),
        0.45,
        0.8,
        0.45,
        wood,
      );
    }
  }

  // --- the walkable slabs, drawn thin (they read as dark planks seen from
  // below through the stair holes; from above the top slab is the floor) ---
  for (const [i, s] of towerSlabs(site).entries()) {
    box(
      `towerSlab${i}`,
      (s.minX + s.maxX) / 2,
      s.top - 0.09,
      (s.minZ + s.maxZ) / 2,
      s.maxX - s.minX,
      0.18,
      s.maxZ - s.minZ,
      wood,
    );
  }

  // --- the switchback staircase: one sloped plank per flight ---------------
  for (const [i, st] of towerStairs(site).entries()) {
    const w = st.maxX - st.minX;
    const run = st.maxZ - st.minZ;
    const rise = st.slopeZ * run;
    const len = Math.hypot(run, rise);
    const m = MeshBuilder.CreateBox(`towerStair${i}`, { width: w, height: 0.14, depth: len }, scene);
    // Sit the plank's TOP face exactly on the collision surface: a plank
    // tilted by θ puts its top face 0.07/cos(θ) above the box centre, so
    // the centre goes that far below `top`. (Centring on `top` used to
    // sink the player's feet 7-9 cm into visible wood on every flight.)
    m.position.set(
      (st.minX + st.maxX) / 2,
      st.top - (0.07 * run) / len,
      (st.minZ + st.maxZ) / 2,
    );
    // Rotate about x so the plank's ends sit at the flight's low/high y
    // (Babylon: positive rotation.x lowers the +z end, so negate the slope).
    m.rotation.x = -Math.atan2(rise, run);
    m.material = wood;
    add(m);
  }

  // --- parapet crown: merlon blocks on the wall top ------------------------
  const top = towerWallTopY(site);
  const o = TOWER_OUTER;
  const step = (o * 2) / 5;
  for (let i = 0; i < 5; i += 2) {
    const t = -o + step * (i + 0.5);
    box(`towerMerlonN${i}`, site.x + t, top + 0.45, site.z - o + 0.35, 0.6, 0.9, 0.7, stone);
    box(`towerMerlonS${i}`, site.x + t, top + 0.45, site.z + o - 0.35, 0.6, 0.9, 0.7, stone);
    box(`towerMerlonE${i}`, site.x + o - 0.35, top + 0.45, site.z + t, 0.7, 0.9, 0.6, stone);
    box(`towerMerlonW${i}`, site.x - o + 0.35, top + 0.45, site.z + t, 0.7, 0.9, 0.6, stone);
  }

  // --- the crooked spire: four corner posts + a leaning shingle cone -------
  const spireBase = top + 0.2;
  for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    box(
      `towerSpirePost_${dx}_${dz}`,
      site.x + dx * (TOWER_OUTER - 0.6),
      spireBase + 1.1,
      site.z + dz * (TOWER_OUTER - 0.6),
      0.22,
      2.2,
      0.22,
      wood,
    );
  }
  const spire = MeshBuilder.CreateCylinder(
    'towerSpire',
    { diameterTop: 0.05, diameterBottom: TOWER_OUTER * 2.6, height: 5.2, tessellation: 8 },
    scene,
  );
  spire.position.set(site.x + 0.25, spireBase + 3.6, site.z);
  spire.rotation.z = 0.055; // crooked, like the witch's hat
  spire.material = wood;
  add(spire);
  shadowMeshes.push(spire);

  // --- doorway: timber frame + the two torches that mean "shop this way" --
  const doorGY = site.baseY;
  box('towerDoorFrameL', site.x - TOWER_OUTER + 0.05, doorGY + 1.35, site.z - 1.15, 0.18, 2.7, 0.3, wood);
  box('towerDoorFrameR', site.x - TOWER_OUTER + 0.05, doorGY + 1.35, site.z + 1.15, 0.18, 2.7, 0.3, wood);
  for (const side of [-1, 1] as const) {
    box(
      `towerTorchPost${side}`,
      site.x - TOWER_OUTER - 0.35,
      doorGY + 1.15,
      site.z + side * 1.5,
      0.09,
      1.1,
      0.09,
      wood,
    );
    const bulb = MeshBuilder.CreateSphere(`towerFlame${side}`, { diameter: 0.22, segments: 8 }, scene);
    bulb.position.set(site.x - TOWER_OUTER - 0.35, doorGY + 1.8, site.z + side * 1.5);
    bulb.material = flame;
    add(bulb);
  }

  // --- glowing window slits: purple, so at night the tower says "her" -----
  const glow = new StandardMaterial('towerWindowGlow', scene);
  glow.diffuseColor = new Color3(0.5, 0.35, 0.95);
  glow.emissiveColor = new Color3(0.4, 0.25, 0.85);
  glow.disableLighting = true;
  for (let k = 1; k < TOWER_FLOORS; k++) {
    const y = towerFloorY(site, k) + 0.9;
    box(`towerWindow${k}N`, site.x, y, site.z - TOWER_OUTER + 0.05, 0.28, 0.8, 0.06, glow);
    box(`towerWindow${k}E`, site.x + TOWER_OUTER - 0.05, y, site.z + (k % 2 ? 1.4 : -1.4), 0.06, 0.8, 0.28, glow);
  }

  return {
    decor: {
      meshes,
      dispose: () => {
        for (const m of meshes) m.dispose();
        stone.dispose();
        flame.dispose();
        glow.dispose();
      },
    },
    shadowMeshes,
  };
}
