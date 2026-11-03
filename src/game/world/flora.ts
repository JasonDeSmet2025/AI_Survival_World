import {
  AbstractMesh,
  Color3,
  Mesh,
  MeshBuilder,
  Quaternion,
  Scene,
  StandardMaterial,
  Vector3,
  VertexBuffer,
  VertexData,
} from '@babylonjs/core';
import type { ResourceNode, Collider } from './types';
import type { SharedWorldState } from './worldState';
import { fbm, hash2, mulberry32, smoothstep } from '../core/noise';
import {
  TERRAIN_SIZE,
  terrainHeight,
  terrainNormal,
  terrainSlope,
  SEA_LEVEL,
  WORLD_SEED,
  isNearLake,
} from './terrain';
import type { SharedMaterials } from '../visual/materials';

export interface FloraHandle {
  /** Apply depleted/damaged state to the visual instances. */
  applyState(): void;
  nodeCount: number;
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
    },
  ): void => {
    const variants = FLORA_VARIANTS[kind];
    for (const c of cands) {
      const y = terrainHeight(c.x, c.z);
      if (y < o.minH || y > o.maxH) continue;
      const slope = terrainSlope(c.x, c.z);
      if (o.maxSlope !== undefined && slope > o.maxSlope) continue;
      if (o.lakePad !== undefined && isNearLake(c.x, c.z, o.lakePad)) continue;
      if (!clear(c.x, c.z, o.radius)) continue;
      const variant = o.variantPick ? o.variantPick(y, slope) : Math.floor(rng() * variants);
      out.push({
        x: c.x,
        z: c.z,
        y,
        kind,
        radius: o.radius,
        maxHp: o.maxHp,
        scale: o.minScale + rng() * (o.maxScale - o.minScale),
        variant,
        rotY: rng() * Math.PI * 2,
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
      minScale: 0.7,
      maxScale: 1.6,
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
    },
  );

  return out;
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

/** Populate the scene with instanced, varied flora (see genPlacements). */
export function populateFlora(
  scene: Scene,
  mats: SharedMaterials,
  state: SharedWorldState,
  colliders: Collider[],
  keepOut: Array<{ x: number; z: number; r: number }> = [],
): FloraHandle {
  const placements = genPlacements(keepOut);

  // Group by (kind, variant) so each visual variant is one prototype.
  const groups = new Map<string, Placement[]>();
  for (const p of placements) {
    const key = `${p.kind}:${p.variant}`;
    const arr = groups.get(key) ?? [];
    arr.push(p);
    groups.set(key, arr);
  }

  interface Visual {
    inst: AbstractMesh;
    node: ResourceNode | null;
    baseScale: number;
  }
  const visuals: Visual[] = [];
  const nodeCounter: Record<string, number> = {};
  const floraMaterial = createFloraMaterial(scene);

  for (const [key, list] of groups) {
    const [kind, vStr] = key.split(':');
    const variant = Number(vStr);
    const proto = buildPrototype(scene, kind, variant, mats, floraMaterial);
    if (!proto) continue;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const inst = proto.createInstance(`${kind}_${variant}_${i}`);
      const s = p.scale;
      inst.scaling.set(s, s, s);
      const sink = kind === 'tree' || kind === 'pine' ? 0.15 * s : 0;
      inst.position.set(p.x, p.y - sink, p.z);

      if (kind === 'tree' || kind === 'pine' || kind === 'rock' || kind === 'bush') {
        // Lean with the terrain, then apply the per-instance yaw.
        const n = terrainNormal(p.x, p.z);
        const tilt = new Quaternion();
        Quaternion.FromUnitVectorsToRef(new Vector3(0, 1, 0), n, tilt);
        const yaw = new Quaternion();
        Quaternion.RotationYawPitchRollToRef(p.rotY, 0, 0, yaw);
        inst.rotationQuaternion = tilt.multiply(yaw);
      } else {
        inst.rotation.y = p.rotY;
      }

      let node: ResourceNode | null = null;
      if (p.kind === 'tree' || p.kind === 'pine' || p.kind === 'rock' || p.kind === 'bush') {
        const c = (nodeCounter[p.kind] = (nodeCounter[p.kind] ?? 0) + 1);
        node = {
          id: `n_${p.kind}_${c}`,
          kind: p.kind,
          x: p.x,
          z: p.z,
          y: p.y,
          radius: p.radius,
          hp: p.maxHp,
          maxHp: p.maxHp,
        };
        state.registerNode(node);
        if (p.kind === 'rock') colliders.push({ x: p.x, z: p.z, radius: 1.1 });
      }
      visuals.push({ inst, node, baseScale: s });
    }
  }

  return {
    nodeCount: state.nodes.length,
    applyState(): void {
      for (const v of visuals) {
        if (!v.node) continue;
        const hp = state.hp[v.node.id] ?? v.node.maxHp;
        if (hp <= 0 || state.isDepleted(v.node.id)) {
          v.inst.setEnabled(false);
        } else {
          v.inst.setEnabled(true);
          // Visual damage feedback: shrink as hp drops.
          const k = v.baseScale * (0.62 + 0.38 * (hp / v.node.maxHp));
          v.inst.scaling.set(k, k, k);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Prototype builders: each variant is procedurally distinct (shape, size,
// vertex jitter and per-part colour). Every variant is merged into a SINGLE
// mesh whose final colours are baked into the vertex-colour buffer, so a
// single shared material is enough and createInstance() truly shares one
// geometry (real GPU instancing).
// ---------------------------------------------------------------------------

interface Part {
  mesh: Mesh;
  /** Base diffuse colour of this part (from the shared materials). */
  color: Color3;
}

/** Shared flat lighting for all merged flora (vertex colours do the work). */
function createFloraMaterial(scene: Scene): StandardMaterial {
  const m = new StandardMaterial('floraMat', scene);
  m.diffuseColor = new Color3(1, 1, 1); // white: vertex colours carry the tint
  m.specularColor = new Color3(0.05, 0.05, 0.05);
  m.emissiveColor = new Color3(0, 0, 0);
  return m;
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
 * Merges a set of parts into one instanciable Mesh. Part transforms are
 * baked in and each vertex's final colour becomes `part.color * vertexTint`.
 * Source parts are disposed. The merged mesh is returned disabled, ready for
 * instancing, using the single shared `material`.
 */
function mergeParts(
  host: Mesh,
  parts: Part[],
  material: StandardMaterial,
): Mesh {
  const scene = host.getScene();
  const allPos: number[] = [];
  const allNrm: number[] = [];
  const allCol: number[] = [];
  const allIdx: number[] = [];
  let vertexOffset = 0;

  for (const { mesh, color } of parts) {
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
    for (let i = 0; i < pos.length; i += 3) {
      v.set(pos[i], pos[i + 1], pos[i + 2]);
      Vector3.TransformCoordinatesToRef(v, matrix, v);
      allPos.push(v.x, v.y, v.z);
      v.set(nrm[i] || 0, nrm[i + 1] || 0, nrm[i + 2] || 0);
      Vector3.TransformNormalToRef(v, matrix, v);
      v.normalize();
      allNrm.push(v.x, v.y, v.z);
      allCol.push(fr, fg, fb);
    }
    for (const ix of idx) allIdx.push(ix + vertexOffset);
    vertexOffset += count;
    mesh.dispose();
  }

  const vdata = new VertexData();
  vdata.positions = allPos;
  vdata.normals = allNrm;
  vdata.colors = allCol;
  vdata.indices = allIdx;

  const merged = new Mesh(host.name, scene);
  vdata.applyToMesh(merged);
  merged.material = material;

  host.dispose();
  merged.setEnabled(false);
  return merged;
}

function leafTint(v: number): Color3 {
  return [
    new Color3(0.3, 0.52, 0.2),
    new Color3(0.34, 0.6, 0.22),
    new Color3(0.27, 0.45, 0.18),
  ][v % 3];
}

function buildBroadleaf(scene: Scene, mats: SharedMaterials, v: number): Part[] {
  const rng = mulberry32((WORLD_SEED + 11 + v * 977) >>> 0);
  const parts: Part[] = [];

  const trunkH = 3.4 + v * 0.7 + rng() * 0.6;
  const trunk = MeshBuilder.CreateCylinder('bl_t', {
    height: trunkH,
    diameterTop: 0.4 + rng() * 0.12,
    diameterBottom: 0.62 + rng() * 0.18,
    tessellation: 7,
  }, scene);
  trunk.material = mats.bark;
  tint(trunk, 0.85 + rng() * 0.3, 0.85 + rng() * 0.2, 0.9 + rng() * 0.2);
  trunk.position.y = trunkH / 2;
  parts.push({ mesh: trunk, color: mats.bark.albedoColor });

  const canopyBase = trunkH * 0.82;
  const mainD = 3.2 + rng() * 1.2 + (v === 1 ? 0.9 : 0);
  const blobs = 2 + (v % 2);
  for (let i = 0; i <= blobs; i++) {
    const d = mainD * (i === 0 ? 1 : 0.55 + rng() * 0.2);
    const blob = MeshBuilder.CreateSphere(`bl_b${i}`, { diameter: d, segments: 8 }, scene);
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
    parts.push({ mesh: blob, color: mats.leaf.albedoColor });
  }
  return parts;
}

function buildPine(scene: Scene, mats: SharedMaterials, v: number): Part[] {
  const rng = mulberry32((WORLD_SEED + 29 + v * 811) >>> 0);
  const parts: Part[] = [];

  const tiers = v === 2 ? 3 : v === 1 ? 4 : 3;
  const trunkH = 1.8 + rng() * 0.9 + (v === 2 ? 0.6 : 0);
  const trunk = MeshBuilder.CreateCylinder('pn_t', {
    height: trunkH,
    diameterTop: 0.3 + rng() * 0.1,
    diameterBottom: 0.46 + rng() * 0.16,
    tessellation: 6,
  }, scene);
  trunk.material = mats.bark;
  tint(trunk, 0.8 + rng() * 0.3, 0.82 + rng() * 0.2, 0.9 + rng() * 0.2);
  trunk.position.y = trunkH / 2;
  parts.push({ mesh: trunk, color: mats.bark.albedoColor });

  let baseD = 2.6 + rng() * 0.7 - v * 0.45;
  let baseH = 2.4 + rng() * 0.6;
  let y = trunkH * 0.55;
  for (let t = 0; t < tiers; t++) {
    const cone = MeshBuilder.CreateCylinder(`pn_c${t}`, {
      height: baseH,
      diameterTop: 0.02,
      diameterBottom: baseD,
      tessellation: 8,
    }, scene);
    cone.material = mats.pineLeaf;
    const k = 0.85 + rng() * 0.3;
    tint(cone, k, k * (0.95 + rng() * 0.25), k);
    jitter(cone, 77 + t + v * 29, baseD * 0.08);
    cone.position.y = y + baseH / 2;
    parts.push({ mesh: cone, color: mats.pineLeaf.albedoColor });
    y += baseH * 0.55;
    baseD *= 0.72;
    baseH *= 0.82;
  }
  return parts;
}

function buildRock(scene: Scene, mats: SharedMaterials, v: number): Part[] {
  const rng = mulberry32((WORLD_SEED + 43 + v * 641) >>> 0);
  const parts: Part[] = [];
  const rockColor = mats.rock.albedoColor;

  const rock = (
    name: string,
    kind: 'sphere' | 'poly' | 'box',
    scale: [number, number, number],
    sink = 0.15,
  ): void => {
    let m: Mesh;
    if (kind === 'sphere') {
      m = MeshBuilder.CreateSphere(name, { diameter: 2, segments: 5 }, scene);
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
      rock('rk3', 'box', [1.3 + rng() * 0.4, 1.8 + rng() * 0.6, 0.7 + rng() * 0.2], 0.25);
      break;
  }
  return parts;
}

function buildBush(scene: Scene, mats: SharedMaterials, v: number): Part[] {
  const rng = mulberry32((WORLD_SEED + 61 + v * 517) >>> 0);
  const parts: Part[] = [];
  const bushColor = mats.bushLeaf.albedoColor;

  const blobs = v === 0 ? 3 : 4;
  for (let i = 0; i < blobs; i++) {
    const b = MeshBuilder.CreateSphere(`bu_${i}`, {
      diameter: i === 0 ? 1.5 + rng() * 0.5 : 0.8 + rng() * 0.5,
      segments: 7,
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
    parts.push({ mesh: b, color: bushColor });
  }
  const berryCount = v === 0 ? 4 : 3;
  for (let i = 0; i < berryCount; i++) {
    const berry = MeshBuilder.CreateSphere(`bu_b${i}`, { diameter: 0.16 + rng() * 0.1, segments: 5 }, scene);
    berry.material = mats.berry;
    const ang = rng() * Math.PI * 2;
    berry.position.set(Math.cos(ang) * 0.55, 0.7 + rng() * 0.5, Math.sin(ang) * 0.55);
    parts.push({ mesh: berry, color: mats.berry.albedoColor });
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
    parts.push({ mesh: blade, color: grassColor });
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
  parts.push({ mesh: stem, color: grassColor });

  const head = MeshBuilder.CreateSphere('fl_h', {
    diameter: 0.16 + rng() * 0.1,
    segments: 5,
  }, scene);
  head.material = mats.flower;
  // flower material is white; bake the head colour directly as the tint.
  tint(head, c.r / flowerColor.r, c.g / flowerColor.g, c.b / flowerColor.b);
  head.position.y = stemH + 0.08;
  parts.push({ mesh: head, color: flowerColor });
  return parts;
}

function buildPlant(scene: Scene, mats: SharedMaterials, v: number): Part[] {
  const rng = mulberry32((WORLD_SEED + 131 + v * 433) >>> 0);
  const parts: Part[] = [];
  if (v === 0) {
    const grassColor = mats.grass.albedoColor;
    const fronds = 6;
    for (let i = 0; i < fronds; i++) {
      const f = MeshBuilder.CreateCylinder(`pl_f${i}`, {
        height: 0.45 + rng() * 0.3,
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
      parts.push({ mesh: f, color: grassColor });
    }
  } else {
    const bushColor = mats.bushLeaf.albedoColor;
    for (let i = 0; i < 3; i++) {
      const g = MeshBuilder.CreateSphere(`pl_g${i}`, { diameter: 0.35 + rng() * 0.25, segments: 6 }, scene);
      g.material = mats.bushLeaf;
      const k = 0.9 + rng() * 0.3;
      tint(g, k, k * 1.1, k * 0.85);
      jitter(g, 151 + i + v * 7, 0.12);
      g.scaling.set(1, 0.5, 1);
      const ang = rng() * Math.PI * 2;
      g.position.set(Math.cos(ang) * 0.18, 0.12, Math.sin(ang) * 0.18);
      parts.push({ mesh: g, color: bushColor });
    }
  }
  return parts;
}

/**
 * Builds one instanciable prototype for a (kind, variant) pair: parts are
 * merged into a single vertex-coloured mesh. Returns the disabled prototype
 * (never rendered directly).
 */
function buildPrototype(
  scene: Scene,
  kind: string,
  variant: number,
  mats: SharedMaterials,
  material: StandardMaterial,
): Mesh | null {
  let parts: Part[] | null;
  switch (kind) {
    case 'tree':
      parts = buildBroadleaf(scene, mats, variant);
      break;
    case 'pine':
      parts = buildPine(scene, mats, variant);
      break;
    case 'rock':
      parts = buildRock(scene, mats, variant);
      break;
    case 'bush':
      parts = buildBush(scene, mats, variant);
      break;
    case 'grass':
      parts = buildGrass(scene, mats, variant);
      break;
    case 'flower':
      parts = buildFlower(scene, mats, variant);
      break;
    case 'plant':
      parts = buildPlant(scene, mats, variant);
      break;
    default:
      return null;
  }
  const host = new Mesh(`${kind}_${variant}_proto`, scene);
  return mergeParts(host, parts, material);
}
