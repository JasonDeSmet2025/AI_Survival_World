import {
  Color3,
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  VertexBuffer,
  VertexData,
} from '@babylonjs/core';
import type { ResourceNode, Collider } from './types';
import type { SharedWorldState } from './worldState';
import { clamp, fbm, hash2, mulberry32, smoothstep } from '../core/noise';
import {
  TERRAIN_SIZE,
  terrainHeight,
  terrainNormal,
  terrainSlope,
  SEA_LEVEL,
  WORLD_SEED,
  isNearLake,
} from './terrain';
import { groundSurfaceHeight, minSurfaceHeightInRadius } from './groundSurface';
import { COLOR_GRADE_GLSL, COLOR_GRADE_UNIFORMS, syncColorPipeline } from './colorPipeline';
import {
  SHADOW_FRAG_DECL,
  SHADOW_SAMPLE,
  SHADOW_UNIFORMS,
  SHADOW_VERT_DECL,
  SHADOW_VERT_MAIN,
  ShadowReceiver,
  shadowReceiveDefines,
} from '../visual/shadowReceiver';
import type { SharedMaterials } from '../visual/materials';

export interface FloraHandle {
  /** Apply depleted/damaged state to the visual instances. */
  applyState(): void;
  nodeCount: number;
  /**
   * Three-tier distance LOD: for every chunk that owns detail twins, pick
   * the mesh to render from the camera's XZ distance to the chunk centre:
   *  - dist < FLORA_LOD_HI  -> high detail,
   *  - dist < FLORA_LOD_MID -> mid detail,
   *  - dist > FLORA_LOD_FAR -> low detail,
   *  - [FLORA_LOD_MID, FLORA_LOD_FAR] -> previous state kept (hysteresis
   *    band ≈ several seconds of walking, so chunks never flicker).
   * Called once per frame by the game loop; allocation-free, O(chunks).
   */
  updateLod(cam: { x: number; z: number }): void;
  /**
   * Shadow-caster proximity culling: the currently-enabled LOD mesh of
   * every chunk whose centre is within FLORA_SHADOW_RADIUS of (px, pz).
   * The directional shadow frustum is only ~130 u around the camera, and
   * v9.33 has no bounding-box caster culling, so registering far chunks
   * wastes shadow-pass vertex work every frame. The game loop diffs this
   * list against the registered casters each frame (O(chunks)).
   */
  shadowCasters(px: number, pz: number): Mesh[];
  /**
   * All live per-chunk batch meshes: the high-detail mesh
   * (`flora_<kind>_c<cx>_<cz>`) plus its mid (`..._mid`) and low
   * (`..._lo`) twins where the kind has them. Exposed for QA/diagnostics;
   * shadow-caster registration uses shadowCasters() instead. The list is
   * rebuilt from the live chunk map on every call, so it always reflects
   * the current (possibly re-baked) meshes.
   */
  chunkMeshes(): Mesh[];
  /**
   * The single shared custom wind shader material of every chunk mesh.
   * The lighting system mirrors its sun/ambient uniforms each frame via
   * `Lighting.addShaderMaterial` (same values as the terrain shader).
   */
  material: ShaderMaterial;
  /**
   * Advances the wind clock and pushes the wind uniforms (time, drifting
   * direction) into the shared material. Call once per frame, next to
   * updateLod(). Negative or zero dt is ignored (paused game = still air).
   */
  updateWind(dt: number): void;
}

export interface Placement {
  x: number;
  z: number;
  y: number;
  kind: ResourceNode['kind'] | 'grass' | 'flower' | 'plant';
  /** Interaction radius for gatherable nodes, 0 for decorative. */
  radius: number;
  maxHp: number;
  scale: number;
  /** Prototype variant index for this kind. */
  variant: number;
  /** Yaw rotation in radians. */
  rotY: number;
  /**
   * Ground-settle depth in world units: how far the instance origin is sunk
   * below the raw terrain height so the object seats on the lowest local
   * ground within its footprint instead of floating or clipping on slopes.
   */
  sink: number;
}

/** Number of visual variants per flora kind. */
export const FLORA_VARIANTS: Record<string, number> = {
  tree: 3,
  pine: 3,
  rock: 4,
  bush: 2,
  grass: 2,
  flower: 3,
  plant: 2,
};

/**
 * Large-scale broadleaf forest coverage (0..1). High values = dense
 * forest, low values = open clearings. Deterministic per world seed.
 */
export function forestMask(x: number, z: number): number {
  return fbm(x * 0.0085 + 3.7, z * 0.0085 + 11.2, 3);
}

/**
 * Deterministic flora placement. Uses jittered grid passes driven by
 * seeded noise masks, which yields natural clusters, forest edges and
 * open clearings instead of uniform scattering.
 */
