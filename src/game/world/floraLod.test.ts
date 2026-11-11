import { afterAll, describe, expect, it } from 'vitest';
import { NullEngine, PBRMaterial, Scene, VertexBuffer } from '@babylonjs/core';
import {
  FLORA_CHUNK_SIZE,
  FLORA_LOD_FAR,
  FLORA_LOD_HI,
  FLORA_LOD_MID,
  FLORA_SHADOW_RADIUS,
  genPlacements,
  populateFlora,
} from './flora';
import { TERRAIN_SIZE } from './terrain';
import { SharedWorldState } from './worldState';
import type { SharedMaterials } from '../visual/materials';

/** Kinds that own mid + low detail twins (mirrors flora.ts LOD_KINDS). */
const LOD_KINDS = ['tree', 'pine', 'rock', 'bush', 'plant'] as const;

const verts = (m: { getVerticesData: (k: string) => unknown }) =>
  ((m.getVerticesData(VertexBuffer.PositionKind) as Float32Array) ?? new Float32Array(0)).length / 3;

/** World XZ centre of a chunk column/row (same formula as flora.ts). */
const center = (i: number) => i * FLORA_CHUNK_SIZE + FLORA_CHUNK_SIZE / 2 - TERRAIN_SIZE / 2;

/** Clamp a chunk index into the 5x5 tile (same as floraChunk). */
const clampIdx = (i: number) => Math.min(4, Math.max(0, i));

/** Chunk indices for a world position (same formula as floraChunk). */
function chunkOf(x: number, z: number): { cx: number; cz: number } {
  return {
    cx: clampIdx(Math.floor((x + TERRAIN_SIZE / 2) / FLORA_CHUNK_SIZE)),
    cz: clampIdx(Math.floor((z + TERRAIN_SIZE / 2) / FLORA_CHUNK_SIZE)),
  };
}

/** Parse `flora_<kind>_c<cx>_<cz>[_mid|_lo]` back into its coordinates. */
function parseChunk(name: string): { kind: string; cx: number; cz: number; suffix: '' | '_mid' | '_lo' } {
  const m = /^flora_(\w+)_c(\d+)_(\d+)(_mid|_lo)?$/.exec(name);
  if (!m) throw new Error(`unparseable chunk name: ${name}`);
  return { kind: m[1], cx: Number(m[2]), cz: Number(m[3]), suffix: (m[4] ?? '') as '' | '_mid' | '_lo' };
}

function mkWorld() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const material = new PBRMaterial('m', scene);
  material.roughness = 0.9;
  material.metallic = 0;
  const mats = Object.fromEntries(
    ['bark', 'leaf', 'pineLeaf', 'rock', 'bushLeaf', 'berry', 'grass', 'flower'].map((k) => [k, material]),
  ) as unknown as SharedMaterials;
  const state = new SharedWorldState();
  const handle = populateFlora(scene, mats, state, []);
  return { engine, scene, state, handle };
}

