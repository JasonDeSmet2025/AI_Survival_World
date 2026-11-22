/**
 * Cave system — pure height-field carvings (no Babylon imports).
 *
 * The terrain is a 2.5D height field, so a "cave" is built as a carved
 * ravine that leads down into a bowl chamber whose OPEN top is covered by a
 * rock ceiling slab (built in game.ts at scene level). Because the floor is
 * part of the height field itself, every existing consumer — the rendered
 * mesh, the mesh-exact ground sampler, ray marching, flora settling, NPC
 * pathing and building support — agrees on the cave geometry for free.
 *
 * Design constraints (guarded by caves.test.ts):
 *  - Every cave floor stays far above SEA_LEVEL (sites sit on mountain
 *    plateaus, so no cave can flood with the global water plane).
 *  - The surrounding rim must stay comfortably above the ceiling slab so
 *    the slab is buried under real terrain at its edge and invisible from
 *    outside — you can only enter through the carved trench.
 *  - Sites and trench headings are fixed constants (the world has one
 *    deterministic seed), which keeps `caveCarveDepth` import-free: it
 *    needs no access to `terrainHeight` itself.
 */

/** One carved cave: chamber centre, trench direction and dimensions. */
export interface CaveSite {
  id: string;
  /** Chamber centre. */
  cx: number;
  cz: number;
  /** Trench direction (unit vector) — points from the chamber to the surface entrance. */
  tx: number;
  tz: number;
  /** Carved depth of the chamber floor below the natural surface. */
  depth: number;
  /** Flat chamber radius (full-depth zone). */
  chamberR: number;
  /** Trench length from the chamber edge out to the surface. */
  trenchLen: number;
  /** Trench half-width. */
  trenchW: number;
  /** Height of the natural surface at the chamber centre (scan-measured). */
  surfaceH: number;
}

/** Smoothstep 0..1 with clamped input (local copy: caves.ts stays import-free). */
function ss(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/**
 * The two cave sites (fixed world seed). Centres were scanned offline for:
 * surface height >= 24 (so a 6.5 m floor drop still sits > 17 m above the
 * sea), a rim that stays within 4 m of the surface around 13 m, and a
 * distance of > 70 m from the NPC camp so the ravines do not litter the
 * starting area.
 */
export const CAVE_SITES: CaveSite[] = [
  {
    id: 'cave_nw',
    cx: -70,
    cz: -46,
    // Trench runs downhill toward the camp/spawn side so players naturally
    // find the entrance mouth on the camp-facing slope.
    tx: 0.226,
    tz: 0.974,
    // Steepness budget: every carve slope stays under ~1.2 u/u — the same
    // order as natural mountain ridges. Steeper profiles violate the
    // island-wide "no cliffs / bounded mesh deviation" contracts that the
    // grounding, groundSurface and terrainLod tests enforce for ALL
    // terrain, caves included (they are part of the height field).
    depth: 4,
    chamberR: 9,
    trenchLen: 15,
    trenchW: 7,
    surfaceH: 25.1,
  },
  {
    id: 'cave_s',
    cx: 95,
    cz: -70,
    tx: -0.763,
    tz: 0.643,
    depth: 4,
    chamberR: 9,
    trenchLen: 15,
    trenchW: 7,
    surfaceH: 24.9,
  },
];

/** Distance from the chamber centre inside which the floor is full-depth. */
function bowlCarve(s: CaveSite, d: number): number {
  // Full depth inside chamberR, ramping smoothly to 0 by 1.62 * chamberR.
  return s.depth * (1 - ss((d - s.chamberR) / (s.chamberR * 0.62)));
}

/** Distance from a line segment, returned as [along, perpendicular]. */
function segmentFrame(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  px: number,
  pz: number,
): [number, number] {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px;
  const qz = az + dz * t - pz;
  return [t * Math.sqrt(len2), Math.hypot(qx, qz)];
}

/** Carving contributed by one cave (chamber bowl + entrance trench). */
function siteCarve(s: CaveSite, x: number, z: number): number {
  const d = Math.hypot(x - s.cx, z - s.cz);
  // Cheap reject: nothing is carved beyond the bowl ramp or trench reach.
  const reach = s.chamberR * 1.62 + 2;
  if (d > reach + s.trenchLen) return 0;
  let carve = bowlCarve(s, d);

  // Trench: from just inside the chamber to `trenchLen` past its edge.
  const ax = s.cx + s.tx * s.chamberR * 0.4;
  const az = s.cz + s.tz * s.chamberR * 0.4;
  const bx = s.cx + s.tx * (s.chamberR + s.trenchLen);
  const bz = s.cz + s.tz * (s.chamberR + s.trenchLen);
  const segLen = Math.hypot(bx - ax, bz - az);
  const [along, perp] = segmentFrame(ax, az, bx, bz, x, z);
  const u = along / segLen; // 0 at chamber end, 1 at the surface mouth
  // Full depth over the inner half, then a walkable ramp out to the mouth.
  const alongProf = 1 - ss((u - 0.5) / 0.5);
  // Cross-section: full width in the middle, smooth banks.
  const crossProf = 1 - ss((perp - s.trenchW * 0.55) / (s.trenchW * 0.75));
  carve = Math.max(carve, s.depth * alongProf * crossProf);
  return carve;
}

/**
 * Total carve depth to subtract from the natural terrain height at (x, z).
 * 0 outside every cave footprint — the common case, and cheap to test.
 */
export function caveCarveDepth(x: number, z: number): number {
  let m = 0;
  for (const s of CAVE_SITES) {
    const c = siteCarve(s, x, z);
    if (c > m) m = c;
  }
  return m;
}

/**
 * Y of the chamber ceiling slab for a cave: the carved floor height at the
 * centre plus the interior headroom. The slab is a dark rock disc of
 * `ceilingRadius` — sized so its rim buries under the ramped bowl wall.
 */
export function caveCeiling(s: CaveSite): { y: number; radius: number } {
  return {
    y: s.surfaceH - s.depth + 3.0,
    // Sized so the whole rim lands where the bowl ramp has carved away
    // more than the 1.0 m of cover between slab top and natural surface
    // (guaranteed by caves.test.ts: at radius the carve is < D-3).
    radius: s.chamberR + 4.5,
  };
}

/** World-space centre of a cave chamber (for lights, decorations, spawns). */
export function caveFloorY(s: CaveSite): number {
  return s.surfaceH - s.depth;
}

/** Keep-out circles so flora never scatters trees/rocks into the caves. */
export function caveKeepOut(): Array<{ x: number; z: number; r: number }> {
  const out: Array<{ x: number; z: number; r: number }> = [];
  for (const s of CAVE_SITES) {
    out.push({ x: s.cx, z: s.cz, r: s.chamberR + 8 });
    out.push({
      x: s.cx + s.tx * (s.chamberR + s.trenchLen * 0.5),
      z: s.cz + s.tz * (s.chamberR + s.trenchLen * 0.5),
      r: s.trenchW + 5,
    });
  }
  return out;
}

/**
 * The witch's cottage plot (flat, dry, ~25 m from both spawn and the NPC
 * camp — scanned offline; the player stumbles over it early on purpose).
 */
export const WITCH_HOME = { x: -14, z: 66 };

/** Keep-out circle so no tree grows through the cottage. */
export function witchKeepOut(): { x: number; z: number; r: number } {
  return { x: WITCH_HOME.x, z: WITCH_HOME.z, r: 13 };
}
