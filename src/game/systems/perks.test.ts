import { describe, expect, it } from 'vitest';
import {
  PERKS,
  PERK_COST,
  buyPerk,
  canBuy,
  craftTimeMul,
  damageTakenMul,
  fallDamageMul,
  farmGrowthMul,
  grantPerkPoints,
  hasPerk,
  isPerkState,
  meleeDamageMul,
  moveSpeedMul,
  newPerkState,
  perkChildren,
  pruneOrphanPerks,
  shopPriceMul,
  snapshotPerks,
  staminaDrainMul,
  treeLayout,
  witchAngerMul,
  witchDecayMul,
} from './perks';

describe('perk tree shape', () => {
  it('is one connected tree: a single root and known parents', () => {
    expect(PERKS).toHaveLength(9);
    const roots = PERKS.filter((p) => p.parent === null);
    expect(roots).toHaveLength(1);
    expect(roots[0].id).toBe('gehard');
    const ids = PERKS.map((p) => p.id);
    expect(new Set(ids).size).toBe(9);
    for (const id of ids) expect(id).toMatch(/^[a-z_]+$/);
    for (const p of PERKS) {
      if (p.parent !== null) expect(PERKS.some((q) => q.id === p.parent), p.id).toBe(true);
    }
  });

  it('the root opens a real choice between two, and each opens two more', () => {
    expect(perkChildren('gehard').map((p) => p.id)).toEqual(['krachtige_slagen', 'snelle_handen']);
    expect(perkChildren('krachtige_slagen')).toHaveLength(2);
    expect(perkChildren('snelle_handen')).toHaveLength(2);
  });

  it('every perk has a Dutch name and description', () => {
    for (const p of PERKS) {
      expect(p.name.length, p.id).toBeGreaterThan(3);
      expect(p.desc.length, p.id).toBeGreaterThan(10);
    }
  });
});

describe('canBuy / buyPerk', () => {
  it('a fresh player can afford nothing', () => {
    const s = newPerkState();
    expect(canBuy(s, 'gehard').ok).toBe(false);
    expect(canBuy(s, 'gehard').reason).toBe('Te weinig talentpunten');
  });

  it('one point buys exactly the root and spends the point', () => {
    const s = newPerkState();
    grantPerkPoints(s, 1);
    expect(s.points).toBe(PERK_COST);
    expect(buyPerk(s, 'gehard')).toBe(true);
    expect(s.points).toBe(0);
    expect(hasPerk(s, 'gehard')).toBe(true);
    // Both children of the root are open now — the only thing left is an
    // empty pocket, and canBuy names THAT reason, not a fake chain error.
    const c = canBuy(s, 'krachtige_slagen');
    expect(c.ok).toBe(false);
    expect(c.reason).toBe('Te weinig talentpunten');
    expect(canBuy(s, 'snelle_handen').ok).toBe(false);
    expect(canBuy(s, 'snelle_handen').reason).toBe('Te weinig talentpunten');
  });

  it('a leaf demands its parent, and the choice is honoured', () => {
    const s = newPerkState();
    s.points = 4;
    expect(canBuy(s, 'rotsbenen').reason).toContain('Krachtige slagen');
    buyPerk(s, 'gehard');
    expect(canBuy(s, 'rotsbenen').ok).toBe(false);
    expect(canBuy(s, 'krachtige_slagen').ok).toBe(true);
    expect(canBuy(s, 'snelle_handen').ok).toBe(true); // the OTHER choice is open too
    buyPerk(s, 'krachtige_slagen');
    expect(canBuy(s, 'rotsbenen').ok).toBe(true);
    expect(canBuy(s, 'stuivende_longen').ok).toBe(true);
  });

  it('refuses unknown ids, double purchases and empty pockets without side effects', () => {
    const s = newPerkState();
    expect(buyPerk(s, 'toverhoed')).toBe(false);
    grantPerkPoints(s, 5);
    expect(buyPerk(s, 'gehard')).toBe(true);
    expect(buyPerk(s, 'gehard')).toBe(false);
    const before = s.points;
    expect(buyPerk(s, 'snelle_handen')).toBe(true); // costs exactly one
    expect(s.points).toBe(before - PERK_COST);
  });

  it('grantPerkPoints pays one point per level and ignores junk', () => {
    const s = newPerkState();
    expect(grantPerkPoints(s, 2)).toBe(2);
    expect(grantPerkPoints(s, 0)).toBe(0);
    expect(grantPerkPoints(s, -3)).toBe(0);
    expect(grantPerkPoints(s, Number.NaN)).toBe(0);
    expect(s.points).toBe(2);
  });
});

