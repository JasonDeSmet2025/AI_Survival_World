/**
 * The second island, its bridge and its village must obey the same contracts
 * as the rest of the world — and the crossing must actually be walkable:
 *
 *  1. The delta never carves (`>= 0`) and is exactly 0 outside its footprint,
 *     which is what makes "the original island is untouched" true by
 *     construction.
 *  2. The cliff contract (adjacent 1 m samples < 2.5 u apart) holds over the
 *     island's whole footprint.
 *  3. The village pad is *exactly* flat, so every house, the church and the
 *     well stand on level ground and the mesh agrees with the analytic field.
 *  4. The beach is wadeable: no slope in the -1.6..+2.6 band exceeds the
 *     player's MAX_SLOPE, so you can always walk out of the sea.
 *  5. The bridge deck is a contiguous chain of platforms whose two ends are
 *     flush with the beaches, with arch clearance over the water — the whole
 *     line from the village square to the mainland has no step taller than
 *     MAX_STEP_UP.
 */
import { describe, expect, it } from 'vitest';
import { SEA_LEVEL, TERRAIN_SIZE, terrainHeight } from './heightfield';
import {
  BOATS,
  FLOOR_LIFT,
  BRIDGE_DECK_Y,
  BRIDGE_DECK_T,
  BRIDGE_Z,
  DOOR_W,
  CHURCH,
  HOUSES,
  ISLE_CORE,
  ISLE_CX,
  ISLE_CZ,
  ISLE_LAND,
  ISLE_OUTER,
  ISLE_SHORE,
  VILLAGE,
  VILLAGE_PAD,
  VILLAGE_Y,
  VILLAGERS,
  WELL,
  bridgePlan,
  churchDoor,
  houseDoor,
  isOnIsle,
  isleDelta,
  isleSurface,
  villageFloors,
  villageKeepOuts,
  villageWalls,
} from './villageIsle';
import { MAX_STEP_UP } from '../systems/building';
import { PlayerController } from '../player/controller';

/** Player constants (player/controller.ts) that the crossing has to respect. */
const MAX_SLOPE = 1.15;

