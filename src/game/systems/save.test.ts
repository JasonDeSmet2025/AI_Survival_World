import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ITEMS } from '../core/items';
import type { BuildingData, ResourceNode } from '../world/types';
import { SharedWorldState } from '../world/worldState';
import { clampCameraPitch } from '../player/controller';
import { CookSession } from './cook';
import { CraftSession } from './crafting';
import { resolveHarvest } from './harvest';
import { Inventory, INVENTORY_SIZE } from './inventory';
import { Progression } from './progress';
import { Save } from './save';
import { SurvivalStats } from './stats';

/**
 * The save file is the only thing a solo player owns permanently, and it is
 * the one path that used to be covered by nothing: `Save.read()` accepted
 * any JSON with `v: 1`, and game.ts restored stats, inventory, world,
 * progression and NPC memory straight out of it. A truncated or foreign
 * object therefore crashed the game boot (black screen, no world) instead of
 * falling back to a fresh start.
 *
 * These tests cover both sides: the structural guard, and a REAL gameplay
 * chain — gather, craft, cook, harvest a node, wear a tool — that is saved
 * and restored without losing or inventing a single unit.
 */

function installFakeStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  };
  (globalThis as Record<string, unknown>).localStorage = storage;
  return store;
}

const NODE = (id: string, kind: ResourceNode['kind'], hp = 3): ResourceNode => ({
  id,
  kind,
  x: 10,
  y: 1,
  z: 10,
  hp,
  maxHp: hp,
  radius: 1.5,
});

const FIRE: BuildingData = { id: 'b1', kind: 'campfire', x: 4, z: 4, y: 1, rot: 0, ownerId: 'p1', fuel: 300 };

let store: Map<string, string>;

beforeEach(() => {
  store = installFakeStorage();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage;
});

