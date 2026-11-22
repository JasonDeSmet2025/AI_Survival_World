/**
 * Pure building logic (Gameplay scope): the construction grid, placement
 * validation, stacking (floors on floors, walls on floors, roofs on walls)
 * and the collision/standing geometry of every structure. No Babylon imports
 * so it can be unit-tested in Node — and so the RENDERED mesh
 * (systems/buildingMeshes.ts) and the PLAYER PHYSICS
 * (player/controller.ts) read the exact same numbers out of this one file.
 *
 * The grid contract:
 *   One cell = BUILDING_MODULE metres square. FLOORS, ROOFS, beds and fires
 *   snap to the cell CENTRES; WALLS snap to the cell EDGES (an offset grid,
 *   half a module sideways). "Walls" means EVERY wall-like kind — wooden
 *   wall, stone wall, door and fence share one edge grid (isEdgeKind), or the
 *   lines would not join. That is what makes a hut buildable: a floor
 *   fills its cell and a wall stands on the floor's border line instead of
 *   in the middle of the deck. A wall is exactly one module long, so walls
 *   butt together corner to corner with no seam, and every wall anchor sits
 *   on the border of exactly two floor cells — either deck can carry it.
 *
 *   The vertical grid: ground-based floors, walls and roofs snap their base
 *   to HEIGHT_GRID steps, so every floor in the area lands on one of the
 *   same shared elevations instead of following the terrain in centimetre
 *   noise. HEIGHT_GRID (0.3 m) is below MAX_STEP_UP, so a neighbouring
 *   level is still walkable. On top of that the player may raise a
 *   placement by up to MAX_BUILD_LEVEL grid steps (build level).
 */

export type BuildingKind =
  | 'campfire'
  | 'wall'
  | 'floor'
  | 'roof'
  | 'bed'
  | 'door'
  | 'stone_wall'
  | 'torch'
  | 'carpet'
  | 'fence'
  | 'stairs'
  | 'workbench'
  | 'planter'
  | 'sign';

/**
 * Kinds that live on the WALL EDGE grid (like `wall`) instead of the cell
 * centres: a door fills a gap in a wall line and a fence continues it, so
 * both must share the wall's anchors, footprint cells and collision segment.
 *
 * This MUST cover every kind `isWallLike` calls a wall (and the fence that
 * hangs in the same line): stone_wall was once missing here and so was
 * placed on the FLOOR grid — a stenen muur landed in the middle of a deck,
 * half a module out of line with every wooden wall next to it. The two
 * predicates are asserted against each other in building.test.ts.
 */
export function isEdgeKind(kind: BuildingKind): boolean {
  return kind === 'wall' || kind === 'stone_wall' || kind === 'door' || kind === 'fence';
}

/**
 * Kinds that stop the player from walking through (AABB collision). A fence
 * blocks but is NOT wall-like: it is lower, and nothing may stack on it.
 */
export function isBlocking(kind: BuildingKind, open = false): boolean {
  if (kind === 'fence') return true;
  if (kind === 'door') return !open;
  return isWallLike(kind);
}

/** Every kind that behaves like a wall for support and blocking. */
export function isWallLike(kind: BuildingKind): boolean {
  return kind === 'wall' || kind === 'door' || kind === 'stone_wall';
}

export interface BuildingData {
  id: string;
  kind: BuildingKind;
  x: number;
  z: number;
  y: number;
  /** rotation in quarter turns (0..3) */
  rot: number;
  ownerId: string;
  /** campfire seconds of remaining fuel */
  fuel?: number;
  /** door: swung open (blocks movement only while closed) */
  open?: boolean;
}

/**
 * One construction cell. Walls, floors and roofs are exactly this wide, so
 * snapping to it lines every structure up in straight rows.
 */
export const BUILDING_MODULE = 2.0;

/** How far off the cell centre an existing building may be and still count as "the same cell". */
export const CELL_TOLERANCE = 0.6;

/** Walking height of the player, used to decide whether a wall's height band applies. */
export const PLAYER_HEIGHT = 1.7;