describe('second island delta', () => {
  it('is a max() blend: never carves, never raises what is already higher', () => {
    for (let z = ISLE_CZ - ISLE_OUTER; z <= ISLE_CZ + ISLE_OUTER; z += 3) {
      for (let x = ISLE_CX - ISLE_OUTER; x <= ISLE_CX + ISLE_OUTER; x += 3) {
        const surf = isleSurface(x, z);
        const inFoot = Math.hypot(x - ISLE_CX, z - ISLE_CZ) < ISLE_OUTER;
        for (const base of [-1000, -40, -12, 0, 5, 20, 40]) {
          const d = isleDelta(x, z, base);
          expect(d).toBeGreaterThanOrEqual(0); // never a carve
          expect(base + d).toBeGreaterThanOrEqual(base); // only ever raised
          if (inFoot) expect(base + d).toBeGreaterThanOrEqual(surf - 1e-9); // reaches its surface
          else expect(d).toBe(0); // and outside the footprint it is simply not there
          if (base >= surf) expect(d).toBe(0); // high ground is left alone
        }
      }
    }
    // And it is simply not there outside the footprint.
    for (let z = -320; z <= 320; z += 8) {
      for (let x = -320; x <= 320; x += 8) {
        if (Math.hypot(x - ISLE_CX, z - ISLE_CZ) >= ISLE_OUTER) expect(isleDelta(x, z, -1000)).toBe(0);
      }
    }
  });

  it('lifts the sea floor into real land', () => {
    expect(terrainHeight(ISLE_CX, ISLE_CZ)).toBeGreaterThan(ISLE_LAND - 0.01);
    // The ring of sea around it is still sea: the delta dies before the coast.
    expect(isleSurface(ISLE_CX + ISLE_SHORE + 4, ISLE_CZ)).toBeLessThan(SEA_LEVEL);
    // ...and the dry land stays well inside the terrain tile.
    let edge = 0;
    for (let z = -320; z <= 320; z += 2) {
      for (let x = -320; x <= 320; x += 2) {
        if (terrainHeight(x, z) > 1) edge = Math.max(edge, Math.abs(x), Math.abs(z));
      }
    }
    expect(edge).toBeLessThan(TERRAIN_SIZE / 2 - 40);
  });

  it('obeys the cliff contract over the whole footprint', () => {
    let worst = 0;
    for (let z = ISLE_CZ - ISLE_OUTER; z <= ISLE_CZ + ISLE_OUTER; z += 1) {
      for (let x = ISLE_CX - ISLE_OUTER; x <= ISLE_CX + ISLE_OUTER; x += 1) {
        const h = terrainHeight(x, z);
        worst = Math.max(worst, Math.abs(terrainHeight(x + 1, z) - h), Math.abs(terrainHeight(x, z + 1) - h));
      }
    }
    expect(worst).toBeLessThan(2.5);
  });

  it('has a wadeable shore everywhere around the beach', () => {
    // The slope that matters: standing in the shallows and walking out.
    for (let a = 0; a < 360; a += 3) {
      const t = (a * Math.PI) / 180;
      let slope = 0;
      for (let r = ISLE_SHORE - 14; r <= ISLE_SHORE + 14; r += 0.5) {
        const x = ISLE_CX + Math.cos(t) * r;
        const z = ISLE_CZ + Math.sin(t) * r;
        const h = terrainHeight(x, z);
        if (h > -1.6 && h < 2.6) {
          slope = Math.max(slope, Math.abs(terrainHeight(x + 1, z) - h), Math.abs(terrainHeight(x, z + 1) - h));
        }
      }
      expect(slope, `shore slope at ${a}deg`).toBeLessThan(MAX_SLOPE);
    }
  });

  it('is a separate landmass: open water all the way around', () => {
    for (let a = 0; a < 360; a += 2) {
      const t = (a * Math.PI) / 180;
      let dryRun = 0;
      let gap = Infinity; // no other land in this direction at all
      for (let r = 0; r < 220; r += 1) {
        const h = terrainHeight(ISLE_CX + Math.cos(t) * r, ISLE_CZ + Math.sin(t) * r);
        if (r <= ISLE_SHORE + 6) {
          if (h > 1) dryRun = r;
        } else if (h > 1) {
          gap = r - dryRun;
          break;
        }
      }
      expect(gap, `strait at ${a}deg`).toBeGreaterThan(14);
    }
  });

  it('reports the island for land checks but not for the mainland', () => {
    expect(isOnIsle(ISLE_CX, ISLE_CZ)).toBe(true);
    expect(isOnIsle(0, 0)).toBe(false); // the camp, on the main island
    expect(isOnIsle(ISLE_CX + ISLE_SHORE + 20, ISLE_CZ)).toBe(false); // open sea
  });
});