export function genPlacements(
  keepOut: Array<{ x: number; z: number; r: number }> = [],
): Placement[] {
  const out: Placement[] = [];
  const rng = mulberry32(WORLD_SEED >>> 0);

  const clear = (x: number, z: number, r: number): boolean =>
    keepOut.every((k) => Math.hypot(x - k.x, z - k.z) >= k.r + r);

  const place = (
    kind: Placement['kind'],
    cands: Array<{ x: number; z: number }>,
    o: {
      radius: number;
      maxHp: number;
      minH: number;
      maxH: number;
      maxSlope?: number;
      lakePad?: number;
      minScale: number;
      maxScale: number;
      variantPick?: (h: number, slope: number) => number;
      /** Horizontal ground-contact radius as a multiple of the scale. */
      footprint?: number;
      /** Base embed depth as a multiple of the scale (trunk roots etc.). */
      baseSink?: number;
      /** Maximum allowed ground-settle depth in world units. */
      sinkCap?: number;
    },
  ): void => {
    const variants = FLORA_VARIANTS[kind];
    for (const c of cands) {
      // Anchor on the RENDERED surface (the mesh the player sees), not the
      // analytic curve: on slopes the coarse triangle grid sits up to ~0.5u
      // off the curve, and analytic anchors made trunks float or clip.
      const y = groundSurfaceHeight(c.x, c.z);
      if (y < o.minH || y > o.maxH) continue;
      const slope = terrainSlope(c.x, c.z);
      if (o.maxSlope !== undefined && slope > o.maxSlope) continue;
      if (o.lakePad !== undefined && isNearLake(c.x, c.z, o.lakePad)) continue;
      if (!clear(c.x, c.z, o.radius)) continue;
      const variant = o.variantPick ? o.variantPick(y, slope) : Math.floor(rng() * variants);
      const scale = o.minScale + rng() * (o.maxScale - o.minScale);
      const rotY = rng() * Math.PI * 2;
      const sink =
        (o.baseSink ?? 0) * scale +
        settleDepth(c.x, c.z, (o.footprint ?? 0.2) * scale, o.sinkCap ?? 0.1);
      out.push({
        x: c.x,
        z: c.z,
        y,
        kind,
        radius: o.radius,
        maxHp: o.maxHp,
        scale,
        variant,
        rotY,
        sink,
      });
    }
  };

  // --- Broadleaf forest: large mask, dense interior, thin edges --------
  const treeCands = gridCandidates(6, 0x1a11, (x, z, h) => {
    if (h < 0.75 || h > 14) return 0;
    const m = forestMask(x, z);
    return smoothstep((m - 0.35) / 0.25);
  }, 3.0);
  place(
    'tree',
    treeCands,
    {
      radius: 2.0,
      maxHp: 3,
      minH: 0.75,
      maxH: 14,
      maxSlope: 1.0,
      lakePad: 5,
      minScale: 0.75,
      maxScale: 1.45,
      footprint: 0.35,
      baseSink: 0.1,
      sinkCap: 0.8,
      variantPick: (h) => (h > 9 ? 2 : Math.floor(rng() * 2)),
    },
  );
  // Second, tighter pass that thickens dense forest interiors.
  place(
    'tree',
    gridCandidates(5, 0x2b22, (x, z, h) => {
      if (h < 1.2 || h > 13.5) return 0;
      const m = forestMask(x, z);
      return m > 0.58 ? 0.35 : 0;
    }, 2.8, treeCands),
    {
      radius: 2.0,
      maxHp: 3,
      minH: 1.2,
      maxH: 13.5,
      maxSlope: 1.0,
      lakePad: 5,
      minScale: 0.75,
      maxScale: 1.45,
      footprint: 0.35,
      baseSink: 0.1,
      sinkCap: 0.8,
      variantPick: (h) => (h > 9 ? 2 : Math.floor(rng() * 2)),
    },
  );

  // --- Pines: higher, colder slopes with their own patch mask ----------
  place(
    'pine',
    gridCandidates(7, 0x77b2, (x, z, h) => {
      if (h < 4 || h > 27) return 0;
      const m = fbm(x * 0.011 + 23.4, z * 0.011 + 5.8, 3);
      const alt = smoothstep((h - 4) / 4);
      return m * alt * 1.15;
    }, 2.6),
    {
      radius: 2.0,
      maxHp: 3,
      minH: 4,
      maxH: 27,
      maxSlope: 1.3,
      lakePad: 5,
      minScale: 0.7,
      maxScale: 1.5,
      footprint: 0.3,
      baseSink: 0.1,
      sinkCap: 0.8,
      variantPick: (h) => (h > 18 ? 2 : h > 11 ? 1 : 0),
    },
  );

  // --- Rocks: exposed on steep/high ground, boulders in the lowlands ---
  place(
    'rock',
    gridCandidates(8, 0x0ce5, (x, z, h) => {
      if (h < 0.4 || h > 30) return 0;
      const m = fbm(x * 0.013 + 31.7, z * 0.013 + 17.3, 3);
      const s = terrainSlope(x, z);
      const steep = smoothstep((s - 0.55) / 0.6);
      const alt = smoothstep((h - 9) / 9);
      const low = (1 - smoothstep((h - 1) / 7)) * 0.55;
      return Math.min(0.5, m * 0.5 + steep * 0.45 + alt * 0.25 + low * 0.3) * 0.6;
    }, 2.2),
    {
      radius: 1.1,
      maxHp: 2,
      minH: 0.4,
      maxH: 30,
      minScale: 0.45,
      maxScale: 0.95,
      footprint: 0.55,
      baseSink: 0.05,
      sinkCap: 1.15,
      variantPick: (h, s) => {
        if (s > 0.9) return h > 8 ? 1 : 2; // angular on slopes
        if (h > 12) return 3; // slabs high up
        return 0; // lowland boulders
      },
    },
  );

  // --- Bushes: forest edges (density peaks where mask crosses 0.5) -----
  place(
    'bush',
    gridCandidates(6, 0xb055, (x, z, h) => {
      if (h < 0.6 || h > 15) return 0;
      const m = forestMask(x, z);
      return m * (1 - m) * 1.2;
    }, 1.7),
    {
      radius: 1.0,
      maxHp: 2,
      minH: 0.6,
      maxH: 15,
      maxSlope: 1.1,
      lakePad: 3,
      minScale: 0.7,
      maxScale: 1.3,
      footprint: 0.55,
      baseSink: 0.05,
      sinkCap: 0.75,
    },
  );

  // --- Grass: dense everywhere the ground is walkable ------------------
  place(
    'grass',
    gridCandidates(2.2, 0x05a1, (x, z, h) => {
      if (h < SEA_LEVEL + 0.35 || h > 18) return 0;
      if (terrainSlope(x, z) > 1.0) return 0;
      const m = forestMask(x, z);
      return 0.28 + 0.12 * (1 - m);
    }),
    {
      radius: 0,
      maxHp: 0,
      minH: SEA_LEVEL + 0.35,
      maxH: 18,
      maxSlope: 1.0,
      lakePad: 2.5,
      minScale: 0.7,
      maxScale: 1.5,
      footprint: 0.15,
      sinkCap: 0.3,
    },
  );

  // --- Flowers: a ring around the lake + lowland meadow patches --------
  place(
    'flower',
    gridCandidates(4, 0xf1c4, (x, z, h) => {
      if (h < SEA_LEVEL + 0.4 || h > 9) return 0;
      let p = 0;
      if (isNearLake(x, z, 8) && !isNearLake(x, z, -5)) p += 0.8;
      const patch = fbm(x * 0.021 + 9.9, z * 0.021 + 4.4, 3);
      if (h < 5 && patch > 0.45) p += (patch - 0.45) * 1.6;
      return Math.min(0.4, p);
    }),
    {
      radius: 0,
      maxHp: 0,
      minH: SEA_LEVEL + 0.4,
      maxH: 9,
      maxSlope: 0.6,
      minScale: 0.6,
      maxScale: 1.3,
      footprint: 0.12,
      sinkCap: 0.25,
      variantPick: () => Math.floor(rng() * 3),
    },
  );

  // --- Small plants / undergrowth under the forest canopy --------------
  place(
    'plant',
    gridCandidates(3, 0x13e5, (x, z, h) => {
      if (h < 0.5 || h > 14) return 0;
      return forestMask(x, z) * 0.42;
    }),
    {
      radius: 0,
      maxHp: 0,
      minH: 0.5,
      maxH: 14,
      maxSlope: 0.9,
      lakePad: 2.5,
      minScale: 0.7,
      maxScale: 1.4,
      footprint: 0.15,
      sinkCap: 0.3,
    },
  );

  return out;
}

/**
 * How far the ground rises above the anchor point within the object's
 * ground-contact circle. Sinking the instance by this amount seats its base
 * on the lowest local ground, so objects embed naturally on slopes instead
 * of floating on one side and clipping on the other. Capped so large
 * objects cannot disappear into steep ground.
 *
 * Measured on the RENDERED surface (groundSurface.ts): the settle target is
 * the visible ground, which is what prevents the "floating object" look on
 * slopes — the analytic curve can sit up to ~0.5–0.8u off the mesh.
 */
function settleDepth(x: number, z: number, footprint: number, cap: number): number {
  const rise = groundSurfaceHeight(x, z) - minSurfaceHeightInRadius(x, z, footprint);
  return clamp(rise, 0, cap);
}

/**
 * Jittered grid candidate pass: walks a fixed grid, jitters each cell
 * deterministically and accepts candidates via a probability function.
 * A single global RNG draws in fixed cell order, so the output is
 * deterministic for a given world seed.
 */
function gridCandidates(
  cell: number,
  salt: number,
  prob: (x: number, z: number, h: number) => number,
  minDist = 0,
  avoid: Array<{ x: number; z: number }> = [],
): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  const half = TERRAIN_SIZE / 2;
  const n = Math.ceil(half / cell);
  const rng = mulberry32((WORLD_SEED ^ Math.imul(salt, 0x9e3779b9)) >>> 0);
  for (let iz = -n; iz < n; iz++) {
    for (let ix = -n; ix < n; ix++) {
      const jx = (hash2(ix + 131, iz + 57) - 0.5) * cell * 0.9;
      const jz = (hash2(iz + 911, ix + 233) - 0.5) * cell * 0.9;
      const x = ix * cell + cell / 2 + jx;
      const z = iz * cell + cell / 2 + jz;
      // Never place outside the rendered terrain tile.
      if (Math.abs(x) > half - 1 || Math.abs(z) > half - 1) continue;
      if (rng() >= prob(x, z, terrainHeight(x, z))) continue;
      if (minDist > 0) {
        let ok = true;
        for (const list of [out, avoid]) {
          for (const p of list) {
            if (Math.hypot(p.x - x, p.z - z) < minDist) {
              ok = false;
              break;
            }
          }
          if (!ok) break;
        }
        if (!ok) continue;
      }
      out.push({ x, z });
    }
  }
  return out;
}

