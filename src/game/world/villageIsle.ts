/**
 * De Tweede Eiland: "Kapeleneiland" — a second island, the bridge to it and the
 * village on it.
 *
 * WHY THIS FILE EXISTS AT ALL
 * The world is one deterministic height field (world/terrain.ts + heightfield
 * .ts). A second island is therefore not a second mesh: it is a second *delta*
 * blended into `terrainHeight` with `Math.max`, exactly the pattern
 * `volcanoDelta` (world/volcano.ts) established — max() can only ever raise the
 * natural sea floor, never carve the original island, so spawn, beaches, the
 * lake, the cave ramps and the cliff contract cannot be broken by it.
 *
 * SHAPE — `surf(d) = LAND * dry(d) - SEA_FLOOR * wet(d)`
 *   - `dry` is 1 inside ISLE_CORE and fades to 0 at ISLE_SHORE: a flat table
 *     land (the village pad) ringed by a walkable hillside;
 *   - `wet` is 0 inside ISLE_SHORE and rises to 1 at ISLE_OUTER, so the shore
 *     lingers near sea level as a reef flat and the drop to the sea floor
 *     happens well under water. That is what keeps the island inside the world
 *     contracts: steepest 1 m step over the whole footprint is 1.34 (the mesh
 *     cliff contract allows 2.5) and the steepest slope in the -1.6..+2.6
 *     wading band is 1.0, below the player's MAX_SLOPE of 1.15 — you can always
 *     walk out of the sea onto this island.
 *
 * THE BRIDGE IS AXIS-ALIGNED ON PURPOSE
 * Walkable surfaces in this game are axis-aligned boxes (`Platform`) and wall
 * collision is axis-aligned too (`WallSegment`): the player-built houses use
 * the same constraint. A bridge on a diagonal would have to be a staircase of
 * boxes with invisible ledges. So the strait crossing was chosen where the
 * channel runs along the X axis at z = BRIDGE_Z (46 m of open water, 8.5 m
 * deep), which lets one exact AABB carry the deck and two exact AABBs carry the
 * rails. Only the decorative arch stones are rotated, and decoration has no
 * collision.
 *
 * Everything here is derived from constants and the height field — never
 * stored, never saved (ARCHITECTURE.md: the world is never saved).
 */
import { fbm } from '../core/noise';
import { SEA_LEVEL, terrainHeight } from './heightfield';
import type { Platform, WallSegment } from '../systems/building';

/** Same shape world/flora.ts takes as its exclusion list (not exported there). */
export interface KeepOut {
  x: number;
  z: number;
  r: number;
}

// ---------------------------------------------------------------------------
// The island's shape
// ---------------------------------------------------------------------------

/** Centre of the second island, in world units. */
export const ISLE_CX = 160;
export const ISLE_CZ = 170;
/** Sea floor the delta rises from (matches the natural ocean floor). */
export const ISLE_SEA_FLOOR = 34;
/** Radius where the delta has faded to nothing. */
export const ISLE_OUTER = 100;
/** Radius where the surface crosses sea level (the beach). */
export const ISLE_SHORE = 62;
/** Inside this radius the surface is exactly ISLE_LAND (table land). */
export const ISLE_CORE = 42;
/** Surface height of the table land, metres above sea level. */
export const ISLE_LAND = 8.5;

