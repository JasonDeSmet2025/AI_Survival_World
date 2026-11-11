import {
  AbstractMesh,
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  ShaderMaterial,
  StandardMaterial,
  Vector3,
  VertexBuffer,
} from '@babylonjs/core';
import {
  SEA_LEVEL,
  TERRAIN_SIZE,
  WORLD_SEED,
  buildTerrainGrid,
  findCampPoint,
  findSpawnPoint,
  isNearLake,
  minTerrainHeightInRadius,
  terrainHeight,
  terrainSlope,
  terrainNormal3,
  type TerrainGrid,
} from './heightfield';
import { COLOR_GRADE_GLSL, COLOR_GRADE_UNIFORMS, syncColorPipeline } from './colorPipeline';
import { NOISE_H21_GLSL, NOISE_VNOISE_GLSL } from './noiseGLSL';
import {
  SHADOW_FRAG_DECL,
  SHADOW_SAMPLE,
  SHADOW_UNIFORMS,
  SHADOW_VERT_DECL,
  SHADOW_VERT_MAIN,
  ShadowReceiver,
  shadowReceiveDefines,
} from '../visual/shadowReceiver';

// Re-export the deterministic world API so existing consumers keep importing
// from './terrain'.
export {
  TERRAIN_SIZE,
  SEA_LEVEL,
  WORLD_SEED,
  terrainHeight,
  isNearLake,
  minTerrainHeightInRadius,
  terrainSlope,
  findSpawnPoint,
  findCampPoint,
};

/** Terrain surface normal as a Babylon Vector3 (approximate). */
export function terrainNormal(x: number, z: number): Vector3 {
  const n = terrainNormal3(x, z);
  return new Vector3(n.x, n.y, n.z);
}

const TERRAIN_VERT = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec4 color;
attribute float ao;
uniform mat4 world;
uniform mat4 viewProjection;
varying vec3 vNormal;
varying vec3 vPos;
varying vec4 vMask;
varying float vAO;
${SHADOW_VERT_DECL}
void main() {
  vec4 wp = world * vec4(position, 1.0);
  vPos = wp.xyz;
  vNormal = normalize(mat3(world) * normal);
  vMask = color;
  vAO = ao;
${SHADOW_VERT_MAIN('wp')}
  gl_Position = viewProjection * wp;
}
`;

const TERRAIN_FRAG = `
precision highp float;
uniform vec3 cameraPosition;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 ambientTop;
uniform vec3 ambientGround;
uniform vec3 fogColor;
uniform float fogDensity;
uniform float seaLevel;
varying vec3 vNormal;
varying vec3 vPos;
varying vec4 vMask;
varying float vAO;
${SHADOW_FRAG_DECL}

${NOISE_H21_GLSL}
${NOISE_VNOISE_GLSL}
// Two-octave grain, base cell ~1.0 world unit: BELOW the 2.0 unit terrain
// grid spacing, so no large uniform tone patches are visible at any angle.
// (The old 3.3-unit-cell value noise produced the reported tone banding.)
float grainA(vec2 p) {
  return vnoise(p) * 0.62 + vnoise(p * 2.17 + vec2(7.31, 3.77)) * 0.38;
}

${COLOR_GRADE_GLSL}