/**
 * World-space side length of one static flora batch chunk. Each (kind, chunk)
 * pair renders as a SINGLE mesh, so the visible world only pays a few dozen
 * draw calls no matter how dense the vegetation is — the key lever for FPS
 * while keeping the full flora density. Chunks scale with the terrain tile,
 * which keeps the system future-proof for larger worlds.
 */
export const FLORA_CHUNK_SIZE = 128;

/** Number of flora chunks along one axis of the terrain tile. */
export const FLORA_CHUNKS_PER_AXIS = Math.ceil(TERRAIN_SIZE / FLORA_CHUNK_SIZE);

/** Deterministic chunk indices for a world position (clamped to the tile). */
export function floraChunk(x: number, z: number): { cx: number; cz: number } {
  const half = TERRAIN_SIZE / 2;
  const cx = Math.floor((x + half) / FLORA_CHUNK_SIZE);
  const cz = Math.floor((z + half) / FLORA_CHUNK_SIZE);
  return {
    cx: Math.min(FLORA_CHUNKS_PER_AXIS - 1, Math.max(0, cx)),
    cz: Math.min(FLORA_CHUNKS_PER_AXIS - 1, Math.max(0, cz)),
  };
}

/** Name of the static batch mesh for one (kind, chunk) group. */
function chunkName(kind: string, cx: number, cz: number): string {
  return `flora_${kind}_c${cx}_${cz}`;
}

/**
 * Camera–chunk XZ distance (world units) below which a chunk renders in
 * HIGH detail. Set to roughly the chunk half-size so the chunk the player
 * stands in is always hi while the eye can still resolve trunk texture.
 */
export const FLORA_LOD_HI = 110;
/**
 * Camera–chunk XZ distance (world units) below which a chunk renders in
 * MID detail. Between MID and FAR the previous state is kept (hysteresis
 * band ≈ 60 u ≈ several seconds of walking, so chunks never flicker at
 * either border).
 */
export const FLORA_LOD_MID = 150;
/** Camera–chunk XZ distance (world units) beyond which a chunk renders in LOW detail. */
export const FLORA_LOD_FAR = 210;
/**
 * Max camera–chunk XZ distance at which a chunk registers as a directional
 * shadow caster. The shadow frustum is a ~130 u box around the camera
 * (half 65 u); a 128 u chunk (half 64 u) can no longer intersect it beyond
 * 65 + 64 u, and frustumEdgeFalloff fades shadow strength to zero in the
 * outer 40 % of the box anyway. Chunks beyond this radius are never
 * registered, so the shadow pass skips their geometry entirely.
 */
export const FLORA_SHADOW_RADIUS = 130;

/**
 * Kinds that own a lighter low-poly prototype (LOD). The small kinds
 * (grass, flower) are already at minimal tessellation, so they share a
 * single geometry for both detail levels.
 */
const LOD_KINDS = new Set(['tree', 'pine', 'rock', 'bush', 'plant']);

/** World XZ centre of one chunk column/row index. */
function chunkCenter(i: number): number {
  return i * FLORA_CHUNK_SIZE + FLORA_CHUNK_SIZE / 2 - TERRAIN_SIZE / 2;
}

/** Raw prototype vertex data of one (kind, variant) — reused by every chunk. */
interface ProtoGeo {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** Per-vertex wind-sway weight (0 = rigid, 1 = fully flexible). */
  sway: Float32Array;
  indices: Uint32Array;
}

/**
 * Wind-sway weight spec for one prototype part, evaluated in the part's
 * LOCAL space (before the part transform is baked in): the weight ramps
 * linearly from 0 at `yMin` to `amp` at `yMax` (clamped to [0, 1]), so a
 * grass blade or tree trunk is rigid at its base and flexible at its tip.
 * `yMin === yMax` yields a constant weight of `amp`.
 */
interface SwaySpec {
  amp: number;
  yMin: number;
  yMax: number;
}

/** One placed flora instance, with its last BAKED visual state. */
interface FloraInstance {
  kind: string;
  /** High-detail prototype geometry. */
  geo: ProtoGeo;
  /** Mid-detail prototype geometry (null for single-detail kinds). */
  geoMid: ProtoGeo | null;
  /** Low-detail prototype geometry (null for single-detail kinds). */
  geoLo: ProtoGeo | null;
  x: number;
  /** Settled (sink-adjusted) Y anchor. */
  y: number;
  z: number;
  quat: Quaternion;
  baseScale: number;
  node: ResourceNode | null;
  /** What the current chunk mesh geometry actually contains. */
  bakedVisible: boolean;
  bakedScale: number;
}

/** A (kind, chunk) batch: all instances of one kind inside one chunk. */
interface FloraChunk {
  kind: string;
  cx: number;
  cz: number;
  instances: FloraInstance[];
  /** High-detail batch mesh (present whenever the chunk is non-empty). */
  meshHi: Mesh | null;
  /** Mid-detail batch mesh (LOD_KINDS only; null for single-detail kinds). */
  meshMid: Mesh | null;
  /** Low-detail batch mesh (LOD_KINDS only; null for single-detail kinds). */
  meshLo: Mesh | null;
  /** Which detail level is currently enabled. */
  lodMode: 'hi' | 'mid' | 'lo';
}

/**
 * Bakes every visible instance of a chunk into one static world-space mesh
 * (shared flora material, vertex colours carry the per-part tint).
 * `detail` selects the prototype detail level (0 hi / 1 mid / 2 lo, distance
 * LOD). Returns null when nothing in the chunk is visible. The result is
 * frozen and frustum-culled as a whole.
 */
function bakeChunkMesh(
  scene: Scene,
  name: string,
  material: ShaderMaterial,
  instances: FloraInstance[],
  detail: 0 | 1 | 2,
): Mesh | null {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const sway: number[] = [];
  const indices: number[] = [];
  let offset = 0;
  const v = new Vector3();
  const scale = new Vector3();
  const m = new Matrix();
  const translation = new Vector3();

  for (const inst of instances) {
    if (!inst.bakedVisible) continue;
    Matrix.ComposeToRef(
      scale.set(inst.bakedScale, inst.bakedScale, inst.bakedScale),
      inst.quat,
      translation.set(inst.x, inst.y, inst.z),
      m,
    );
    const g =
      detail === 0 ? inst.geo : detail === 1 ? (inst.geoMid ?? inst.geo) : (inst.geoLo ?? inst.geo);
    const pos = g.positions;
    const nrm = g.normals;
    for (let i = 0; i < pos.length; i += 3) {
      v.set(pos[i], pos[i + 1], pos[i + 2]);
      Vector3.TransformCoordinatesToRef(v, m, v);
      positions.push(v.x, v.y, v.z);
      // Uniform scale: transform the normal with the full matrix, then
      // renormalise (removes the scale factor exactly).
      v.set(nrm[i], nrm[i + 1], nrm[i + 2]);
      Vector3.TransformNormalToRef(v, m, v);
      v.normalize();
      normals.push(v.x, v.y, v.z);
    }
    for (let i = 0; i < g.colors.length; i++) colors.push(g.colors[i]);
    // Sway weights are scale/rotation invariant — copied verbatim.
    for (let i = 0; i < g.sway.length; i++) sway.push(g.sway[i]);
    const count = pos.length / 3;
    for (let i = 0; i < g.indices.length; i++) indices.push(g.indices[i] + offset);
    offset += count;
  }

  if (offset === 0) return null;

  const mesh = new Mesh(name, scene);
  mesh.setVerticesData(VertexBuffer.PositionKind, Float32Array.from(positions));
  mesh.setVerticesData(VertexBuffer.NormalKind, Float32Array.from(normals));
  mesh.setVerticesData(VertexBuffer.ColorKind, Float32Array.from(colors));
  // Custom vertex kind: v9.33 deduces the stride only for built-in kinds,
  // so pass stride=1 explicitly (same pattern as the water 'depth' and
  // terrain 'ao' attributes).
  mesh.setVerticesData('sway', Float32Array.from(sway), false, 1);
  mesh.setIndices(indices);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.refreshBoundingInfo(); // correct frustum culling for the batch
  mesh.freezeWorldMatrix(); // geometry is already in world space
  return mesh;
}

