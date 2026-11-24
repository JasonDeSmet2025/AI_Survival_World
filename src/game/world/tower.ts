/**
 * The witch's TOWER — a hostile landmark, pure data (no Babylon imports).
 *
 * The witch keeps a crooked stone tower far from the NPC camp. Its top floor
 * holds a chest of gold coins, and spiders live in the tower and in the court
 * around it. This module answers the three questions the game shell needs,
 * without Babylon in sight (same rule as world/caves.ts):
 *
 *  1. WHERE is the tower and how flat is the ground under it?
 *     `towerSite()` scans the height field once (a flat, dry, out-of-the-way
 *     pad away from camp, witch hut and cave mouths).
 *  2. WHAT does it collide like? `towerWalls()` describes the stone shell
 *     (with a doorway on the camp-facing side), `towerSlabs()` the floor
 *     discs (each with a hole where the staircase emerges) and
 *     `towerStairs()` the three flights between the floors — all in the same
 *     wall/platform structs the player-built houses already use, so the
 *     player controller walks up the tower with zero new physics.
 *  3. WHAT LIVES WHERE? `towerSpiders()` gives the spawn roster (court,
 *     inside and one on the top floor by the chest) and `towerChests()` the
 *     loot chests, each with its floor height.
 *
 * The visuals (visual/towerVisual.ts) are built from exactly these numbers,
 * so what you see is what you bump into.
 */
import { terrainHeight, terrainSlope } from './heightfield';

/** Candidate anchor for the tower site (scanned by towerSite()). */
export const TOWER_ANCHOR = { x: 128, z: 44 };

/** Half-width of the stone shell (outer square is 2× this wide). */
export const TOWER_OUTER = 4.0;
/** Wall thickness (outer face to inner face). */
export const TOWER_WALL = 0.9;
/** Half-width of the interior floor (OUTER - WALL). */
export const TOWER_INNER = TOWER_OUTER - TOWER_WALL;
/** Floor-to-floor height. */
export const TOWER_LEVEL_H = 3.3;
/** Walkable floors 0..3 (0 = ground level, 3 = the top with the big chest). */
export const TOWER_FLOORS = 4;
/** Parapet height above the top floor. */
export const TOWER_PARAPET = 1.4;
/** Doorway in the west wall (camp side): half-width and head height. */
export const TOWER_DOOR = { halfWidth: 0.95, height: 2.5 };

/** AABB the player controller pushes against (shape of systems/building.ts). */
export interface TowerWall {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
  baseY: number;
  topY: number;
}

/**
 * Standing surface (shape of Platform in systems/building.ts). `top` is the
 * surface height at (refX, refZ); slopeX/slopeZ are metres of height per
 * metre travelled along that axis — the staircase flights use them.
 */
export interface TowerPlatform {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  top: number;
  slopeX: number;
  slopeZ: number;
  refX: number;
  refZ: number;
}

export interface TowerSite {
  x: number;
  z: number;
  /** Terrain height at the centre — the ground floor's surface. */
  baseY: number;
}

/** World y of the walkable surface of floor k (0 = the terrain itself). */
export function towerFloorY(site: TowerSite, k: number): number {
  return site.baseY + k * TOWER_LEVEL_H;
}

/** Y the outer walls end at (top floor + parapet). */
export function towerWallTopY(site: TowerSite): number {
  return towerFloorY(site, TOWER_FLOORS - 1) + TOWER_PARAPET;
}

/**
 * Scan for a flat dry pad for the tower. The anchor point was found by a
 * grid scan of the height field; this re-anchors slightly if needed and
 * guarantees: above sea, flat within the footprint, and far enough from the
 * camp spawn, the witch hut and every cave mouth (same courtesy the witch
 * herself gets from witchKeepOut).
 */
