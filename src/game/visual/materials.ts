import {
  Color3,
  PBRMaterial,
  Scene,
  StandardMaterial,
} from '@babylonjs/core';
import { createTextureKit, type TextureKit } from './textures';

/**
 * Shared procedural PBR materials (Visual Agent scope).
 *
 * Every world material is a textured PBRMaterial with physically plausible
 * roughness and (where it helps) a procedural normal map, so the same
 * material language runs across flora, buildings, the player and tools.
 * Muted, natural palettes only — no toy colors.
 */
export interface SharedMaterials {
  // flora
  bark: PBRMaterial;
  leaf: PBRMaterial;
  pineLeaf: PBRMaterial;
  rock: PBRMaterial;
  bushLeaf: PBRMaterial;
  berry: PBRMaterial;
  grass: PBRMaterial;
  flower: PBRMaterial;
  stump: PBRMaterial;
  // player
  playerBody: PBRMaterial;
  playerPants: PBRMaterial;
  playerBoots: PBRMaterial;
  playerSkin: PBRMaterial;
  playerHair: PBRMaterial;
  backpack: PBRMaterial;
  // buildings + tools
  buildingWood: PBRMaterial;
  buildingStone: PBRMaterial;
  toolWood: PBRMaterial;
  toolStone: PBRMaterial;
  // fx
  fireGlow: StandardMaterial;
  ghost: StandardMaterial;
}

export function createSharedMaterials(scene: Scene): SharedMaterials {
  const kit = createTextureKit(scene);

  const pbr = (name: string, albedo: Color3, roughness: number): PBRMaterial => {
    const m = new PBRMaterial(name, scene);
    m.albedoColor = albedo;
    m.metallic = 0;
    m.roughness = roughness;
    return m;
  };

  const textured = (
    name: string,
    kitSet: TextureKit[keyof TextureKit],
    albedoScale: Color3,
    roughness: number,
  ): PBRMaterial => {
    const m = pbr(name, albedoScale, roughness);
    m.albedoTexture = kitSet.albedo;
    if (kitSet.normal) {
      m.bumpTexture = kitSet.normal;
    }
    return m;
  };

  const c = (r: number, g: number, b: number) => new Color3(r, g, b);

  // --- flora ---------------------------------------------------------------
  const bark = textured('barkMat', kit.bark, c(1, 1, 1), 0.95);
  const rock = textured('rockMat', kit.rock, c(0.96, 0.97, 1.0), 1.0);

  // Foliage keeps a flat albedo (per-instance vertex colors tint it) but
  // gains PBR roughness so it reads as matte, organic material.
  const leaf = pbr('leafMat', c(1, 1, 1), 0.92);
  const pineLeaf = pbr('pineLeafMat', c(0.15, 0.31, 0.19), 0.9);
  const bushLeaf = pbr('bushLeafMat', c(0.24, 0.42, 0.18), 0.9);
  const grass = pbr('grassMat', c(0.34, 0.44, 0.2), 0.95);
  const flower = pbr('flowerMat', c(1, 1, 1), 0.7);
  const berry = pbr('berryMat', c(0.62, 0.1, 0.14), 0.35);

  // --- player ---------------------------------------------------------------
  const playerBody = textured('playerBodyMat', kit.fabricShirt, c(1, 1, 1), 0.9);
  const playerPants = textured('playerPantsMat', kit.fabricPants, c(1, 1, 1), 0.92);
  const playerBoots = textured('playerBootsMat', kit.fabricBoots, c(1.2, 1.1, 1.0), 0.8);
  const backpack = textured('backpackMat', kit.fabricPants, c(1.35, 1.15, 0.9), 0.85);
  const playerSkin = pbr('playerSkinMat', c(0.86, 0.68, 0.52), 0.55);
  const playerHair = pbr('playerHairMat', c(0.16, 0.11, 0.07), 0.95);

  // --- buildings + tools -----------------------------------------------------
  const buildingWood = textured('buildingWoodMat', kit.planks, c(1, 1, 1), 0.85);
  const buildingStone = textured('buildingStoneMat', kit.stone, c(1, 1, 1), 1.0);
  const toolWood = textured('toolWoodMat', kit.toolWood, c(1.1, 1.05, 1.0), 0.55);
  const toolStone = textured('toolStoneMat', kit.toolStone, c(1.05, 1.05, 1.05), 0.7);

  // --- fx ---------------------------------------------------------------------
  const fireGlow = new StandardMaterial('fireGlowMat', scene);
  fireGlow.diffuseColor = c(1, 0.55, 0.18);
  fireGlow.emissiveColor = c(1, 0.5, 0.15);
  fireGlow.disableLighting = true;

  const ghost = new StandardMaterial('ghostMat', scene);
  ghost.diffuseColor = c(0.42, 0.62, 0.48);
  ghost.alpha = 0.45;
  ghost.disableLighting = true;

  return {
    bark,
    leaf,
    pineLeaf,
    rock,
    bushLeaf,
    berry,
    grass,
    flower,
    // stump reuses the bark look (tree cross-sections at this scale)
    stump: bark,
    playerBody,
    playerPants,
    playerBoots,
    playerSkin,
    playerHair,
    backpack,
    buildingWood,
    buildingStone,
    toolWood,
    toolStone,
    fireGlow,
    ghost,
  };
}
