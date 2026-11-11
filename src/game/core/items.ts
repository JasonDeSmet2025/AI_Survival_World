/**
 * Item + recipe definitions (Gameplay Agent scope).
 * Pure data — usable by inventory, crafting, HUD, save and MP.
 */

export type ItemKind = 'resource' | 'food' | 'tool' | 'building' | 'fuel';

/** Stat changes applied when one unit of a consumable is used. */
export interface FoodEffect {
  hunger: number;
  thirst: number;
  health: number;
}

/** Cooking model: the item can be cooked at a lit campfire into `output`. */
export interface Cookable {
  /** Item id produced by one successful cook. */
  output: string;
  /** Real seconds the cook takes next to a lit fire. */
  seconds: number;
}

/** Wear model for tools. Durability drains continuously while the tool is in use. */
export interface ToolWear {
  /** Durability points at full condition (also the HUD bar denominator). */
  maxDurability: number;
  /** Durability points lost per second of active use. */
  wearPerSec: number;
}

export interface ItemDef {
  id: string;
  name: string;
  kind: ItemKind;
  /** Max stack size. */
  stack: number;
  /** HUD swatch color [r,g,b] 0..1. */
  color: [number, number, number];
  desc: string;
  /** Present on consumable (food) items: effects of eating one unit. */
  edible?: FoodEffect;
  /** Present on tools: wear + breakage model. */
  tool?: ToolWear;
  /** Present on campfire-cookable items: output item + cook time. */
  cookable?: Cookable;
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
    color: [0.75, 0.15, 0.2], desc: 'Edible. Better cooked at a campfire (select + E).',
    edible: { hunger: 12, thirst: 5, health: 1 },
    cookable: { output: 'cooked_berry', seconds: 5 },
  },
  cooked_berry: {
    id: 'cooked_berry', name: 'Gekookte bessen', kind: 'food', stack: 20,
    color: [0.52, 0.1, 0.14], desc: 'Gekookt op een kampvuur — voedzamer dan rauwe bessen.',
    edible: { hunger: 18, thirst: 8, health: 2 },
  },
  'stone_axe': {
    id: 'stone_axe', name: 'Stone Axe', kind: 'tool', stack: 1,
    color: [0.6, 0.5, 0.3], desc: 'Chops wood much faster than bare hands. Wears out with use.',
    tool: { maxDurability: 120, wearPerSec: 0.25 },
  },
  'stone_pick': {
    id: 'stone_pick', name: 'Stone Pickaxe', kind: 'tool', stack: 1,
    color: [0.55, 0.55, 0.55], desc: 'Mines stone much faster than bare hands. Wears out with use.',
    tool: { maxDurability: 120, wearPerSec: 0.3 },
  },
  campfire: {
    id: 'campfire', name: 'Campfire', kind: 'building', stack: 5,
    color: [1, 0.55, 0.2], desc: 'Burns for 5 min, +2 min per log of wood. Keeps you warm and lets you cook (bessen geselecteerd + E).',
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
  bed: {
    id: 'bed', name: 'Wooden Bed', kind: 'building', stack: 2,
    color: [0.52, 0.4, 0.26], desc: 'Sleep in it (E) to rest until morning: full stamina, some health back.',
  },
};

export interface Recipe {
  id: string;
  output: { id: string; count: number };
  inputs: Array<{ id: string; count: number }>;
  /**
   * Real seconds of work the recipe takes (timed crafting). The player
   * stands still and works while the session runs; inputs are consumed
   * only when the session completes, so cancelling loses nothing.
   */
  craftSeconds: number;
  /**
   * Player level required before the recipe is available (progression).
   * Missing = available from level 1. Data-driven: unlocking is decided
   * by systems/progress.ts and systems/crafting.ts from this single field.
   */
  unlockLevel?: number;
}

export const RECIPES: Recipe[] = [
  {
    id: 'recipe_axe',
    output: { id: 'stone_axe', count: 1 },
    inputs: [
      { id: 'wood', count: 2 },
      { id: 'stone', count: 1 },
    ],
    craftSeconds: 3,
  },
  {
    id: 'recipe_pick',
    output: { id: 'stone_pick', count: 1 },
    inputs: [
      { id: 'wood', count: 2 },
      { id: 'stone', count: 2 },
    ],
    craftSeconds: 3,
  },
  {
    id: 'recipe_campfire',
    output: { id: 'campfire', count: 1 },
    inputs: [
      { id: 'wood', count: 4 },
      { id: 'stone', count: 2 },
    ],
    craftSeconds: 4,
  },
  {
    id: 'recipe_wall',
    output: { id: 'wall', count: 2 },
    inputs: [{ id: 'wood', count: 6 }],
    craftSeconds: 5,
    unlockLevel: 2,
  },
  {
    id: 'recipe_floor',
    output: { id: 'floor', count: 2 },
    inputs: [{ id: 'wood', count: 4 }],
    craftSeconds: 4,
    unlockLevel: 2,
  },
  {
    id: 'recipe_roof',
    output: { id: 'roof', count: 2 },
    inputs: [
      { id: 'wood', count: 4 },
      { id: 'stone', count: 2 },
    ],
    craftSeconds: 5,
    unlockLevel: 3,
  },
  {
    id: 'recipe_bed',
    output: { id: 'bed', count: 1 },
    inputs: [
      { id: 'wood', count: 8 },
      { id: 'stone', count: 2 },
    ],
    craftSeconds: 5,
    unlockLevel: 4,
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
 * The tool that works effectively on a node kind (single source of truth
 * for harvest speed, the +1 bonus item and wear): the axe chops trees and
 * pines, the pickaxe mines rocks, bushes are picked by hand.
 */
export function toolForNode(kind: string): string | null {
  if (kind === 'rock') return 'stone_pick';
  if (kind === 'tree' || kind === 'pine') return 'stone_axe';
  return null;
}

/**
 * Harvest speed multiplier per node kind for hands vs tool.
 * (lower seconds = faster)
 */
export function harvestSeconds(kind: string, toolId: string | null): number {
  const tool = toolForNode(kind);
  const base = kind === 'bush' ? 0.7 : 1.4;
  if (tool && toolId === tool) return base * 0.45;
  return base;
}