/** Half the collision thickness of a wall (the mesh is thinner than this). */
export const WALL_HALF_THICKNESS = 0.15;

/** Height of a wall above its own base — also the vertical spacing between storeys. */
export const WALL_HEIGHT = 2.4;

/**
 * Height of a fence above its base. Above MAX_STEP_UP (0.43) so it really
 * blocks, low enough to still see over and to build without a permit.
 */
export const FENCE_HEIGHT = 1.15;

/**
 * How high a single flight of stairs carries you across one cell. It is a
 * multiple of HEIGHT_GRID (3 steps) and its grade (0.45 m per m) stays below
 * the point where the controller starts sliding you back down.
 */
export const STAIRS_RISE = 0.9;

/** Walking height gained per metre of a stairs run (derived from one cell). */
export const STAIRS_GRADE = STAIRS_RISE / BUILDING_MODULE;

/** Height of a blocked thing above its base, per kind (collision + mesh). */
export function blockHeight(kind: BuildingKind): number {
  return kind === 'fence' ? FENCE_HEIGHT : WALL_HEIGHT;
}

/** Height of the finished walking surface of a floor, above the floor's base y. */
export const FLOOR_SURFACE_OFFSET = 0.18;

/** Kinds that get their base from the shared HEIGHT_GRID when on bare ground. */
export function isGridElevated(kind: BuildingKind): boolean {
  return kind === 'floor' || isWallLike(kind) || kind === 'roof';
}

/** Roof ridge height above the roof's base y (the base sits on top of the walls). */
export const ROOF_RIDGE_OFFSET = 0.45;

/** Roof slope in radians, and how far the eaves overhang past the cell edge. */
export const ROOF_PITCH = 0.36;
export const ROOF_SPAN = 1.08;

/**
 * Highest step up the player can walk onto without jumping. Derived from the
 * deck height itself (+ 25 cm of slack) so a plank floor is always walkable
 * and the next storey, 2.4 m up, never is.
 */
export const MAX_STEP_UP = FLOOR_SURFACE_OFFSET + 0.25;

/**
 * Vertical spacing (metres) of the shared height grid. Every ground-based
 * floor/wall/roof base snaps to a multiple of this, so neighbouring plots
 * are either level or exactly one walkable step apart. It divides
 * WALL_HEIGHT (2.4 = 8 steps), so a full storey stays on the grid too.
 */
export const HEIGHT_GRID = 0.3;

/** How many grid steps the player may lift a placement (PgUp/PgDn). */
export const MAX_BUILD_LEVEL = 2;

export const BUILDING_SIZE: Record<BuildingKind, number> = {
  campfire: 1.6,
  wall: BUILDING_MODULE,
  stone_wall: BUILDING_MODULE,
  door: BUILDING_MODULE,
  fence: BUILDING_MODULE,
  floor: BUILDING_MODULE,
  stairs: BUILDING_MODULE,
  roof: BUILDING_MODULE,
  bed: 2.4,
  torch: 0.5,
  carpet: BUILDING_MODULE,
  workbench: 1.6,
  planter: 1.2,
  sign: 1.0,
};

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

/** Centre of the grid cell containing `v` (0 stays on a centre, 1.2 -> 1). */
export function snapToGrid(v: number, pitch = BUILDING_MODULE): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n / pitch) * pitch;
}

/** Centre of the cell a world point falls in. */
export function snapToCell(
  x: number,
  z: number,
  pitch = BUILDING_MODULE,
): { x: number; z: number } {
  return { x: snapToGrid(x, pitch), z: snapToGrid(z, pitch) };
}

/**
 * Snap a world point to the nearest WALL anchor: the mid-point of a cell
 * edge. `rot` follows the edge — 0 = the wall runs along +x (rot 2 is the
 * same line), 1 = along +z. This is the fix for "the wall lands in the
 * middle of the floor": walls live on the edges of the floor grid.
 */