void main() {
  // Muted, natural biome palette (no saturated / rainbow tones).
  vec3 sandLo  = vec3(0.60, 0.545, 0.415);
  vec3 sandHi  = vec3(0.715, 0.655, 0.505);
  vec3 grassLo = vec3(0.175, 0.265, 0.125);
  vec3 grassHi = vec3(0.255, 0.345, 0.175);
  vec3 rockLo  = vec3(0.315, 0.305, 0.290);
  vec3 rockHi  = vec3(0.415, 0.405, 0.385);
  vec3 snowLo  = vec3(0.600, 0.635, 0.695);
  vec3 snowHi  = vec3(0.820, 0.845, 0.885);
  vec3 seabed  = vec3(0.280, 0.345, 0.300);

  vec2 xz = vPos.xz;
  float gA = grainA(xz * 0.95);                    // ~1.0u organic mottling
  float gF = vnoise(xz * 3.4 + vec2(11.7, 5.3));   // ~0.3u fine grain
  float gP = vnoise(xz * 0.033 + vec2(2.1, 8.4));  // ~30u slow tone patches

  vec3 sandC  = mix(sandLo,  sandHi,  gA);
  vec3 grassC = mix(grassLo, grassHi, 0.35 + 0.65 * gA);
  vec3 rockC  = mix(rockLo,  rockHi,  gA);
  vec3 snowC  = mix(snowLo,  snowHi,  0.40 + 0.60 * gA);

  vec3 col = sandC * vMask.r + grassC * vMask.g + rockC * vMask.b + snowC * vMask.a;
  // Gentle modulation only: slow large-scale tone + fine grain. The old
  // single +/-9% low-frequency multiplier read as visible tone bands.
  col *= 0.97 + 0.06 * gP;
  col *= 0.97 + 0.06 * gF;

  // Underwater terrain reads as silt/rock rather than surface biomes.
  float wet = smoothstep(seaLevel + 0.25, seaLevel - 1.5, vPos.y);
  col = mix(col, seabed, wet * 0.72);

  // Baked per-vertex ambient occlusion (see world/terrainAO.ts): darkens
  // valley insides, cliff bases and concave slopes so the landforms read
  // with real depth instead of flat Lambert shading. Applied to the
  // surface colour before lighting; fog is blended afterwards, so the
  // horizon stays unaffected. The squared curve is a deliberate contrast
  // boost (0.8 -> 0.64) so the occlusion reads on the smooth landforms.
  col *= vAO * vAO;

  // Micro normal perturbation: finite differences of the coarse grain
  // octave give subtle per-tile shading so flat areas are not plastic.
  // Sand/grass get the most grain; rock/snow stay smoother.
  float e = 0.25;
  float nL = vnoise((xz - vec2(e, 0.0)) * 0.95);
  float nR = vnoise((xz + vec2(e, 0.0)) * 0.95);
  float nD = vnoise((xz - vec2(0.0, e)) * 0.95);
  float nU = vnoise((xz + vec2(0.0, e)) * 0.95);
  float nAmt = 0.15 + 0.30 * vMask.r + 0.45 * vMask.g;
  vec3 N = normalize(vNormal + vec3((nL - nR) * nAmt, 0.0, (nD - nU) * nAmt));

  float ndl = max(dot(N, normalize(sunDir)), 0.0);
  float hemi = 0.5 + 0.5 * N.y;
  vec3 amb = mix(ambientGround, ambientTop, hemi);
  // Sun shadows: only the DIRECT sun term is darkened (flora, player and
  // buildings cast; the BSM map is mirrored by ShadowReceiver each frame).
  // Ambient/hemisphere stays full so forest interiors keep readability.
  float shadow = ${SHADOW_SAMPLE};
  vec3 light = sunColor * (ndl * shadow) + amb;
  vec3 c = col * light;

  // Engine-matched scene fog (EXP2), blended in LINEAR space like the
  // built-in materials do, then graded (ACES + gamma + contrast + dither)
  // by colorGrade() so the horizon matches standard materials exactly.
  float dist = length(vPos - cameraPosition);
  float f = 1.0 - exp(-fogDensity * fogDensity * dist * dist);
  c = mix(c, fogColor, clamp(f, 0.0, 1.0));
  gl_FragColor = vec4(colorGrade(c), 1.0);
}
`;

/** Exposes the final shader sources (QA regression guards). */
export function dumpTerrainGLSL(): string {
  return TERRAIN_VERT + '\n----------------\n' + TERRAIN_FRAG;
}

/** World units per side of one terrain chunk (matches the flora chunks). */
export const TERRAIN_CHUNK_SIZE = 128;

/**
 * Terrain detail levels for the per-chunk distance LOD (same architecture as
 * the flora LOD: hi is the full 2u mesh; mid/lo are coarser samplings of the
 * SAME deterministic grid — mid reuses every 2nd hi vertex, lo every 4th, so
 * a lo/mid surface always passes EXACTLY through a subset of hi vertices).
 */
export type TerrainLodLevel = 'hi' | 'mid' | 'lo';

/** Grid-vertex stride per level (1 = every vertex, 2 = every 2nd, 4 = every 4th). */
const LOD_STRIDE: Record<TerrainLodLevel, number> = { hi: 1, mid: 2, lo: 4 };

/** Mesh-name suffix per level ('' keeps the historic hi names). */
const LOD_SUFFIX: Record<TerrainLodLevel, string> = { hi: '', mid: '_mid', lo: '_lo' };

export interface TerrainChunk {
  cx: number;
  cz: number;
  /** Detail level this chunk geometry belongs to. */
  level: TerrainLodLevel;
  /** Grid-vertex stride the geometry was sampled with. */
  stride: number;
  /** Mesh name: `terrain_c<cx>_<cz>` (+ `_mid` / `_lo` suffix for LOD twins). */
  name: string;
  /** Origin of the chunk in GRID INDEX space (hi vertices, not cells). */
  x0: number;
  z0: number;
  /** Number of GRID CELLS per axis inside the chunk (coarse cells). */
  cells: number;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** Baked per-vertex ambient occlusion (1 = fully lit). */
  ao: Float32Array;
  indices: Uint32Array;
}

/**
 * Splits a full terrain grid into chunked geometry for per-chunk frustum
 * culling (pure, no Babylon — unit-testable).
 *
 * Chunks share boundary vertices BY VALUE (the same grid vertex is copied
 * into every chunk that contains it, computed identically), so there are
 * no seams, no cracks and no duplicated triangles between neighbours.
 * The union of all chunk triangles is exactly the original grid: nothing is
 * added, removed or smoothed.
 *
 * LOD levels sample the SAME grid at a coarser stride (mid = every 2nd hi
 * vertex, lo = every 4th): each mid/lo chunk vertex is byte-identical to the
 * hi grid vertex it reuses, so every level passes exactly through the hi
 * surface at its sample points and differs from it only by the linear chord
 * between sample points (sub-centimetre for mid — see tests).
 *
 * When the grid does not divide evenly by the target chunk size at the
 * requested stride, that level falls back to full (stride 1) resolution so
 * the renderer always works.
 */
export function buildTerrainChunks(grid: TerrainGrid, level: TerrainLodLevel = 'hi'): TerrainChunk[] {
  const S = grid.samples;
  const cellsPerAxis = S - 1;
  const step = TERRAIN_SIZE / cellsPerAxis;

  // Effective sampling stride for this level (1 when the grid cannot
  // support the requested stride or the chunk layout does not divide).
  let stride = LOD_STRIDE[level];
  let coarseCells = cellsPerAxis;
  if (stride > 1 && cellsPerAxis % stride === 0) {
    const candidate = cellsPerAxis / stride;
    const targetCells = Math.max(4, Math.round(TERRAIN_CHUNK_SIZE / (step * stride)));
    if (candidate % targetCells !== 0) {
      stride = 1;
    } else {
      coarseCells = candidate;
    }
  }
  const coarseStep = step * stride;
  const targetCells = Math.max(4, Math.round(TERRAIN_CHUNK_SIZE / coarseStep));

  let chunksPerAxis = 1;
  let cells = coarseCells;
  if (coarseCells % targetCells === 0) {
    chunksPerAxis = Math.max(1, coarseCells / targetCells);
    cells = targetCells;
  }

  const suffix = LOD_SUFFIX[level];
  const chunks: TerrainChunk[] = [];
  for (let cz = 0; cz < chunksPerAxis; cz++) {
    for (let cx = 0; cx < chunksPerAxis; cx++) {
      const x0 = cx * cells * stride; // hi-grid index of the chunk origin
      const z0 = cz * cells * stride;
      const x1 = Math.min(x0 + cells * stride, cellsPerAxis);
      const L = (x1 - x0) / stride + 1; // local vertices per axis (coarse)
      const count = L * L;
      const positions = new Float32Array(count * 3);
      const normals = new Float32Array(count * 3);
      const colors = new Float32Array(count * 4);
      const ao = new Float32Array(count);
      for (let lz = 0; lz < L; lz++) {
        for (let lx = 0; lx < L; lx++) {
          const src = ((z0 + lz * stride) * S + (x0 + lx * stride)) * 3;
          const srcC = (z0 + lz * stride) * S * 4 + (x0 + lx * stride) * 4; // grid colours are RGBA (stride 4)
          const dst = ((lz * L + lx)) * 3;
          const dstC = (lz * L + lx) * 4; // colour mask is RGBA (stride 4)
          positions[dst] = grid.positions[src];
          positions[dst + 1] = grid.positions[src + 1];
          positions[dst + 2] = grid.positions[src + 2];
          normals[dst] = grid.normals[src];
          normals[dst + 1] = grid.normals[src + 1];
          normals[dst + 2] = grid.normals[src + 2];
          colors[dstC] = grid.colors[srcC];
          colors[dstC + 1] = grid.colors[srcC + 1];
          colors[dstC + 2] = grid.colors[srcC + 2];
          colors[dstC + 3] = grid.colors[srcC + 3];
          ao[dst / 3] = grid.ao[(z0 + lz * stride) * S + (x0 + lx * stride)];
        }
      }
      const indices = new Uint32Array((L - 1) * (L - 1) * 6);
      let p = 0;
      for (let lz = 0; lz < L - 1; lz++) {
        for (let lx = 0; lx < L - 1; lx++) {
          const a = lz * L + lx;
          const b = a + 1;
          const c = a + L;
          const d = c + 1;
          // Same winding as buildTerrainGrid.
          indices[p++] = a;
          indices[p++] = c;
          indices[p++] = b;
          indices[p++] = b;
          indices[p++] = c;
          indices[p++] = d;
        }
      }
      chunks.push({
        cx,
        cz,
        level,
        stride,
        name: `terrain_c${cx}_${cz}${suffix}`,
        x0,
        z0,
        cells,
        positions,
        normals,
        colors,
        ao,
        indices,
      });
    }
  }
  return chunks;
}

/**
 * World-space centre of a terrain chunk along one axis (the distance LOD
 * compares camera-to-chunk-centre XZ distances, same convention as the
 * flora LOD).
 */
export function terrainChunkCenter(index: number): number {
  return index * TERRAIN_CHUNK_SIZE + TERRAIN_CHUNK_SIZE / 2 - TERRAIN_SIZE / 2;
}

/**
 * Distance LOD thresholds (camera-to-chunk-centre, XZ):
 *  - dist < TERRAIN_LOD_HI  -> hi detail (2u grid — byte-identical to the
 *    historic single-resolution mesh),
 *  - dist < TERRAIN_LOD_MID -> mid detail (4u grid),
 *  - dist > TERRAIN_LOD_FAR -> lo detail (8u grid),
 *  - [TERRAIN_LOD_MID, TERRAIN_LOD_FAR] -> previous state kept (hysteresis
 *    band ≈ 70 u of walking, so chunks never flicker at the borders).
 *
 * The hi zone always covers everything the player can inspect up close
 * (the camera-occlusion ray, collision and object placement live within a
 * few units of the player and use the full-resolution grid).
 *
 * Quality budget: the coarser levels pass exactly through the hi surface at
 * their sample points and deviate from it only between them. Measured over
 * the full deterministic map: max deviation 1.6 u (mid) / 3.6 u (lo), both
 * on the steep mountain ridges — flat ground deviates ~0. At the nearest
 * edge of a non-hi chunk (≥ 140 u from the camera) the scene fog (EXP2,
 * density 0.0028–0.0042) already blends 25–55 % of those pixels toward the
 * fog colour, so a level swap never produces a visible pop in play.
 */
export const TERRAIN_LOD_HI = 170;
export const TERRAIN_LOD_MID = 230;
export const TERRAIN_LOD_FAR = 300;

export interface TerrainHandle {
  /** Hi-detail static frozen meshes, one per 128u chunk (historic API). */
  meshes: Mesh[];
  /** Single shared material (fog + image-processing + shadow sync). */
  material: ShaderMaterial;
  /**
   * Per-chunk distance LOD (same hysteresis pattern as the flora LOD):
   * exactly ONE of hi/mid/lo is enabled per chunk; the level follows the
   * camera-to-chunk-centre distance with a dead band so chunks never
   * flicker. Purely visual — collision, raycasts and placement keep using
   * the full-resolution grid. Cheap: O(chunks) ≈ 25 comparisons/frame.
   */
  updateLod(cam: { x: number; y: number; z: number }): void;
  /** Every LOD mesh (hi + mid + lo), for QA/diagnostics. */
  lodMeshes(): Mesh[];
  /** Disposes every chunk mesh, the material and the scene observers. */
  dispose(): void;
}

interface LodChunkState {
  cx: number;
  cz: number;
  cxWorld: number;
  czWorld: number;
  mode: TerrainLodLevel;
  hi: Mesh;
  mid: Mesh;
  lo: Mesh;
}

/**
 * Builds the island terrain as CHUNKED static meshes (one per 128u tile):
 *  - the same Float32 grid as before (no byte-quantised heightmap),
 *  - per-vertex 4-channel biome mask (sand/grass/rock/snow),
 *  - one SHARED custom shader with muted biome colours and engine-matched
 *    fog; `world`/`viewProjection` are built-in per-mesh uniforms, so a
 *    single material instance serves every chunk without shader recompiles.
 * Chunking lets the renderer frustum-cull whole 128u tiles: from anywhere
 * on the 640u island most of the 25 chunks are off-screen or fully fogged
 * and cost zero vertices/fill — this is also what makes a future large
 * (or streaming) world cheap. Geometry is byte-identical to the old single
 * mesh (shared boundary vertices, identical winding): zero visual change.
 *
 * Distance LOD: every chunk additionally owns mid (4u) and lo (8u) twins
 * baked from the SAME grid (see buildTerrainChunks). `updateLod()` keeps
 * exactly one detail level enabled per chunk based on camera distance with
 * hysteresis, so far terrain renders at a fraction of the triangle count
 * while everything the player inspects up close stays at full 2u detail.
 * The hi meshes are byte-identical to the chunked mesh from before, so the
 * world looks exactly as it did when near the player.
 *
 * The material's sun/ambient uniforms are driven by the lighting system each
 * frame; fog colour/density are mirrored from the scene so day/night fog
 * stays consistent between the terrain and standard materials.
 * The material receives the directional-light BSM shadow map (flora/player
 * cast), so tree shadows land on the ground — see visual/shadowReceiver.ts.
 */
export function createTerrain(scene: Scene): TerrainHandle {
  const grid = buildTerrainGrid();
  const hi = buildTerrainChunks(grid);
  const mid = buildTerrainChunks(grid, 'mid');
  const lo = buildTerrainChunks(grid, 'lo');

  const material = new ShaderMaterial(
    'terrainMat',
    scene,
    { vertexSource: TERRAIN_VERT, fragmentSource: TERRAIN_FRAG },
    {
      attributes: ['position', 'normal', 'color', 'ao'],
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
        'seaLevel',
        ...COLOR_GRADE_UNIFORMS,
        ...SHADOW_UNIFORMS,
      ],
      defines: shadowReceiveDefines(scene.getEngine()),
    },
  );
  // Keep the ground visible if the camera ever views it from underneath.
  material.backFaceCulling = false;
  material.setFloat('seaLevel', SEA_LEVEL);
  material.setVector3('sunDir', new Vector3(-0.4, -0.8, 0.3));
  material.setVector3('sunColor', new Vector3(1, 0.96, 0.86));
  material.setVector3('ambientTop', new Vector3(0.32, 0.36, 0.42));
  material.setVector3('ambientGround', new Vector3(0.2, 0.18, 0.15));
  material.setFloat('fogDensity', 0.0028);
  material.setVector3('fogColor', new Vector3(0.62, 0.72, 0.82));

  // One static frozen mesh per chunk per detail level; they all share the
  // single material. The world starts in hi everywhere (mid/lo disabled);
  // updateLod() swaps per chunk as the camera moves.
  const buildMesh = (c: TerrainChunk) => {
    const mesh = new Mesh(c.name, scene);
    mesh.setVerticesData(VertexBuffer.PositionKind, c.positions);
    mesh.setVerticesData(VertexBuffer.NormalKind, c.normals);
    mesh.setVerticesData(VertexBuffer.ColorKind, c.colors);
    // Custom vertex kind: v9.33's Geometry deduces the stride from the
    // kind for built-in kinds only, so pass stride=1 explicitly for 'ao'
    // (same pattern as the water 'depth' attribute).
    mesh.setVerticesData('ao', c.ao, false, 1);
    mesh.setIndices(c.indices);
    // Correct per-chunk bounds so frustum culling works on whole 128u tiles.
    mesh.refreshBoundingInfo();
    // The v9 default culls on the bounding SPHERE, which for a 128u chunk is
    // far larger than the tile and hides most of the culling win. Use the
    // accurate sphere-then-box strategy (negligible cost per frame).
    mesh.cullingStrategy = AbstractMesh.CULLINGSTRATEGY_STANDARD;
    mesh.material = material;
    mesh.freezeWorldMatrix();
    return mesh;
  };

  const meshes: Mesh[] = hi.map(buildMesh);
  const midMeshes = mid.map(buildMesh);
  const loMeshes = lo.map(buildMesh);
  for (const m of [...midMeshes, ...loMeshes]) m.setEnabled(false);

  // Per-chunk LOD state: one entry per hi chunk, matched to the mid/lo twin
  // with the same (cx, cz). The default world yields identical 5x5 layouts
  // for all levels; the key lookup also stays correct when a level fell
  // back to a coarser/finer chunk layout than the hi level.
  const midIdx = new Map(mid.map((c, i) => [`${c.cx}_${c.cz}`, i] as const));
  const loIdx = new Map(lo.map((c, i) => [`${c.cx}_${c.cz}`, i] as const));
  const lodState: LodChunkState[] = hi.map((c, i) => ({
    cx: c.cx,
    cz: c.cz,
    cxWorld: terrainChunkCenter(c.cx),
    czWorld: terrainChunkCenter(c.cz),
    mode: 'hi',
    hi: meshes[i],
    mid: midMeshes[midIdx.get(`${c.cx}_${c.cz}`) ?? 0],
    lo: loMeshes[loIdx.get(`${c.cx}_${c.cz}`) ?? 0],
  }));

  // Mirror the engine scene fog (set by the lighting system each frame) and
  // the image-processing pipeline (exposure/contrast/dither/vignette) into
  // the shared shader so day/night fog and colour grading match standard
  // materials exactly.
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
  const observable = scene.onBeforeRenderObservable.add(fogSync);
  fogSync();

  // Mirror the directional-light shadow map into this material every frame
  // (safe no-op until the lighting system creates its ShadowGenerator).
  const shadowReceiver = new ShadowReceiver(scene, material);

  // The shared material + its observers live on the terrain as a whole, so
  // clean them up exactly once — whichever mesh goes first (a chunk mesh
  // can be disposed individually without taking the material down with it).
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    scene.onBeforeRenderObservable.remove(observable);
    shadowReceiver.dispose();
    material.dispose();
  };
  const allMeshes = [...meshes, ...midMeshes, ...loMeshes];
  for (const mesh of allMeshes) mesh.onDisposeObservable.add(cleanup);

  return {
    meshes,
    material,
    /** Distance LOD swap (see TERRAIN_LOD_* constants and updateLod doc). */
    updateLod(cam: { x: number; y: number; z: number }): void {
      for (const st of lodState) {
        const dist = Math.hypot(cam.x - st.cxWorld, cam.z - st.czWorld);
        let mode = st.mode;
        if (dist < TERRAIN_LOD_HI) mode = 'hi';
        else if (dist < TERRAIN_LOD_MID) mode = 'mid';
        else if (dist > TERRAIN_LOD_FAR) mode = 'lo';
        // [TERRAIN_LOD_MID, TERRAIN_LOD_FAR]: keep the previous state.
        if (mode !== st.mode) {
          st.mode = mode;
          st.hi.setEnabled(mode === 'hi');
          st.mid.setEnabled(mode === 'mid');
          st.lo.setEnabled(mode === 'lo');
        }
      }
    },
    lodMeshes(): Mesh[] {
      return allMeshes;
    },
    dispose() {
      for (const mesh of allMeshes) mesh.dispose();
      cleanup();
    },
  };
}

/**
 * Static deep-ocean plane that extends well beyond the animated Water mesh
 * into the fog, hiding the world boundary. Visual only.
 *
 * It sits a fixed offset BELOW sea level (below every wave trough) and uses
 * a deep-water colour. Placing it exactly at SEA_LEVEL with the default
 * white material makes it z-fight with the animated semi-transparent water
 * surface, which produced the reported blue/white patchy sea patterns.
 */
export const SEA_PLANE_DEPTH = 0.4;

export function createSeaPlane(scene: Scene): Mesh {
  const ocean = MeshBuilder.CreateGround('ocean', {
    width: TERRAIN_SIZE * 3.2,
    height: TERRAIN_SIZE * 3.2,
    subdivisions: 2,
  }, scene);
  // Must stay below the lowest wave trough of the Water surface
  // (amplitude max ~0.15) to avoid z-fighting at any animation phase.
  ocean.position.y = SEA_LEVEL - SEA_PLANE_DEPTH;
  const mat = new StandardMaterial('deepOceanMat', scene);
  // Matches the deep tone of the Water shader so the shore-to-open-water
  // transition is seamless; scene fog blends it into the horizon.
  mat.diffuseColor = new Color3(0.03, 0.16, 0.21);
  mat.specularColor = new Color3(0, 0, 0);
  mat.fogEnabled = true;
  ocean.material = mat;
  ocean.isPickable = false;
  return ocean;
}