/**
 * Populates the scene with static, varied flora (see genPlacements).
 *
 * Rendering model (v2, chunked): each placed instance keeps its exact
 * deterministic transform, but instances are BAKED into static world-space
 * batch meshes per (kind, chunk). The whole world is at most
 * kinds × chunks² meshes (7 × 25 = 175 here) instead of one InstancedMesh
 * per placement (~2700 draw calls), and frustum culling drops off-screen
 * chunks entirely. Visual density is identical — no instance is removed.
 *
 * Node state (harvest damage / depletion) is applied by REBAKING only the
 * affected (kind, chunk) mesh, which happens at most once per harvest event.
 */
export function populateFlora(
  scene: Scene,
  mats: SharedMaterials,
  state: SharedWorldState,
  colliders: Collider[],
  keepOut: Array<{ x: number; z: number; r: number }> = [],
): FloraHandle {
  const placements = genPlacements(keepOut);

  // One raw prototype geometry per (kind, variant, detail), built lazily.
  const protos = new Map<string, ProtoGeo>();
  const protoFor = (kind: string, variant: number, detail: 0 | 1 | 2): ProtoGeo | null => {
    const key = `${kind}:${variant}:${detail}`;
    const cached = protos.get(key);
    if (cached) return cached;
    const built = buildPrototype(scene, kind, variant, mats, detail);
    if (built) protos.set(key, built);
    return built ?? null;
  };

  /** Bakes the chunk's hi/mid/lo triple (re-bakes replace all meshes). */
  const bakeChunk = (ch: FloraChunk): void => {
    const name = chunkName(ch.kind, ch.cx, ch.cz);
    const lod = LOD_KINDS.has(ch.kind);
    ch.meshHi = bakeChunkMesh(scene, name, floraMaterial, ch.instances, 0);
    ch.meshMid = lod ? bakeChunkMesh(scene, `${name}_mid`, floraMaterial, ch.instances, 1) : null;
    ch.meshLo = lod ? bakeChunkMesh(scene, `${name}_lo`, floraMaterial, ch.instances, 2) : null;
    // Fresh meshes are enabled by default: force the chunk's current mode on
    // ALL meshes so a re-bake never flashes the wrong detail level for one
    // frame (in hi mode the new mid/lo twins must be switched off explicitly).
    ch.meshHi?.setEnabled(ch.lodMode === 'hi');
    ch.meshMid?.setEnabled(ch.lodMode === 'mid');
    ch.meshLo?.setEnabled(ch.lodMode === 'lo');
  };

  const nodeCounter: Record<string, number> = {};
  const instances: FloraInstance[] = [];

  for (const p of placements) {
    const geo = protoFor(p.kind, p.variant, 0);
    if (!geo) continue;
    const lod = LOD_KINDS.has(p.kind);
    const geoMid = lod ? protoFor(p.kind, p.variant, 1) : null;
    const geoLo = lod ? protoFor(p.kind, p.variant, 2) : null;

    const harvestable = p.kind === 'tree' || p.kind === 'pine' || p.kind === 'rock' || p.kind === 'bush';
    const quat = new Quaternion();
    if (harvestable) {
      // Lean with the terrain, then apply the per-instance yaw.
      const n = terrainNormal(p.x, p.z);
      const tilt = new Quaternion();
      Quaternion.FromUnitVectorsToRef(new Vector3(0, 1, 0), n, tilt);
      const yaw = new Quaternion();
      Quaternion.RotationYawPitchRollToRef(p.rotY, 0, 0, yaw);
      quat.copyFrom(tilt.multiply(yaw));
    } else {
      Quaternion.RotationYawPitchRollToRef(p.rotY, 0, 0, quat);
    }

    // Node identity type (harvestable kinds only); keeps the narrow type for
    // the ResourceNode registration below.
    const harvestableKind: ResourceNode['kind'] | null =
      p.kind === 'tree' || p.kind === 'pine' || p.kind === 'rock' || p.kind === 'bush'
        ? p.kind
        : null;

    let node: ResourceNode | null = null;
    if (harvestableKind) {
      const c = (nodeCounter[harvestableKind] = (nodeCounter[harvestableKind] ?? 0) + 1);
      node = {
        id: `n_${harvestableKind}_${c}`,
        kind: harvestableKind,
        x: p.x,
        z: p.z,
        y: p.y,
        radius: p.radius,
        hp: p.maxHp,
        maxHp: p.maxHp,
      };
      state.registerNode(node);
      if (p.kind === 'rock')
        colliders.push({
          x: p.x,
          z: p.z,
          // Scale-aware footprint so big boulders cannot be walked through.
          radius: Math.min(1.6, Math.max(0.7, 0.85 * p.scale)),
        });
    }

    instances.push({
      kind: p.kind,
      geo,
      geoMid,
      geoLo,
      x: p.x,
      // Settle on the lowest local ground within the footprint (see
      // Placement.sink) so the base never floats or clips through terrain.
      y: p.y - p.sink,
      z: p.z,
      quat,
      baseScale: p.scale,
      node,
      bakedVisible: true,
      bakedScale: p.scale,
    });
  }

  // Group instances into (kind, chunk) batches.
  const chunks = new Map<string, FloraChunk>();
  for (const inst of instances) {
    const { cx, cz } = floraChunk(inst.x, inst.z);
    const key = chunkName(inst.kind, cx, cz);
    let ch = chunks.get(key);
    if (!ch) {
      ch = { kind: inst.kind, cx, cz, instances: [], meshHi: null, meshMid: null, meshLo: null, lodMode: 'hi' };
      chunks.set(key, ch);
    }
    ch.instances.push(inst);
  }

  const floraMaterial = createFloraWindMaterial(scene);
  for (const ch of chunks.values()) bakeChunk(ch); // the world starts in high detail

  // Wind clock (session time — purely visual, never part of world state).
  let windT = 0;
  const windDir = new Vector2(1, 0);

  return {
    nodeCount: state.nodes.length,
    /**
     * Re-bakes every (kind, chunk) mesh whose visual state diverged from the
     * node state (harvest damage shrink or depletion). Meshes without changes
     * are left untouched — so a single harvest re-bakes one small chunk at
     * most.
     */
    applyState(): void {
      const dirty = new Set<FloraChunk>();
      for (const ch of chunks.values()) {
        for (const inst of ch.instances) {
          if (!inst.node) continue;
          const hp = state.hp[inst.node.id] ?? inst.node.maxHp;
          const visible = !(hp <= 0 || state.isDepleted(inst.node.id));
          const scale = visible
            ? inst.baseScale * (0.62 + 0.38 * (hp / inst.node.maxHp))
            : inst.bakedScale;
          if (visible !== inst.bakedVisible || Math.abs(scale - inst.bakedScale) > 1e-4) {
            inst.bakedVisible = visible;
            inst.bakedScale = scale;
            dirty.add(ch);
          }
        }
      }
      for (const ch of dirty) {
        if (ch.meshHi) ch.meshHi.dispose();
        if (ch.meshMid) ch.meshMid.dispose();
        if (ch.meshLo) ch.meshLo.dispose();
        bakeChunk(ch); // re-bakes ALL detail levels, preserving lodMode
      }
    },
    /** Distance LOD swap (see FloraHandle.updateLod). */
    updateLod(cam: { x: number; z: number }): void {
      for (const ch of chunks.values()) {
        if (!ch.meshLo) continue; // single-detail kind (grass/flower)
        const dist = Math.hypot(cam.x - chunkCenter(ch.cx), cam.z - chunkCenter(ch.cz));
        let mode: 'hi' | 'mid' | 'lo' = ch.lodMode;
        if (dist < FLORA_LOD_HI) mode = 'hi';
        else if (dist < FLORA_LOD_MID) mode = 'mid';
        else if (dist > FLORA_LOD_FAR) mode = 'lo';
        // [FLORA_LOD_MID, FLORA_LOD_FAR]: keep the previous state (hysteresis).
        if (mode !== ch.lodMode) {
          ch.lodMode = mode;
          ch.meshHi?.setEnabled(mode === 'hi');
          ch.meshMid?.setEnabled(mode === 'mid');
          ch.meshLo?.setEnabled(mode === 'lo');
        }
      }
    },
    /** Shadow-caster proximity culling (see FloraHandle.shadowCasters). */
    shadowCasters(px: number, pz: number): Mesh[] {
      const out: Mesh[] = [];
      const r2 = FLORA_SHADOW_RADIUS * FLORA_SHADOW_RADIUS;
      for (const ch of chunks.values()) {
        const m = ch.lodMode === 'hi' ? ch.meshHi : ch.lodMode === 'mid' ? ch.meshMid : ch.meshLo;
        if (!m || !m.isEnabled()) continue;
        const dx = px - chunkCenter(ch.cx);
        const dz = pz - chunkCenter(ch.cz);
        if (dx * dx + dz * dz <= r2) out.push(m);
      }
      return out;
    },
    /** Live chunk batch meshes, hi + mid + lo (for QA/diagnostics). */
    chunkMeshes(): Mesh[] {
      const out: Mesh[] = [];
      for (const ch of chunks.values()) {
        if (ch.meshHi) out.push(ch.meshHi);
        if (ch.meshMid) out.push(ch.meshMid);
        if (ch.meshLo) out.push(ch.meshLo);
      }
      return out;
    },
    material: floraMaterial,
    /** Advance the wind clock and push the wind uniforms (once per frame). */
    updateWind(dt: number): void {
      if (!(dt > 0)) return; // paused / negative dt: still air
      windT += dt;
      // Slowly drifting wind direction (never stops blowing).
      const a = 0.8 + 0.5 * Math.sin(windT * 0.031) + 0.25 * Math.sin(windT * 0.011 + 1.7);
      windDir.set(Math.cos(a), Math.sin(a));
      floraMaterial.setFloat('uWindTime', windT);
      floraMaterial.setVector2('uWindDir', windDir);
    },
  };
}