export function snapToWallEdge(
  x: number,
  z: number,
  pitch = BUILDING_MODULE,
): { x: number; z: number; rot: number } {
  const h = pitch / 2;
  const odd = (v: number): number => Math.round((v - h) / pitch) * pitch + h;
  const even = (v: number): number => Math.round(v / pitch) * pitch;
  const dAlongX = Math.hypot(x - even(x), z - odd(z));
  const dAlongZ = Math.hypot(x - odd(x), z - even(z));
  return dAlongX <= dAlongZ
    ? { x: even(x), z: odd(z), rot: 0 }
    : { x: odd(x), z: even(z), rot: 1 };
}

/**
 * Save files and server snapshots from before stone walls joined the edge
 * grid carry them on the FLOOR grid (see `isEdgeKind`). Re-snapping them on
 * load is what keeps an old world readable: the wall moves at most half a
 * module sideways onto the line it should always have stood on, and `rot`
 * comes from the edge that was nearest.
 *
 * Idempotent — a wall that is already on an edge anchor maps to itself — so
 * it is safe to run on every load, for every player's buildings. Base `y` is
 * deliberately left alone: re-deriving it would cascade through everything
 * stacked on top of the wall. On flat or gently sloping ground the deck or
 * terrain it now stands on is within a few centimetres of the saved height.
 *
 * Returns how many buildings were moved (0 in a healthy world — the common
 * case costs one pass over the list).
 */
export function migrateWallGrid(buildings: BuildingData[]): number {
  let moved = 0;
  for (const b of buildings) {
    if (b.kind !== 'stone_wall') continue;
    const edge = snapToWallEdge(b.x, b.z);
    if (Math.abs(edge.x - b.x) < 1e-6 && Math.abs(edge.z - b.z) < 1e-6) continue;
    b.x = edge.x;
    b.z = edge.z;
    b.rot = edge.rot;
    moved++;
  }
  return moved;
}

/**
 * The two floor cells a wall stands between. Derived from the wall's own
 * rot exactly like wallSegment(): rot even = the wall runs along +x, so it
 * borders the cells at z -/+ half a module. Old centre-grid walls keep
 * working — this is just geometry around whatever x/z they were saved with.
 */
export function wallFootprintCells(b: {
  x: number;
  z: number;
  rot: number;
}): { x: number; z: number }[] {
  const h = BUILDING_MODULE / 2;
  return b.rot % 2 === 0
    ? [{ x: b.x, z: b.z - h }, { x: b.x, z: b.z + h }]
    : [{ x: b.x - h, z: b.z }, { x: b.x + h, z: b.z }];
}

/** True when a building occupies/abuts the floor cell centred at (cx, cz). */
export function touchesCell(b: BuildingData, cx: number, cz: number): boolean {
  if (isEdgeKind(b.kind)) return wallFootprintCells(b).some((c) => sameCell(c.x, c.z, cx, cz));
  return sameCell(b.x, b.z, cx, cz);
}

/**
 * Snap a ground-based base height to the shared vertical grid, then lift it
 * `level` grid steps. Rounds up to the grid (so sloping terrain cannot poke
 * through the deck) but sinks up to 0.1 m back down when the grid step above
 * would leave a visible floating gap. `level` is the player's PgUp/PgDn
 * build level.
 */
export function snapHeightToGrid(
  y: number,
  level = 0,
  pitch = HEIGHT_GRID,
): number {
  const n = Number.isFinite(y) ? y : 0;
  let base = Math.ceil(n / pitch - 1e-9) * pitch;
  if (n - (base - pitch) <= 0.1) base -= pitch;
  return Math.round((base + level * pitch) * 1e6) / 1e6;
}

/** True when two world points fall in the same construction cell. */
export function sameCell(ax: number, az: number, bx: number, bz: number): boolean {
  return (
    Math.abs(ax - bx) < CELL_TOLERANCE &&
    Math.abs(az - bz) < CELL_TOLERANCE
  );
}