// One shared world for the cheap structural/behaviour tests (building it is
// the expensive part — ~5 s). Determinism gets its own fresh worlds.
describe('flora three-tier distance LOD', () => {
  const { engine, scene, state, handle } = mkWorld();

  afterAll(() => engine.dispose());

  const hiMeshes = () => scene.meshes.filter((m) => m.name.startsWith('flora_') && parseChunk(m.name).suffix === '');
  const midMeshes = () => scene.meshes.filter((m) => m.name.startsWith('flora_') && m.name.endsWith('_mid'));
  const loMeshes = () => scene.meshes.filter((m) => m.name.startsWith('flora_') && m.name.endsWith('_lo'));

  it('every LOD-kind chunk has hi + mid + lo; grass/flower stay single-mesh', () => {
    for (const m of hiMeshes()) {
      const { kind } = parseChunk(m.name);
      const mid = scene.meshes.find((x) => x.name === `${m.name}_mid`);
      const lo = scene.meshes.find((x) => x.name === `${m.name}_lo`);
      if ((LOD_KINDS as readonly string[]).includes(kind)) {
        expect(mid, `missing mid twin for ${m.name}`).toBeDefined();
        expect(lo, `missing lo twin for ${m.name}`).toBeDefined();
      } else {
        expect(mid, `unexpected mid twin for ${m.name}`).toBeUndefined();
        expect(lo, `unexpected lo twin for ${m.name}`).toBeUndefined();
      }
    }
    expect(hiMeshes().length).toBeGreaterThan(0);
    expect(midMeshes().length).toBeGreaterThan(0);
    expect(loMeshes().length).toBeGreaterThan(0);
    // Every mid/lo twin pairs 1:1 with its hi mesh.
    for (const suffix of ['_mid', '_lo']) {
      const twins = scene.meshes.filter((m) => m.name.endsWith(suffix));
      expect(new Set(twins.map((m) => m.name.slice(0, -suffix.length))).size).toBe(twins.length);
    }
  });

  it('the world starts in high detail: all hi enabled, mid + lo disabled', () => {
    for (const m of hiMeshes()) expect(m.isEnabled()).toBe(true);
    for (const m of midMeshes()) expect(m.isEnabled()).toBe(false);
    for (const m of loMeshes()) expect(m.isEnabled()).toBe(false);
  });

  it('detail hierarchy: mid < hi and lo < mid (strict for tree/pine/rock/bush)', () => {
    for (const m of midMeshes()) {
      const hi = scene.meshes.find((x) => x.name === m.name.slice(0, -4))!;
      const lo = scene.meshes.find((x) => x.name === m.name.slice(0, -4) + '_lo')!;
      const { kind } = parseChunk(m.name);
      if (kind === 'plant') {
        // plant variant 0 (fronds) is already minimal: a frond-only chunk may
        // be identical across levels.
        expect(verts(m)).toBeLessThanOrEqual(verts(hi));
        expect(verts(lo)).toBeLessThanOrEqual(verts(m));
      } else {
        expect(verts(m), `${m.name} mid not lighter than hi`).toBeLessThan(verts(hi));
        expect(verts(lo), `${m.name} lo not lighter than mid`).toBeLessThan(verts(m));
      }
    }
  });

  it('three levels by distance: hi < MID < mid < hysteresis < lo', () => {
    const someTree = hiMeshes().find((m) => parseChunk(m.name).kind === 'tree')!;
    const { cx, cz } = parseChunk(someTree.name);
    const mid = scene.meshes.find((x) => x.name === `${someTree.name}_mid`)!;
    const lo = scene.meshes.find((x) => x.name === `${someTree.name}_lo`)!;
    const dHi = Math.round((FLORA_LOD_HI + FLORA_LOD_MID) / 2); // 130
    const dBand = Math.round((FLORA_LOD_MID + FLORA_LOD_FAR) / 2); // 180
    const dLo = FLORA_LOD_FAR + 40; // 250

    // Far -> lo, then approaching: band keeps lo, mid zone -> mid, close -> hi.
    handle.updateLod({ x: center(cx) + dLo, z: center(cz) });
    expect(lo.isEnabled()).toBe(true);
    handle.updateLod({ x: center(cx) + dBand, z: center(cz) });
    expect(lo.isEnabled()).toBe(true); // hysteresis from lo
    handle.updateLod({ x: center(cx) + dHi, z: center(cz) });
    expect(mid.isEnabled()).toBe(true);
    expect(someTree.isEnabled()).toBe(false);
    expect(lo.isEnabled()).toBe(false);
    handle.updateLod({ x: center(cx), z: center(cz) });
    expect(someTree.isEnabled()).toBe(true);
    expect(mid.isEnabled()).toBe(false);
    expect(lo.isEnabled()).toBe(false);

    // And leaving: band keeps hi, mid zone -> mid, far -> lo.
    handle.updateLod({ x: center(cx) + dBand, z: center(cz) });
    expect(someTree.isEnabled()).toBe(true); // hysteresis from hi
    handle.updateLod({ x: center(cx) + dHi, z: center(cz) });
    expect(mid.isEnabled()).toBe(true);
    handle.updateLod({ x: center(cx) + dLo, z: center(cz) });
    expect(lo.isEnabled()).toBe(true);
  });

  it('exactly one detail level is active per LOD chunk, always', () => {
    for (const dx of [-2000, -500, 0, 120, 180, 300]) {
      for (const dz of [-2000, -500, 0, 120, 180, 300]) {
        handle.updateLod({ x: dx, z: dz });
        for (const m of hiMeshes()) {
          const { kind } = parseChunk(m.name);
          if (!(LOD_KINDS as readonly string[]).includes(kind)) continue;
          const mid = scene.meshes.find((x) => x.name === `${m.name}_mid`)!;
          const lo = scene.meshes.find((x) => x.name === `${m.name}_lo`)!;
          const active = (m.isEnabled() ? 1 : 0) + (mid.isEnabled() ? 1 : 0) + (lo.isEnabled() ? 1 : 0);
          expect(active, `${m.name} at cam(${dx},${dz})`).toBe(1);
        }
      }
    }
  });

  it('harvest re-bake rebuilds ALL detail levels and preserves the active LOD mode', () => {
    // Move the world to the lo state first.
    handle.updateLod({ x: -2000, z: -2000 });
    const tree = state.nodes.find((n) => n.kind === 'tree')!;
    const { cx, cz } = chunkOf(tree.x, tree.z);
    const hi = scene.meshes.find((m) => m.name === `flora_tree_c${cx}_${cz}`)!;
    const mid = scene.meshes.find((x) => x.name === `${hi.name}_mid`)!;
    const lo = scene.meshes.find((x) => x.name === `${hi.name}_lo`)!;
    expect(lo.isEnabled()).toBe(true); // far state
    const midBefore = verts(mid);
    const loBefore = verts(lo);
    const hiBefore = verts(hi);

    state.damageNode(tree.id, 99); // deplete
    handle.applyState();

    const hiAfter = scene.meshes.find((x) => x.name === hi.name);
    const midAfter = scene.meshes.find((x) => x.name === mid.name);
    const loAfter = scene.meshes.find((x) => x.name === lo.name);
    expect(hiAfter, 'hi mesh re-baked under the same name').toBeDefined();
    expect(midAfter, 'mid mesh re-baked under the same name').toBeDefined();
    expect(loAfter, 'lo mesh re-baked under the same name').toBeDefined();
    // The depleted instance is gone from ALL levels.
    if (hiBefore > 0) expect(verts(hiAfter!)).toBeLessThan(hiBefore);
    expect(verts(midAfter!)).toBeLessThan(midBefore);
    expect(verts(loAfter!)).toBeLessThan(loBefore);
    // Mode survived the re-bake: lo stays active, hi + mid disabled.
    expect(loAfter!.isEnabled()).toBe(true);
    expect(hiAfter!.isEnabled()).toBe(false);
    expect(midAfter!.isEnabled()).toBe(false);
  });

  it('re-bake of a chunk in any mode never leaves another level enabled (no one-frame double render)', () => {
    // The world starts in hi mode; a partial harvest re-bakes the chunk.
    // New Babylon meshes are enabled by default, so the re-bake must switch
    // the fresh mid/lo twins off explicitly.
    const tree = state.nodes.find((n) => n.kind === 'tree')!;
    state.damageNode(tree.id, Math.max(1, Math.floor(tree.maxHp / 4))); // visible, chunk re-bakes
    handle.applyState();

    for (const m of hiMeshes()) {
      const { kind } = parseChunk(m.name);
      if (!(LOD_KINDS as readonly string[]).includes(kind)) continue;
      const mid = scene.meshes.find((x) => x.name === `${m.name}_mid`)!;
      const lo = scene.meshes.find((x) => x.name === `${m.name}_lo`)!;
      const active = (m.isEnabled() ? 1 : 0) + (mid.isEnabled() ? 1 : 0) + (lo.isEnabled() ? 1 : 0);
      expect(active, `${m.name} must have exactly one detail level active after hi-mode re-bake`).toBe(1);
    }
  });

  it('keeps the full placement density: every placement still has its hi chunk mesh', () => {
    const placements = genPlacements();
    for (const p of placements) {
      const { cx, cz } = chunkOf(p.x, p.z);
      const real = `flora_${p.kind}_c${cx}_${cz}`;
      expect(scene.meshes.some((m) => m.name === real), `missing ${real}`).toBe(true);
    }
  });

  it('updateLod is cheap (allocation-free per-frame path, O(chunks))', () => {
    // Warm up, then 2000 updates with a moving camera. The threshold is
    // generous (5 ms/sweep) so noisy/loaded CI machines don't flake — a real
    // regression (e.g. per-instance iteration) would exceed it by ~100x.
    let t0 = performance.now();
    for (let i = 0; i < 2000; i++) {
      handle.updateLod({ x: Math.cos(i * 0.01) * 300, z: Math.sin(i * 0.01) * 300 });
    }
    const ms = performance.now() - t0;
    expect(ms / 2000).toBeLessThan(5);
  });
});

