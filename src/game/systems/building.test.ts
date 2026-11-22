import { describe, expect, it } from 'vitest';
import {
  BUILDING_MODULE,
  BUILDING_SIZE,
  FLOOR_SURFACE_OFFSET,
  HEIGHT_GRID,
  ROOF_PITCH,
  ROOF_RIDGE_OFFSET,
  WALL_HEIGHT,
  buildingPlatforms,
  buildingPlacementHeight,
  isEdgeKind,
  isWallLike,
  migrateWallGrid,
  platformHeightAt,
  platformSurfaceAt,
  placementBaseY,
  sameCell,
  snapHeightToGrid,
  snapToCell,
  snapToGrid,
  snapToWallEdge,
  supportHeightAt,
  touchesCell,
  validatePlacement,
  wallFootprintCells,
  wallSegment,
  type BuildingData,
  type BuildingKind,
} from './building';

const flatGround = (_x: number, _z: number) => 2.0;
const SEA = 0;

function building(over: Partial<BuildingData> = {}): BuildingData {
  return {
    id: 'b_test_1',
    kind: 'campfire',
    x: 0,
    z: 0,
    y: 2.0,
    rot: 0,
    ownerId: 'test',
    ...over,
  };
}

describe('bed placement validation', () => {
  it('accepts a bed on valid ground', () => {
    const err = validatePlacement(
      'bed', 5, 5, 2.0, [], { x: 8, z: 8 }, flatGround, SEA,
    );
    expect(err).toBeNull();
  });

  describe('terrain-aware wall and floor placement', () => {
    const slopedGround = (x: number, z: number) => 2 + x * 0.35 + z * 0.12;

    it('raises floors above the highest sampled point in their footprint', () => {
      const y = buildingPlacementHeight('floor', 10, 4, 0, slopedGround);
      expect(y).toBeGreaterThan(slopedGround(10.92, 4.92));
      expect(y).toBeCloseTo(slopedGround(10.92, 4.92) + 0.08, 6);
    });

    it('supports walls along their rotated footprint rather than only at the centre', () => {
      const y = buildingPlacementHeight('wall', 10, 4, 1, slopedGround);
      // A wall is one grid cell long, so it samples 0.92 m either way of its
      // centre (rotated: along z) and 0.12 m across it.
      expect(y).toBeGreaterThan(slopedGround(10 + 0.12, 4 + 0.92));
      expect(y).toBeCloseTo(slopedGround(10 + 0.12, 4 + 0.92) + 0.08, 6);
    });

    it('validates a raised floor against its centre ground instead of its raised base', () => {
      const centerY = slopedGround(10, 4);
      const baseY = buildingPlacementHeight('floor', 10, 4, 0, slopedGround);
      expect(baseY - centerY).toBeGreaterThan(0.5);
      expect(validatePlacement('floor', 10, 4, centerY, [], { x: 0, z: 0 }, slopedGround, SEA))
        .toBeNull();
    });

    it('keeps campfires and other small structures at the centre ground height', () => {
      expect(buildingPlacementHeight('campfire', 10, 4, 0, slopedGround))
        .toBe(slopedGround(10, 4));
    });
  });

  it('rejects a bed underwater', () => {
    const err = validatePlacement(
      'bed', 5, 5, -2.0, [], { x: 8, z: 8 }, (_x, _z) => -2.0, SEA,
    );
    expect(err).toBe('cannot build underwater');
  });

  it('rejects a bed where another bed occupies the same spot', () => {
    const existing = [building({ id: 'b_other', kind: 'bed', x: 5, z: 5 })];
    const err = validatePlacement(
      'bed', 5, 5, 2.0, existing, { x: 8, z: 8 }, flatGround, SEA,
    );
    expect(err).toBe('a building already occupies this spot');
  });

  it('allows a bed in a cell shared by a different building kind (current cell rules)', () => {
    // The placement rules only block same-kind overlaps (and floor/roof
    // combos), so a bed may share a cell with a wall — beds lean on walls.
    const existing = [building({ id: 'b_other', kind: 'wall', x: 5, z: 5 })];
    const err = validatePlacement(
      'bed', 5, 5, 2.0, existing, { x: 8, z: 8 }, flatGround, SEA,
    );
    expect(err).toBeNull();
  });

  it('rejects a bed placed too far off the ground (floating)', () => {
    const err = validatePlacement(
      'bed', 5, 5, 10.0, [], { x: 8, z: 8 }, flatGround, SEA,
    );
    expect(err).toBe('not on a valid platform');
  });

  it('has a registered building size', () => {
    expect(BUILDING_SIZE.bed).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Construction grid, stacking and physical (walkable) structures
// ---------------------------------------------------------------------------

const levelGround = (_x = 0, _z = 0) => 0;

function placed(
  kind: BuildingKind,
  x: number,
  z: number,
  y = 0,
  rot = 0,
): BuildingData {
  return { id: `b_${kind}_${x}_${z}_${y}_${rot}`, kind, x, z, y, rot, ownerId: 'tester' };
}

describe('construction grid', () => {
  it('snaps a free-float point to the centre of its cell', () => {
    expect(snapToGrid(0)).toBe(0);
    expect(snapToGrid(1.2)).toBe(BUILDING_MODULE);
    expect(snapToGrid(0.4)).toBe(0);
    expect(snapToGrid(-1.9)).toBe(-BUILDING_MODULE);
    expect(snapToGrid(Number.NaN)).toBe(0);
    expect(snapToCell(3.1, 0.9)).toEqual({ x: 4, z: 0 });
  });

  it('gives wall, floor and roof the same one-cell footprint so they line up', () => {
    expect(BUILDING_SIZE.wall).toBe(BUILDING_MODULE);
    expect(BUILDING_SIZE.floor).toBe(BUILDING_MODULE);
    expect(BUILDING_SIZE.roof).toBe(BUILDING_MODULE);
  });

  it('butts two neighbouring walls together with no seam and no overlap', () => {
    // Walls live on the edge grid: two collinear walls sit at (0,1) and (2,1),
    // both running along +x, and butt together at x = 1.
    const a = wallSegment(placed('wall', 0, 1, 0, 0));
    const b = wallSegment(placed('wall', BUILDING_MODULE, 1, 0, 0));
    expect(a.maxX).toBeCloseTo(b.minX, 9);
    expect(b.minX - a.maxX).toBeCloseTo(0, 9);
    // A rotated wall keeps the same footprint (the cell is square).
    const c = wallSegment(placed('wall', 1, 0, 0, 1));
    expect(c.maxZ - c.minZ).toBeCloseTo(a.maxX - a.minX, 9);
  });

  it('reports sameCell for neighbours in one cell only', () => {
    expect(sameCell(0, 0, 0.4, -0.3)).toBe(true);
    expect(sameCell(0, 0, BUILDING_MODULE, 0)).toBe(false);
  });

  it('snaps walls to the cell EDGES, not the floor centre', () => {
    // Aiming just inside the north edge of cell (0,0) must anchor the wall on
    // the border line (z = 1), NOT in the middle of the floor at (0, 0).
    expect(snapToWallEdge(0.4, 0.9)).toEqual({ x: 0, z: 1, rot: 0 });
    expect(snapToWallEdge(2.4, 2.9)).toEqual({ x: 2, z: 3, rot: 0 });
    expect(snapToWallEdge(1.2, 0.2)).toEqual({ x: 1, z: 0, rot: 1 });
    // The wall anchor is never a floor cell centre.
    const a = snapToWallEdge(0.4, 0.9);
    expect(sameCell(a.x, a.z, 0, 0)).toBe(false);
  });

  it('a wall anchor borders exactly the two floor cells on its sides', () => {
    const cells = wallFootprintCells({ x: 0, z: 1, rot: 0 });
    expect(cells).toEqual([
      { x: 0, z: 0 },
      { x: 0, z: 2 },
    ]);
    const wall = placed('wall', 1, 0, 0, 1);
    expect(touchesCell(wall, 0, 0)).toBe(true);
    expect(touchesCell(wall, 2, 0)).toBe(true);
    expect(touchesCell(wall, 1, 1)).toBe(false);
  });

  it('puts EVERY wall kind on the same edge grid (stone included)', () => {
    // The owner's complaint: "de grid van stenen muren komt niet overeen met
    // hout en floor". Stone walls used to be missing from isEdgeKind, so they
    // were placed on the FLOOR grid — half a module out of line with the
    // wooden wall next to them. Everything isWallLike must be edge-placed.
    for (const kind of ['wall', 'stone_wall', 'door', 'fence'] as BuildingKind[]) {
      expect(isEdgeKind(kind), kind).toBe(true);
    }
    for (const kind of ['wall', 'stone_wall', 'door'] as BuildingKind[]) {
      expect(isEdgeKind(kind), `${kind} is wall-like but not edge-placed`).toBe(
        isWallLike(kind),
      );
    }
    // The things that DO live on the floor grid must stay there.
    for (const kind of ['floor', 'roof', 'bed', 'campfire', 'carpet', 'stairs'] as BuildingKind[]) {
      expect(isEdgeKind(kind), kind).toBe(false);
    }
  });

  it('anchors a stone wall exactly where a wooden wall would stand', () => {
    // Same aim point, same anchor, same rot: the two wall kinds are
    // interchangeable links of ONE line.
    const aims: [number, number][] = [
      [0.4, 0.9],
      [1.2, 0.2],
      [-2.6, 3.4],
      [5.9, -5.1],
      [0, 0],
    ];
    for (const [x, z] of aims) {
      const edge = snapToWallEdge(x, z);
      const floor = snapToCell(x, z);
      // An edge anchor is always half a module off the floor grid: one
      // coordinate on a multiple of the module, the other halfway between.
      const onLine = (v: number) => Math.abs(v / BUILDING_MODULE - Math.round(v / BUILDING_MODULE)) < 1e-9;
      const halfway = (v: number) =>
        Math.abs(v / BUILDING_MODULE - 0.5 - Math.round(v / BUILDING_MODULE - 0.5)) < 1e-9;
      expect(onLine(edge.x) && halfway(edge.z) || halfway(edge.x) && onLine(edge.z)).toBe(true);
      // And the anchor is a border line, never a floor cell centre — which is
      // precisely what made stone walls look off-grid on a wooden floor.
      expect(sameCell(edge.x, edge.z, floor.x, floor.z)).toBe(false);
    }
  });

  it('lets a stone wall butt against a wooden wall with no seam', () => {
    // Collinear: wooden wall at (0,1), stone wall at (2,1), both along +x.
    const wood = wallSegment(placed('wall', 0, 1, 0, 0));
    const stone = wallSegment(placed('stone_wall', BUILDING_MODULE, 1, 0, 0));
    expect(stone.minX - wood.maxX).toBeCloseTo(0, 9);
    expect(stone.minZ).toBeCloseTo(wood.minZ, 9);
    expect(stone.maxZ).toBeCloseTo(wood.maxZ, 9);
    // And a door continues the same line without a step.
    const door = wallSegment(placed('door', BUILDING_MODULE * 2, 1, 0, 0));
    expect(door.minX - stone.maxX).toBeCloseTo(0, 9);
  });

  it('refuses two different wall kinds on one anchor', () => {
    // Wood + stone on the SAME edge would fight over the same metres of space;
    // the anchor clash is now caught across kinds, not just within one.
    const y = flatGround(0, 0);
    const wall = placed('wall', 0, 1, y, 0);
    expect(
      validatePlacement('stone_wall', 0, 1, y, [wall], { x: 5, z: 5 }, flatGround, SEA, 0),
    ).toBe('a building already occupies this spot');
    // The next anchor down the same line is free and must stay allowed.
    expect(
      validatePlacement(
        'stone_wall', BUILDING_MODULE, 1, y, [wall], { x: 5, z: 5 }, flatGround, SEA, 0,
      ),
    ).toBeNull();
    // A floor may still share its cell with a wall — different grid, no clash.
    expect(
      validatePlacement('floor', 0, 0, y, [wall], { x: 5, z: 5 }, flatGround, SEA, 0),
    ).toBeNull();
  });
});

describe('migrating old stone walls onto the edge grid', () => {
  it('moves a centre-placed stone wall onto the nearest border line', () => {
    // What an old save looks like: the wall sits in the middle of the deck.
    const b = placed('stone_wall', 0, 0, 0, 0);
    expect(migrateWallGrid([b])).toBe(1);
    expect({ x: b.x, z: b.z, rot: b.rot }).toEqual(snapToWallEdge(0, 0));
    expect(isEdgeKind(b.kind)).toBe(true);
    // It never moved further than half a module sideways.
    expect(Math.hypot(b.x - 0, b.z - 0)).toBeLessThanOrEqual(BUILDING_MODULE / 2 + 1e-9);
  });

  it('is idempotent and leaves everything else alone', () => {
    const bench = placed('workbench', 2, 2, 0, 0);
    const floor = placed('floor', 0, 2, 0, 0);
    const wood = placed('wall', 0, 1, 0, 0);
    const stone = placed('stone_wall', 0, 3, 0, 0); // already an edge anchor
    const list = [bench, floor, wood, stone];
    const before = list.map((b) => ({ x: b.x, z: b.z, rot: b.rot }));
    expect(migrateWallGrid(list)).toBe(0);
    expect(list.map((b) => ({ x: b.x, z: b.z, rot: b.rot }))).toEqual(before);
    // Running it twice cannot drift the world (a load happens every session).
    expect(migrateWallGrid(list)).toBe(0);
  });

  it('lands a migrated wall on the deck it now borders', () => {
    const deck = placed('floor', 0, 0, 0, 0);
    const stone = placed('stone_wall', 0, 0, 0, 0); // saved in the deck's middle
    migrateWallGrid([deck, stone]);
    // After the move it borders cells (0,0) and (0,2), so the deck carries it.
    expect(touchesCell(stone, 0, 0)).toBe(true);
    expect(supportHeightAt('stone_wall', stone.x, stone.z, [deck], levelGround, stone.rot))
      .toBeCloseTo(FLOOR_SURFACE_OFFSET, 9);
  });
});

describe('shared height grid', () => {
  it('HEIGHT_GRID is walkable and divides a full storey', () => {
    expect(HEIGHT_GRID).toBeLessThan(0.43); // MAX_STEP_UP slack
    expect(WALL_HEIGHT / HEIGHT_GRID).toBeCloseTo(Math.round(WALL_HEIGHT / HEIGHT_GRID), 9);
  });

  it('snaps ground bases onto common elevations instead of terrain noise', () => {
    // buildingPlacementHeight lands ~0.08 above the highest terrain sample;
    // that sinks back to the grid level (flush) rather than floating.
    expect(snapHeightToGrid(0.08)).toBe(0);
    expect(snapHeightToGrid(2.08)).toBe(2.1);
    // Just above a grid level: sink tolerance keeps it flush instead of a
    // visible floating gap, so two nearby floors agree on their height.
    expect(snapHeightToGrid(2.13)).toBe(2.1);
    expect(snapHeightToGrid(2.2)).toBe(2.4);
  });

  it('lifts a placement by the player build level in grid steps', () => {
    expect(snapHeightToGrid(0.08, 1)).toBeCloseTo(HEIGHT_GRID, 9);
    expect(snapHeightToGrid(0.08, 2)).toBeCloseTo(2 * HEIGHT_GRID, 9);
  });

  it('two floors on slightly different ground end up at the SAME height', () => {
    const baseA = placementBaseY('floor', 0, 0, 0, [], () => 2.0);
    const baseB = placementBaseY('floor', 2, 0, 0, [], () => 2.05);
    expect(baseB).toBe(baseA);
  });

  it('stacking keeps the exact support height, never re-snapped', () => {
    const deck = placed('floor', 0, 0, snapHeightToGrid(0.08));
    // A wall on the deck edge stands exactly on the plank top.
    const y = placementBaseY('wall', 0, 1, 0, [deck], () => 0);
    expect(y).toBeCloseTo(snapHeightToGrid(0.08) + FLOOR_SURFACE_OFFSET, 9);
  });
});

describe('stacking structures (support heights)', () => {
  const floor = placed('floor', 0, 0, 0);
  // The wall stands on the edge between the floor's cell and its neighbour.
  const wall = placed('wall', 0, 1, 0, 0);

  it('stands a wall on the deck of the floor whose edge it borders', () => {
    expect(supportHeightAt('wall', 0, 1, [floor], levelGround, 0)).toBeCloseTo(FLOOR_SURFACE_OFFSET, 9);
    expect(placementBaseY('wall', 0, 1, 0, [floor], levelGround)).toBeCloseTo(FLOOR_SURFACE_OFFSET, 9);
    // A wall two cells away from any deck only has the terrain.
    expect(supportHeightAt('wall', 0, 5, [floor], levelGround, 0)).toBe(0);
  });

  it('puts a roof on top of the walls, never on bare ground or on a deck alone', () => {
    expect(supportHeightAt('roof', 0, 0, [wall], levelGround)).toBeCloseTo(WALL_HEIGHT, 9);
    expect(supportHeightAt('roof', 0, 0, [floor], levelGround)).toBeCloseTo(0, 9);
    // The wall tops of a taller neighbour win, so a roof never buries itself.
    const high = placed('wall', 0, 1, 4, 0);
    expect(supportHeightAt('roof', 0, 0, [wall, high], levelGround)).toBeCloseTo(4 + WALL_HEIGHT, 9);
  });

  it('never stacks a deck directly on another deck — an upper storey needs walls', () => {
    const first = placed('floor', 0, 0, 0);
    // Only a deck below: no new support height, so it would land on the old one.
    expect(supportHeightAt('floor', 0, 0, [first], levelGround)).toBe(0);
    expect(
      validatePlacement('floor', 0, 0, placementBaseY('floor', 0, 0, 0, [first], levelGround), [first], { x: 5, z: 5 }, levelGround),
    ).toBe('a building already occupies this spot');
    // The bordering walls lift the deck a full storey, and that is accepted.
    const deckY = supportHeightAt('floor', 0, 0, [wall], levelGround);
    expect(deckY).toBeCloseTo(WALL_HEIGHT, 9);
    expect(
      validatePlacement('floor', 0, 0, deckY, [wall], { x: 5, z: 5 }, levelGround),
    ).toBeNull();
  });

  it('lets a deck lie on top of walls (upper storey) and a bed on a deck', () => {
    expect(supportHeightAt('floor', 0, 0, [wall], levelGround)).toBeCloseTo(WALL_HEIGHT, 9);
    expect(supportHeightAt('bed', 0, 0, [floor], levelGround)).toBeCloseTo(FLOOR_SURFACE_OFFSET, 9);
    // A bed is not a support: nothing stacks on it.
    expect(supportHeightAt('wall', 0, 1, [placed('bed', 0, 0)], levelGround, 0)).toBe(0);
  });

  it('keeps terrain shape in charge where nothing supports (sloped ground)', () => {
    const sloped = (x: number) => x * 0.4;
    // Floor base follows the highest sampled point, not the flat centre.
    expect(placementBaseY('floor', 4, 0, 0, [], sloped)).toBeGreaterThan(sloped(4));
  });
});

describe('placement rules with stacking', () => {
  const floor = placed('floor', 0, 0, 0);
  const wall = placed('wall', 0, 1, 0, 0);

  it('accepts a wall standing on a floor', () => {
    const y = placementBaseY('wall', 0, 1, 0, [floor], levelGround);
    expect(validatePlacement('wall', 0, 1, y, [floor], { x: 5, z: 5 }, levelGround, SEA, 0)).toBeNull();
  });

  it('accepts an upper-storey floor even though it is far above the ground', () => {
    const y = placementBaseY('floor', 0, 0, 0, [wall], levelGround);
    expect(Math.abs(y - levelGround(0, 0))).toBeGreaterThan(1.2);
    expect(validatePlacement('floor', 0, 0, y, [wall], { x: 5, z: 5 }, levelGround)).toBeNull();
  });

  it('rejects a roof that has no wall bordering its cell, accepts one that has', () => {
    expect(validatePlacement('roof', 0, 0, levelGround(0, 0), [floor], { x: 5, z: 5 }, levelGround)).toBe(
      'roof needs a wall below it',
    );
    const y = placementBaseY('roof', 0, 0, 0, [wall, floor], levelGround);
    expect(validatePlacement('roof', 0, 0, y, [wall, floor], { x: 5, z: 5 }, levelGround)).toBeNull();
  });

  it('rejects the same wall twice on one edge but accepts it one storey higher', () => {
    expect(validatePlacement('wall', 0, 1, 0, [wall], { x: 5, z: 5 }, levelGround, SEA, 0)).toBe(
      'a building already occupies this spot',
    );
    const upper = placementBaseY('wall', 0, 1, 0, [wall], levelGround);
    expect(upper).toBeCloseTo(WALL_HEIGHT, 9);
    expect(validatePlacement('wall', 0, 1, upper, [wall], { x: 5, z: 5 }, levelGround, SEA, 0)).toBeNull();
  });

  it('still rejects something floating in mid air', () => {
    expect(validatePlacement('wall', 0, 1, 12, [], { x: 5, z: 5 }, levelGround, SEA, 0)).toBe(
      'not on a valid platform',
    );
  });

  it('accepts a placement lifted to the maximum build level', () => {
    // MAX_BUILD_LEVEL steps of HEIGHT_GRID stay within the floating tolerance.
    const y = placementBaseY('floor', 0, 0, 0, [], () => 2.0, 2);
    expect(validatePlacement('floor', 0, 0, y, [], { x: 5, z: 5 }, () => 2.0)).toBeNull();
  });
});

describe('physical building surfaces (walking on floors and roofs)', () => {
  it('turns a floor into one full-cell deck at the plank top', () => {
    const [p] = buildingPlatforms(placed('floor', 2, 0, 4));
    expect(p.minX).toBeCloseTo(1, 9);
    expect(p.maxX).toBeCloseTo(3, 9);
    expect(p.minZ).toBeCloseTo(-1, 9);
    expect(p.maxZ).toBeCloseTo(1, 9);
    expect(platformSurfaceAt(p, 2, 0)).toBeCloseTo(4 + FLOOR_SURFACE_OFFSET, 9);
    // Outside the deck there is nothing to stand on.
    expect(platformSurfaceAt(p, 3.1, 0)).toBe(-Infinity);
  });

  it('turns a roof into two pitched halves that match the mesh slope', () => {
    const halves = buildingPlatforms(placed('roof', 0, 0, WALL_HEIGHT));
    expect(halves).toHaveLength(2);
    const [north, south] = halves;
    expect(platformSurfaceAt(north, 0, 0)).toBeCloseTo(WALL_HEIGHT + ROOF_RIDGE_OFFSET, 6);
    // Down the pitch: one metre out, tan(pitch) lower.
    expect(platformSurfaceAt(south, 0, 1)).toBeCloseTo(
      WALL_HEIGHT + ROOF_RIDGE_OFFSET - Math.tan(ROOF_PITCH),
      6,
    );
    // A roof rotated a quarter turn slopes along x instead of z.
    const turned = buildingPlatforms(placed('roof', 0, 0, WALL_HEIGHT, 1));
    const east = turned.find((p) => p.maxX > 0)!;
    const west = turned.find((p) => p.maxX <= 0)!;
    expect(east).toBeDefined();
    expect(west).toBeDefined();
    expect(platformSurfaceAt(east, 1, 0)).toBeCloseTo(
      WALL_HEIGHT + ROOF_RIDGE_OFFSET - Math.tan(ROOF_PITCH),
      6,
    );
    expect(platformSurfaceAt(east, 0, 1)).toBeCloseTo(WALL_HEIGHT + ROOF_RIDGE_OFFSET, 6);
    expect(platformSurfaceAt(west, -1, 0)).toBeCloseTo(
      WALL_HEIGHT + ROOF_RIDGE_OFFSET - Math.tan(ROOF_PITCH),
      6,
    );
  });

  it('has no walkable surface on walls, campfires and beds', () => {
    expect(buildingPlatforms(placed('wall', 0, 0))).toEqual([]);
    expect(buildingPlatforms(placed('campfire', 0, 0))).toEqual([]);
    expect(buildingPlatforms(placed('bed', 0, 0))).toEqual([]);
  });

  it('lets the player step up onto a deck lip but not onto a deck above head height', () => {
    const deck = buildingPlatforms(placed('floor', 0, 0, 0));
    const upper = buildingPlatforms(placed('floor', 0, 0, WALL_HEIGHT));
    // 0.18 m lip: walkable.
    expect(platformHeightAt(deck, 0.2, 0, 0, 0, 0)).toBeCloseTo(FLOOR_SURFACE_OFFSET, 9);
    // Feet on the ground, deck two metres up: not climbable by walking.
    expect(platformHeightAt(upper, 0.2, 0, 0, 0, 0)).toBe(-Infinity);
  });

  it('catches a fast fall instead of tunneling through the deck', () => {
    const deck = buildingPlatforms(placed('floor', 0, 0, 4));
    const top = 4 + FLOOR_SURFACE_OFFSET;
    // One frame of a hard fall: the feet jumped from above the deck to below it.
    expect(platformHeightAt(deck, 0, 0, top - 0.4, top + 0.4, -20)).toBeCloseTo(top, 9);
    // Rising through it from well below (a jump) must NOT be caught.
    expect(platformHeightAt(deck, 0, 0, top - 2, top - 2.4, 8)).toBe(-Infinity);
  });
});