describe('village pad', () => {
  /** Every solid wall in the village, computed once for the whole block. */
  const walls = villageWalls();

  it('is exactly flat at the table-land height', () => {
    for (let z = VILLAGE.z - VILLAGE_PAD; z <= VILLAGE.z + VILLAGE_PAD; z += 2) {
      for (let x = VILLAGE.x - VILLAGE_PAD; x <= VILLAGE.x + VILLAGE_PAD; x += 2) {
        if (Math.hypot(x - VILLAGE.x, z - VILLAGE.z) > VILLAGE_PAD) continue;
        expect(Math.abs(terrainHeight(x, z) - VILLAGE_Y)).toBeLessThan(1e-6);
      }
    }
  });

  it('sits on the island, inside the table land', () => {
    expect(Math.hypot(VILLAGE.x - ISLE_CX, VILLAGE.z - ISLE_CZ) + VILLAGE_PAD).toBeLessThan(ISLE_CORE);
  });

  it('has every plot, the church and the well on flat ground', () => {
    const plots = [
      ...HOUSES.map((h) => ({ x: h.x, z: h.z, r: Math.max(h.w, h.d) / 2 + 1 })),
      { x: (CHURCH.nave.x0 + CHURCH.tower.x1) / 2, z: (CHURCH.nave.z0 + CHURCH.nave.z1) / 2, r: 12 },
      { x: WELL.x, z: WELL.z, r: 2 },
      ...VILLAGERS.filter((v) => v.id !== 'sien').map((v) => ({ x: v.x, z: v.z, r: 3 })),
    ];
    for (const p of plots) {
      expect(Math.hypot(p.x - VILLAGE.x, p.z - VILLAGE.z) + p.r).toBeLessThan(VILLAGE_PAD);
      expect(Math.abs(terrainHeight(p.x, p.z) - VILLAGE_Y)).toBeLessThan(1e-6);
    }
  });

  it('has a dry beach for the harbour and its boats', () => {
    // The harbour is on the island's flank below the pad: above the water, but
    // below the point where the flank turns rocky.
    for (const b of [...BOATS, ...VILLAGERS.filter((v) => v.id === 'sien')]) {
      const h = terrainHeight(b.x, b.z);
      expect(h, `harbour spot ${b.x},${b.z}`).toBeGreaterThan(SEA_LEVEL + 1);
      expect(h).toBeLessThan(VILLAGE_Y - 1);
    }
  });

  it('keeps the church tower clear of every house', () => {
    for (const h of HOUSES) {
      const hx0 = h.x - h.w / 2;
      const hx1 = h.x + h.w / 2;
      const hz0 = h.z - h.d / 2;
      const hz1 = h.z + h.d / 2;
      const overlaps = (x0: number, z0: number, x1: number, z1: number) =>
        hx0 < x1 && hx1 > x0 && hz0 < z1 && hz1 > z0;
      expect(overlaps(CHURCH.nave.x0, CHURCH.nave.z0, CHURCH.nave.x1, CHURCH.nave.z1)).toBe(false);
      expect(overlaps(CHURCH.tower.x0, CHURCH.tower.z0, CHURCH.tower.x1, CHURCH.tower.z1)).toBe(false);
    }
  });

  it('has walls that stand on the pad and stay inside it', () => {
    expect(walls.length).toBeGreaterThan(HOUSES.length * 4);
    for (const w of walls) {
      expect(w.baseY).toBe(VILLAGE_Y);
      expect(w.topY).toBeGreaterThan(w.baseY);
      expect(w.height).toBeCloseTo(w.topY - w.baseY, 9);
      // Every corner of every slab is on the flat pad, so no wall ever sits
      // on a slope (which would leave a gap under its foundation).
      for (const [cx, cz] of [
        [w.minX, w.minZ],
        [w.maxX, w.maxZ],
        [w.minX, w.maxZ],
        [w.maxX, w.minZ],
      ]) {
        expect(Math.hypot(cx - VILLAGE.x, cz - VILLAGE.z)).toBeLessThan(VILLAGE_PAD);
      }
      // Axis-aligned and thick enough to be a wall, never a sliver.
      expect(w.maxX - w.minX).toBeGreaterThanOrEqual(0.05);
      expect(w.maxZ - w.minZ).toBeGreaterThanOrEqual(0.05);
    }
  });

  it('has one walk-in door per cottage, facing the square', () => {
    for (const h of HOUSES) {
      const doorWall = walls.filter((w) => w.building === h.id && w.doorSide);
      // Two stubs around the gap (or one, if the door sits in a corner).
      expect(doorWall.length).toBeGreaterThanOrEqual(1);
      expect(doorWall.length).toBeLessThanOrEqual(2);
      for (const w of doorWall) expect(w.face).toBe(h.door);
      // The gap itself: measure the face's total run minus the stubs.
      const face = walls.filter((w) => w.building === h.id && w.face === h.door);
      const along =
        h.door === 'px' || h.door === 'nx' ? (["minZ", "maxZ"] as const) : (["minX", "maxX"] as const);
      const lo = Math.min(...face.map((w) => w[along[0]] as number));
      const hi = Math.max(...face.map((w) => w[along[1]] as number));
      const solid = face.reduce((s, w) => s + ((w[along[1]] as number) - (w[along[0]] as number)), 0);
      expect(hi - lo - solid).toBeGreaterThanOrEqual(DOOR_W - 1e-6);
      // And it is centred on the plot, i.e. it looks at the square.
      const centre = (lo + hi) / 2;
      expect(Math.abs(centre - (h.door === 'px' || h.door === 'nx' ? h.z : h.x))).toBeLessThan(0.01);
    }
  });

  it('has a church whose door is on the street and whose nave is open to the tower', () => {
    const westDoor = walls.filter(
      (w) => w.building === 'church' && w.face === 'nx' && w.doorSide,
    );
    expect(westDoor.length).toBe(2);
    // The doorway is centred on the street line (the bridge lands on it).
    const lo = Math.min(...westDoor.map((w) => w.minZ));
    const hi = Math.max(...westDoor.map((w) => w.maxZ));
    expect((lo + hi) / 2).toBeCloseTo(BRIDGE_Z, 6);
    expect(hi - lo).toBeGreaterThanOrEqual(CHURCH.door.width - 1e-6);
    // No wall runs across the tower/nave joint: the tower is the porch.
    for (const w of walls.filter((w) => w.building === 'church')) {
      const spansJoint = w.minX < CHURCH.tower.x1 && w.maxX > CHURCH.tower.x1;
      const insideJoint = w.minZ < CHURCH.tower.z1 && w.maxZ > CHURCH.tower.z0;
      expect(spansJoint && insideJoint).toBe(false);
    }
  });

  it('has no wall that blocks the street or the square', () => {
    // The street centre line from the bridge head to the church door must be
    // free standing ground at pad height, or the village is a dead end.
    for (let x = VILLAGE.x - VILLAGE_PAD; x <= CHURCH.door.x; x += 0.5) {
      for (const w of walls) {
        const inside = x > w.minX - 0.3 && x < w.maxX + 0.3 && BRIDGE_Z > w.minZ - 0.3 && BRIDGE_Z < w.maxZ + 0.3;
        expect(inside, `wall of ${w.building} blocks the street at x=${x}`).toBe(false);
      }
    }
    // Nothing stands on the well or on a villager's home spot.
    const spots = [{ x: WELL.x, z: WELL.z, r: WELL.radius }, ...VILLAGERS.map((v) => ({ x: v.x, z: v.z, r: 1 }))];
    for (const s of spots) {
      for (const w of walls) {
        const inside =
          s.x > w.minX - s.r && s.x < w.maxX + s.r && s.z > w.minZ - s.r && s.z < w.maxZ + s.r;
        expect(inside, `${w.building} wall overlaps ${s.x},${s.z}`).toBe(false);
      }
    }
  });

  it('clears flora from every structure, the street and the crossing', () => {
    const bridge = bridgePlan(terrainHeight);
    const keeps = villageKeepOuts(bridge);
    const covered = (x: number, z: number) => keeps.some((k) => Math.hypot(x - k.x, z - k.z) < k.r);
    for (const h of HOUSES) expect(covered(h.x, h.z)).toBe(true);
    expect(covered(CHURCH.tower.x1 - 1, CHURCH.door.z)).toBe(true);
    expect(covered(WELL.x, WELL.z)).toBe(true);
    expect(covered(bridge.xEast - 4, BRIDGE_Z)).toBe(true);
    expect(covered((bridge.xEast + VILLAGE.x) / 2, VILLAGE.z)).toBe(true);
    for (const b of BOATS) expect(covered(b.x, b.z)).toBe(true);
  });
});