export function towerSite(): TowerSite {
  let best = TOWER_ANCHOR;
  let bestScore = Infinity;
  for (let dx = -6; dx <= 6; dx += 2) {
    for (let dz = -6; dz <= 6; dz += 2) {
      const x = TOWER_ANCHOR.x + dx;
      const z = TOWER_ANCHOR.z + dz;
      const h = terrainHeight(x, z);
      if (h < 2.5) continue;
      let spread = 0;
      for (let ax = -TOWER_OUTER - 2; ax <= TOWER_OUTER + 2; ax += 2) {
        for (let az = -TOWER_OUTER - 2; az <= TOWER_OUTER + 2; az += 2) {
          const hh = terrainHeight(x + ax, z + az);
          spread = Math.max(spread, Math.abs(hh - h));
        }
      }
      const score = spread * 4 + terrainSlope(x, z) + Math.hypot(dx, dz) * 0.05;
      if (spread < 0.8 && score < bestScore) {
        bestScore = score;
        best = { x, z };
      }
    }
  }
  return { x: best.x, z: best.z, baseY: terrainHeight(best.x, best.z) };
}

/** Flora/collider keep-out disc for the tower site (flora.ts keepOut shape). */
export function towerKeepOut(site: TowerSite): { x: number; z: number; r: number } {
  return { x: site.x, z: site.z, r: TOWER_OUTER + 6 };
}

/**
 * Distance further than this the tower's spiders do NOT pull the player
 * into (their leash stays around the tower; see ai/spiders.ts).
 */
export function towerIsNear(site: TowerSite, x: number, z: number, r = 40): boolean {
  return Math.hypot(x - site.x, z - site.z) <= r;
}

// ---------------------------------------------------------------------------
// Collision geometry
// ---------------------------------------------------------------------------

/** One wall box from the shell. */
function wall(site: TowerSite, minX: number, maxX: number, minZ: number, maxZ: number, baseY: number, topY: number): TowerWall {
  return {
    minX: site.x + minX,
    maxX: site.x + maxX,
    minZ: site.z + minZ,
    maxZ: site.z + maxZ,
    height: topY - baseY,
    baseY,
    topY,
  };
}

/**
 * The stone shell: one tall box per side, with the west side split around
 * the doorway (two side pieces full height + a lintel over the door). The
 * doorway faces roughly the spawn/camp direction, so the tower presents its
 * entrance to the players coming to rob it.
 */
export function towerWalls(site: TowerSite): TowerWall[] {
  const o = TOWER_OUTER;
  const i = TOWER_INNER;
  const top = towerWallTopY(site);
  const b = site.baseY;
  const d = TOWER_DOOR;
  return [
    // North / south / east: unbroken, ground to parapet.
    wall(site, -o, o, -o, -i, b, top),
    wall(site, -o, o, i, o, b, top),
    wall(site, i, o, -o, o, b, top),
    // West: doorway in the middle (gap |z| <= halfWidth, y < door height).
    wall(site, -o, -i, -o, -d.halfWidth, b, top),
    wall(site, -o, -i, d.halfWidth, o, b, top),
    wall(site, -o, -i, -d.halfWidth, d.halfWidth, b + d.height, top),
  ];
}

/** Staircase flight f (0..TOWER_FLOORS-2): which side band it occupies. */
export interface TowerStair {
  flight: number;
  /** x band (east or west side of the interior). */
  x0: number;
  x1: number;
  /** z range of the flight (always z0 < z1 — the climb direction is in the slope). */
  z0: number;
  z1: number;
  /** y at the LOW end of the climb / at the high end (= the next floor). */
  yLow: number;
  yHigh: number;
  /** +1 when the flight climbs towards +z, -1 when towards -z. */
  dir: 1 | -1;
}

const STAIR_BAND = 2.0;
/**
 * How far forward (in the climbing direction) every flight sits. A flight's
 * TOP end is flush with the inner wall it climbs towards, so its BOTTOM
 * edge leaves STAIR_SHIFT metres of open floor in front of the walk-on step
 * (run = 2·TOWER_INNER − STAIR_SHIFT = 5.0 m at grade 0.66).
 *
 * Centring the flights (the first version) crammed the walk-on edge
 * 0.8 m from the wall: after the 0.42 m wall push-out allowance there was
 * barely room to stand, so any approach that was a few degrees off pinned
 * the player in the corner — the reported "haperingen". Running the flight
 * into the wall costs nothing either: the top steps sit under the wall
 * itself and the controller stops the player 0.42 m short anyway, almost
 * exactly where the flight reaches the floor's own level.
 */
