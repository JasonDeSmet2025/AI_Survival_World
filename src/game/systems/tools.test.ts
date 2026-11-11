import { describe, expect, it } from 'vitest';
import { harvestSeconds, ITEMS, toolForNode } from '../core/items';
import { Inventory } from './inventory';
import { Crafting } from './crafting';
import {
  isEffectiveTool,
  remainingUses,
  slotDurability,
  toolInfo,
  wearTool,
} from './tools';

const AXE = ITEMS.stone_axe.tool!;
const PICK = ITEMS.stone_pick.tool!;

function invWithTool(itemId: string, durability?: number): Inventory {
  const inv = new Inventory();
  inv.add(itemId, 1);
  const idx = inv.slots.findIndex((s) => s?.id === itemId);
  if (durability !== undefined) inv.slots[idx]!.durability = durability;
  return inv;
}

function toolSlotIndex(inv: Inventory, itemId: string): number {
  const idx = inv.slots.findIndex((s) => s?.id === itemId);
  expect(idx).toBeGreaterThanOrEqual(0);
  return idx;
}

describe('toolInfo', () => {
  it('returns the wear model for tools', () => {
    const info = toolInfo('stone_axe');
    expect(info).toEqual({ id: 'stone_axe', maxDurability: AXE.maxDurability, wearPerSec: AXE.wearPerSec });
    expect(toolInfo('stone_pick')!.maxDurability).toBe(PICK.maxDurability);
  });

  it('returns null for non-tools, unknown ids and empty selection', () => {
    expect(toolInfo('wood')).toBeNull();
    expect(toolInfo('campfire')).toBeNull();
    expect(toolInfo('unknown')).toBeNull();
    expect(toolInfo(null)).toBeNull();
  });
});

describe('isEffectiveTool', () => {
  it('matches the node-specific tools only', () => {
    expect(isEffectiveTool('stone_axe', 'tree')).toBe(true);
    expect(isEffectiveTool('stone_axe', 'pine')).toBe(true);
    expect(isEffectiveTool('stone_pick', 'rock')).toBe(true);
    // Wrong tool for the node: no effect, no wear.
    expect(isEffectiveTool('stone_axe', 'rock')).toBe(false);
    expect(isEffectiveTool('stone_pick', 'tree')).toBe(false);
    // Bushes are picked by hand; no item is effective there.
    expect(isEffectiveTool('stone_axe', 'bush')).toBe(false);
    expect(isEffectiveTool(null, 'tree')).toBe(false);
  });
});

describe('wearTool', () => {
  it('drains durability by wearPerSec * dt while in use', () => {
    const inv = invWithTool('stone_axe');
    const idx = toolSlotIndex(inv, 'stone_axe');
    const before = inv.slots[idx]!.durability!;

    const r = wearTool(inv, idx, 10);

    expect(r.broke).toBe(false);
    expect(r.itemId).toBe('stone_axe');
    expect(inv.slots[idx]!.durability).toBeCloseTo(before - AXE.wearPerSec * 10);
  });

  it('does not go below 0 without breaking: the last partial tick breaks the tool', () => {
    const inv = invWithTool('stone_axe', AXE.wearPerSec * 10); // exactly 10s of life left
    const idx = toolSlotIndex(inv, 'stone_axe');

    const r = wearTool(inv, idx, 10.0001);

    expect(r.broke).toBe(true);
    expect(r.itemId).toBe('stone_axe');
    expect(inv.slots[idx]).toBeNull(); // slot emptied — gathering falls back to hands
  });

  it('is a no-op for empty slots and non-tool items', () => {
    const inv = new Inventory();
    expect(wearTool(inv, 0, 5)).toEqual({ broke: false, itemId: null });

    inv.add('wood', 5);
    const r = wearTool(inv, 0, 5);
    expect(r.broke).toBe(false);
    expect(r.itemId).toBe(null);
    expect(inv.count('wood')).toBe(5);
  });

  it('ignores non-positive dt', () => {
    const inv = invWithTool('stone_pick', 60);
    const idx = toolSlotIndex(inv, 'stone_pick');
    expect(wearTool(inv, idx, 0)).toEqual({ broke: false, itemId: 'stone_pick' });
    expect(inv.slots[idx]!.durability).toBe(60);
  });

  it('treats a legacy tool slot (no durability value) as full', () => {
    const inv = invWithTool('stone_axe');
    const idx = toolSlotIndex(inv, 'stone_axe');
    inv.slots[idx]!.durability = undefined;

    const r = wearTool(inv, idx, 10);

    expect(r.broke).toBe(false);
    expect(inv.slots[idx]!.durability).toBeCloseTo(AXE.maxDurability - AXE.wearPerSec * 10);
  });
});