describe('flora shadow-caster proximity culling', () => {
  const { engine, scene, handle } = mkWorld();

  afterAll(() => engine.dispose());

  const enabled = () => scene.meshes.filter((m) => m.name.startsWith('flora_') && m.isEnabled());

  it('returns only currently-enabled LOD meshes within FLORA_SHADOW_RADIUS of the point', () => {
    handle.updateLod({ x: -2000, z: -2000 }); // far state: lo everywhere
    const px = 0;
    const pz = 0; // dense island centre: guarantees non-empty casters
    const casters = handle.shadowCasters(px, pz);
    expect(casters.length, 'dense centre must have in-range casters').toBeGreaterThan(0);
    const r2 = FLORA_SHADOW_RADIUS * FLORA_SHADOW_RADIUS;
    const byName = new Map(scene.meshes.map((m) => [m.name, m]));

    for (const m of casters) {
      expect(m.isEnabled(), `${m.name} is not enabled`).toBe(true);
      const { cx, cz } = parseChunk(m.name);
      const dx = px - center(cx);
      const dz = pz - center(cz);
      expect(dx * dx + dz * dz, `${m.name} outside shadow radius`).toBeLessThanOrEqual(r2 + 1e-9);
    }

    // Completeness: every enabled chunk whose centre is in range is present,
    // and only its ACTIVE (enabled) mesh — the disabled twins never are.
    const castersByName = new Set(casters.map((m) => m.name));
    for (const m of enabled()) {
      const { cx, cz } = parseChunk(m.name);
      const dx = px - center(cx);
      const dz = pz - center(cz);
      if (dx * dx + dz * dz <= r2) {
        expect(castersByName.has(m.name), `missing enabled in-range caster ${m.name}`).toBe(true);
      }
    }
    for (const m of scene.meshes.filter((x) => x.name.startsWith('flora_') && !x.isEnabled())) {
      expect(byName.get(m.name)).toBeDefined();
      expect(castersByName.has(m.name), `disabled caster leaked: ${m.name}`).toBe(false);
    }
  });

  it('tracks the LOD level: nearby chunks cast their hi mesh, far ones their lo mesh', () => {
    // Park at the centre of a tree chunk (distance 0 -> hi).
    const someTree = scene.meshes.find((m) => m.name.startsWith('flora_tree_') && !m.name.includes('_mid') && !m.name.endsWith('_lo'))!;
    const { cx, cz } = parseChunk(someTree.name);
    const px = center(cx);
    const pz = center(cz);
    handle.updateLod({ x: px, z: pz });
    const casters = handle.shadowCasters(px, pz);
    const names = new Set(casters.map((m) => m.name));
    const tree = scene.meshes.find((m) => m.name === `flora_tree_c${cx}_${cz}`)!;
    expect(names.has(tree.name), 'own tree chunk casts its hi mesh').toBe(true);

    // The same chunk 250 u away (far) must then cast its lo twin instead.
    const q = { x: px + 250, z: pz };
    handle.updateLod(q);
    const far = new Set(handle.shadowCasters(q.x, q.z).map((m) => m.name));
    const treeLo = scene.meshes.find((m) => m.name === `flora_tree_c${cx}_${cz}_lo`)!;
    if (Math.hypot(q.x - center(cx), q.z - center(cz)) <= FLORA_SHADOW_RADIUS) {
      expect(far.has(treeLo.name), 'far tree chunk casts its lo mesh').toBe(true);
      expect(far.has(tree.name)).toBe(false);
    }
  });

  it('a moving camera changes the caster set between distant positions', () => {
    handle.updateLod({ x: -2000, z: -2000 });
    // Deterministically pick two chunk centres ≥180 u apart that both own
    // flora, so the assertion is stable regardless of corner sparseness.
    const centers: Array<{ x: number; z: number }> = [];
    for (let cx = 0; cx < 5; cx++)
      for (let cz = 0; cz < 5; cz++) centers.push({ x: center(cx), z: center(cz) });
    const p1 = centers[12]; // centre of the 5x5 tile (dense spawn area)
    const nonEmpty = (p: { x: number; z: number }) => handle.shadowCasters(p.x, p.z).length > 0;
    const p2 = centers.find((c) => Math.hypot(c.x - p1.x, c.z - p1.z) > 180 && nonEmpty(c))!;
    expect(p2, 'a non-empty chunk ≥180 u from the centre').toBeDefined();

    const a = new Set(handle.shadowCasters(p1.x, p1.z).map((m) => m.name));
    const b = new Set(handle.shadowCasters(p2.x, p2.z).map((m) => m.name));
    // The positions are >180 u apart (> FLORA_SHADOW_RADIUS): most casters differ.
    const shared = [...a].filter((n) => b.has(n)).length;
    expect(shared).toBeLessThan(Math.min(a.size, b.size));
    expect(a.size).toBeGreaterThan(0);
    expect(b.size).toBeGreaterThan(0);
    // Every returned mesh is a real, live scene mesh.
    const names = new Set(scene.meshes.map((m) => m.name));
    for (const n of [...a, ...b]) expect(names.has(n), `unknown mesh ${n}`).toBe(true);
  });
});

describe('flora LOD determinism', () => {
  it('identical seeds yield identical hi, mid AND lo chunk vertex counts and node ids', () => {
    const a = mkWorld();
    const b = mkWorld();

    const snap = (w: ReturnType<typeof mkWorld>) =>
      new Map(w.scene.meshes.filter((m) => m.name.startsWith('flora_')).map((c) => [c.name, verts(c)]));
    const mapA = snap(a);
    const mapB = snap(b);
    expect(mapA.size).toBe(mapB.size);
    expect(mapA.size).toBeGreaterThan(0);
    for (const [n, v] of mapA) expect(mapB.get(n), n).toBe(v);

    expect(JSON.stringify(a.state.nodes.map((n) => n.id))).toBe(JSON.stringify(b.state.nodes.map((n) => n.id)));

    a.engine.dispose();
    b.engine.dispose();
  }, 20000);
});