describe('the bridge', () => {
  const bridge = bridgePlan(terrainHeight);

  it('crosses water: the span is over the sea floor', () => {
    expect(bridge.length).toBeGreaterThan(30);
    // The deck only ever spans ground that is at or below its own surface.
    for (const p of bridge.piers) {
      expect(terrainHeight(p.x, BRIDGE_Z)).toBeLessThanOrEqual(bridge.deckY + 1e-6);
      expect(p.bottom).toBeLessThan(p.top);
    }
    // There is open water under the deck, and the deck stands clear of it.
    const mid = (bridge.westShore + bridge.eastShore) / 2;
    expect(terrainHeight(mid, BRIDGE_Z)).toBeLessThan(SEA_LEVEL);
    expect(bridge.deckY - terrainHeight(mid, BRIDGE_Z)).toBeGreaterThan(2);
    expect(bridge.eastShore - bridge.westShore).toBeGreaterThan(20);
  });

  it('is a contiguous walkable chain with flush ends', () => {
    const ds = bridge.decks;
    expect(ds.length).toBeGreaterThan(3);
    expect(ds[0].minX).toBeCloseTo(bridge.xWest, 6);
    expect(ds[ds.length - 1].maxX).toBeCloseTo(bridge.xEast, 6);
    for (let i = 0; i + 1 < ds.length; i++) {
      expect(ds[i + 1].minX).toBeLessThanOrEqual(ds[i].maxX + 1e-6); // no seam gap
      expect(ds[i + 1].top).toBeCloseTo(ds[i].top, 9); // no lip at the seam
    }
    // Ends meet the beaches at deck height: a step, not a climb.
    expect(Math.abs(terrainHeight(bridge.xWest, BRIDGE_Z) - bridge.deckY)).toBeLessThan(MAX_STEP_UP);
    expect(Math.abs(terrainHeight(bridge.xEast, BRIDGE_Z) - bridge.deckY)).toBeLessThan(MAX_STEP_UP);
    // The rails cover the whole deck and stand on it.
    for (const r of bridge.rails) {
      expect(r.minX).toBeLessThanOrEqual(bridge.xWest + 1e-6);
      expect(r.maxX).toBeGreaterThanOrEqual(bridge.xEast - 1e-6);
      expect(r.baseY).toBeCloseTo(bridge.deckY, 6);
      expect(r.height).toBeGreaterThan(0.8);
    }
  });

  it('connects the village square to the mainland without a single tall step', () => {
    // Walk the axis; the surface underfoot is terrain or deck, whichever is higher.
    const surfaceAt = (x: number) => {
      let best = terrainHeight(x, BRIDGE_Z);
      for (const d of bridge.decks) {
        if (x >= d.minX && x <= d.maxX) best = Math.max(best, d.top);
      }
      return best;
    };
    let x = VILLAGE.x;
    let prev = surfaceAt(x);
    for (x = VILLAGE.x - 0.5; x >= 24; x -= 0.5) {
      const h = surfaceAt(x);
      expect(Math.abs(h - prev), `step at x=${x.toFixed(1)}`).toBeLessThan(MAX_STEP_UP);
      prev = h;
    }
    expect(prev).toBeGreaterThan(SEA_LEVEL); // arrives on dry mainland
  });

  it('leaves headroom under the deck and arches over the deep part', () => {
    for (const a of bridge.arches) {
      expect(a.r).toBeGreaterThan(2);
      const soffit = bridge.deckY - BRIDGE_DECK_T;
      const ground = terrainHeight(a.x, BRIDGE_Z);
      // The arch stands over water: its crown is under the deck and there is
      // real air between the sea and the soffit for the water to pass under.
      expect(ground).toBeLessThan(SEA_LEVEL);
      expect(soffit - Math.max(ground, SEA_LEVEL)).toBeGreaterThan(1.5);
      // Its springing is at or below the sea: a half-buried arch, which is how
      // an arch built on a shallow bed looks.
      expect(soffit - a.r).toBeLessThan(SEA_LEVEL);
    }
    expect(bridge.arches.length).toBeGreaterThan(0);
    // Nothing stands on the deck.
    for (const d of bridge.decks) expect(d.top).toBeCloseTo(BRIDGE_DECK_Y, 6);
  });
});