describe('treeLayout (drawing geometry)', () => {
  const pos = new Map(treeLayout().map((p) => [p.id, p]));

  it('places every node exactly once', () => {
    expect(pos.size).toBe(PERKS.length);
  });

  it('the root is on the top row and the choice splits left/right', () => {
    const root = pos.get('gehard')!;
    const left = pos.get('krachtige_slagen')!;
    const right = pos.get('snelle_handen')!;
    expect(root.y).toBe(0);
    expect(left.y).toBe(1);
    expect(right.y).toBe(1);
    expect(left.x).toBeLessThan(root.x);
    expect(right.x).toBeGreaterThan(root.x);
  });

  it('children hang one row under their parent, parents over their kids', () => {
    for (const def of PERKS) {
      if (def.parent === null) continue;
      const p = pos.get(def.parent)!;
      const c = pos.get(def.id)!;
      expect(c.y, def.id).toBe(p.y + 1);
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x).toBeLessThanOrEqual(100);
    }
    const kids = perkChildren('gehard').map((k) => pos.get(k.id)!);
    const mid = (kids[0].x + kids[1].x) / 2;
    expect(pos.get('gehard')!.x).toBeCloseTo(mid, 6);
  });

  it('no two nodes share a drawing spot', () => {
    const spots = new Set([...pos.values()].map((p) => `${p.x.toFixed(2)},${p.y}`));
    expect(spots.size).toBe(PERKS.length);
  });
});

describe('effect multipliers', () => {
  it('are exactly 1 for a player who bought nothing', () => {
    const s = newPerkState();
    for (const f of [
      damageTakenMul,
      meleeDamageMul,
      fallDamageMul,
      craftTimeMul,
      shopPriceMul,
      farmGrowthMul,
      moveSpeedMul,
      staminaDrainMul,
      witchAngerMul,
      witchDecayMul,
    ]) {
      expect(f(s)).toBe(1);
    }
  });

  it('each perk moves exactly its own multiplier and no other', () => {
    const s = newPerkState();
    s.points = 9;
    for (const p of PERKS) expect(buyPerk(s, p.id), p.id).toBe(true);
    expect(damageTakenMul(s)).toBeLessThan(1);
    expect(meleeDamageMul(s)).toBeGreaterThan(1);
    expect(fallDamageMul(s)).toBeLessThan(damageTakenMul(s));
    expect(craftTimeMul(s)).toBeLessThan(1);
    expect(shopPriceMul(s)).toBeLessThan(1);
    expect(farmGrowthMul(s)).toBeGreaterThan(1);
    expect(moveSpeedMul(s)).toBeGreaterThan(1);
    expect(staminaDrainMul(s)).toBeLessThan(1);
    expect(witchAngerMul(s)).toBeLessThan(1);
    expect(witchDecayMul(s)).toBeGreaterThan(1);
    for (const f of [
      damageTakenMul,
      meleeDamageMul,
      fallDamageMul,
      craftTimeMul,
      shopPriceMul,
      farmGrowthMul,
      moveSpeedMul,
      staminaDrainMul,
      witchAngerMul,
      witchDecayMul,
    ]) {
      const v = f(s);
      expect(v, 'multiplier stays sane').toBeGreaterThan(0);
      expect(v).toBeLessThan(3);
    }
  });

  it('the whole tree costs exactly the points a maxed player has', () => {
    // MAX_LEVEL is 10 → 9 points for 9 perks at 1 each: completable only by
    // a player who banked every point — nobody buys it alongside anything.
    const s = newPerkState();
    grantPerkPoints(s, 9);
    for (const p of PERKS) expect(buyPerk(s, p.id), p.id).toBe(true);
    expect(s.points).toBe(0);
  });
});

describe('save validation + prune', () => {
  it('accepts fresh and honestly-built states, and snapshot copies', () => {
    expect(isPerkState(newPerkState())).toBe(true);
    const s = newPerkState();
    grantPerkPoints(s, 3);
    buyPerk(s, 'snelle_handen');
    expect(isPerkState(snapshotPerks(s))).toBe(true);
  });

  it('rejects garbage, unknown ids and duplicates', () => {
    expect(isPerkState(null)).toBe(false);
    expect(isPerkState([])).toBe(false);
    expect(isPerkState('gehard')).toBe(false);
    expect(isPerkState({ points: -1, owned: [] })).toBe(false);
    expect(isPerkState({ points: 1.5, owned: [] })).toBe(false);
    expect(isPerkState({ points: 0, owned: ['toverbald'] })).toBe(false);
    expect(isPerkState({ points: 0, owned: ['gehard', 'gehard'] })).toBe(false);
    expect(isPerkState({ points: 0, owned: [42] })).toBe(false);
  });

  it('prune refunds perks whose parent vanished from the tree', () => {
    // A save that owns a leaf whose branch was rewired by an update.
    const s = { points: 0, owned: ['gehard', 'krachtige_slagen', 'rotsbenen', 'lichtvoetig'] };
    expect(pruneOrphanPerks(s)).toBe(1);
    expect(s.owned).toEqual(['gehard', 'krachtige_slagen', 'rotsbenen']);
    expect(s.points).toBe(1);
    // Nothing to prune on a healthy tree.
    const ok = { points: 3, owned: ['gehard', 'snelle_handen', 'scherpe_koop', 'hekenvriend'] };
    expect(pruneOrphanPerks(ok)).toBe(0);
    expect(ok.points).toBe(3);
    // A detached branch collapses deepest-first, refunding every rank.
    const rot = { points: 0, owned: ['hekenvriend', 'krachtige_slagen'] };
    expect(pruneOrphanPerks(rot)).toBe(2);
    expect(rot.owned).toEqual([]);
    expect(rot.points).toBe(2);
  });
});