/**
 * Base height for a structure footprint on open ground. Floors and walls sit
 * slightly above the highest sampled ground point so sloping terrain cannot
 * hide their geometry. Other buildings keep the exact ground height at their
 * centre.
 *
 * For anything that stacks on another structure use `placementBaseY()`, which
 * combines this with the support the cell already offers.
 */
export function buildingPlacementHeight(
  kind: BuildingKind,
  x: number,
  z: number,
  rot: number,
  terrainHeightAt: (x: number, z: number) => number,
): number {
  if (kind !== 'floor' && !isWallLike(kind)) return terrainHeightAt(x, z);

  const half = BUILDING_MODULE / 2 - 0.08;
  const depth = kind === 'floor' ? half : 0.12;
  const angle = (rot / 4) * Math.PI * 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let maxY = -Infinity;

  for (const along of [-half, 0, half]) {
    for (const across of kind === 'floor' ? [-depth, 0, depth] : [-depth, depth]) {
      const sampleX = x + along * cos + across * sin;
      const sampleZ = z - along * sin + across * cos;
      maxY = Math.max(maxY, terrainHeightAt(sampleX, sampleZ));
    }
  }

  return maxY + 0.08;
}

/** Height of the walking surface a structure offers on top of it (null = nothing to stand on). */
export function structureTopY(b: BuildingData): number | null {
  switch (b.kind) {
    case 'floor':
      return b.y + FLOOR_SURFACE_OFFSET;
    case 'wall':
    case 'stone_wall':
    case 'door':
      return b.y + WALL_HEIGHT;
    default:
      // A fence, stair flight and every loose prop carry nothing: no storey
      // is ever supported by them.
      return null;
  }
}

/**
 * Height a new `kind` would stand at at (x, z): the terrain, or the top of
 * whatever already stands there. For a wall, (x, z) is an EDGE anchor and
 * `rot` says which way the wall runs; for everything else it is a cell
 * centre.
 *
 * Support rules (what may carry what):
 *   floor  -> wall top (an upper-storey deck: any wall bordering the cell)
 *             or the ground — never another deck, which would be an 18 cm
 *             staircase
 *   wall/door/stone_wall -> floor top of either cell the edge borders, or
 *             the top of the same wall line (wall on wall = a taller storey)
 *   roof   -> wall top ONLY, of the walls/doors bordering the cell (a roof
 *             belongs on walls, not floating on a deck)
 *   others -> floor top (a bed, fire, torch or carpet on a deck), terrain
 *             otherwise
 */
export function supportHeightAt(
  kind: BuildingKind,
  x: number,
  z: number,
  existing: BuildingData[],
  terrainHeightAt: (x: number, z: number) => number,
  rot = 0,
): number {
  let best = terrainHeightAt(x, z);
  if (isEdgeKind(kind)) {
    const cells = wallFootprintCells({ x, z, rot });
    for (const b of existing) {
      const top = structureTopY(b);
      if (top === null) continue;
      if (b.kind === 'floor' && cells.some((c) => sameCell(b.x, b.z, c.x, c.z))) {
        best = Math.max(best, top);
      } else if (isWallLike(b.kind) && sameCell(b.x, b.z, x, z)) {
        best = Math.max(best, top);
      }
    }
    return best;
  }
  for (const b of existing) {
    if (!touchesCell(b, x, z)) continue;
    const top = structureTopY(b);
    if (top === null) continue;
    if (isWallLike(b.kind) && (kind === 'roof' || kind === 'floor')) {
      best = Math.max(best, top);
      continue;
    }
    // A deck carries walls, a bed, a fire, a torch, a carpet — but not
    // another deck (that would be an 18 cm staircase) and not a roof (a
    // roof belongs on walls).
    if (b.kind === 'floor' && kind !== 'floor' && kind !== 'roof') best = Math.max(best, top);
  }
  return best;
}

/**
 * The y a new structure is actually placed at: the ground snapped to the
 * shared height grid (plus the player's build `level`), or the exact top of
 * whatever supports it — stacking must land flush, never re-snapped.
 */
