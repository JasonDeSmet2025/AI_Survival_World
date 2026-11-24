import { describe, expect, it } from 'vitest';
import {
  CRATER_FIRE_CHANCE,
  ELEMENT_BY_NODE,
  ELEMENT_CHANCE,
  inCrater,
  rollElementDrop,
} from './elements';
import { BOWL_R, VOLCANO_HOME } from '../world/volcano';
import { ITEMS } from '../core/items';

/** Deterministic rng that replays a fixed list of draws (then always misses). */
function scripted(draws: number[]): () => number {
  let i = 0;
  return () => (i < draws.length ? draws[i++] : 0.999);
}

describe('element drop table', () => {
  it('maps every harvestable node kind to exactly one existing element item', () => {
    expect(ELEMENT_BY_NODE).toEqual({
      rock: 'element_fire',
      tree: 'element_air',
      pine: 'element_earth',
      bush: 'element_water',
    });
    for (const id of Object.values(ELEMENT_BY_NODE)) {
      expect(ITEMS[id]).toBeDefined();
      expect(ITEMS[id].edible).toBeDefined(); // raw pinches are eatable buffs
    }
  });

  it('eaten pinches have their buff timer in the shop buff table', async () => {
    const { POTION_BUFF_SECONDS } = await import('./shop');
    for (const id of Object.values(ELEMENT_BY_NODE)) {
      expect(POTION_BUFF_SECONDS[id]).toBe(20);
    }
  });

  it('crater covers the volcano bowl and nothing far away', () => {
    expect(inCrater(VOLCANO_HOME.x, VOLCANO_HOME.z)).toBe(true);
    expect(inCrater(VOLCANO_HOME.x + BOWL_R + 9, VOLCANO_HOME.z)).toBe(true);
    expect(inCrater(VOLCANO_HOME.x + BOWL_R + 11, VOLCANO_HOME.z)).toBe(false);
    expect(inCrater(0, 0)).toBe(false); // spawn is not on the volcano
  });
});

describe('rollElementDrop', () => {
  it('yields the mapped element when the roll hits (normal chance)', () => {
    const drop = rollElementDrop('bush', 10, 10, scripted([0.05, 0.9]));
    expect(drop).toEqual({ itemId: 'element_water', count: 1 });
  });

  it('lucky second draw doubles the count', () => {
    const drop = rollElementDrop('tree', 5, 5, scripted([0.01, 0.0]));
    expect(drop).toEqual({ itemId: 'element_air', count: 2 });
  });

  it('misses when the roll exceeds the chance', () => {
    expect(rollElementDrop('tree', 5, 5, scripted([ELEMENT_CHANCE + 0.01]))).toBeNull();
  });

  it('crater rocks hit far more often than the normal chance', () => {
    // A roll between the plain chance and the crater chance only succeeds
    // inside the crater — the volcano is the element jackpot.
    const roll = (ELEMENT_CHANCE + CRATER_FIRE_CHANCE) / 2;
    expect(rollElementDrop('rock', VOLCANO_HOME.x, VOLCANO_HOME.z, scripted([roll, 0.9]))).toEqual({
      itemId: 'element_fire',
      count: 1,
    });
    expect(rollElementDrop('rock', 0, 0, scripted([roll]))).toBeNull();
  });

  it('unknown node kinds never drop elements', () => {
    expect(rollElementDrop('bush', 0, 0, scripted([0.0]))).not.toBeNull();
    expect(rollElementDrop('sign', 0, 0, scripted([0.0, 0.0]))).toBeNull();
  });
});