const STAIR_SHIFT = 1.2;

/** The flight between floor f and f+1 — east band on even f, west on odd. */
export function towerStairFlight(site: TowerSite, f: number): TowerStair {
  void site;
  const east = f % 2 === 0;
  const x0 = east ? TOWER_INNER - STAIR_BAND - 0.05 : -TOWER_INNER + 0.05;
  const x1 = east ? TOWER_INNER - 0.05 : -TOWER_INNER + STAIR_BAND + 0.05;
  // Even flights climb towards +z, odd flights towards -z: a switchback, so
  // the three flights alternate sides exactly like a real tower staircase.
  const dir: 1 | -1 = east ? 1 : -1;
  return {
    flight: f,
    x0,
    x1,
    z0: dir === 1 ? -TOWER_INNER + STAIR_SHIFT : -TOWER_INNER,
    z1: dir === 1 ? TOWER_INNER : TOWER_INNER - STAIR_SHIFT,
    yLow: f * TOWER_LEVEL_H,
    yHigh: (f + 1) * TOWER_LEVEL_H,
    dir,
  };
}

/**
 * Sloped standing platforms for the three flights (height field along z —
 * the player controller already supports sloped platforms for stairs/roofs).
 */
export function towerStairs(site: TowerSite): TowerPlatform[] {
  const out: TowerPlatform[] = [];
  for (let f = 0; f < TOWER_FLOORS - 1; f++) {
    const s = towerStairFlight(site, f);
    out.push({
      minX: site.x + s.x0,
      maxX: site.x + s.x1,
      minZ: site.z + s.z0,
      maxZ: site.z + s.z1,
      top: site.baseY + s.yLow + (s.yHigh - s.yLow) / 2,
      slopeX: 0,
      slopeZ: (s.dir * (s.yHigh - s.yLow)) / (s.z1 - s.z0),
      refX: site.x + (s.x0 + s.x1) / 2,
      refZ: site.z + (s.z0 + s.z1) / 2,
    });
  }
  return out;
}

/**
 * Floor slabs for floors 1..3. Each slab covers the whole interior MINUS
 * the footprint of the flight that arrives there — that hole is where the
 * staircase punches through, so the walkable path never tunnels through
 * stone. (The slab above a flight starts exactly where the flight ends.)
 */