describe('what you see is what you collide with', () => {
  const walls = villageWalls();

  it('leaves every doorway a real hole in the wall it stands in', () => {
    const inWall = (x: number, z: number, y: number): boolean =>
      walls.some(
        (w) => x > w.minX + 0.02 && x < w.maxX - 0.02 && z > w.minZ + 0.02 && z < w.maxZ - 0.02 && y > w.baseY && y < w.topY,
      );
    const doors = [...HOUSES.map(houseDoor), churchDoor()];
    for (const d of doors) {
      // The panel stands in the wall's plane, so the centre of the doorway is
      // the point that must be free — at knee, chest and head height.
      for (const y of [VILLAGE_Y + 0.3, VILLAGE_Y + 1.4, VILLAGE_Y + 2.4]) expect(inWall(d.x, d.z, y)).toBe(false);
    }
    // And the gap is a doorway, not a crack: it is DOOR_W wide, which is what
    // the controller's own clearance needs.
    expect(DOOR_W).toBeGreaterThan(1.2);
  });

  it('points each door outwards, away from its own walls', () => {
    // yaw is the outward normal (x = sin, z = cos), so one step along it must
    // leave the building and land on dry ground.
    for (const h of HOUSES) {
      const d = houseDoor(h);
      const out = { x: d.x + Math.sin(d.yaw) * 0.8, z: d.z + Math.cos(d.yaw) * 0.8 };
      expect(walls.some((w) => w.building === h.id && out.x > w.minX && out.x < w.maxX && out.z > w.minZ && out.z < w.maxZ)).toBe(false);
      expect(terrainHeight(out.x, out.z)).toBeGreaterThan(SEA_LEVEL + 1);
    }
    const cd = churchDoor();
    expect(walls.filter((w) => w.building === 'church').some((w) => cd.x - 0.8 > w.minX && cd.x - 0.8 < w.maxX && cd.z > w.minZ && cd.z < w.maxZ)).toBe(false);
  });

  it('lines the church door up with the bridge, so the street is one straight run', () => {
    const cd = churchDoor();
    const crossing = bridgePlan(terrainHeight);
    expect(Math.abs(cd.z - BRIDGE_Z)).toBeLessThan(0.5); // same axis as the crossing
    expect(cd.x).toBeGreaterThan(crossing.xEast); // and the bridge heads straight for it
  });

  it('never lets one building collide into another', () => {
    for (let i = 0; i < walls.length; i++) {
      for (let j = i + 1; j < walls.length; j++) {
        const a = walls[i];
        const b = walls[j];
        if (a.building === b.building) continue;
        const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
        const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
        const oy = Math.min(a.topY, b.topY) - Math.max(a.baseY, b.baseY);
        expect(ox > 0.02 && oz > 0.02 && oy > 0.02).toBe(false);
      }
    }
  });

  it('keeps every islander and their whole walking ring on dry land', () => {
    for (const v of VILLAGERS) {
      expect(terrainHeight(v.x, v.z)).toBeGreaterThan(SEA_LEVEL + 2);
      // The wander route lands anywhere in [min, max] at any angle, so the
      // worst case is the outer ring — and nobody should ever reach the sea.
      const rMax = v.ring[0] + v.ring[1];
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        expect(terrainHeight(v.x + Math.cos(a) * rMax, v.z + Math.sin(a) * rMax)).toBeGreaterThan(SEA_LEVEL + 0.2);
      }
    }
    expect(VILLAGERS.length).toBe(3);
  });

  it('grounds every wall and boat where the ground actually is', () => {
    for (const w of walls) expect(w.baseY).toBeCloseTo(VILLAGE_Y, 6); // the pad is flat by construction
    for (const b of BOATS) expect(terrainHeight(b.x, b.z)).toBeGreaterThan(SEA_LEVEL + 1); // hauled up the beach
  });
});

