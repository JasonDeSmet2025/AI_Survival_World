/**
 * Item + recipe definitions (Gameplay Agent scope).
 * Pure data — usable by inventory, crafting, HUD, save and MP.
 */

export type ItemKind = 'resource' | 'food' | 'tool' | 'building' | 'fuel';

export interface ItemDef {
  id: string;
  name: string;
  kind: ItemKind;
  /** Max stack size. */
  stack: number;
  /** HUD swatch color [r,g,b] 0..1. */
  color: [number, number, number];
  desc: string;
}

export const ITEMS: Record<string, ItemDef> = {
  wood: {
    id: 'wood', name: 'Wood', kind: 'resource', stack: 60,
    color: [0.45, 0.32, 0.18], desc: 'From trees. Basic building material.',
  },
  stone: {
    id: 'stone', name: 'Stone', kind: 'resource', stack: 60,
    color: [0.55, 0.55, 0.52], desc: 'From rocks. Used for tools and buildings.',
  },
  berry: {
    id: 'berry', name: 'Berries', kind: 'food', stack: 20,
    color: [0.75, 0.15, 0.2], desc: 'Edible. Restores a little hunger and thirst.',
  },
  'stone_axe': {
    id: 'stone_axe', name: 'Stone Axe', kind: 'tool', stack: 1,
    color: [0.6, 0.5, 0.3], desc: 'Chops wood much faster than bare hands.',
  },
  'stone_pick': {
    id: 'stone_pick', name: 'Stone Pickaxe', kind: 'tool', stack: 1,
    color: [0.55, 0.55, 0.55], desc: 'Mines stone much faster than bare hands.',
  },
  campfire: {
    id: 'campfire', name: 'Campfire', kind: 'building', stack: 5,
    color: [1, 0.55, 0.2], desc: 'Keeps you warm at night. Right-place with preview.',
  },
  wall: {
    id: 'wall', name: 'Wooden Wall', kind: 'building', stack: 10,
    color: [0.5, 0.38, 0.24], desc: 'Blocks line of sight and movement.',
  },
  floor: {
    id: 'floor', name: 'Wooden Floor', kind: 'building', stack: 10,
    color: [0.56, 0.44, 0.28], desc: 'A raised plank platform.',
  },
  roof: {
    id: 'roof', name: 'Roof Panel', kind: 'building', stack: 10,
    color: [0.42, 0.3, 0.18], desc: 'Covers your shelter from above.',
  },
};

export interface Recipe {
  id: string;
  output: { id: string; count: number };
  inputs: Array<{ id: string; count: number }>;
}

export const RECIPES: Recipe[] = [
  {
    id: 'recipe_axe',
    output: { id: 'stone_axe', count: 1 },
    inputs: [
      { id: 'wood', count: 2 },
      { id: 'stone', count: 1 },
    ],
  },
  {
    id: 'recipe_pick',
    output: { id: 'stone_pick', count: 1 },
    inputs: [
      { id: 'wood', count: 2 },
      { id: 'stone', count: 2 },
    ],
  },
  {
    id: 'recipe_campfire',
    output: { id: 'campfire', count: 1 },
    inputs: [
      { id: 'wood', count: 4 },
      { id: 'stone', count: 2 },
    ],
  },
  {
    id: 'recipe_wall',
    output: { id: 'wall', count: 2 },
    inputs: [{ id: 'wood', count: 6 }],
  },
  {
    id: 'recipe_floor',
    output: { id: 'floor', count: 2 },
    inputs: [{ id: 'wood', count: 4 }],
  },
  {
    id: 'recipe_roof',
    output: { id: 'roof', count: 2 },
    inputs: [
      { id: 'wood', count: 4 },
      { id: 'stone', count: 2 },
    ],
  },
];

/** Harvest yields per node kind (per successful harvest). */
export const YIELDS: Record<string, { itemId: string; min: number; max: number }> = {
  tree: { itemId: 'wood', min: 2, max: 3 },
  pine: { itemId: 'wood', min: 2, max: 3 },
  rock: { itemId: 'stone', min: 2, max: 3 },
  bush: { itemId: 'berry', min: 2, max: 3 },
};

/**
 * Harvest speed multiplier per node kind for hands vs tool.
 * (lower seconds = faster)
 */
export function harvestSeconds(kind: string, toolId: string | null): number {
  const tool = kind === 'rock' ? 'stone_pick' : kind === 'bush' ? null : 'stone_axe';
  const base = kind === 'bush' ? 0.7 : 1.4;
  if (tool && toolId === tool) return base * 0.45;
  return base;
}