export function towerSlabs(site: TowerSite): TowerPlatform[] {
  const i = TOWER_INNER;
  const out: TowerPlatform[] = [];
  const slab = (x0: number, x1: number, z0: number, z1: number, y: number): TowerPlatform => ({
    minX: site.x + x0,
    maxX: site.x + x1,
    minZ: site.z + z0,
    maxZ: site.z + z1,
    top: y,
    slopeX: 0,
    slopeZ: 0,
    refX: site.x,
    refZ: site.z,
  });
  const sliver = (x0: number, x1: number, z0: number, z1: number, y: number): void => {
    // The shifted flights' top edges are flush with the inner wall, which
    // makes one corner piece per floor exactly zero-sized. A zero-area
    // slab would render as a degenerate box — skip it.
    if (x1 - x0 < 0.02 || z1 - z0 < 0.02) return;
    out.push(slab(x0, x1, z0, z1, y));
  };
  for (let k = 1; k < TOWER_FLOORS; k++) {
    const y = towerFloorY(site, k);
    const hole = towerStairFlight(site, k - 1); // the flight arriving at floor k
    if (hole.x0 > 0) {
      // East hole: full-width strip west of it + the east corner(s).
      sliver(-i, hole.x0, -i, i, y);
      sliver(hole.x0, i, -i, hole.z0, y);
      sliver(hole.x0, i, hole.z1, i, y);
    } else {
      sliver(hole.x1, i, -i, i, y);
      sliver(-i, hole.x1, -i, hole.z0, y);
      sliver(-i, hole.x1, hole.z1, i, y);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Spiders + chests
// ---------------------------------------------------------------------------

export interface SpiderSpawn {
  /** Stable id (persisted nothing — spiders respawn with the world). */
  id: string;
  /** Absolute world x/z. */
  x: number;
  z: number;
  /** Which floor this spider lives on (its y = that floor's surface). */
  floor: number;
  /** Wander radius around the spawn point on its own floor. */
  leash: number;
}

/**
 * Spawn roster: four in the court around the base, one on the ground floor,
 * two per middle floor and ONE on the top floor beside the gold chest. The
 * top spider is the final guard of the loot — the tower is meant to be
 * cleared, not walked through.
 */
export function towerSpiders(site: TowerSite): SpiderSpawn[] {
  const out: SpiderSpawn[] = [];
  // Court: a ring around the tower, on the terrain (floor 0).
  const court = [0.6, 2.2, 3.9, 5.3];
  court.forEach((ang, i) => {
    out.push({
      id: `sp_court${i}`,
      x: site.x + Math.cos(ang) * 8.5,
      z: site.z + Math.sin(ang) * 8.5,
      floor: 0,
      leash: 6,
    });
  });
  const inside: Array<[number, number, number]> = [
    // [floor, x-offset, z-offset] — tucked against the walls, away from
    // the doorway and the staircase bands (which now run flush into the
    // wall at their TOP end: the corner behind a flight's top edge is
    // slab, the rest of that wall is stairs).
    [0, -1.6, 1.9],
    [1, -2.6, -2.2], // west band = flight 1 (climbs -z): south corner
    [1, 2.4, -2.6], // east band = flight 0 (climbs +z): south corner
    [2, -2.6, 2.2], // west band = flight 2 (climbs +z): north corner
    [2, 2.4, 2.6], // east band = flight 1 (climbs -z): north corner
    [3, 1.8, -2.0], // the chest guard, top floor
  ];
  inside.forEach(([floor, dx, dz], i) => {
    out.push({ id: `sp_f${floor}_${i}`, x: site.x + dx, z: site.z + dz, floor, leash: 2.2 });
  });
  return out;
}

/** A loot chest: where it stands and what tier of gold it holds. */
export interface TowerChest {
  id: string;
  label: string;
  x: number;
  z: number;
  /** World y of the floor it stands on. */
  y: number;
  /** Which chest tier (see systems/chests.ts). */
  tier: 'small' | 'great';
  /** Which way the lid faces (radians, mesh + opening point). */
  yaw: number;
}

/**
 * The loot: a modest chest on floors 1 and 2, and the CHEST on top — the
 * witch's strongbox, which is why spiders live in her tower. Positions are
 * against the walls so the doorway path and the staircase hole stay clear.
 */
export function towerChests(site: TowerSite): TowerChest[] {
  return [
    { id: 'chest_tower_l1', label: 'Kist', x: site.x - 2.1, z: site.z + 2.1, y: towerFloorY(site, 1), tier: 'small', yaw: Math.PI * 0.25 },
    { id: 'chest_tower_l2', label: 'Kist', x: site.x - 2.1, z: site.z + 2.1, y: towerFloorY(site, 2), tier: 'small', yaw: Math.PI * 0.25 },
    { id: 'chest_tower_top', label: 'Grote kist', x: site.x - 0.0, z: site.z - 1.6, y: towerFloorY(site, 3), tier: 'great', yaw: 0 },
  ];
}

/**
 * World y a tower entity stands at: the slab it lives on for floors 1+,
 * terrain under the footprint otherwise. Spiders use this to stay level on
 * their floor while wandering.
 */
export function towerFloorAt(site: TowerSite, floor: number): number {
  return floor >= 1 ? towerFloorY(site, floor) : site.baseY;
}