/**
 * Geometry proofs are all well and good, but the doorway question is only
 * answered by walking a body through it: the player is a cylinder of radius
 * 0.42, so a gap that measures 1.5 m on paper can still be a wall. These run
 * the REAL controller against the REAL wall list, headless, at a fixed dt —
 * which is exactly what the browser QA harness cannot do (it draws one frame
 * per second on the CI renderer, so a keyboard walk there is a coin toss).
 */
describe('walking into the village with the real controller', () => {
  const DT = 1 / 60;
  const bridge = bridgePlan(terrainHeight);
  const walls = [...villageWalls(), ...bridge.rails];
  const inp = { forward: 1, strafe: 0, jumpHeld: false, sprint: false, crouch: false };

  /** Walk `meters` along the doorway's inward axis; report where you ended. */
  function walkIn(door: { x: number; z: number; yaw: number }, meters: number) {
    // yaw 0 faces +z and the doorway's yaw is the OUTWARD normal, so the walk
    // into the building is yaw + PI.
    const yaw = door.yaw + Math.PI;
    const nx = Math.sin(yaw);
    const nz = Math.cos(yaw);
    const c = new PlayerController({
      x: door.x - nx * 2.5,
      y: VILLAGE_Y + 0.5,
      z: door.z - nz * 2.5,
    });
    const start = { x: c.pos.x, z: c.pos.z };
    const steps = Math.ceil((meters + 5) / (5.2 * DT));
    for (let i = 0; i < steps; i++) {
      c.update(DT, inp as never, yaw, [], true, walls, bridge.decks);
      if (Math.hypot(c.pos.x - start.x, c.pos.z - start.z) >= meters) break;
    }
    // Progress and drift, measured in the doorway's own frame.
    const dx = c.pos.x - start.x;
    const dz = c.pos.z - start.z;
    return {
      along: dx * nx + dz * nz,
      across: dx * -nz + dz * nx,
      x: c.pos.x,
      z: c.pos.z,
      y: c.pos.y,
    };
  }

  it('walks through the church door into the tower', () => {
    const door = churchDoor();
    const r = walkIn(door, 4);
    expect(r.along).toBeGreaterThan(3.5);
    expect(Math.abs(r.across)).toBeLessThan(0.3);
    expect(r.y).toBeGreaterThan(VILLAGE_Y - 0.5); // did not fall through
  });

  it('walks through every house door', () => {
    for (const h of HOUSES) {
      const door = houseDoor(h);
      const r = walkIn(door, 3);
      expect(r.along, `${h.id}: ${r.along.toFixed(2)} m door de deur`).toBeGreaterThan(2.5);
      expect(Math.abs(r.across)).toBeLessThan(0.3);
    }
  });

  it('walks off the bridge onto the island beach without falling in the strait', () => {
    const yaw = Math.PI / 2; // looking along +x, the bridge's axis
    const c = new PlayerController({ x: bridge.xEast - 6, y: bridge.deckY + 0.4, z: BRIDGE_Z });
    let minY = 99;
    for (let i = 0; i < 400 && c.pos.x < bridge.xEast + 4; i++) {
      c.update(DT, inp as never, yaw, [], true, walls, bridge.decks);
      minY = Math.min(minY, c.pos.y);
    }
    expect(c.pos.x).toBeGreaterThan(bridge.xEast + 3);
    expect(minY).toBeGreaterThan(bridge.deckY - 0.5); // never dropped towards the sea
    expect(c.pos.y).toBeGreaterThan(bridge.deckY); // and ended up on the beach, climbing
  });

  it('cannot walk through a wall (the door is the only way in)', () => {
    const nave = CHURCH.nave;
    const yaw = Math.PI / 2;
    // Start inside the nave and walk at its east wall. Without a collision the
    // body would be 34 m away by now; it has to stop at the wall's inner face
    // (x = 171.68) minus the player's radius.
    const c = new PlayerController({ x: nave.x1 - 4, y: VILLAGE_Y + 0.5, z: 170 });
    for (let i = 0; i < 400; i++) c.update(DT, inp as never, yaw, [], true, walls, bridge.decks);
    expect(c.pos.x).toBeGreaterThan(nave.x1 - 2); // it did walk
    expect(c.pos.x).toBeLessThan(nave.x1 - 0.1); // and the wall stopped it
  });
});

