import { describe, it, expect } from 'vitest';
import { Color3, DirectionalLight, NullEngine, Scene, ShadowGenerator, StandardMaterial, Vector3 } from '@babylonjs/core';
import {
  TERRAIN_SIZE,
  SEA_LEVEL,
  WORLD_SEED,
  terrainHeight,
  terrainSlope,
  terrainNormal,
  isNearLake,
  findSpawnPoint,
  findCampPoint,
  createTerrain,
  createSeaPlane,
  dumpTerrainGLSL,
  SEA_PLANE_DEPTH,
  TERRAIN_CHUNK_SIZE,
  buildTerrainChunks,
} from './terrain';
import { buildTerrainGrid, terrainGridLayout } from './heightfield';
import { TERRAIN_SIZE as HF_SIZE, SEA_LEVEL as HF_SEA } from './heightfield';

describe('terrain module API', () => {
  it('re-exports the deterministic world API from the heightfield', () => {
    expect(TERRAIN_SIZE).toBe(HF_SIZE);
    expect(SEA_LEVEL).toBe(HF_SEA);
    expect(SEA_LEVEL).toBe(0);
    expect(WORLD_SEED).toBeGreaterThan(0);
  });

  it('exposes the world functions as callable values', () => {
    for (const fn of [
      terrainHeight,
      terrainSlope,
      terrainNormal,
      isNearLake,
      findSpawnPoint,
      findCampPoint,
      createTerrain,
      createSeaPlane,
    ]) {
      expect(typeof fn).toBe('function');
    }
  });

  it('terrainNormal returns a unit Vector3 with an upward component', () => {
    const n = terrainNormal(20, -30);
    expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 4);
    expect(n.y).toBeGreaterThan(0);
  });
});

describe('terrain colour pipeline', () => {
  it('mirrors the scene image-processing settings into the terrain shader', async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogDensity = 0.0022;
    scene.fogColor = new Color3(0.62, 0.75, 0.85);

    const terrain = createTerrain(scene);
    const material = terrain.material;
    const floats = (material as unknown as { _floats: Record<string, number> })._floats;
    const vec4s = (material as unknown as { _vectors4: Record<string, { w: number }> })._vectors4;

    // Already mirrored at creation (before the first frame).
    expect(floats.exposureLinear).toBe(scene.imageProcessingConfiguration.exposure);
    expect(floats.contrastValue).toBe(scene.imageProcessingConfiguration.contrast);
    expect(floats.fogDensity).toBeCloseTo(0.0022, 6);

    // The lighting system animates exposure each frame; the shader must
    // follow through the onBeforeRender hook.
    scene.imageProcessingConfiguration.exposure = 0.9;
    scene.imageProcessingConfiguration.ditheringEnabled = true;
    scene.imageProcessingConfiguration.ditheringIntensity = 1 / 255;
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(floats.exposureLinear).toBeCloseTo(0.9, 6);
    expect(floats.ditherIntensity).toBeCloseTo(0.5 / 255, 10);
    // Vignette disabled by default on a bare scene => power 0 (no-op).
    expect(vec4s.vignetteSettings2.w).toBe(0);

    // Dispose removes the sync observers (v9 finalises removal async).
    terrain.dispose();
    await new Promise((r) => setTimeout(r, 5));
    expect(scene.onBeforeRenderObservable.observers.length).toBe(0);

    scene.dispose();
    engine.dispose();
  });
});

