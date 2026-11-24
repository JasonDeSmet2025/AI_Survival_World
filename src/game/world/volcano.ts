/**
 * The VOLCANO — a live landmark built entirely into the height field
 * (no Babylon imports, same rule as world/caves.ts).
 *
 * The island is a 2.5D height field, so the volcano is not a prop: it is a
 * smooth delta ADDED to `terrainHeight`. Four terms, all smoothsteps, each
 * existing because a test proved the geometry needed it:
 *
 *  - cone:      plateau-topped cone — a flat summit so the crater bowl
 *               actually holds its lava instead of letting it run off;
 *  - pedestal:  a smooth skirt that lifts the low natural ground around the
 *               site up to a dry bench (the site ring wobbles ~13 m, and
 *               lava needs walls that stand ABOVE the crater floor);
 *  - crater:    a bowl carved into the flat summit: the spiders' den floor;
 *  - trench:    one carved ravine from the flank into the bowl — the only
 *               way in. Its floor rides a spillway pin just above the lava
 *               surface, then descends the flank on its own steady ramp —
 *               so the crater drains nowhere and the ravine stays walkable
 *               from its mouth all the way to the bowl.
 *
 * On top: a glowing lava disc sunk into the bowl floor (a real scan picks
 * its level so its rim buries everywhere) and the witch-era strongboxes —
 * the world's only reliable gold, which is what makes the village haggling
 * (systems/negotiation.ts) worth learning. The island-wide "no cliffs"
 * contract (adjacent 1 m samples < 2.5 u apart) is verified by volcano.test.
 */
import { terrainHeight } from './heightfield';