export function placementBaseY(
  kind: BuildingKind,
  x: number,
  z: number,
  rot: number,
  existing: BuildingData[],
  terrainHeightAt: (x: number, z: number) => number,
  level = 0,
): number {
  const groundBase = buildingPlacementHeight(kind, x, z, rot, terrainHeightAt);
  const support = supportHeightAt(kind, x, z, existing, terrainHeightAt, rot);
  // Loose props (fire, bed, torch, rug, workbench, planter, sign) and stairs
  // stand flush on whatever carries them, never re-snapped to the grid.
  if (
    kind === 'campfire' ||
    kind === 'bed' ||
    kind === 'torch' ||
    kind === 'carpet' ||
    kind === 'workbench' ||
    kind === 'planter' ||
    kind === 'sign' ||
    kind === 'stairs'
  ) {
    return Math.max(groundBase, support);
  }
  if (support > groundBase) {
    return Math.round((support + level * HEIGHT_GRID) * 1e6) / 1e6;
  }
  return isGridElevated(kind) ? snapHeightToGrid(groundBase, level) : groundBase;
}

// ---------------------------------------------------------------------------
// Collision geometry
// ---------------------------------------------------------------------------

export interface WallSegment {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
  /** World y the wall starts at (a second-storey wall starts on the deck). */
  baseY: number;
  /** World y the wall ends at. */
  topY: number;
}

export function wallSegment(b: BuildingData): WallSegment {
  const half = BUILDING_MODULE / 2;
  const thick = WALL_HALF_THICKNESS;
  const swapped = b.rot % 2 === 1;
  const dx = swapped ? thick : half;
  const dz = swapped ? half : thick;
  const height = blockHeight(b.kind);
  return {
    minX: b.x - dx,
    maxX: b.x + dx,
    minZ: b.z - dz,
    maxZ: b.z + dz,
    height,
    baseY: b.y,
    topY: b.y + height,
  };
}

/**
 * A horizontal surface the player can stand on. `top` is the surface height
 * at (refX, refZ); `slopeX` / `slopeZ` are the metres of height gained per
 * metre travelled along that axis, so a pitched roof is described exactly
 * instead of being flattened into a lie.
 */