describe('terrain shadow receive', () => {
  it('GLSL: vertex projects into the shadow camera, fragment samples the BSM map', () => {
    const [vert, frag] = dumpTerrainGLSL().split('\n----------------\n');
    // Shared varyings must match between the two stages.
    for (const v of ['varying vec4 vShadowPos;', 'varying float vShadowDepthMetric;']) {
      expect(vert).toContain(v);
      expect(frag).toContain(v);
    }
    expect(vert).toContain('vShadowPos = shadowLightMatrix * wp;');
    // The shadow functions include depends on getRand() from the engine's
    // helperFunctions include — both must be pulled in, helperFunctions
    // first (GLSL: used-before-defined is a compile error). Regression #26.
    expect(frag.indexOf('#include <helperFunctions>')).toBeGreaterThanOrEqual(0);
    expect(frag).toContain('#include <shadowsFragmentFunctions>');
    expect(frag.indexOf('#include <helperFunctions>')).toBeLessThan(frag.indexOf('#include <shadowsFragmentFunctions>'));
    expect(frag).toContain('float shadow = computeShadowWithESM(');
    // Only the DIRECT sun term is darkened; ambient/hemisphere stays full
    // so forest interiors keep readability.
    expect(frag).toContain('vec3 light = sunColor * (ndl * shadow) + amb;');
    // Baked per-vertex AO: declared as attribute in the vertex stage, passed
    // through the matching varying, multiplied into the surface colour.
    expect(vert).toContain('attribute float ao;');
    expect(vert).toContain('varying float vAO;');
    expect(vert).toContain('vAO = ao;');
    expect(frag).toContain('varying float vAO;');
    expect(frag).toContain('col *= vAO * vAO;');
  });

  it('material binds the shadow generator per frame (no-op default until one exists)', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const terrain = createTerrain(scene);
    const material = terrain.material;
    const floats = (material as unknown as { _floats: Record<string, number> })._floats;

    // No shadow generator yet: the safe no-op default (darkness=1 makes
    // computeShadowWithESM return exactly 1.0, even with an unbound sampler).
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(floats.shadowDarkness).toBe(1);

    // Once the lighting system's generator exists, the terrain follows it.
    const sun = new DirectionalLight('sun', new Vector3(0, -1, 0), scene);
    const gen = new ShadowGenerator(1024, sun);
    gen.useBlurExponentialShadowMap = true;
    gen.darkness = 0.35;
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(floats.shadowDarkness).toBeCloseTo(0.35, 6);

    const textures = (material as unknown as { _textures: Record<string, unknown> })._textures;
    const matrices = (material as unknown as { _matrices: Record<string, { m: number[] }> })._matrices;
    const vec2s = (material as unknown as { _vectors2: Record<string, { x: number; y: number }> })._vectors2;
    expect(textures.shadowSampler).toBe(gen.getShadowMapForRendering());
    expect(matrices.shadowLightMatrix).toBeDefined();
    // Directional light: depthValues = (minZ, minZ + maxZ) = (1, 2).
    expect(vec2s.shadowDepthValues.x).toBeCloseTo(1, 6);
    expect(vec2s.shadowDepthValues.y).toBeCloseTo(2, 6);

    terrain.dispose();
    scene.dispose();
    engine.dispose();
  }, 20000);
});

describe('terrain chunking (frustum-culled 128u tiles)', () => {
  const grid = buildTerrainGrid();
  const chunks = buildTerrainChunks(grid);
  const { samples, step } = terrainGridLayout();

  it('splits the 640u tile into a 5x5 grid of 128u chunks', () => {
    expect(TERRAIN_CHUNK_SIZE).toBe(128);
    expect(chunks.length).toBe(25);
    expect(chunks[0].cells).toBe(TERRAIN_CHUNK_SIZE / step);
    // Chunk names are deterministic and unique.
    const names = new Set(chunks.map((c) => c.name));
    expect(names.size).toBe(25);
    expect(chunks[0].name).toBe('terrain_c0_0');
    expect(chunks[24].name).toBe('terrain_c4_4');
  });

  it('chunk triangles are exactly the original grid: none added or lost', () => {
    const totalTris = chunks.reduce((s, c) => s + c.indices.length / 3, 0);
    expect(totalTris).toBe(grid.indices.length / 3);
    for (const c of chunks) {
      const L = c.cells + 1;
      expect(c.positions.length).toBe(L * L * 3);
      expect(c.colors.length).toBe(L * L * 4);
      expect(c.ao.length).toBe(L * L);
      expect(c.indices.length).toBe((L - 1) * (L - 1) * 6);
    }
  });

  it('every chunk vertex is byte-identical to its grid vertex (no drift)', () => {
    for (const c of chunks) {
      const L = c.cells + 1;
      // Spot-check: corners + strided interior.
      const probes: Array<[number, number]> = [];
      for (let lz = 0; lz < L; lz += 17) for (let lx = 0; lx < L; lx += 17) probes.push([lx, lz]);
      probes.push([0, 0], [L - 1, 0], [0, L - 1], [L - 1, L - 1]);
      for (const [lx, lz] of probes) {
        const gx = c.x0 + lx;
        const gz = c.z0 + lz;
        const src = (gz * samples + gx) * 3;
        const srcC = (gz * samples + gx) * 4; // grid colours are RGBA (stride 4)
        const dst = (lz * L + lx) * 3;
        const dstC = (lz * L + lx) * 4; // RGBA biome mask is stride 4
        expect(c.positions[dst]).toBe(grid.positions[src]);
        expect(c.positions[dst + 1]).toBe(grid.positions[src + 1]);
        expect(c.positions[dst + 2]).toBe(grid.positions[src + 2]);
        expect(c.normals[dst + 1]).toBe(grid.normals[src + 1]);
        // The full biome mask must land in its own RGBA slot (stride 4 —
        // Babylon's ColorKind). The old stride-3 copy scrambled every
        // colour after the first vertex of each row.
        expect(c.colors[dstC]).toBe(grid.colors[srcC]);
        expect(c.colors[dstC + 1]).toBe(grid.colors[srcC + 1]);
        expect(c.colors[dstC + 2]).toBe(grid.colors[srcC + 2]);
        expect(c.colors[dstC + 3]).toBe(grid.colors[srcC + 3]);
        // A valid biome mask: 4 channels in [0,1] summing to ~1.
        const sum = c.colors[dstC] + c.colors[dstC + 1] + c.colors[dstC + 2] + c.colors[dstC + 3];
        expect(sum).toBeGreaterThan(0.999);
        expect(sum).toBeLessThan(1.001);
        // AO is copied by value, bit for bit.
        expect(c.ao[dst / 3]).toBe(grid.ao[gz * samples + gx]);
      }
    }
  });

  it('shared boundary vertices are identical between neighbours (no seams)', () => {
    // Along the x=64 grid line: the right edge of chunk (0,0) must equal the
    // left edge of chunk (1,0), bit for bit — so the surface is continuous
    // and no crack or double-drawn triangle can appear between chunks.
    const a = chunks[0]; // terrain_c0_0
    const b = chunks[1]; // terrain_c1_0
    const L = a.cells + 1;
    for (let lz = 0; lz < L; lz++) {
      const srcA = (lz * L + L - 1) * 3;
      const srcB = (lz * L + 0) * 3;
      expect(a.positions[srcA]).toBe(b.positions[srcB]);
      expect(a.positions[srcA + 1]).toBe(b.positions[srcB + 1]);
      expect(a.positions[srcA + 2]).toBe(b.positions[srcB + 2]);
    }
  });

  it('chunk triangles only index vertices inside their own chunk', () => {
    for (const c of chunks) {
      const L = c.cells + 1;
      let ok = true;
      let maxIdx = 0;
      for (const i of c.indices) {
        if (i >= L * L) ok = false;
        if (i > maxIdx) maxIdx = i;
        const lx = i % L;
        const lz = Math.floor(i / L);
        if (c.x0 + lx < c.x0 || c.x0 + lx > c.x0 + c.cells) ok = false;
        if (c.z0 + lz < c.z0 || c.z0 + lz > c.z0 + c.cells) ok = false;
      }
      expect(ok).toBe(true);
      expect(maxIdx).toBeLessThan(L * L);
    }
  });
});