// ---------------------------------------------------------------------------
// Prototype builders: each variant is procedurally distinct (shape, size,
// vertex jitter and per-part colour). Every variant is merged into a single
// raw geometry whose final colours are baked into the vertex-colour buffer,
// so one shared material serves every chunk batch mesh.
// ---------------------------------------------------------------------------

interface Part {
  mesh: Mesh;
  /** Base diffuse colour of this part (from the shared materials). */
  color: Color3;
  /** Wind-sway weight for this part (absent = rigid, e.g. rocks). */
  sway?: SwaySpec;
}

/**
 * Wind tuning. `amp` is the world-unit displacement of a fully-weighted
 * vertex (grass tips) at peak gust + peak wave. The per-vertex budget is
 * provably bounded:
 *   max offset = amp * maxWeight(1) * maxGust(0.7+0.3) * maxDirTerms(0.65+0.35)
 *              = amp
 * and unit-tested against every baked chunk (see floraWind.test.ts).
 */
export const FLORA_WIND = {
  amp: 0.12,
  maxOffset: 0.12,
};

const FLORA_VERT = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec4 color;
attribute float sway;
uniform mat4 world;
uniform mat4 viewProjection;
uniform float uWindTime;
uniform vec2 uWindDir;
uniform float uWindAmp;
varying vec3 vNormal;
varying vec3 vPos;
varying vec4 vColor;
${SHADOW_VERT_DECL}
// Wind sway: the baked per-vertex weight (sway) modulates a slowly
// gusting displacement in world space. The phase is a pure function of
// the world XZ position, so every plant in a batched chunk bobs on its
// own (two sine terms + a low-frequency gust envelope; bounded hash-free
// noise only — no per-cell lattice terms). The shadow depth pass
// uses its own position-only shader, so caster silhouettes stay stable.
vec3 windOffset(vec3 p) {
  float ph = dot(p.xz, vec2(0.317, 0.229));
  float gust = 0.7 + 0.3 * sin(uWindTime * 0.21 + ph * 0.17);
  float s = sway * uWindAmp * gust;
  vec2 d = uWindDir * (0.65 * sin(uWindTime * 0.9 + ph) + 0.35 * sin(uWindTime * 1.63 + ph * 1.93));
  return vec3(d * s, 0.0);
}

void main() {
  vec3 lp = position + windOffset(position);
  vec4 wp = world * vec4(lp, 1.0);
  vPos = wp.xyz;
  vNormal = normalize(mat3(world) * normal);
  vColor = color;
${SHADOW_VERT_MAIN('wp')}
  gl_Position = viewProjection * wp;
}
`;

const FLORA_FRAG = `
precision highp float;
uniform vec3 cameraPosition;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 ambientTop;
uniform vec3 ambientGround;
uniform vec3 fogColor;
uniform float fogDensity;
varying vec3 vNormal;
varying vec3 vPos;
varying vec4 vColor;
${SHADOW_FRAG_DECL}

${COLOR_GRADE_GLSL}