export interface Platform {
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

/** Height of a platform surface at a world point (0 when outside its footprint). */
export function platformSurfaceAt(p: Platform, x: number, z: number): number {
  if (x < p.minX || x > p.maxX || z < p.minZ || z > p.maxZ) return -Infinity;
  return p.top + (x - p.refX) * p.slopeX + (z - p.refZ) * p.slopeZ;
}

/**
 * Standing surfaces a building provides. Floors are one full-cell deck; a
 * roof is two pitched halves meeting at the ridge. Walls, fires and beds are
 * deliberately absent — a 0.3 m wide wall top is not a floor.
 */
export function buildingPlatforms(b: BuildingData): Platform[] {
  const half = BUILDING_MODULE / 2;
  if (b.kind === 'floor') {
    const top = b.y + FLOOR_SURFACE_OFFSET;
    return [{ minX: b.x - half, maxX: b.x + half, minZ: b.z - half, maxZ: b.z + half, top, slopeX: 0, slopeZ: 0, refX: b.x, refZ: b.z }];
  }
  if (b.kind === 'stairs') {
    // One flight = one sloped deck across the cell. The local +X side is the
    // high end, and rot maps local +X to world (cos, -sin) exactly like the
    // meshes rotate, so the reference height is the cell centre's surface.
    const angle = (b.rot / 4) * Math.PI * 2;
    return [{
      minX: b.x - half,
      maxX: b.x + half,
      minZ: b.z - half,
      maxZ: b.z + half,
      top: b.y + STAIRS_RISE / 2,
      slopeX: Math.cos(angle) * STAIRS_GRADE,
      slopeZ: -Math.sin(angle) * STAIRS_GRADE,
      refX: b.x,
      refZ: b.z,
    }];
  }
  if (b.kind === 'roof') {
    const top = b.y + ROOF_RIDGE_OFFSET;
    const grade = Math.tan(ROOF_PITCH);
    const alongX = b.rot % 2 === 1;
    const surf: Platform[] = [];
    for (const s of [-1, 1] as const) {
      if (alongX) {
        surf.push({
          minX: s === 1 ? b.x : b.x - ROOF_SPAN,
          maxX: s === 1 ? b.x + ROOF_SPAN : b.x,
          minZ: b.z - ROOF_SPAN,
          maxZ: b.z + ROOF_SPAN,
          top,
          slopeX: -s * grade,
          slopeZ: 0,
          refX: b.x,
          refZ: b.z,
        });
      } else {
        surf.push({
          minX: b.x - ROOF_SPAN,
          maxX: b.x + ROOF_SPAN,
          minZ: s === 1 ? b.z : b.z - ROOF_SPAN,
          maxZ: s === 1 ? b.z + ROOF_SPAN : b.z,
          top,
          slopeX: 0,
          slopeZ: -s * grade,
          refX: b.x,
          refZ: b.z,
        });
      }
    }
    return surf;
  }
  return [];
}

/**
 * Highest platform the player can stand on at (x, z).
 *
 * Two ways a surface counts, because both failure modes are visible in game:
 *  - walking onto it: the surface is at most `stepUp` above the feet, so a
 *    0.18 m deck lip is walkable but a deck two metres up is not;
 *  - falling onto it: the feet crossed the surface plane this step (from
 *    `prevFeetY` down to `feetY`) while moving down. Without this a fast
 *    fall tunnels straight through a floor in a single frame.
 */
export function platformHeightAt(
  platforms: Platform[],
  x: number,
  z: number,
  feetY: number,
  prevFeetY: number,
  velY: number,
  stepUp = MAX_STEP_UP,
  eps = 0.01,
): number {
  let best = -Infinity;
  for (const p of platforms) {
    const top = platformSurfaceAt(p, x, z);
    if (top === -Infinity) continue;
    const reachableFromHere = top <= feetY + stepUp;
    const crossedWhileFalling = velY <= 0 && top <= prevFeetY + eps && top >= feetY;
    if (!reachableFromHere && !crossedWhileFalling) continue;
    if (top > best) best = top;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Placement rules
// ---------------------------------------------------------------------------

/** Validate a placement; returns null when allowed, else a reason. */
export function validatePlacement(
  kind: BuildingKind,
  x: number,
  z: number,
  y: number,
  existing: BuildingData[],
  playerPos: { x: number; z: number },
  terrainHeightAt: (x: number, z: number) => number,
  seaLevel = 0,
  rot = 0,
): string | null {
  const groundY = terrainHeightAt(x, z);
  const supportY = supportHeightAt(kind, x, z, existing, terrainHeightAt, rot);
  // A structure must stand on the ground or on what is already in its cell —
  // never on nothing.
  if (Math.abs(y - groundY) > 1.2 && Math.abs(y - supportY) > 0.6) {
    return 'not on a valid platform';
  }
  if (groundY < seaLevel - 0.3 && kind !== 'floor') return 'cannot build underwater';
  if (
    kind === 'roof' &&
    !existing.some((b) => isWallLike(b.kind) && touchesCell(b, x, z))
  ) {
    return 'roof needs a wall below it';
  }
  // One structure per kind per level: two walls on the same edge at the same
  // height are the same wall twice, a wall on top of a wall is a storey. On
  // the edge grid this extends across kinds: a wooden wall, a stone wall, a
  // door or a fence on ONE anchor all occupy the same metres of space, so
  // only one of them may stand there.
  for (const b of existing) {
    if (!sameCell(b.x, b.z, x, z)) continue;
    const clash = b.kind === kind || (isEdgeKind(kind) && isEdgeKind(b.kind));
    if (clash && Math.abs(b.y - y) < 0.8) return 'a building already occupies this spot';
  }
  // campfire must not be placed on top of the player.
  if (kind === 'campfire' && Math.hypot(playerPos.x - x, playerPos.z - z) < 1.2) {
    return 'too close to you';
  }
  return null;
}