describe('terrain chunk rendering (NullEngine)', () => {
  it('creates one frozen mesh per chunk per LOD level, all sharing the single material', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const terrain = createTerrain(scene);
    // 25 hi chunks + 25 mid + 25 lo twins = 75 static meshes.
    const meshes = scene.meshes.filter((m) => m.name.startsWith('terrain_c'));
    expect(meshes.length).toBe(75);
    expect(terrain.meshes.length).toBe(25);
    expect(terrain.lodMeshes().length).toBe(75);
    // Mid/lo twins are named by suffix; the world starts in hi everywhere.
    const byName = new Map(meshes.map((m) => [m.name, m]));
    for (let cz = 0; cz < 5; cz++) {
      for (let cx = 0; cx < 5; cx++) {
        expect(byName.get(`terrain_c${cx}_${cz}`)?.isEnabled()).toBe(true);
        expect(byName.get(`terrain_c${cx}_${cz}_mid`)).toBeDefined();
        expect(byName.get(`terrain_c${cx}_${cz}_mid`)?.isEnabled()).toBe(false);
        expect(byName.get(`terrain_c${cx}_${cz}_lo`)).toBeDefined();
        expect(byName.get(`terrain_c${cx}_${cz}_lo`)?.isEnabled()).toBe(false);
      }
    }
    // Single shared material instance -> one shader program for all chunks.
    expect(new Set(terrain.meshes.map((m) => m.material)).size).toBe(1);
    expect(terrain.meshes[0].material).toBe(terrain.material);
    // The ground must remain visible from beneath hills instead of exposing
    // the sky through culled back faces.
    expect(terrain.material.backFaceCulling).toBe(false);
    // Accurate per-chunk culling: sphere-then-box, not the v9 sphere-only default
    // (which would leave nearly every chunk active from most viewpoints).
    expect(terrain.meshes[0].cullingStrategy).toBe(0); // AbstractMesh.CULLINGSTRATEGY_STANDARD
    // Per-chunk bounding boxes are populated (frustum culling needs them).
    for (const m of terrain.lodMeshes()) {
      const bb = m.getBoundingInfo().boundingBox;
      expect(Number.isFinite(bb.minimumWorld.x)).toBe(true);
      expect(bb.minimumWorld.x).toBeLessThan(bb.maximumWorld.x);
      expect(bb.minimumWorld.z).toBeLessThan(bb.maximumWorld.z);
    }
    // Every chunk mesh carries the full vertex payload (position/normal/color/ao).
    for (const m of terrain.meshes) {
      expect(m.getVerticesData('position')).not.toBeNull();
      expect(m.getVerticesData('normal')).not.toBeNull();
      expect(m.getVerticesData('color')).not.toBeNull();
      const ao = m.getVerticesData('ao') as Float32Array;
      expect(ao).not.toBeNull();
      // AO values must be finite, in range, and the material must bind the
      // attribute (a missing 'ao' entry would render with an unbound attr).
      for (let i = 0; i < ao.length; i += 997) {
        expect(Number.isFinite(ao[i])).toBe(true);
        expect(ao[i]).toBeGreaterThanOrEqual(0.3);
        expect(ao[i]).toBeLessThanOrEqual(1);
      }
      // (v9.33 keeps the option list on `_options.attributes`).
      const mat = terrain.material as unknown as { _options?: { attributes?: string[] } };
      expect(mat._options?.attributes ?? []).toContain('ao');
    }
    terrain.dispose();
    expect(scene.meshes.filter((m) => m.name.startsWith('terrain_c')).length).toBe(0);
    scene.dispose();
    engine.dispose();
  });

  it('chunk geometry is deterministic across scenes (all three LOD levels)', () => {
    const build = () => {
      const engine = new NullEngine();
      const scene = new Scene(engine);
      const terrain = createTerrain(scene);
      const summary = terrain.lodMeshes()
        .map((m) => {
          const pos = m.getVerticesData('position') as Float32Array;
          const idx = m.getIndices() as Uint32Array;
          // Signature: vertex count + strided position/height/index samples.
          let sig = 0;
          for (let i = 0; i < pos.length; i += 997) sig = (sig * 31 + pos[i]) | 0;
          for (let i = 0; i < pos.length; i += 2017) sig = (sig * 31 + pos[i]) | 0;
          for (let i = 0; i < idx.length; i += 397) sig = (sig * 31 + idx[i]) | 0;
          const ao = m.getVerticesData('ao') as Float32Array;
          for (let i = 0; i < ao.length; i += 521) sig = (sig * 31 + Math.round(ao[i] * 1e4)) | 0;
          return `${m.name}:${pos.length / 3}:${idx.length}:${sig}`;
        })
        .sort()
        .join('|');
      terrain.dispose();
      scene.dispose();
      engine.dispose();
      return summary;
    };
    expect(build()).toBe(build());
  }, 30000);

  it('disposing one chunk cleans the shared observers exactly once', async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const terrain = createTerrain(scene);
    const before = scene.onBeforeRenderObservable.observers.length;
    terrain.meshes[0].dispose();
    await new Promise((r) => setTimeout(r, 5));
    // fog observer + shadow-receiver observer removed once.
    expect(scene.onBeforeRenderObservable.observers.length).toBe(before - 2);
    // Remaining chunk meshes (all LOD levels) are untouched.
    expect(scene.meshes.filter((m) => m.name.startsWith('terrain_c')).length).toBe(74);
    terrain.dispose();
    await new Promise((r) => setTimeout(r, 5));
    expect(scene.onBeforeRenderObservable.observers.length).toBe(0);
    scene.dispose();
    engine.dispose();
  });
});

describe('sea plane', () => {
  it('sits below the wave troughs with a deep-water material (no z-fight, no white patches)', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const plane = createSeaPlane(scene);

    // Water waves oscillate about SEA_LEVEL with max amplitude ~0.15;
    // the static plane must stay clear below every trough.
    expect(plane.position.y).toBe(SEA_LEVEL - SEA_PLANE_DEPTH);
    expect(SEA_PLANE_DEPTH).toBeGreaterThan(0.2);
    expect(plane.position.y).toBeLessThan(SEA_LEVEL - 0.2);

    // The old bug: no material -> default white mesh z-fighting the water.
    const mat = plane.material as StandardMaterial;
    expect(mat).toBeInstanceOf(StandardMaterial);
    expect(mat.diffuseColor.r).toBeLessThan(0.1);
    expect(mat.diffuseColor.g).toBeLessThan(0.3);
    // Must stay fog-affected so it blends into the horizon.
    expect(mat.fogEnabled).toBe(true);

    plane.dispose();
    scene.dispose();
    engine.dispose();
  });
});