void main() {
  vec3 N = normalize(vNormal);
  vec3 L = normalize(sunDir);
  vec3 col = vColor.rgb;

  float ndl = max(dot(N, L), 0.0);
  float hemi = 0.5 + 0.5 * N.y;
  vec3 amb = mix(ambientGround, ambientTop, hemi);
  // Sun shadows: only the DIRECT sun + specular terms are darkened, the
  // hemisphere ambient stays full so forest interiors keep readability
  // (same model as the terrain shader).
  float shadow = ${SHADOW_SAMPLE};
  vec3 light = sunColor * (ndl * shadow) + amb;

  // Soft Blinn glint so canopy blobs catch the sun (kept small: the old
  // StandardMaterial specular was 0.05 — a visible but subtle sheen).
  vec3 V = normalize(cameraPosition - vPos);
  vec3 H = normalize(V + L);
  float spec = pow(max(dot(N, H), 0.0), 64.0) * 0.12 * shadow;
  vec3 c = col * light + sunColor * spec;

  // Engine-matched scene fog (EXP2), blended in LINEAR space before the
  // ACES + gamma grade — the same order as terrain/water/sky, so the
  // horizon stays seamless and the flora grades exactly like the engine
  // materials used to.
  float dist = length(vPos - cameraPosition);
  float f = 1.0 - exp(-fogDensity * fogDensity * dist * dist);
  c = mix(c, fogColor, clamp(f, 0.0, 1.0));
  gl_FragColor = vec4(colorGrade(c), 1.0);
}
`;

/** Exposes the final flora shader sources (QA regression guards). */
export function dumpFloraGLSL(): string {
  return FLORA_VERT + '\n----------------\n' + FLORA_FRAG;
}

/**
 * The single shared flora material. Replaces the old StandardMaterial:
 * it keeps the exact same lighting model (directional sun + hemisphere
 * ambient, vertex colours, scene EXP2 fog, ACES grading via the shared
 * colour pipeline, shadow receive via ShadowReceiver) and adds the
 * vertex-shader wind sway. One material serves every chunk batch mesh,
 * so the draw-call count is unchanged by this switch.
 */
function createFloraWindMaterial(scene: Scene): ShaderMaterial {
  const material = new ShaderMaterial(
    'floraMat',
    scene,
    { vertexSource: FLORA_VERT, fragmentSource: FLORA_FRAG },
    {
      attributes: ['position', 'normal', 'color', 'sway'],
      uniforms: [
        'world',
        'viewProjection',
        'cameraPosition',
        'sunDir',
        'sunColor',
        'ambientTop',
        'ambientGround',
        'fogColor',
        'fogDensity',
        'uWindTime',
        'uWindDir',
        'uWindAmp',
        ...COLOR_GRADE_UNIFORMS,
        ...SHADOW_UNIFORMS,
      ],
      defines: shadowReceiveDefines(scene.getEngine()),
    },
  );
  // Initial values mirror the terrain defaults; Lighting.addShaderMaterial
  // drives the live sun/ambient values from the same cycle clock.
  material.setVector3('sunDir', new Vector3(-0.4, 0.8, -0.3));
  material.setVector3('sunColor', new Vector3(1, 0.96, 0.86));
  material.setVector3('ambientTop', new Vector3(0.32, 0.36, 0.42));
  material.setVector3('ambientGround', new Vector3(0.2, 0.18, 0.15));
  material.setFloat('fogDensity', 0.0028);
  material.setVector3('fogColor', new Vector3(0.62, 0.72, 0.82));
  material.setFloat('uWindTime', 0);
  material.setVector2('uWindDir', new Vector2(1, 0));
  material.setFloat('uWindAmp', FLORA_WIND.amp);

  // Mirror the engine scene fog + image-processing pipeline each frame
  // (same allocation-free pattern as the terrain material).
  const fogV = new Vector3(0.62, 0.72, 0.82);
  const fogSync = () => {
    if (scene.fogDensity != null) material.setFloat('fogDensity', scene.fogDensity);
    if (scene.fogColor) {
      const fc = scene.fogColor;
      fogV.set(fc.r, fc.g, fc.b);
      material.setVector3('fogColor', fogV);
    }
    syncColorPipeline(scene, material);
  };
  scene.onBeforeRenderObservable.add(fogSync);
  fogSync();

  // Receive the directional-light BSM shadow map (flora also casts — the
  // shadow pass uses its own depth shader, so sway never bleeds into the
  // shadow silhouette).
  new ShadowReceiver(scene, material);

  return material;
}

/**
 * A mesh that carries a baked colour tint. The tint is stored as a
 * side-channel (not a vertex buffer) because the v9 CPU read path for
 * colour buffers is unreliable. mergeParts() multiplies it into the final
 * vertex colours.
 */
interface TintedMesh extends Mesh {
  _floraTint?: Color3;
}

const WHITE_TINT = new Color3(1, 1, 1);

/** Records a per-part colour multiplier (multiplied with the part base colour). */
function tint(m: Mesh, r: number, g: number, b: number): void {
  (m as TintedMesh)._floraTint = new Color3(r, g, b);
}

/**
 * Seeded per-vertex displacement along normals for organic shapes.
 * Recomputes normals afterwards so lighting stays correct.
 */
function jitter(m: Mesh, seed: number, amount: number): void {
  const pos = m.getVerticesData(VertexBuffer.PositionKind) as Float32Array | null;
  const nrm = m.getVerticesData(VertexBuffer.NormalKind) as Float32Array | null;
  const idx = m.getIndices();
  if (!pos || !nrm || nrm.length !== pos.length || !idx) return;
  for (let i = 0; i < pos.length; i += 3) {
    const k = (hash2(i / 3, seed) - 0.5) * amount;
    pos[i] += nrm[i] * k;
    pos[i + 1] += nrm[i + 1] * k;
    pos[i + 2] += nrm[i + 2] * k;
  }
  const normals = new Float32Array(pos.length);
  VertexData.ComputeNormals(pos, idx, normals);
  m.setVerticesData(VertexBuffer.PositionKind, pos);
  m.setVerticesData(VertexBuffer.NormalKind, normals);
}

/**
 * Merges a set of parts into ONE raw prototype geometry. Part transforms are
 * baked in and each vertex's final colour becomes `part.color * vertexTint`.
 * Source parts are disposed. No scene mesh is created: chunk bakers reuse the
 * raw arrays directly, which keeps GPU memory at exactly one copy of the
 * prototype data plus the baked chunk meshes.
 */
function mergeProtoGeo(
  parts: Part[],
): ProtoGeo {
  const allPos: number[] = [];
  const allNrm: number[] = [];
  const allCol: number[] = [];
  const allSway: number[] = [];
  const allIdx: number[] = [];
  let vertexOffset = 0;

  for (const { mesh, color, sway: swaySpec } of parts) {
    const matrix = mesh.computeWorldMatrix(true);
    const pos = mesh.getVerticesData(VertexBuffer.PositionKind) as Float32Array;
    const kinds = mesh.getVerticesDataKinds();
    const nrm = kinds.includes(VertexBuffer.NormalKind)
      ? (mesh.getVerticesData(VertexBuffer.NormalKind) as Float32Array)
      : new Float32Array(pos.length);
    const tintC = (mesh as TintedMesh)._floraTint ?? WHITE_TINT;
    const fr = color.r * tintC.r;
    const fg = color.g * tintC.g;
    const fb = color.b * tintC.b;
    const idx = mesh.getIndices();
    if (!idx) continue;
    const count = pos.length / 3;

    const v = new Vector3();
    const swaySpan = swaySpec ? swaySpec.yMax - swaySpec.yMin : 0;
    for (let i = 0; i < pos.length; i += 3) {
      v.set(pos[i], pos[i + 1], pos[i + 2]);
      Vector3.TransformCoordinatesToRef(v, matrix, v);
      allPos.push(v.x, v.y, v.z);
      v.set(nrm[i] || 0, nrm[i + 1] || 0, nrm[i + 2] || 0);
      Vector3.TransformNormalToRef(v, matrix, v);
      v.normalize();
      allNrm.push(v.x, v.y, v.z);
      allCol.push(fr, fg, fb, 1);
      // Wind-sway weight from the part's LOCAL y (before the part
      // transform is baked in): 0 at yMin, amp at yMax, clamped.
      let w = 0;
      if (swaySpec) {
        const t = swaySpan > 1e-6 ? (pos[i + 1] - swaySpec.yMin) / swaySpan : 1;
        w = Math.min(1, Math.max(0, t));
        w = Math.min(1, swaySpec.amp * w);
      }
      allSway.push(w);
    }
    for (const ix of idx) allIdx.push(ix + vertexOffset);
    vertexOffset += count;
    mesh.dispose();
  }

  return {
    positions: Float32Array.from(allPos),
    normals: Float32Array.from(allNrm),
    colors: Float32Array.from(allCol),
    sway: Float32Array.from(allSway),
    indices: Uint32Array.from(allIdx),
  };
}

function leafTint(v: number): Color3 {
  return [
    new Color3(0.3, 0.52, 0.2),
    new Color3(0.34, 0.6, 0.22),
    new Color3(0.27, 0.45, 0.18),
  ][v % 3];
}

function buildBroadleaf(scene: Scene, mats: SharedMaterials, v: number, detail: 0 | 1 | 2): Part[] {
  const rng = mulberry32((WORLD_SEED + 11 + v * 977) >>> 0);
  const parts: Part[] = [];
  // Distance LOD (hi/mid/lo): fewer segments further away. The RNG stream
  // below is detail-independent, so all three levels show the SAME tree
  // (same trunk, same blob layout) — only the facet count differs.
  const trunkTess = [7, 5, 4][detail];
  const canopySeg = [8, 5, 3][detail];

  const trunkH = 3.4 + v * 0.7 + rng() * 0.6;
  const trunk = MeshBuilder.CreateCylinder('bl_t', {
    height: trunkH,
    diameterTop: 0.4 + rng() * 0.12,
    diameterBottom: 0.62 + rng() * 0.18,
    tessellation: trunkTess,
  }, scene);
  trunk.material = mats.bark;
  tint(trunk, 0.85 + rng() * 0.3, 0.85 + rng() * 0.2, 0.9 + rng() * 0.2);
  trunk.position.y = trunkH / 2;
  // The trunk is nearly rigid; only its very top flexes (crown weight).
  parts.push({
    mesh: trunk,
    color: mats.bark.albedoColor,
    sway: { amp: 0.05, yMin: -trunkH / 2, yMax: trunkH / 2 },
  });

  const canopyBase = trunkH * 0.82;
  const mainD = 3.2 + rng() * 1.2 + (v === 1 ? 0.9 : 0);
  const blobs = 2 + (v % 2);
  for (let i = 0; i <= blobs; i++) {
    const d = mainD * (i === 0 ? 1 : 0.55 + rng() * 0.2);
    const blob = MeshBuilder.CreateSphere(`bl_b${i}`, { diameter: d, segments: canopySeg }, scene);
    blob.material = mats.leaf;
    const t = leafTint(v);
    const k = i === 0 ? 1 : 0.82;
    tint(blob, t.r * k, t.g * k, t.b * k);
    jitter(blob, 41 + i + v * 13, d * 0.16);
    blob.scaling.set(1, 0.78 + rng() * 0.12, 1);
    if (i === 0) {
      blob.position.set((rng() - 0.5) * 0.4, canopyBase, (rng() - 0.5) * 0.4);
    } else {
      const ang = rng() * Math.PI * 2;
      const r = mainD * (0.32 + rng() * 0.22);
      blob.position.set(
        Math.cos(ang) * r,
        canopyBase - 0.3 + rng() * mainD * 0.45,
        Math.sin(ang) * r,
      );
    }
    parts.push({
      mesh: blob,
      color: mats.leaf.albedoColor,
      // Canopy blobs wave: base of the sphere barely, top fully.
      sway: { amp: i === 0 ? 0.85 : 0.7, yMin: -d / 2, yMax: d / 2 },
    });
  }
  return parts;
}

function buildPine(scene: Scene, mats: SharedMaterials, v: number, detail: 0 | 1 | 2): Part[] {
  const rng = mulberry32((WORLD_SEED + 29 + v * 811) >>> 0);
  const parts: Part[] = [];
  const trunkTess = [6, 5, 4][detail];
  const coneTess = [8, 5, 4][detail];

  const tiers = v === 2 ? 3 : v === 1 ? 4 : 3;
  const trunkH = 1.8 + rng() * 0.9 + (v === 2 ? 0.6 : 0);
  const trunk = MeshBuilder.CreateCylinder('pn_t', {
    height: trunkH,
    diameterTop: 0.3 + rng() * 0.1,
    diameterBottom: 0.46 + rng() * 0.16,
    tessellation: trunkTess,
  }, scene);
  trunk.material = mats.bark;
  tint(trunk, 0.8 + rng() * 0.3, 0.82 + rng() * 0.2, 0.9 + rng() * 0.2);
  trunk.position.y = trunkH / 2;
  parts.push({
    mesh: trunk,
    color: mats.bark.albedoColor,
    sway: { amp: 0.04, yMin: -trunkH / 2, yMax: trunkH / 2 },
  });

  let baseD = 2.6 + rng() * 0.7 - v * 0.45;
  let baseH = 2.4 + rng() * 0.6;
  let y = trunkH * 0.55;
  for (let t = 0; t < tiers; t++) {
    const cone = MeshBuilder.CreateCylinder(`pn_c${t}`, {
      height: baseH,
      diameterTop: 0.02,
      diameterBottom: baseD,
      tessellation: coneTess,
    }, scene);
    cone.material = mats.pineLeaf;
    const k = 0.85 + rng() * 0.3;
    tint(cone, k, k * (0.95 + rng() * 0.25), k);
    jitter(cone, 77 + t + v * 29, baseD * 0.08);
    cone.position.y = y + baseH / 2;
    parts.push({
      mesh: cone,
      color: mats.pineLeaf.albedoColor,
      sway: { amp: 0.8, yMin: -baseH / 2, yMax: baseH / 2 },
    });
    y += baseH * 0.55;
    baseD *= 0.72;
    baseH *= 0.82;
  }
  return parts;
}

function buildRock(scene: Scene, mats: SharedMaterials, v: number, detail: 0 | 1 | 2): Part[] {
  const rng = mulberry32((WORLD_SEED + 43 + v * 641) >>> 0);
  const parts: Part[] = [];
  // Flora uses a vertex-colour shader, so it bakes this tint instead of
  // sampling the white albedo texture multiplier used by PBR rock meshes.
  const rockColor = new Color3(0.42, 0.43, 0.41);
  const sphereSeg = [5, 4, 3][detail];

  const rock = (
    name: string,
    kind: 'sphere' | 'poly' | 'box',
    scale: [number, number, number],
    sink = 0.15,
  ): void => {
    let m: Mesh;
    if (kind === 'sphere') {
      m = MeshBuilder.CreateSphere(name, { diameter: 2, segments: sphereSeg }, scene);
      jitter(m, 91 + v * 17, 0.55 + rng() * 0.2);
    } else if (kind === 'box') {
      m = MeshBuilder.CreateBox(name, { width: 1.6, height: 1.8, depth: 0.7 }, scene);
      jitter(m, 97 + v * 23, 0.5);
    } else {
      m = MeshBuilder.CreatePolyhedron(name, { type: v === 2 ? 3 : 1 }, scene);
      jitter(m, 97 + v * 31, 0.35);
    }
    m.material = mats.rock;
    const warm = 0.85 + rng() * 0.4;
    tint(m, warm, warm * (0.94 + rng() * 0.12), warm * (0.92 + rng() * 0.15));
    m.scaling.set(scale[0], scale[1], scale[2]);
    m.position.set((rng() - 0.5) * 0.3, -sink * scale[1], (rng() - 0.5) * 0.3);
    m.rotation.y = rng() * Math.PI * 2;
    m.rotation.x = (rng() - 0.5) * 0.25;
    parts.push({ mesh: m, color: rockColor });
  };

  switch (v) {
    case 0: // lowland boulder
      rock('rk0', 'sphere', [1.5 + rng() * 0.4, 1.0 + rng() * 0.3, 1.2 + rng() * 0.3]);
      if (rng() > 0.4) rock('rk0s', 'sphere', [0.5 + rng() * 0.3, 0.4, 0.5], 0.05);
      break;
    case 1: // angular highland block
      rock('rk1', 'poly', [1.5 + rng() * 0.4, 1.1 + rng() * 0.3, 1.1 + rng() * 0.3]);
      break;
    case 2: // steep-slope wedge (boulder pair)
      rock('rk2', 'poly', [1.2 + rng() * 0.3, 0.9 + rng() * 0.3, 0.8 + rng() * 0.3]);
      rock('rk2s', 'sphere', [0.7 + rng() * 0.3, 0.55, 0.65], 0.05);
      break;
    default: // tall slab
      rock('rk3', 'box', [0.9 + rng() * 0.25, 1.0 + rng() * 0.4, 0.55 + rng() * 0.15], 0.25);
      break;
  }
  return parts;
}

function buildBush(scene: Scene, mats: SharedMaterials, v: number, detail: 0 | 1 | 2): Part[] {
  const rng = mulberry32((WORLD_SEED + 61 + v * 517) >>> 0);
  const parts: Part[] = [];
  const bushColor = mats.bushLeaf.albedoColor;
  // Distance LOD: fewer blob segments further away, and the sub-centimetre
  // berries are dropped at mid/lo (they are sub-pixel beyond those
  // distances, so the silhouette is unchanged).
  const blobSeg = [7, 4, 3][detail];

  const blobs = v === 0 ? 3 : 4;
  for (let i = 0; i < blobs; i++) {
    const bd = i === 0 ? 1.5 + rng() * 0.5 : 0.8 + rng() * 0.5;
    const b = MeshBuilder.CreateSphere(`bu_${i}`, {
      diameter: bd,
      segments: blobSeg,
    }, scene);
    b.material = mats.bushLeaf;
    const k = 0.85 + rng() * 0.35;
    tint(b, k, k * (1.0 + rng() * 0.25), k * 0.9);
    jitter(b, 113 + i + v * 7, 0.3);
    b.scaling.set(1, 0.72 + rng() * 0.15, 1);
    if (i === 0) {
      b.position.set(0, 0.65, 0);
    } else {
      const ang = rng() * Math.PI * 2;
      const r = 0.5 + rng() * 0.45;
      b.position.set(Math.cos(ang) * r, 0.55 + rng() * 0.3, Math.sin(ang) * r);
    }
    parts.push({
      mesh: b,
      color: bushColor,
      sway: { amp: 0.6, yMin: -bd / 2, yMax: bd / 2 },
    });
  }
  const berryCount = detail === 0 ? (v === 0 ? 4 : 3) : 0;
  for (let i = 0; i < berryCount; i++) {
    const berry = MeshBuilder.CreateSphere(`bu_b${i}`, { diameter: 0.16 + rng() * 0.1, segments: 5 }, scene);
    berry.material = mats.berry;
    const ang = rng() * Math.PI * 2;
    berry.position.set(Math.cos(ang) * 0.55, 0.7 + rng() * 0.5, Math.sin(ang) * 0.55);
    parts.push({
      mesh: berry,
      color: mats.berry.albedoColor,
      // Berries hang from the bush mass and follow it (constant weight).
      sway: { amp: 0.8, yMin: 0, yMax: 0 },
    });
  }
  return parts;
}

function buildGrass(scene: Scene, mats: SharedMaterials, v: number): Part[] {
  const rng = mulberry32((WORLD_SEED + 79 + v * 389) >>> 0);
  const parts: Part[] = [];
  const grassColor = mats.grass.albedoColor;
  const blades = v === 0 ? 3 : 5;
  const dry = v === 1 ? 1 : 0;
  for (let i = 0; i < blades; i++) {
    const h = 0.55 + rng() * 0.45;
    const lean = 0.12 + rng() * 0.25;
    const dir = rng() * Math.PI * 2;
    const blade = MeshBuilder.CreateCylinder(`gr_${i}`, {
      height: h,
      diameterTop: 0.02,
      diameterBottom: 0.12,
      tessellation: 3,
    }, scene);
    blade.material = mats.grass;
    const k = 0.85 + rng() * 0.3;
    tint(blade, k * (dry ? 1.25 : 1), k * (dry ? 1.05 : 1), k * (dry ? 0.55 : 0.85));
    blade.position.set(Math.sin(dir) * lean * 0.5, h / 2, Math.cos(dir) * lean * 0.5);
    blade.rotation.z = Math.sin(dir) * lean;
    blade.rotation.x = -Math.cos(dir) * lean;
    parts.push({
      mesh: blade,
      color: grassColor,
      // Full flexibility: grass is the wind's main performer.
      sway: { amp: 1.0, yMin: -h / 2, yMax: h / 2 },
    });
  }
  return parts;
}

function buildFlower(scene: Scene, mats: SharedMaterials, v: number): Part[] {
  const rng = mulberry32((WORLD_SEED + 97 + v * 271) >>> 0);
  const parts: Part[] = [];
  const grassColor = mats.grass.albedoColor;
  const flowerColor = mats.flower.albedoColor;
  const headColor: Color3[] = [
    new Color3(0.95, 0.3, 0.35),
    new Color3(0.95, 0.9, 0.55),
    new Color3(0.92, 0.92, 0.95),
  ];
  const c = headColor[v % 3];

  const stemH = 0.4 + rng() * 0.25;
  const stem = MeshBuilder.CreateCylinder('fl_s', {
    height: stemH,
    diameterTop: 0.03,
    diameterBottom: 0.05,
    tessellation: 4,
  }, scene);
  stem.material = mats.grass;
  tint(stem, 0.9, 1.0, 0.8);
  stem.position.y = stemH / 2;
  parts.push({
    mesh: stem,
    color: grassColor,
    sway: { amp: 0.6, yMin: -stemH / 2, yMax: stemH / 2 },
  });

  const head = MeshBuilder.CreateSphere('fl_h', {
    diameter: 0.16 + rng() * 0.1,
    segments: 5,
  }, scene);
  head.material = mats.flower;
  // flower material is white; bake the head colour directly as the tint.
  tint(head, c.r / flowerColor.r, c.g / flowerColor.g, c.b / flowerColor.b);
  head.position.y = stemH + 0.08;
  parts.push({
    mesh: head,
    color: flowerColor,
    // The head sways fully with the stem tip.
    sway: { amp: 1.0, yMin: 0, yMax: 0 },
  });
  return parts;
}

function buildPlant(scene: Scene, mats: SharedMaterials, v: number, detail: 0 | 1 | 2): Part[] {
  const rng = mulberry32((WORLD_SEED + 131 + v * 433) >>> 0);
  const parts: Part[] = [];
  if (v === 0) {
    const grassColor = mats.grass.albedoColor;
    const fronds = 6;
    for (let i = 0; i < fronds; i++) {
      const fh = 0.45 + rng() * 0.3;
      const f = MeshBuilder.CreateCylinder(`pl_f${i}`, {
        height: fh,
        diameterTop: 0.015,
        diameterBottom: 0.09,
        tessellation: 3,
      }, scene);
      f.material = mats.grass;
      const k = 0.8 + rng() * 0.4;
      tint(f, k, k * 1.15, k * 0.8);
      const ang = (i / fronds) * Math.PI * 2 + rng() * 0.5;
      f.position.set(Math.cos(ang) * 0.12, 0.22, Math.sin(ang) * 0.12);
      f.rotation.z = Math.cos(ang) * 0.8;
      f.rotation.x = -Math.sin(ang) * 0.8;
      parts.push({
        mesh: f,
        color: grassColor,
        sway: { amp: 0.8, yMin: -fh / 2, yMax: fh / 2 },
      });
    }
  } else {
    const bushColor = mats.bushLeaf.albedoColor;
    const gSeg = [6, 4, 3][detail];
    for (let i = 0; i < 3; i++) {
      const gd = 0.35 + rng() * 0.25;
      const g = MeshBuilder.CreateSphere(`pl_g${i}`, { diameter: gd, segments: gSeg }, scene);
      g.material = mats.bushLeaf;
      const k = 0.9 + rng() * 0.3;
      tint(g, k, k * 1.1, k * 0.85);
      jitter(g, 151 + i + v * 7, 0.12);
      g.scaling.set(1, 0.5, 1);
      const ang = rng() * Math.PI * 2;
      g.position.set(Math.cos(ang) * 0.18, 0.12, Math.sin(ang) * 0.18);
      parts.push({
        mesh: g,
        color: bushColor,
        sway: { amp: 0.45, yMin: -gd / 2, yMax: gd / 2 },
      });
    }
  }
  return parts;
}

/**
 * Builds the raw prototype geometry for one (kind, variant) pair: parts are
 * merged into a single vertex-coloured geometry that chunk bakers reuse.
 */
function buildPrototype(
  scene: Scene,
  kind: string,
  variant: number,
  mats: SharedMaterials,
  detail: 0 | 1 | 2 = 0,
): ProtoGeo | null {
  let parts: Part[] | null;
  switch (kind) {
    case 'tree':
      parts = buildBroadleaf(scene, mats, variant, detail);
      break;
    case 'pine':
      parts = buildPine(scene, mats, variant, detail);
      break;
    case 'rock':
      parts = buildRock(scene, mats, variant, detail);
      break;
    case 'bush':
      parts = buildBush(scene, mats, variant, detail);
      break;
    case 'grass':
      parts = buildGrass(scene, mats, variant);
      break;
    case 'flower':
      parts = buildFlower(scene, mats, variant);
      break;
    case 'plant':
      parts = buildPlant(scene, mats, variant, detail);
      break;
    default:
      return null;
  }
  return mergeProtoGeo(parts);
}