describe('slotDurability / remainingUses', () => {
  it('reports current and max for tools, null otherwise', () => {
    const inv = invWithTool('stone_axe', 42);
    const idx = toolSlotIndex(inv, 'stone_axe');
    expect(slotDurability(inv, idx)).toEqual({ current: 42, max: AXE.maxDurability });
    inv.slots[idx]!.durability = undefined;
    expect(slotDurability(inv, idx)).toEqual({ current: AXE.maxDurability, max: AXE.maxDurability });
    expect(slotDurability(inv, 5)).toBeNull();
    inv.add('wood', 1);
    expect(slotDurability(inv, inv.slots.findIndex((s) => s?.id === 'wood'))).toBeNull();
  });

  it('estimates remaining harvests from durability and per-hit wear', () => {
    const inv = invWithTool('stone_axe', AXE.wearPerSec * harvestSeconds('tree', 'stone_axe') * 25);
    const idx = toolSlotIndex(inv, 'stone_axe');
    expect(remainingUses(inv, idx, harvestSeconds('tree', 'stone_axe'))).toBe(25);
    expect(remainingUses(inv, 4, 1)).toBeNull();
    expect(remainingUses(inv, idx, 0)).toBeNull();
  });
});

describe('harvestSeconds with toolForNode (single source of truth)', () => {
  it('grants the tool speed-up only for the matching tool', () => {
    expect(harvestSeconds('tree', 'stone_axe')).toBeCloseTo(1.4 * 0.45);
    expect(harvestSeconds('pine', 'stone_axe')).toBeCloseTo(1.4 * 0.45);
    expect(harvestSeconds('rock', 'stone_pick')).toBeCloseTo(1.4 * 0.45);
    // Wrong tool or no tool: base speed.
    expect(harvestSeconds('tree', 'stone_pick')).toBeCloseTo(1.4);
    expect(harvestSeconds('tree', null)).toBeCloseTo(1.4);
    expect(harvestSeconds('bush', 'stone_axe')).toBeCloseTo(0.7);
    expect(toolForNode('grass')).toBeNull();
    expect(toolForNode('flower')).toBeNull();
  });
});

describe('inventory integration', () => {
  it('add() creates new tools at full durability', () => {
    const inv = new Inventory();
    inv.add('stone_axe', 1);
    expect(inv.slots[0]).toEqual({ id: 'stone_axe', count: 1, durability: AXE.maxDurability });
    const resources = new Inventory();
    resources.add('wood', 10);
    expect(resources.slots[0]!.durability).toBeUndefined();
  });

  it('crafting a tool yields a full-durability item', () => {
    const inv = new Inventory();
    inv.add('wood', 4);
    inv.add('stone', 3);
    expect(Crafting.craft(inv, 'recipe_axe')).toBe('stone_axe');
    const idx = toolSlotIndex(inv, 'stone_axe');
    expect(inv.slots[idx]!.durability).toBe(AXE.maxDurability);
  });

  it('the death penalty keeps tool durability', () => {
    const inv = invWithTool('stone_axe', 55);
    const idx = toolSlotIndex(inv, 'stone_axe');
    inv.applyDeathPenalty();
    expect(inv.slots[idx]).toEqual({ id: 'stone_axe', count: 1, durability: 55 });
  });

  it('serialize/restore round-trip preserves durability', () => {
    const inv = invWithTool('stone_pick', 37.5);
    inv.add('wood', 5);
    const data = inv.serialize();
    const restored = new Inventory();
    restored.restore(data, inv.selected);
    const idx = toolSlotIndex(restored, 'stone_pick');
    expect(restored.slots[idx]!.durability).toBe(37.5);
    expect(restored.count('wood')).toBe(5);
  });

  it('legacy saves (2-element tuples, no durability) restore tools at full condition', () => {
    const legacy: Array<[string, number, number?] | null> = [
      ['stone_axe', 1],
      ['wood', 5],
      null,
    ];
    const inv = new Inventory();
    inv.restore(legacy);
    const idx = toolSlotIndex(inv, 'stone_axe');
    expect(inv.slots[idx]!.durability).toBe(AXE.maxDurability);
  });

  it('restores clamp durability to [0, max] and drop fully worn-out tools', () => {
    const inv = new Inventory();
    inv.restore([['stone_axe', 1, AXE.maxDurability + 100]]);
    expect(inv.slots[0]!.durability).toBe(AXE.maxDurability);

    const broken = new Inventory();
    broken.restore([['stone_pick', 1, 0]]);
    expect(broken.slots[0]).toBeNull();
    expect(broken.count('stone_pick')).toBe(0);

    const negative = new Inventory();
    negative.restore([['stone_pick', 1, -5]]);
    expect(negative.slots[0]).toBeNull();
  });

  it('a broken tool stops gathering bonuses and speed on the next tick', () => {
    const inv = invWithTool('stone_axe', AXE.wearPerSec * 2);
    const idx = toolSlotIndex(inv, 'stone_axe');
    // Two seconds of chopping at the axe speed (0.63 s/harvest → ~3 harvests,
    // 2 s of wear → the axe breaks mid-session).
    let tool: string | null = 'stone_axe';
    let progress = 0;
    for (let t = 0; t < 2.0; t += 0.016) {
      progress += 0.016 / harvestSeconds('tree', tool);
      if (isEffectiveTool(tool, 'tree')) {
        const r = wearTool(inv, idx, 0.016);
        if (r.broke) tool = null; // slot emptied, selectedItemId() → null
      }
      if (progress >= 1) progress = 0;
    }
    expect(inv.slots[idx]).toBeNull();
    expect(tool).toBeNull();
    expect(harvestSeconds('tree', tool)).toBeCloseTo(1.4); // back to bare hands
  });
});