/** Smoothstep with clamped input (same curve as volcano.ts / caves.ts). */
function ss(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** Distance from the island's centre — plain sqrt, this runs millions of times. */
export function isleDist(x: number, z: number): number {
  const dx = x - ISLE_CX;
  const dz = z - ISLE_CZ;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Surface shape at a known distance from the centre (see `isleSurface`). */
function isleSurfaceAt(x: number, z: number, d: number): number {
  if (d >= ISLE_OUTER) return -ISLE_SEA_FLOOR;
  const dry = 1 - ss((d - ISLE_CORE) / (ISLE_SHORE - ISLE_CORE));
  const wet = ss((d - ISLE_SHORE) / (ISLE_OUTER - ISLE_SHORE));
  // Rolling relief on the flanks: kept off the village pad (which must stay
  // exactly flat) and faded out toward the shore so the reef flat stays a
  // clean gentle ramp. Both gates are checked before the noise is sampled —
  // this function runs millions of times during worldgen.
  const shoreFall = 1 - wet;
  let relief = 0;
  if (shoreFall > 0.02) {
    const pdx = x - VILLAGE.x;
    const pdz = z - VILLAGE.z;
    const padD = Math.sqrt(pdx * pdx + pdz * pdz);
    if (padD > VILLAGE_PAD) {
      relief = (fbm(x * 0.031 + 91.3, z * 0.031 - 44.7, 2) - 0.5) * 1.7 * ss((padD - VILLAGE_PAD) / 10) * shoreFall;
    }
  }
  return ISLE_LAND * dry - ISLE_SEA_FLOOR * wet + relief;
}

/**
 * The island's own surface shape at (x, z) — its height above sea level if it
 * were the only thing there. Outside the footprint this is the sea floor it
 * fades into, which is what the natural height field already has there.
 */
export function isleSurface(x: number, z: number): number {
  return isleSurfaceAt(x, z, isleDist(x, z));
}

/**
 * Height the island adds on top of `baseHeight` at (x, z): never negative, and
 * exactly 0 outside ISLE_OUTER. Same call shape as `volcanoDelta(x, z, h)` —
 * `baseHeight` is what the rest of `terrainHeight` produced, so the blend is a
 * max(): the original island can only ever be added to, never carved. Called
 * from `terrainHeight` right after the volcano.
 */
export function isleDelta(x: number, z: number, baseHeight: number): number {
  const d = isleDist(x, z);
  if (d >= ISLE_OUTER) return 0; // not here at all
  const lift = isleSurfaceAt(x, z, d) - baseHeight;
  return lift > 0 ? lift : 0;
}

/** True when (x, z) is on the second island's landmass (above 1 m). */
export function isOnIsle(x: number, z: number): boolean {
  return terrainHeight(x, z) > 1 && Math.hypot(x - ISLE_CX, z - ISLE_CZ) < ISLE_SHORE + 6;
}

// ---------------------------------------------------------------------------
// The village
// ---------------------------------------------------------------------------

/** Centre of the village square — the flat pad the whole settlement stands on. */
export const VILLAGE = { x: 150, z: 170 } as const;
/** Radius of the perfectly flat pad around the square (see `isleDelta`). */
export const VILLAGE_PAD = 30;
/** Standing height everywhere on the pad (the table land, exactly). */
export const VILLAGE_Y = ISLE_LAND;

/** One house plot. `door` is the side of the box the doorway sits on. */
export interface HousePlot {
  id: string;
  /** Centre of the footprint. */
  x: number;
  z: number;
  /** Footprint size along x / z. */
  w: number;
  d: number;
  /** Wall height above the pad. */
  wallH: number;
  /** Ridge height above the pad. */
  ridge: number;
  /** Which face the door is on: +x, -x, +z or -z. */
  door: 'px' | 'nx' | 'pz' | 'nz';
  /** Chimney corner (+1/-1 on each axis) or 0 for a hearth-less hut. */
  chimney: [number, number] | null;
}

/**
 * Five houses around the square, every one axis-aligned with its door facing
 * the square, plus the church on the east side. Authored as plain numbers:
 * this is the layout, not a procedure — a village that moves every reload is
 * not a village. The one hard rule the test enforces: the street (the bridge
 * lands at z = BRIDGE_Z and runs due west-east into the square) stays clear,
 * so C/D sit north and south of it, not on it.
 */
export const HOUSES: HousePlot[] = [
  { id: 'huis-a', x: 140, z: 156, w: 6, d: 6, wallH: 3.0, ridge: 4.9, door: 'pz', chimney: [1, -1] },
  { id: 'huis-b', x: 140, z: 184, w: 6, d: 6, wallH: 3.0, ridge: 4.9, door: 'nz', chimney: [-1, 1] },
  { id: 'huis-c', x: 128, z: 158, w: 6, d: 6, wallH: 2.8, ridge: 4.6, door: 'pz', chimney: null },
  { id: 'huis-d', x: 128, z: 182, w: 6, d: 6, wallH: 2.8, ridge: 4.6, door: 'nz', chimney: [-1, -1] },
  { id: 'huis-e', x: 163, z: 186, w: 6.5, d: 5.5, wallH: 2.8, ridge: 4.5, door: 'nz', chimney: [1, 1] },
];

/** The church: a nave with a west tower and a spire — the island's landmark. */
export const CHURCH = {
  /** Nave footprint. */
  nave: { x0: 158, z0: 164.5, x1: 172, z1: 175.5 },
  /** Wall height of the nave above the pad. */
  wallH: 7.2,
  /** Ridge above the pad. */
  ridge: 11.4,
  /** Tower footprint (its west face is the east edge of the square). */
  tower: { x0: 151.6, z0: 166.8, x1: 158, z1: 173.2 },
  /** Tower top (parapet) above the pad; the spire adds SPIRE. */
  towerH: 19,
  spire: 8.5,
  /** Main doorway: middle of the tower's west face. */
  door: { x: 151.6, z: 170, width: 1.6 },
  /** Side doors in the nave's south wall. */
  sideDoors: [163.4, 168.6],
} as const;

/** Village well in the square, and the two boats hauled up on the beach. */
export const WELL = { x: 148, z: 164.6, radius: 0.9 } as const;
export const BOATS = [
  { x: 110.5, z: 176.5, yaw: 0.35 },
  { x: 113, z: 162.5, yaw: -0.5 },
] as const;

/** A villager's home spot; the NPC wanders its ring around this. */
export interface VillagerSpot {
  id: string;
  x: number;
  z: number;
  /** Wander ring [min, max] passed through to `Npc`. */
  ring: [number, number];
}

/** Where the three islanders stand when the world loads. */
export const VILLAGERS: VillagerSpot[] = [
  { id: 'sien', x: 112, z: 171.5, ring: [2.5, 4] }, // harbour, mending nets
  { id: 'ansel', x: 155.5, z: 177.5, ring: [2, 3.5] }, // church side, the elder
  { id: 'joris', x: 141.5, z: 164, ring: [2.5, 4.5] }, // square, the mason
];

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

/** The channel runs along the X axis at this z. */
export const BRIDGE_Z = ISLE_CZ;
/** Top surface of the deck, metres above sea level. */
export const BRIDGE_DECK_Y = 2.6;
/** Deck plank thickness. */
export const BRIDGE_DECK_T = 0.4;
/** Clear width between the two rails. */
export const BRIDGE_WIDTH = 3.2;
/** Rail height above the deck. */
export const BRIDGE_RAIL_H = 1.05;
/** Deck is one collision platform per this many metres (short = cheap checks). */
export const BRIDGE_SEGMENT = 7.5;

/** Everything about the crossing, derived from the height field. */
export interface BridgePlan {
  /** Deck ends (west = main island side, east = island side). */
  xWest: number;
  xEast: number;
  z: number;
  deckY: number;
  length: number;
  /** Collision: one platform per BRIDGE_SEGMENT. */
  decks: Platform[];
  /** Collision: the two rails. */
  rails: WallSegment[];
  /** Stone piers standing on the sea floor / beach under the deck. */
  piers: { x: number; z: number; w: number; d: number; top: number; bottom: number }[];
  /** Arch rings (visual only): semicircle of radius r, crown at the soffit. */
  arches: { x: number; r: number }[];
  /** Where the deck touches each shore (harbour side / mainland side). */
  eastShore: number;
  westShore: number;
}

/**
 * A flat walkable slab (the deck planks): `Platform` is not a box but a
 * surface — footprint + height + slope, see `platformSurfaceAt`.
 */
function deckSlab(x0: number, x1: number, z0: number, z1: number, top: number): Platform {
  return {
    minX: x0,
    maxX: x1,
    minZ: z0,
    maxZ: z1,
    top,
    slopeX: 0,
    slopeZ: 0,
    refX: (x0 + x1) / 2,
    refZ: (z0 + z1) / 2,
  };
}

function railBox(x0: number, x1: number, z0: number, z1: number, baseY: number, topY: number): WallSegment {
  return { minX: x0, maxX: x1, minZ: z0, maxZ: z1, height: topY - baseY, baseY, topY };
}

/**
 * The crossing. The deck ends are found by walking the axis and interpolating
 * where the ground crosses deck height: the deck then stops exactly flush with
 * both beaches, so walking from either shore onto the planks is a normal step
 * instead of a wall (a deck end buried 0.8 m in a beach blocks the whole
 * route — the player's slope gate stops them there). Pure function of the
 * height field: deterministic, testable, never stored.
 */
export function bridgePlan(heightAt: (x: number, z: number) => number): BridgePlan {
  const deckY = BRIDGE_DECK_Y;
  /** First point along the axis where the ground crosses `level`. */
  const crossing = (from: number, to: number, level: number): number => {
    const step = 0.25 * (to > from ? 1 : -1);
    let px = from;
    let ph = heightAt(px, BRIDGE_Z);
    for (let x = from + step; (to - x) * step > 1e-9; x += step) {
      const h = heightAt(x, BRIDGE_Z);
      if ((ph - level) * (h - level) <= 0) {
        const t = (level - ph) / (h - ph || 1e-9);
        return px + (x - px) * t;
      }
      px = x;
      ph = h;
    }
    return to;
  };

  // East end: walk west off the island's table land until the ground drops to
  // deck height. West end: walk east out of the mainland until it does the same.
  const xEast = crossing(ISLE_CX - ISLE_CORE, ISLE_CX - ISLE_OUTER - 8, deckY);
  const xWest = crossing(12, xEast - 4, deckY);
  // Where the water actually starts and ends under the deck (for the piers).
  const westShore = crossing(xWest, xEast, SEA_LEVEL);
  const eastShore = crossing(xEast, xWest, SEA_LEVEL);

  const half = BRIDGE_WIDTH / 2 + BRIDGE_DECK_T; // structural width incl. plank edge
  const decks: Platform[] = [];
  for (let x = xWest; x < xEast - 0.01; x += BRIDGE_SEGMENT) {
    const x1 = Math.min(x + BRIDGE_SEGMENT, xEast);
    // One platform per segment; the seam between two neighbouring platforms is
    // not a ledge (both have the same top), so they are all 'full'.
    decks.push(deckSlab(x, x1, BRIDGE_Z - half, BRIDGE_Z + half, deckY));
  }
  const rails: WallSegment[] = [
    railBox(xWest, xEast, BRIDGE_Z - half, BRIDGE_Z - half + 0.24, deckY, deckY + BRIDGE_RAIL_H),
    railBox(xWest, xEast, BRIDGE_Z + half - 0.24, BRIDGE_Z + half, deckY, deckY + BRIDGE_RAIL_H),
  ];

  // Piers: one under every deck seam, standing on whatever is under it (sea
  // floor or beach sand). At the ends the sand is nearly at soffit height, so
  // those piers read as plinths — which is what an abutment is.
  const piers: BridgePlan['piers'] = [];
  for (let x = xWest; x <= xEast + 0.01; x += BRIDGE_SEGMENT) {
    const bottom = Math.min(heightAt(x, BRIDGE_Z), deckY - BRIDGE_DECK_T) - 0.6;
    piers.push({ x, z: BRIDGE_Z, w: 1.7, d: half * 2 + 0.5, top: deckY - BRIDGE_DECK_T, bottom });
  }
  // Arches: a semicircle over each span that crosses open water, its crown
  // touching the deck soffit. Over the beaches the sand is too close to the
  // soffit for an arch, and the piers just stand in the sand instead.
  const arches: BridgePlan['arches'] = [];
  for (let i = 0; i + 1 < piers.length; i++) {
    const mid = (piers[i].x + piers[i + 1].x) / 2;
    if (heightAt(mid, BRIDGE_Z) > SEA_LEVEL) continue; // not water
    const r = (piers[i + 1].x - piers[i].x) / 2;
    if (r < 2) continue; // a last short stub segment is not a span
    arches.push({ x: mid, r });
  }

  return {
    xWest,
    xEast,
    z: BRIDGE_Z,
    deckY,
    length: xEast - xWest,
    decks,
    rails,
    piers,
    arches,
    eastShore,
    westShore,
  };
}

// ---------------------------------------------------------------------------
// Flora exclusion + landmarks
// ---------------------------------------------------------------------------

/**
 * Everything the village needs must not be a tree: the pad, the street, the
 * bridge corridor and the harbour. Returned as `KeepOut`s for world/flora.ts
 * (same mechanism the tower, the volcano shrine and the caves already use).
 */
export function villageKeepOuts(bridge: BridgePlan): KeepOut[] {
  const out: KeepOut[] = [
    // The pad, generous enough that no trunk leans over a roof.
    { x: VILLAGE.x, z: VILLAGE.z, r: VILLAGE_PAD + 6 },
    // Street from the bridge head into the square.
    { x: (bridge.xEast + VILLAGE.x) / 2, z: VILLAGE.z, r: (VILLAGE.x - bridge.xEast) / 2 + 4 },
    { x: bridge.xEast - 3, z: VILLAGE.z, r: 7 },
    // The bridge itself: deck, abutments and a corridor over the water.
    { x: (bridge.xWest + bridge.xEast) / 2, z: BRIDGE_Z, r: bridge.length / 2 + 6 },
    // Harbour: boats and nets on the island's beach.
    { x: 111, z: 170, r: 12 },
  ];
  // Each house gets its own cleared yard so a sapling can never grow inside a
  // wall (flora only checks its own point, so the circle must cover the box).
  for (const h of HOUSES) out.push({ x: h.x, z: h.z, r: Math.max(h.w, h.d) });
  out.push({ x: (CHURCH.nave.x0 + CHURCH.tower.x1) / 2, z: (CHURCH.nave.z0 + CHURCH.nave.z1) / 2, r: 14 });
  return out;
}

/** A doorway: where it is, and the direction you walk to enter.
 *
 * `yaw` is the OUTWARD normal of the wall the door sits in, in the game's yaw
 * convention (yaw 0 faces +z, so x = sin(yaw), z = cos(yaw)). */
export interface Doorway {
  x: number;
  z: number;
  yaw: number;
}

/** A house's doorway (the gap `villageWalls()` leaves in its door face). */
export function houseDoor(h: HousePlot): Doorway {
  const hw = h.w / 2;
  const hd = h.d / 2;
  switch (h.door) {
    case 'px':
      return { x: h.x + hw, z: h.z, yaw: Math.PI / 2 };
    case 'nx':
      return { x: h.x - hw, z: h.z, yaw: -Math.PI / 2 };
    case 'pz':
      return { x: h.x, z: h.z + hd, yaw: 0 };
    default:
      return { x: h.x, z: h.z - hd, yaw: Math.PI };
  }
}

/** The church's front door, on the tower's west face, looking down the street. */
export function churchDoor(): Doorway {
  return { x: CHURCH.tower.x0, z: CHURCH.door.z, yaw: -Math.PI / 2 };
}

/** Where a villager stands, on the ground (the pad or the beach). */
export function villagerSpawn(v: VillagerSpot): { x: number; z: number; y: number } {
  return { x: v.x, z: v.z, y: terrainHeight(v.x, v.z) };
}

/** Height the bridge deck top has over the sea at the deepest point. */
export function bridgeClearance(bridge: BridgePlan): number {
  let deep = 0;
  for (let x = bridge.westShore; x <= bridge.eastShore; x += 0.5) {
    deep = Math.max(deep, SEA_LEVEL - terrainHeight(x, BRIDGE_Z));
  }
  return bridge.deckY - deep;
}

export const ISLE_APPROACH = 118;

/** Distance at which the village itself reads (smoke, spire, quay). */
export const VILLAGE_APPROACH = 46;

// ---------------------------------------------------------------------------
// Walls: what the buildings are made of, as collision
// ---------------------------------------------------------------------------

/** Wall thickness of every village building (also the drawn thickness). */
export const WALL_T = 0.32;
/** Clear width of a doorway. */
export const DOOR_W = 1.5;

/** A wall slab plus what it belongs to (the visual layer draws from this). */
export interface VillageWall extends WallSegment {
  /** House id / 'church' so the renderer can group and tint. */
  building: string;
  /** Which face of the footprint this slab is on. */
  face: 'px' | 'nx' | 'pz' | 'nz';
  /** True for the two stubs left around a doorway. */
  doorSide?: boolean;
}

/** Wall height above the pad for a building's top (church nave vs houses). */
function slab(
  building: string,
  face: VillageWall['face'],
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  height: number,
  doorSide = false,
): VillageWall {
  return {
    building,
    face,
    doorSide,
    minX: x0,
    maxX: x1,
    minZ: z0,
    maxZ: z1,
    baseY: VILLAGE_Y,
    topY: VILLAGE_Y + height,
    height,
  };
}

/**
 * One face of a footprint as wall slabs, with a clear gap around each door
 * centre (`doors` runs along the face: z for the x-faces, x for the z-faces).
 * A face with no doors is one slab; a door in the middle splits it in two.
 */
function face(
  building: string,
  f: VillageWall['face'],
  box: { x0: number; x1: number; z0: number; z1: number },
  height: number,
  doors: number[] = [],
  doorW = DOOR_W,
): VillageWall[] {
  const t = WALL_T;
  const [from, to] = f === 'px' || f === 'nx' ? [box.z0, box.z1] : [box.x0, box.x1];
  const push = (a: number, b: number, doorSide: boolean): void => {
    if (b - a < 0.05) return;
    if (f === 'nz') push2(slab(building, f, a, b, box.z0, box.z0 + t, height, doorSide));
    else if (f === 'pz') push2(slab(building, f, a, b, box.z1 - t, box.z1, height, doorSide));
    else if (f === 'nx') push2(slab(building, f, box.x0, box.x0 + t, a, b, height, doorSide));
    else push2(slab(building, f, box.x1 - t, box.x1, a, b, height, doorSide));
  };
  const out: VillageWall[] = [];
  const push2 = (w: VillageWall) => out.push(w);
  let cursor = from;
  for (const d of [...doors].sort((a, b) => a - b)) {
    push(cursor, d - doorW / 2, cursor < d - doorW / 2 - 0.05);
    cursor = d + doorW / 2;
  }
  push(cursor, to, cursor > from + 0.05);
  return out;
}

/**
 * Every solid wall of the village as `WallSegment`s — the same struct the
 * player controller already walks for the witch's tower and for player-built
 * houses, so nothing new is needed to keep the player out of the stone. Door
 * ways are real gaps (the cottages can be walked into; the flat pad is their
 * floor), and the `building`/`face` tags let the renderer draw exactly these
 * boxes: what you see is what you bump into.
 */
export function villageWalls(): VillageWall[] {
  const out: VillageWall[] = [];
  for (const h of HOUSES) {
    const box = { x0: h.x - h.w / 2, x1: h.x + h.w / 2, z0: h.z - h.d / 2, z1: h.z + h.d / 2 };
    for (const f of ['px', 'nx', 'pz', 'nz'] as const) {
      // Only the door face has a gap, and it is centred on the plot.
      const doors = h.door === f ? [(f === 'px' || f === 'nx' ? h.z : h.x)] : [];
      out.push(...face(h.id, f, box, h.wallH, doors));
    }
  }

  // The church: a nave with a west tower. The tower is its porch and belfry,
  // so the two share an open arch — the nave's west face exists only where the
  // tower does not cover it, and the tower has no east wall at all.
  const nave = CHURCH.nave;
  const tower = CHURCH.tower;
  out.push(...face('church', 'nz', nave, CHURCH.wallH, [...CHURCH.sideDoors]));
  out.push(...face('church', 'pz', nave, CHURCH.wallH));
  out.push(...face('church', 'px', nave, CHURCH.wallH));
  if (tower.z0 - nave.z0 > 0.05)
    out.push(...face('church', 'nx', { ...nave, z1: tower.z0 }, CHURCH.wallH));
  if (nave.z1 - tower.z1 > 0.05)
    out.push(...face('church', 'nx', { ...nave, z0: tower.z1 }, CHURCH.wallH));
  const towerBox = { x0: tower.x0, x1: tower.x1, z0: tower.z0, z1: tower.z1 };
  out.push(...face('church', 'nx', towerBox, CHURCH.towerH, [CHURCH.door.z], CHURCH.door.width));
  out.push(...face('church', 'nz', towerBox, CHURCH.towerH));
  out.push(...face('church', 'pz', towerBox, CHURCH.towerH));

  return out;
}

// ---------------------------------------------------------------------------
// Floors: the inside of a building is stone, not the village pad
// ---------------------------------------------------------------------------

/**
 * How far the flagstones stand above the pad. 6 cm: tall enough that a boot at
 * pad height does not clip through the visible slab, and small enough to step
 * onto (the player's MAX_STEP_UP is 0.43), so a doorway is a threshold, not a
 * kerb you hop.
 */
export const FLOOR_LIFT = 0.06;

/**
 * Interior floors as standing surfaces — the same `Platform` struct the bridge
 * deck uses, and the visual layer draws a box whose top is exactly `top`.
 *
 * Like the witch's tower, each slab stops at the wall's INNER face: the pad
 * heightfield carries the walls, and there is never a standing surface inside
 * a wall's box for the controller to argue about. The doorway is where the two
 * meet — you step up 6 cm over the threshold, which is a step, not a kerb.
 */
export function villageFloors(): Platform[] {
  const t = WALL_T;
  const lift = VILLAGE_Y + FLOOR_LIFT;
  const out: Platform[] = HOUSES.map((h) =>
    deckSlab(
      h.x - h.w / 2 + t,
      h.x + h.w / 2 - t,
      h.z - h.d / 2 + t,
      h.z + h.d / 2 - t,
      lift,
    ),
  );
  const nave = CHURCH.nave;
  const tower = CHURCH.tower;
  out.push(deckSlab(nave.x0 + t, nave.x1 - t, nave.z0 + t, nave.z1 - t, lift));
  // The tower's floor runs flush into the nave's: at their meeting line there
  // is no wall (that is the arch), so the two slabs must not leave a gap.
  out.push(deckSlab(tower.x0 + t, nave.x0 + t, tower.z0 + t, tower.z1 - t, lift));
  return out;
}