/** Smoothstep 0..1 with clamped input (local copy: stays import-free). */
function ss(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

// ---------------------------------------------------------------------------
// The site
// ---------------------------------------------------------------------------

/**
 * Volcano centre (fixed world seed). Scanned offline for: dry ground,
 * >115 m from spawn, >55 m from the witch and >140 m from both carved
 * caves, so no two height-field features ever compound.
 */
export const VOLCANO_HOME = { x: -60, z: 100 };

/** Height added on top of the natural ground at the flat summit. */
export const CONE_H = 30;
/** Flat summit out to this radius, then the flank melts down by CONE_R. */
export const CONE_PLAT = 16;
/** Cone base radius (delta is exactly 0 beyond this). */
export const CONE_R = 58;

/**
 * Pedestal bench: the natural ground around the site dips to ~2 m in
 * places, which would leave the crater standing on a hillside lower than
 * its own floor — lava would pour off the low side. The pedestal smooths
 * the skirt up to a dry bench height, gently enough (fade over 30 m) to
 * stay far inside the no-cliffs budget.
 */
export const PAD_H = 15;

/** Rise of the pedestal at (x, z): only ever lifts ground that is too low.
 *  Ends at d=65 — well before the marshy shoreline bands, whose flora sink
 *  budget is already maxed out (grounding.test.ts). */
function pedestalRise(x: number, z: number, naturalH: number): number {
  const d = Math.hypot(x - VOLCANO_HOME.x, z - VOLCANO_HOME.z);
  const mask = 1 - ss((d - 40) / 25);
  if (mask <= 0) return 0;
  return Math.max(0, PAD_H - naturalH) * mask;
}

/**
 * Natural (pre-volcano) terrain height at the centre, scan-measured. Only
 * documentation and lore strings use it — everything structural is either
 * relative or verified against the real terrain by volcano.test.ts.
 */
export const BASE_H = 15.9;

/** Rise of the cone at (x, z). Exactly 0 outside CONE_R. */
export function volcanoCone(x: number, z: number): number {
  const d = Math.hypot(x - VOLCANO_HOME.x, z - VOLCANO_HOME.z);
  if (d >= CONE_R) return 0;
  return CONE_H * (1 - ss((d - CONE_PLAT) / (CONE_R - CONE_PLAT)));
}

// ---------------------------------------------------------------------------
// The crater bowl — the den floor
// ---------------------------------------------------------------------------

/** Bowl depth carved into the flat summit, and its geometry. */
export const BOWL_D = 8;
/** Full depth (the den floor) inside this radius... */
export const BOWL_R = 14;
/** ...ramping to zero at the rim over this band (the inner crater wall).
 *  11 m wide: steep enough to read as a crater wall, soft enough that the
 *  terrain LOD chord sag (terrainLod.test.ts budget) stays under 4 u. */
export const BOWL_RAMP = 11;

/** Carve depth of the crater bowl (caves.ts profile family). */
function craterCarve(x: number, z: number): number {
  const d = Math.hypot(x - VOLCANO_HOME.x, z - VOLCANO_HOME.z);
  return BOWL_D * (1 - ss((d - BOWL_R) / BOWL_RAMP));
}

/** Nominal mean height of the bowl floor (natural wobble rides along). */
export const BOWL_FLOOR = BASE_H + CONE_H - BOWL_D; // ≈ 37.9

/** Base height of the raised crater ridge (a ring bump, not a plateau). */
const RIM_H = 7;

/**
 * Rise of the crater ridge: a ring bump around the bowl, fading out over a
 * WIDE outer band so the flank slope it adds stays inside the cliff budget.
 * With the pedestal bench underneath, no extra local lift is needed: every
 * direction now walls in above the lava surface (volcano.test.ts verifies).
 */
function rimRise(x: number, z: number): number {
  const d = Math.hypot(x - VOLCANO_HOME.x, z - VOLCANO_HOME.z);
  return RIM_H * ss((d - 15) / 18) * (1 - ss((d - 24) / 30));
}

// ---------------------------------------------------------------------------
// The trench — the only way in
// ---------------------------------------------------------------------------

/**
 * Trench direction: down the flank toward the island interior, so the
 * ravine mouth (where the carve fades out at the surface) sits well away
 * from the witch's clearing and the base-camp approach paths.
 */
export const TRENCH_DIR = { x: -0.365, z: 0.931 };
/** Trench length from the bowl edge outward, and its width. */
export const TRENCH_LEN = 58;
export const TRENCH_W = 7;

/** Ravine floor profile: pinned at the spillway, then a steady walk-down
 * that bottoms out on the pedestal bench — the MOUTH is where the profile
 * meets the flank, so the ravine ends there instead of cutting the plain. */
function trenchFloorTarget(along: number): number {
  const spill = BOWL_FLOOR - 0.6;
  const start = 34; // where the flank has dropped enough to let the floor out
  const terminal = PAD_H + 1.5; // never carve the corridor below the bench
  return Math.max(terminal, spill - 0.85 * (along - start) * ss((along - start) / 6));
}

/**
 * Carve of the trench ravine inside volcanoDelta: the corridor floor is
 * `trenchFloorTarget` wherever the surface stands above it (the carve is
 * exactly the gap), and simply does not exist where it doesn't — so the
 * mouth blends into the flank with zero step and no buried pipe is ever
 * possible. Across the corridor the carve fades over ~8 m: ramped walls.
 */
function trenchMask(x: number, z: number): { along: number; cross: number; target: number } | null {
  const dx = x - VOLCANO_HOME.x;
  const dz = z - VOLCANO_HOME.z;
  const along = dx * TRENCH_DIR.x + dz * TRENCH_DIR.z;
  if (along < BOWL_R - 3 || along > BOWL_R + TRENCH_LEN + 8) return null;
  const perp = Math.hypot(dx - TRENCH_DIR.x * along, dz - TRENCH_DIR.z * along);
  const cross = 1 - ss((perp - TRENCH_W * 0.4) / (TRENCH_W * 1.7));
  if (cross <= 0) return null;
  return { along, cross, target: trenchFloorTarget(along) };
}
/**
 * The volcano's signed contribution to `terrainHeight`. `naturalH` is the
 * untouched height at this point (heightfield.ts passes it): the pedestal
 * needs it to know how much bench to build under the cone.
 */
export function volcanoDelta(x: number, z: number, naturalH: number): number {
  const d = Math.hypot(x - VOLCANO_HOME.x, z - VOLCANO_HOME.z);
  if (d >= CONE_R + 40) return 0;
  const pad = pedestalRise(x, z, naturalH);
  const cone = volcanoCone(x, z);
  const rim = rimRise(x, z);
  const surface = naturalH + pad + cone + rim; // summit before any carving
  let carve = craterCarve(x, z);
  const trench = trenchMask(x, z);
  if (trench) {
    // The corridor exists only where the surface actually stands above the
    // ravine floor profile: the carve is exactly that gap, so the floor is
    // the profile (never deeper — the crater can never drain below the
    // spillway pin), the MOUTH is where surface meets profile (zero step,
    // no buried pipe), and sideways it fades into ramped walls.
    const gap = surface - trench.target;
    if (gap > 0) carve = Math.max(carve, gap * trench.cross);
  }
  return pad + cone + rim - carve;
}

// ---------------------------------------------------------------------------
// Lava
// ---------------------------------------------------------------------------

/**
 * The lava lake: a glowing disc SUNK into the bowl floor. Its height comes
 * from a one-time scan of the real floor (like tower.ts scans its site), so
 * the disc's rim is buried under terrain at every angle — no floating edge,
 * no seam. game.ts dresses it (emissive disc + light + shimmer) and burns
 * anyone standing inside `hazardR`.
 */
export interface LavaLake {
  x: number;
  z: number;
  y: number;
  /** Radius of the glowing disc. */
  r: number;
  /** Standing within this radius (on the bowl floor) burns. */
  hazardR: number;
}

let lakeCache: LavaLake | null = null;

/** Scan-measured lava lake (computed once, on first use). */
export function volcanoLake(): LavaLake {
  if (lakeCache) return lakeCache;
  const r = 9;
  let floorMin = Infinity;
  for (let a = 0; a < 48; a++) {
    const ang = (a / 48) * Math.PI * 2;
    for (const rr of [r - 1.5, r]) {
      floorMin = Math.min(
        floorMin,
        terrainHeight(VOLCANO_HOME.x + Math.cos(ang) * rr, VOLCANO_HOME.z + Math.sin(ang) * rr),
      );
    }
  }
  lakeCache = {
    x: VOLCANO_HOME.x,
    z: VOLCANO_HOME.z,
    y: floorMin - 0.35, // sunk: the disc rim buries under the floor everywhere
    r,
    hazardR: r - 0.8,
  };
  return lakeCache;
}

/**
 * True when (x, z) is inside the lava lake. The crater floor is the only
 * ground at those coordinates (the pinned trench never passes under the
 * lake), so no height check is needed.
 */
export function inCraterLava(x: number, z: number): boolean {
  const lake = volcanoLake();
  return Math.hypot(x - lake.x, z - lake.z) <= lake.hazardR;
}

// ---------------------------------------------------------------------------
// Den roster (spiders + chests)
// ---------------------------------------------------------------------------

/** A spider's lair: where it lives and how far it roams. */
export interface SpiderLair {
  id: string;
  x: number;
  z: number;
  /** Roam radius around the lair (metres). */
  leash: number;
}

/** Magma vent glowing in the bowl floor, tucked beside the lake. */
export const VENT = { x: VOLCANO_HOME.x + 11.2, z: VOLCANO_HOME.z - 4.5, r: 1.6 };

/**
 * Five spiders guard the hoard: three ring the lake, two lie in the trench.
 * All lairs sit on the bowl floor or inside the trench corridor, off the
 * vent and off the chest pads — enforced by volcano.test.ts.
 */
export function volcanoSpiders(): SpiderLair[] {
  const lair = (id: string, x: number, z: number, leash: number): SpiderLair => ({ id, x, z, leash });
  return [
    // Bowl floor ring, opposite the vent.
    lair('sp_v_1', VOLCANO_HOME.x - 11.0, VOLCANO_HOME.z + 6.5, 3.4),
    lair('sp_v_2', VOLCANO_HOME.x + 3.5, VOLCANO_HOME.z + 11.8, 3.4),
    lair('sp_v_3', VOLCANO_HOME.x + 12.4, VOLCANO_HOME.z + 3.0, 3.0),
    // Trench ambushers (metres from the centre along TRENCH_DIR).
    lair('sp_v_4', VOLCANO_HOME.x + TRENCH_DIR.x * 24, VOLCANO_HOME.z + TRENCH_DIR.z * 24, 3.2),
    lair('sp_v_5', VOLCANO_HOME.x + TRENCH_DIR.x * 42, VOLCANO_HOME.z + TRENCH_DIR.z * 42, 3.2),
  ];
}

/** A loot chest in the den (tiers: see systems/chests.ts). */
export interface VolcanoChest {
  id: string;
  label: string;
  x: number;
  z: number;
  tier: 'small' | 'great';
  /** Which way the lid faces (radians). */
  yaw: number;
}

/**
 * The witch-era hoard on the bowl floor: two smaller strongboxes tucked at
 * the wall, the GREAT chest behind the lava lake — you must cross (or skirt)
 * the lake and beat the ring to reach it.
 */
export function volcanoChests(): VolcanoChest[] {
  const yaw = Math.atan2(TRENCH_DIR.x, TRENCH_DIR.z) + Math.PI;
  return [
    {
      id: 'chest_v_1',
      label: 'Kist',
      x: VOLCANO_HOME.x - 11.6,
      z: VOLCANO_HOME.z - 6.4,
      tier: 'small',
      yaw,
    },
    {
      id: 'chest_v_2',
      label: 'Kist',
      x: VOLCANO_HOME.x + 8.2,
      z: VOLCANO_HOME.z + 11.4,
      tier: 'small',
      yaw,
    },
    {
      id: 'chest_v_top',
      label: 'Grote kist',
      x: VOLCANO_HOME.x - 3.5,
      z: VOLCANO_HOME.z - 11.6,
      tier: 'great',
      yaw,
    },
  ];
}

/** Flora keep-outs: a bare cone, and clear ground along the ravine. */
export function volcanoKeepOut(): Array<{ x: number; z: number; r: number }> {
  return [
    // The cone itself stays barren rock (the silhouette reads from far off).
    { x: VOLCANO_HOME.x, z: VOLCANO_HOME.z, r: CONE_R + 16 },
    // The trench corridor (nothing may dangle trees over the ravine).
    {
      x: VOLCANO_HOME.x + TRENCH_DIR.x * (BOWL_R + TRENCH_LEN * 0.6),
      z: VOLCANO_HOME.z + TRENCH_DIR.z * (BOWL_R + TRENCH_LEN * 0.6),
      r: TRENCH_W + 26,
    },
  ];
}

/** True when a point is close enough that volcano logic should even run. */
export function volcanoIsNear(x: number, z: number, r = 80): boolean {
  return Math.hypot(x - VOLCANO_HOME.x, z - VOLCANO_HOME.z) <= r;
}

export const VOLCANO_NAME = 'De Vulkaan';
