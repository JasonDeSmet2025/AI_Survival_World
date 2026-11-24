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
  // --- hunting yield -----------------------------------------------------
  raw_mutton: {
    id: 'raw_mutton', name: 'Rauw schapenvlees', kind: 'food', stack: 12,
    color: [0.78, 0.35, 0.35], desc: 'Van een schaap. Rauw eetbaar maar risky — bak het op een kampvuur.',
    edible: { hunger: 8, thirst: 0, health: -2 },
    cookable: { output: 'cooked_mutton', seconds: 6 },
  },
  cooked_mutton: {
    id: 'cooked_mutton', name: 'Gebraden schapenvlees', kind: 'food', stack: 12,
    color: [0.62, 0.3, 0.16], desc: 'Gebakken boven het kampvuur — een echte maaltijd.',
    edible: { hunger: 30, thirst: 2, health: 5 },
  },
  raw_beef: {
    id: 'raw_beef', name: 'Rauw rundvlees', kind: 'food', stack: 12,
    color: [0.7, 0.22, 0.24], desc: 'Van een koe. Rauw eetbaar maar risky — bak het op een kampvuur.',
    edible: { hunger: 10, thirst: 0, health: -3 },
    cookable: { output: 'cooked_beef', seconds: 8 },
  },
  cooked_beef: {
    id: 'cooked_beef', name: 'Gebraden rundvlees', kind: 'food', stack: 12,
    color: [0.5, 0.2, 0.12], desc: 'Gebakken boven het kampvuur — de meest vullende maaltijd.',
    edible: { hunger: 40, thirst: 2, health: 7 },
  },
  wool: {
    id: 'wool', name: 'Wol', kind: 'resource', stack: 12,
    color: [0.9, 0.87, 0.8], desc: 'Van schapen. Zachte isolatie — tapijt en warmte.',
  },
  // --- the money + the spider yield -----------------------------------------
  gold: {
    id: 'gold', name: 'Goudstuk', kind: 'resource', stack: 200,
    color: [0.92, 0.72, 0.22], desc: 'Munt van de dorpelingen. In de toren boven de spinnen te vinden, uit te geven bij Mara en Tomas — ze dongen af, net als echte mensen.',
  },
  silk: {
    id: 'silk', name: 'Spinrag', kind: 'resource', stack: 24,
    color: [0.82, 0.84, 0.9], desc: 'Sterker dan draad. Mara koopt het voor verband, Tomas voor pezen — uit de buik van een torenspin.',
  },
  leather: {
    id: 'leather', name: 'Leder', kind: 'resource', stack: 12,
    color: [0.55, 0.36, 0.2], desc: 'Van runderen. Sterk scharnier- en bindingmateriaal.',
  },
  // --- new structures -----------------------------------------------------
  door: {
    id: 'door', name: 'Houten Deur', kind: 'building', stack: 4,
    color: [0.48, 0.34, 0.18], desc: 'Sluit je huis af (E = openen/sluiten). Lederen scharnieren.',
  },
  stone_wall: {
    id: 'stone_wall', name: 'Stenen Muur', kind: 'building', stack: 10,
    color: [0.58, 0.57, 0.54], desc: 'Muur van netjes opgetrokken steen — zelfde raster als houten muren.',
  },
  torch: {
    id: 'torch', name: 'Fakkelperk', kind: 'building', stack: 5,
    color: [1, 0.68, 0.25], desc: 'Staande fakkel. Verlicht je kamp en terras ’s nachts.',
  },
  carpet: {
    id: 'carpet', name: 'Wollen Tapijt', kind: 'building', stack: 6,
    color: [0.72, 0.28, 0.3], desc: 'Wol op je vloer — puur knus, maar het staat lekker.',
  },
  sword: {
    id: 'sword', name: 'Stenen Zwaard', kind: 'tool', stack: 1,
    color: [0.75, 0.76, 0.8], desc: 'Scherp genoeg om dieren neer te slaan en andere spelers te verwonden. LMB zwaait.',
    // Each swing costs one swing-animation of wear (~200 strikes total).
    tool: { maxDurability: 100, wearPerSec: 1.4 },
  },
  potion_heal: {
    id: 'potion_heal', name: 'Genezingsdrank', kind: 'food', stack: 5,
    color: [0.9, 0.2, 0.35], desc: 'Van de heks — herstelt 40 gezondheid in één slok.',
    edible: { hunger: 2, thirst: 6, health: 40 },
  },
  potion_swift: {
    id: 'potion_swift', name: 'Snelheidsdrank', kind: 'food', stack: 5,
    color: [0.95, 0.75, 0.15], desc: 'Van de heks — 90 seconden ren je als de wind.',
    edible: { hunger: 1, thirst: 5, health: 1 },
  },
  potion_night: {
    id: 'potion_night', name: 'Nachtzichtdrank', kind: 'food', stack: 5,
    color: [0.35, 0.55, 0.95], desc: 'Van de heks — 120 seconden licht rondom jou in het donker.',
    edible: { hunger: 1, thirst: 5, health: 1 },
  },
  potion_fire: {
    id: 'potion_fire', name: 'Vuurdrank', kind: 'food', stack: 5,
    color: [1.0, 0.42, 0.1], desc: 'Van de heks — 120 seconden prikt lava je alleen maar.',
    edible: { hunger: 2, thirst: 4, health: 1 },
  },
  potion_strength: {
    id: 'potion_strength', name: 'Krachtdrank', kind: 'food', stack: 5,
    color: [0.7, 0.15, 0.15], desc: 'Van de heks — 90 seconden slaan en schieten dubbel zo hard.',
    edible: { hunger: 2, thirst: 4, health: 1 },
  },
  potion_tough: {
    id: 'potion_tough', name: 'Houtenhuid', kind: 'food', stack: 5,
    color: [0.45, 0.35, 0.2], desc: 'Van de heks — 90 seconden voel je klauwen en bits als takken.',
    edible: { hunger: 2, thirst: 4, health: 1 },
  },
  herb: {
    id: 'herb', name: 'Torenkruid', kind: 'resource', stack: 64,
    color: [0.35, 0.6, 0.3], desc: 'Groeit in de pot van een heks en in de vacht van haar wachters. Moeder van elke drank — en van Wondzalf.',
  },
  // --- THE FOUR ELEMENTS -------------------------------------------------
  // The alchemy layer of the world. Each element is reaped from ONE kind of
  // nature (see ELEMENT_DROPS in systems/elements.ts): fire comes only from
  // the crater's glassy rocks, air from the leafy canopy, earth from under
  // the pines and water from the dewy berry bushes — the elements are what
  // make you walk into different corners of the map. A pinch eaten raw gives
  // a short (20 s) version of the witch's brew; combined with Torenkruid at
  // the workbench it becomes the real thing.
  element_fire: {
    id: 'element_fire', name: 'Vuurpoeder', kind: 'resource', stack: 20,
    color: [1.0, 0.45, 0.12],
    desc: 'Vonkend glasgruis uit de kraterstenen. Eet een snuf (20 s lava-immuun) of stook er bij de tekentafel een Vuurdrank van.',
    edible: { hunger: 1, thirst: 0, health: 0 },
  },
  element_water: {
    id: 'element_water', name: 'Waterdauw', kind: 'resource', stack: 20,
    color: [0.3, 0.62, 0.95],
    desc: 'Heldere dauw die op rijpe bessen blijft hangen. Eet een snuf (20 s nachtzicht) of brouw er bij de tekentafel een Nachtzichtdrank van.',
    edible: { hunger: 1, thirst: 8, health: 1 },
  },
  element_air: {
    id: 'element_air', name: 'Luchtveder', kind: 'resource', stack: 20,
    color: [0.75, 0.9, 0.98],
    desc: 'Pluizig vederschil dat hoog boven de bomen blijft zweven. Eet een snuf (20 s sneller) of bind er bij de tekentafel een Snelheidsdrank van.',
    edible: { hunger: 1, thirst: 0, health: 1 },
  },
  element_earth: {
    id: 'element_earth', name: 'Aardekloot', kind: 'resource', stack: 20,
    color: [0.46, 0.33, 0.2],
    desc: 'Klibberige kluit onder de naaldbomen. Eet een kloot (20 s houtenhuid) of meng er bij de tekentafel Houtenhuid van.',
    edible: { hunger: 2, thirst: 0, health: 1 },
  },
  salve: {
    id: 'salve', name: 'Wondzalf', kind: 'food', stack: 10,
    color: [0.55, 0.8, 0.5], desc: 'Van torenkruid en bessen — eetbare smeer die 30 gezondheid herstelt.',
    edible: { hunger: 4, thirst: 2, health: 30 },
  },
  // --- second building tier (added with the extra craft list) -------------
  rope: {
    id: 'rope', name: 'Touw', kind: 'resource', stack: 12,
    color: [0.82, 0.72, 0.45], desc: 'Gevlochten wol. Draai je touw van — nodig voor de jachtboog.',
  },
  arrow: {
    id: 'arrow', name: 'Pijl', kind: 'resource', stack: 20,
    color: [0.72, 0.66, 0.55], desc: 'Verbruiksitem: elke schoot met de boog kost er één.',
  },
  bow: {
    id: 'bow', name: 'Jachtboog', kind: 'tool', stack: 1,
    color: [0.62, 0.44, 0.24],
    desc: 'LMB schiet tot 22 m ver — dieren van afstand strikken. Kost per schoot een pijl.',
    // Each shot pays one draw animation of wear (~300 arrows before it snaps).
    tool: { maxDurability: 90, wearPerSec: 1.2 },
  },
  shield: {
    id: 'shield', name: 'Houten Schild', kind: 'tool', stack: 1,
    color: [0.5, 0.36, 0.22],
    desc: 'Geselecteerd = de helft minder schade van klappen en vallen. Slijt per blok.',
    // Blocks are charged as flat wear (SHIELD_BLOCK_WEAR), not per second:
    // 90 blocks before it shatters, which is the whole point of carrying one.
    tool: { maxDurability: 180, wearPerSec: 2 },
  },
  fence: {
    id: 'fence', name: 'Houten Hek', kind: 'building', stack: 10,
    color: [0.52, 0.4, 0.26], desc: 'Lijnt je kavel af. Loop er niet overheen — wel omheen.',
  },
  stairs: {
    id: 'stairs', name: 'Houten Trap', kind: 'building', stack: 4,
    color: [0.54, 0.42, 0.26], desc: 'Loopt in één cel omhoog (+0,9 m). Zet de richting met je kijkhoek.',
  },
  workbench: {
    id: 'workbench', name: 'Tekentafel', kind: 'building', stack: 2,
    color: [0.46, 0.34, 0.2],
    desc: 'Je eerste werkplek. Alleen hier maak je bouw-, wapen- en kledingrecepten — en je werkt er 40% sneller.',
  },
  planter: {
    id: 'planter', name: 'Bloempot', kind: 'building', stack: 4,
    color: [0.5, 0.38, 0.24], desc: 'Plant een struik erin: elke 90 s rijpe bessen (E om te plukken).',
  },
  sign: {
    id: 'sign', name: 'Houten Bord', kind: 'building', stack: 6,
    color: [0.58, 0.45, 0.28], desc: 'Een bord op een paal. Duidelijk voor wie langskomt.',
  },
  stew: {
    id: 'stew', name: 'Hutpot', kind: 'food', stack: 6,
    color: [0.6, 0.36, 0.2], desc: 'Gaarvuurmaaltijd in één kom — het vullendst wat je kunt maken.',
    edible: { hunger: 55, thirst: 10, health: 14 },
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
  /**
   * true = doable anywhere, with bare hands in the open field. Missing =
   * the recipe needs a WORK STATION: the player must stand within
   * BENCH_RADIUS of their own tekentafel (`workbench`, systems/crafting.ts).
   *
   * The default is deliberately the strict one: a new recipe is a project,
   * not a keystroke. The whole tech tree therefore hangs off ONE milestone —
   * collect wood, make the table, and only then the house, the bow, the
   * stew pot — which is also what keeps the craft menu small in the first
   * half hour of the game. Which recipes stay `fieldRecipe` is pinned by
   * items.test.ts, so the set can never drift silently.
   */
  fieldRecipe?: boolean;
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
    fieldRecipe: true,
  },
  {
    id: 'recipe_pick',
    output: { id: 'stone_pick', count: 1 },
    inputs: [
      { id: 'wood', count: 2 },
      { id: 'stone', count: 2 },
    ],
    craftSeconds: 3,
    fieldRecipe: true,
  },
  {
    id: 'recipe_campfire',
    output: { id: 'campfire', count: 1 },
    inputs: [
      { id: 'wood', count: 4 },
      { id: 'stone', count: 2 },
    ],
    craftSeconds: 4,
    fieldRecipe: true,
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
  {
    id: 'recipe_torch',
    fieldRecipe: true,
    output: { id: 'torch', count: 2 },
    inputs: [
      { id: 'wood', count: 2 },
      { id: 'stone', count: 1 },
    ],
    craftSeconds: 3,
    unlockLevel: 2,
  },
  {
    id: 'recipe_stone_wall',
    output: { id: 'stone_wall', count: 2 },
    inputs: [{ id: 'stone', count: 6 }],
    craftSeconds: 5,
    unlockLevel: 3,
  },
  {
    id: 'recipe_door',
    output: { id: 'door', count: 1 },
    inputs: [
      { id: 'wood', count: 6 },
      { id: 'leather', count: 1 },
    ],
    craftSeconds: 5,
    unlockLevel: 3,
  },
  {
    id: 'recipe_carpet',
    output: { id: 'carpet', count: 1 },
    inputs: [
      { id: 'wool', count: 4 },
      { id: 'wood', count: 2 },
    ],
    craftSeconds: 4,
    unlockLevel: 3,
  },
  {
    id: 'recipe_sword',
    output: { id: 'sword', count: 1 },
    inputs: [
      { id: 'stone', count: 6 },
      { id: 'wood', count: 3 },
      { id: 'leather', count: 1 },
    ],
    craftSeconds: 6,
    unlockLevel: 2,
  },
  // --- second tier: the hunting + building expansion ---------------------
  {
    id: 'recipe_rope',
    fieldRecipe: true,
    output: { id: 'rope', count: 2 },
    inputs: [{ id: 'wool', count: 3 }],
    craftSeconds: 3,
    unlockLevel: 2,
  },
  {
    id: 'recipe_fence',
    output: { id: 'fence', count: 2 },
    inputs: [{ id: 'wood', count: 4 }],
    craftSeconds: 4,
    unlockLevel: 2,
  },
  {
    // The alchemist's answer to the witch's heal potion: she keeps her
    // recipe, the player can copy the HERB half of it. Needs the table —
    // grinding salve bare-handed is a fairy tale.
    id: 'recipe_salve',
    output: { id: 'salve', count: 1 },
    inputs: [
      { id: 'herb', count: 2 },
      { id: 'berry', count: 2 },
    ],
    craftSeconds: 4,
    unlockLevel: 2,
  },
  {
    id: 'recipe_sign',
    output: { id: 'sign', count: 1 },
    inputs: [{ id: 'wood', count: 2 }],
    craftSeconds: 2,
    unlockLevel: 2,
  },
  {
    id: 'recipe_shield',
    output: { id: 'shield', count: 1 },
    inputs: [
      { id: 'wood', count: 5 },
      { id: 'leather', count: 2 },
    ],
    craftSeconds: 5,
    unlockLevel: 3,
  },
  {
    id: 'recipe_stairs',
    output: { id: 'stairs', count: 1 },
    inputs: [
      { id: 'wood', count: 6 },
      { id: 'stone', count: 2 },
    ],
    craftSeconds: 5,
    unlockLevel: 3,
  },
  {
    id: 'recipe_workbench',
    // THE first milestone of the game: six sticks and a few minutes of work,
    // and every other recipe opens up. Deliberately level 1 and deliberately
    // cheap enough that a fresh player can reach it before the first night.
    fieldRecipe: true,
    output: { id: 'workbench', count: 1 },
    inputs: [{ id: 'wood', count: 6 }],
    craftSeconds: 5,
    unlockLevel: 1,
  },
  {
    id: 'recipe_planter',
    output: { id: 'planter', count: 1 },
    inputs: [
      { id: 'wood', count: 6 },
      { id: 'stone', count: 4 },
    ],
    craftSeconds: 5,
    unlockLevel: 3,
  },
  {
    id: 'recipe_bow',
    output: { id: 'bow', count: 1 },
    inputs: [
      { id: 'wood', count: 4 },
      { id: 'rope', count: 2 },
    ],
    craftSeconds: 6,
    unlockLevel: 4,
  },
  {
    id: 'recipe_arrow',
    output: { id: 'arrow', count: 4 },
    inputs: [
      { id: 'wood', count: 1 },
      { id: 'stone', count: 1 },
    ],
    craftSeconds: 3,
    unlockLevel: 4,
  },
  {
    id: 'recipe_stew',
    output: { id: 'stew', count: 2 },
    inputs: [
      { id: 'cooked_beef', count: 1 },
      { id: 'cooked_mutton', count: 1 },
      { id: 'berry', count: 2 },
    ],
    craftSeconds: 6,
    unlockLevel: 4,
  },
  // --- ELEMENTAL ALCHEMY -------------------------------------------------
  // The witch's monopoly, politely ended: with an element in one hand and
  // her own torenkruid in the other, the workbench replicates her brews at
  // level 4. Raw pinches work in a hurry; real brewing is twice as strong.
  {
    id: 'recipe_potion_fire',
    output: { id: 'potion_fire', count: 1 },
    inputs: [
      { id: 'element_fire', count: 2 },
      { id: 'herb', count: 1 },
    ],
    craftSeconds: 6,
    unlockLevel: 4,
  },
  {
    id: 'recipe_potion_night',
    output: { id: 'potion_night', count: 1 },
    inputs: [
      { id: 'element_water', count: 2 },
      { id: 'herb', count: 1 },
    ],
    craftSeconds: 6,
    unlockLevel: 4,
  },
  {
    id: 'recipe_potion_swift',
    output: { id: 'potion_swift', count: 1 },
    inputs: [
      { id: 'element_air', count: 2 },
      { id: 'herb', count: 1 },
    ],
    craftSeconds: 6,
    unlockLevel: 4,
  },
  {
    id: 'recipe_potion_tough',
    output: { id: 'potion_tough', count: 1 },
    inputs: [
      { id: 'element_earth', count: 2 },
      { id: 'herb', count: 1 },
    ],
    craftSeconds: 6,
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