describe('Save structural guard', () => {
  it('returns null when nothing was ever stored', () => {
    expect(Save.read()).toBeNull();
  });

  it('round-trips a complete save', () => {
    const inv = new Inventory();
    inv.add('wood', 7);
    const stats = new SurvivalStats();
    const data = Save.toSaveData(stats.snapshot(), inv, { x: 1, y: 2, z: 3 }, 0.5, -0.65, 120, {
      version: 1,
      seed: 0x5eed2024,
      depleted: ['n1'],
      hp: { n2: 1 },
      buildings: [],
    });
    expect(Save.write(data)).toBe(true);
    const back = Save.read();
    expect(back).not.toBeNull();
    expect(back!.inventory).toEqual(data.inventory);
    expect(back!.stats).toEqual(data.stats);
    expect(back!.world.depleted).toEqual(['n1']);
    expect(back!.world.hp).toEqual({ n2: 1 });
    expect(back!.pos).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('rejects junk, wrong versions and partial shapes instead of returning them', () => {
    const put = (raw: string) => store.set('asw_save_v1', raw);

    put('not json at all');
    expect(Save.read()).toBeNull();

    put('null');
    expect(Save.read()).toBeNull();
    put('[1,2,3]');
    expect(Save.read()).toBeNull();
    put('"a string"');
    expect(Save.read()).toBeNull();

    put(JSON.stringify({ v: 2, savedAt: 1 })); // future/unknown version
    expect(Save.read()).toBeNull();

    put(JSON.stringify({ v: 1 })); // no fields at all
    expect(Save.read()).toBeNull();

    const base = {
      v: 1,
      savedAt: 1,
      stats: new SurvivalStats().snapshot(),
      inventory: [],
      selected: 0,
      pos: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: -0.65,
      elapsed: 0,
      world: { version: 1, seed: 0, depleted: [], hp: {}, buildings: [] },
    };
    // Every required part must be there in the right shape.
    put(JSON.stringify({ ...base, stats: undefined }));
    expect(Save.read()).toBeNull();
    put(JSON.stringify({ ...base, inventory: 'wood' }));
    expect(Save.read()).toBeNull();
    put(JSON.stringify({ ...base, pos: { x: NaN, y: 0, z: 0 } }));
    expect(Save.read()).toBeNull();
    put(JSON.stringify({ ...base, pitch: 'up' }));
    expect(Save.read()).toBeNull();
    put(JSON.stringify({ ...base, world: { version: 1, seed: 0 } }));
    expect(Save.read()).toBeNull();
    // Malformed OPTIONAL parts are rejected too (they are restored directly).
    put(JSON.stringify({ ...base, progress: { level: 'high', xp: 0 } }));
    expect(Save.read()).toBeNull();
    put(JSON.stringify({ ...base, npcs: [] }));
    expect(Save.read()).toBeNull();

    // ...while a legacy save WITHOUT the optional parts still loads.
    put(JSON.stringify(base));
    expect(Save.read()).not.toBeNull();
    put(JSON.stringify({ ...base, progress: { level: 3, xp: 40 }, npcs: { mara: { history: [] } } }));
    expect(Save.read()).not.toBeNull();
  });

  it('clear() removes the save', () => {
    const inv = new Inventory();
    Save.write(Save.toSaveData(new SurvivalStats().snapshot(), inv, { x: 0, y: 0, z: 0 }, 0, -0.65, 0, {
      version: 1,
      seed: 0,
      depleted: [],
      hp: {},
      buildings: [],
    }));
    expect(Save.read()).not.toBeNull();
    Save.clear();
    expect(Save.read()).toBeNull();
    expect(store.size).toBe(0);
  });

  it('reports failure instead of throwing when storage is unavailable', () => {
    (globalThis as Record<string, unknown>).localStorage = {
      getItem() {
        throw new Error('quota');
      },
      setItem() {
        throw new Error('quota');
      },
    };
    const data = Save.toSaveData(new SurvivalStats().snapshot(), new Inventory(), { x: 0, y: 0, z: 0 }, 0, -0.65, 0, {
      version: 1,
      seed: 0,
      depleted: [],
      hp: {},
      buildings: [],
    });
    expect(Save.write(data)).toBe(false);
    expect(Save.read()).toBeNull();
    expect(() => Save.clear()).not.toThrow();
  });
});

describe('gameplay chain survives a save/load round trip', () => {
  it('gather → craft → cook → harvest → save → load restores everything', () => {
    const inv = new Inventory();
    const stats = new SurvivalStats();
    const prog = new Progression();
    const world = new SharedWorldState();
    world.registerNode(NODE('t1', 'tree', 3));
    world.registerNode(NODE('r1', 'rock', 2));
    world.addBuilding({ ...FIRE });

    // Gather twice with the axe (bonus included) and pay the XP.
    inv.add('stone_axe', 1);
    for (let i = 0; i < 2; i++) {
      const out = resolveHarvest({ kind: 'tree', inventory: inv, toolId: 'stone_axe', rng: () => 0 });
      expect(out.status).toBe('gathered');
      expect(out.granted).toBe(out.rolled);
      prog.addXp(out.xp);
    }
    const woodGathered = inv.count('wood');
    expect(woodGathered).toBe(6); // (min 2 + tool bonus 1) × 2 harvests

    // Craft one axe from the gathered wood plus some stone.
    inv.add('stone', 2);
    const craft = CraftSession.start(inv, 'recipe_pick', prog.level)!;
    expect(craft).toBeDefined();
    expect(craft.tick(inv, craft.duration + 1)).toBe('done');
    expect(inv.count('stone_pick')).toBe(1);

    // Cook a berry at the fire.
    inv.add('berry', 2);
    const cook = CookSession.start('berry', inv, { id: FIRE.id, fuel: FIRE.fuel })!;
    expect(cook.tick(inv, FIRE.fuel, cook.duration)).toBe('done');
    expect(inv.count('cooked_berry')).toBe(1);

    // Damage the world and wear the tool down a bit.
    world.damageNode('t1', 2); // 3 → 1 hp, not depleted
    world.damageNode('r1', 2); // 2 → 0 hp, depleted
    world.building('b1')!.fuel = 120; // the fire burned down while playing
    const wornSlot = inv.slots.find((s) => s && s.id === 'stone_axe');
    expect(wornSlot).toBeDefined();
    wornSlot!.durability = 41;

    stats.health = 63.5;
    stats.hunger = 44;
    stats.temperature = 12.25;

    const data = Save.toSaveData(
      stats.snapshot(),
      inv,
      { x: 12.5, y: 3, z: -8 },
      1.25,
      // A LOOKING-UP pitch: an older loader clamped this to -0.65 on load.
      0.9,
      480,
      world.serialize(),
      { level: prog.level, xp: prog.xp },
    );
    expect(Save.write(data)).toBe(true);

    // --- fresh session: restore exactly like game.ts does ---
    const back = Save.read()!;
    const inv2 = new Inventory();
    inv2.restore(back.inventory, back.selected);
    const stats2 = new SurvivalStats();
    stats2.restore(back.stats);
    const prog2 = new Progression();
    if (back.progress) prog2.restore(back.progress);
    const world2 = new SharedWorldState();
    world2.registerNode(NODE('t1', 'tree', 3));
    world2.registerNode(NODE('r1', 'rock', 2));
    world2.apply(back.world);

    expect(inv2.serialize()).toEqual(inv.serialize()); // includes durability
    expect(inv2.count('wood')).toBe(woodGathered - 2); // recipe_pick costs 2 wood
    expect(inv2.slots.find((s) => s && s.id === 'stone_axe')!.durability).toBe(41);
    expect(stats2.snapshot()).toEqual(stats.snapshot());
    expect(prog2.level).toBe(prog.level);
    expect(prog2.xp).toBe(prog.xp);
    expect(world2.hp['t1']).toBe(1);
    expect(world2.isDepleted('r1')).toBe(true);
    expect(world2.building('b1')!.fuel).toBe(120);

    // Camera orientation survives WITHOUT being flattened.
    expect(back.pitch).toBe(0.9);
    expect(clampCameraPitch(back.pitch)).toBe(0.9);
    expect(back.yaw).toBe(1.25);
    expect(back.elapsed).toBe(480);
  });

  it('restores a nearly full bag slot-for-slot, including partial stacks', () => {
    const inv = new Inventory();
    for (let i = 0; i < INVENTORY_SIZE - 1; i++) inv.add('wall', ITEMS.wall.stack);
    inv.add('berry', 3);
    inv.add('cooked_berry', 7);
    inv.select(5);
    Save.write(
      Save.toSaveData(new SurvivalStats().snapshot(), inv, { x: 0, y: 0, z: 0 }, 0, -0.65, 0, {
        version: 1,
        seed: 0,
        depleted: [],
        hp: {},
        buildings: [],
      }),
    );
    const back = Save.read()!;
    const inv2 = new Inventory();
    inv2.restore(back.inventory, back.selected);
    expect(inv2.serialize()).toEqual(inv.serialize());
    expect(inv2.selected).toBe(5);
    // The restored bag is still full: no phantom room appeared.
    expect(inv2.roomFor('wood')).toBe(0);
  });
});

describe('camera pitch handling (the flattened-look bug)', () => {
  it('keeps the whole playable range instead of collapsing to the default', () => {
    // Looking up (positive) and far down (-1.15) must survive a load; the
    // old loader used Math.min(pitch, -0.65), which flattened both.
    expect(clampCameraPitch(0.9)).toBe(0.9);
    expect(clampCameraPitch(-1.1)).toBe(-1.1);
    expect(clampCameraPitch(-0.65)).toBe(-0.65);
    // Out-of-range values (a hand-edited or corrupt save) are pulled back.
    expect(clampCameraPitch(5)).toBeLessThan(2);
    expect(clampCameraPitch(-5)).toBeGreaterThan(-2);
    // Garbage falls back to the horizon default.
    expect(clampCameraPitch(Number.NaN)).toBe(-0.65);
    expect(clampCameraPitch(undefined as unknown as number)).toBe(-0.65);
  });
});