describe('village floors', () => {
  const floors = villageFloors();
  const wallList = villageWalls();

  it('gives every building a floor and lifts it by a step-onto height', () => {
    expect(floors.length).toBe(HOUSES.length + 2); // five houses, nave + tower
    for (const f of floors) {
      expect(f.top).toBeCloseTo(VILLAGE_Y + FLOOR_LIFT, 6);
      expect(FLOOR_LIFT).toBeLessThan(MAX_STEP_UP); // you step onto it, not climb
      expect(f.maxX - f.minX).toBeGreaterThan(1);
      expect(f.maxZ - f.minZ).toBeGreaterThan(1);
    }
  });

  it('never puts a standing surface inside a wall', () => {
    // The controller resolves walls by pushing you out and floors by standing
    // you up; a floor that runs under a wall gives it both jobs at once.
    for (const f of floors) {
      for (const w of wallList) {
        const ox = Math.min(f.maxX, w.maxX) - Math.max(f.minX, w.minX);
        const oz = Math.min(f.maxZ, w.maxZ) - Math.max(f.minZ, w.minZ);
        expect(ox > 0.02 && oz > 0.02, `floor ${f.minX.toFixed(1)} vs ${w.building} ${w.face}`).toBe(false);
      }
    }
  });

  it('reaches every doorway, so the threshold is a step and not a climb', () => {
    const doors = [...HOUSES.map(houseDoor), churchDoor()];
    for (const d of doors) {
      const near = floors.some((f) => {
        // The slab's edge must be within a wall thickness of the door's plane,
        // on the inside: walking straight in, you meet the floor right after
        // the wall instead of 30 cm of bare pad.
        const gapX = Math.max(f.minX - d.x, d.x - f.maxX);
        const gapZ = Math.max(f.minZ - d.z, d.z - f.maxZ);
        return Math.max(gapX, gapZ) <= 0.5;
      });
      expect(near, `deur op ${d.x.toFixed(1)},${d.z.toFixed(1)} heeft geen vloer`).toBe(true);
    }
  });
});
