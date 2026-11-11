import { describe, it, expect } from 'vitest';
import { Color3, DirectionalLight, Mesh, NullEngine, Scene, ShadowGenerator, Vector3 } from '@babylonjs/core';
import { Water, MAX_WAVE_AMPLITUDE, WATER_DEPTH_CAP, WATER_SUBDIVISIONS, WATER_VERTEX_WAVES, WATER_WAVES, VERTEX_WAVE_AMPLITUDE, WATER_FOAM, foamMask, foamMaxDepth, dumpWaterGLSL, waterVertexSpacing } from './water';
import { SEA_LEVEL, SEA_PLANE_DEPTH } from './terrain';
import { COLOR_GRADE_UNIFORMS } from './colorPipeline';
import { SHADOW_UNIFORMS } from '../visual/shadowReceiver';
import { terrainHeight, findSpawnPoint } from './heightfield';

/**
 * Water behaviour tests on NullEngine. The shader code itself cannot run
 * without WebGL, but the scene-state wiring (mesh placement, fog mirroring
 * from the engine scene) is pure JS and fully testable.
 */

/** Read a ShaderMaterial float uniform (values are cached in _floats before
 *  the GPU effect exists, so this works on NullEngine). */
function floatUniform(mat: Water['material'], name: string): number {
  return (mat as unknown as { _floats: Record<string, number> })._floats[name];
}

/** Read a ShaderMaterial vec3 uniform (cached in _vectors3 on NullEngine). */
function vec3Uniform(mat: Water['material'], name: string): { x: number; y: number; z: number } {
  return (mat as unknown as { _vectors3: Record<string, { x: number; y: number; z: number }> })._vectors3[name];
}
/** The v9 Observable API requires at least one notification argument. */
function fireOnBeforeRender(scene: Scene): void {
  scene.onBeforeRenderObservable.notifyObservers(scene);
}

describe('Water module', () => {
  it('exports a class with the expected lifecycle/scene API', () => {
    expect(typeof Water).toBe('function');
    for (const method of ['syncSun', 'update', 'dispose', 'syncFog']) {
      expect(typeof (Water.prototype as unknown as Record<string, unknown>)[method]).toBe('function');
    }
  });

  it('places the water surface at sea level', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const water = new Water(scene, engine);
    expect(water.mesh.position.y).toBe(SEA_LEVEL);
    water.dispose();
    scene.dispose();
    engine.dispose();
  });

  it('mirrors scene fog (colour + EXP2 density) and the color pipeline into the water shader each frame', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.fogMode = Scene.FOGMODE_EXP2;

    const water = new Water(scene, engine);

    // Day fog: dense, light blue-grey. The image-processing settings are
    // mirrored through the same per-frame observer as the fog.
    scene.fogDensity = 0.0022;
    scene.fogColor = new Color3(0.62, 0.75, 0.85);
    scene.imageProcessingConfiguration.exposure = 1.12;
    fireOnBeforeRender(scene);
    expect(floatUniform(water.material, 'fogDensity')).toBeCloseTo(0.0022, 6);
    expect(floatUniform(water.material, 'exposureLinear')).toBeCloseTo(1.12, 6);
    expect(vec3Uniform(water.material, 'fogColor').x).toBeCloseTo(0.62, 6);

    // Night fog: different density, near-black blue. The water must follow
    // instead of keeping a hardcoded day tone (the old bug).
    scene.fogDensity = 0.0038;
    scene.fogColor = new Color3(0.035, 0.055, 0.1);
    fireOnBeforeRender(scene);
    expect(floatUniform(water.material, 'fogDensity')).toBeCloseTo(0.0038, 6);
    const fc = vec3Uniform(water.material, 'fogColor');
    expect(fc.x).toBeCloseTo(0.035, 6);
    expect(fc.y).toBeCloseTo(0.055, 6);
    expect(fc.z).toBeCloseTo(0.1, 6);

    water.dispose();
    scene.dispose();
    engine.dispose();
  });

  it('mirrors the sky-reflection tint from the scene horizon colour (day AND night)', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.fogMode = Scene.FOGMODE_EXP2;

    const water = new Water(scene, engine);
    // The constructor runs an initial fog sync, so the tint already tracks
    // the scene fog colour. Day: bright blue-grey horizon.
    scene.fogColor = new Color3(0.62, 0.75, 0.85);
    fireOnBeforeRender(scene);
    const day = vec3Uniform(water.material, 'skyTint');
    expect(day.x).toBeCloseTo(0.62, 6);
    expect(day.y).toBeCloseTo(0.75, 6);
    expect(day.z).toBeCloseTo(0.85, 6);

    // Dusk: the water must reflect the warm haze, not a fixed day blue.
    scene.fogColor = new Color3(0.58, 0.45, 0.36);
    fireOnBeforeRender(scene);
    const dusk = vec3Uniform(water.material, 'skyTint');
    expect(dusk.x).toBeCloseTo(0.58, 6);
    expect(dusk.y).toBeCloseTo(0.45, 6);
    expect(dusk.z).toBeCloseTo(0.36, 6);

    // Night: near-black blue — the old hardcoded day tone is gone.
    scene.fogColor = new Color3(0.035, 0.055, 0.1);
    fireOnBeforeRender(scene);
    const night = vec3Uniform(water.material, 'skyTint');
    expect(night.x).toBeCloseTo(0.035, 6);
    expect(night.y).toBeCloseTo(0.055, 6);
    expect(night.z).toBeCloseTo(0.1, 6);

    water.dispose();
    scene.dispose();
    engine.dispose();
  });

  it('dispose removes the fog + shadow sync observables (no stale callbacks)', async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const water = new Water(scene, engine);
    const before = scene.onBeforeRenderObservable.observers.length;
    expect(before).toBe(2); // the water fog sync + the shadow receiver sync
    water.dispose();
    // The callbacks must be inert immediately after dispose...
    fireOnBeforeRender(scene);
    // ...and v9 observables finalise removal asynchronously (setTimeout 0).
    await new Promise((r) => setTimeout(r, 5));
    expect(scene.onBeforeRenderObservable.observers.length).toBe(before - 2);
    scene.dispose();
    engine.dispose();
  });

  describe('baked per-vertex water depth', () => {
    it('bakes a depth attribute on the water grid (193x193) with sane values', () => {
      const engine = new NullEngine();
      const scene = new Scene(engine);
      const water = new Water(scene, engine);

      const pos = water.mesh.getVerticesData('position') as Float32Array;
      const depth = water.mesh.getVerticesData('depth') as Float32Array;
      expect(water.mesh.getVerticesDataKinds()).toContain('depth');
      expect(depth.length).toBe(pos.length / 3); // one depth per vertex
      expect(depth.length).toBe((WATER_SUBDIVISIONS + 1) * (WATER_SUBDIVISIONS + 1));

      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < depth.length; i++) {
        expect(depth[i]).toBeGreaterThanOrEqual(0);
        expect(depth[i]).toBeLessThanOrEqual(WATER_DEPTH_CAP);
        if (depth[i] < min) min = depth[i];
        if (depth[i] > max) max = depth[i];
      }
      // The plane covers land (depth clamped to 0) AND deep ocean (capped).
      expect(min).toBe(0);
      expect(max).toBe(WATER_DEPTH_CAP);
      water.dispose();
      scene.dispose();
      engine.dispose();
    });

    it('agrees with the deterministic height field per vertex', () => {
      const engine = new NullEngine();
      const scene = new Scene(engine);
      const water = new Water(scene, engine);

      const pos = water.mesh.getVerticesData('position') as Float32Array;
      const depth = water.mesh.getVerticesData('depth') as Float32Array;
      // Spot-check a spread of vertices: the baked depth must equal
      // clamp(SEA_LEVEL - terrainHeight(x, z), 0, WATER_DEPTH_CAP).
      const n = depth.length;
      for (const i of [0, 500, 4762, 6000, 9000, n - 2, n - 1]) {
        const x = pos[i * 3];
        const z = pos[i * 3 + 2];
        const expected = Math.min(WATER_DEPTH_CAP, Math.max(0, SEA_LEVEL - terrainHeight(x, z)));
        expect(depth[i]).toBeCloseTo(expected, 5);
      }
      water.dispose();
      scene.dispose();
      engine.dispose();
    });

    it('is byte-identical across scenes (deterministic baking)', () => {
      const engine = new NullEngine();
      const scene = new Scene(engine);
      const w1 = new Water(scene, engine);
      const w2 = new Water(scene, engine);
      const d1 = w1.mesh.getVerticesData('depth') as Float32Array;
      const d2 = w2.mesh.getVerticesData('depth') as Float32Array;
      expect(d1.length).toBe(d2.length);
      for (let i = 0; i < d1.length; i++) {
        expect(d1[i]).toBe(d2[i]);
      }
      w1.dispose();
      w2.dispose();
      scene.dispose();
      engine.dispose();
    });

    it('reads 0 depth over dry land at the spawn point area', () => {
      const engine = new NullEngine();
      const scene = new Scene(engine);
      const water = new Water(scene, engine);
      const pos = water.mesh.getVerticesData('position') as Float32Array;
      const depth = water.mesh.getVerticesData('depth') as Float32Array;

      const spawn = findSpawnPoint();
      // Find the grid vertex closest to the (dry) spawn point.
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < depth.length; i++) {
        const dx = pos[i * 3] - spawn.x;
        const dz = pos[i * 3 + 2] - spawn.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
      expect(terrainHeight(spawn.x, spawn.z)).toBeGreaterThan(SEA_LEVEL);
      expect(depth[best]).toBe(0); // nearest grid point is still dry land
      water.dispose();
      scene.dispose();
      engine.dispose();
    });
  });

  describe('generated GLSL (regression guards)', () => {
    const glsl = dumpWaterGLSL();
    const [vert, frag] = glsl.split('\n----------------\n');

    it('declares every wave accumulator before use', () => {
      expect(vert).toContain('float wy = 0.0;');
      expect(vert).toContain('vec2 wgrad = vec2(0.0);');
      expect(frag).toContain('float fy = 0.0;');
      expect(frag).toContain('vec2 fgrad = vec2(0.0);');
      // The fragment must define its own xzw (the vertex xzw is not visible).
      expect(frag).toContain('vec2 xzw = vPos.xz;');
      // The crest brightness combines coarse (vertex) + fine (fragment)
      // waves instead of the coarse vWave alone.
      expect(frag).toContain('float crest = clamp(vWave + fy /');
      expect(frag).toContain('max(0.0, crest)');
    });

    it('passes all varyings from vertex to fragment', () => {
      for (const v of ['varying vec3 vPos;', 'varying vec3 vNormal;', 'varying float vDepth;', 'varying float vWave;']) {
        expect(vert).toContain(v);
        expect(frag).toContain(v);
      }
    });

    it('discards the ocean plane over dry land', () => {
      expect(frag).toContain('if (vDepth <= 0.0) discard;');
    });

    it('no quantised hash checker sparkle remains in the ocean', () => {
      // The old `h21(floor(vPos.xz * 2.2) + floor(time * 1.3))` produced the
      // unnatural blue/white pattern. The fragment must not hash world space.
      expect(frag).not.toMatch(/h21\s*\(/);
      expect(frag).not.toMatch(/floor\s*\(\s*vPos\.xz/);
    });

    it('sky reflection is driven by the live skyTint uniform (no hardcoded day sky)', () => {
      // The old shader reflected a constant day-blue sky at every hour of
      // the cycle. The fresnel mix must consume the per-frame uniform.
      expect(frag).toContain('uniform vec3 skyTint;');
      expect(frag).toContain('base = mix(base, skyTint, fres * 0.55);');
      expect(frag).not.toContain('vec3 skyRef');
      // The uniform is registered so the engine binds it.
      const engine = new NullEngine();
      const scene = new Scene(engine);
      const water = new Water(scene, engine);
      const uniforms = (water.material as unknown as { _options: { uniforms: string[] } })._options.uniforms;
      expect(uniforms).toContain('skyTint');
      water.dispose();
      scene.dispose();
      engine.dispose();
    });

    it('receives the directional-light shadow map (trees shade the water)', () => {
      // The displaced surface (wpp, after the wave offset) is the position
      // that must be projected into the shadow camera — flat-position
      // shadows would swim against the waves.
      expect(vert).toContain('varying vec4 vShadowPos;');
      expect(vert).toContain('varying float vShadowDepthMetric;');
      expect(vert).toContain('vShadowPos = shadowLightMatrix * wpp;');
      expect(frag).toContain('#include <shadowsFragmentFunctions>');
      // The shadow functions include depends on getRand() from the engine's
      // helperFunctions include (see shadowReceiver.ts) — helperFunctions
      // must come first in the generated source — regression #26.
      expect(frag.indexOf('#include <helperFunctions>')).toBeGreaterThanOrEqual(0);
      expect(frag.indexOf('#include <helperFunctions>')).toBeLessThan(
        frag.indexOf('#include <shadowsFragmentFunctions>'),
      );
      expect(frag).toContain('float shadow = computeShadowWithESM(');
      expect(frag).toContain('* shadow;');
    });

    it('binds the shadow generator uniforms per frame on the live material', () => {
      const engine = new NullEngine();
      const scene = new Scene(engine);
      const water = new Water(scene, engine);

      // Safe no-op default before any generator exists.
      fireOnBeforeRender(scene);
      expect(floatUniform(water.material, 'shadowDarkness')).toBe(1);

      const sun = new DirectionalLight('sun', new Vector3(0, -1, 0), scene);
      const gen = new ShadowGenerator(1024, sun);
      gen.useBlurExponentialShadowMap = true;
      gen.darkness = 0.4;
      fireOnBeforeRender(scene);
      expect(floatUniform(water.material, 'shadowDarkness')).toBeCloseTo(0.4, 6);

      const textures = (water.material as unknown as { _textures: Record<string, unknown> })._textures;
      const matrices = (water.material as unknown as { _matrices: Record<string, unknown> })._matrices;
      expect(textures.shadowSampler).toBe(gen.getShadowMapForRendering());
      expect(matrices.shadowLightMatrix).toBeDefined();

      water.dispose();
      scene.dispose();
      engine.dispose();
    });
  });

  describe('wave field budget (z-fight safety + sampling quality)', () => {
    it('keeps the worst-case trough above the static deep-ocean plane', () => {
      // Trough depth = sum of the VERTICALLY DISPLACED amplitudes (fragment
      // waves are normal-only and never move the surface). The deep-ocean
      // plane sits SEA_PLANE_DEPTH below sea level; a comfortable margin
      // must remain.
      expect(VERTEX_WAVE_AMPLITUDE).toBeGreaterThan(0);
      expect(VERTEX_WAVE_AMPLITUDE).toBeLessThan(SEA_PLANE_DEPTH - 0.1);
      // The full table (incl. normal-only waves) stays inside the same
      // budget as a conservative ceiling.
      expect(MAX_WAVE_AMPLITUDE).toBeGreaterThan(0);
      expect(MAX_WAVE_AMPLITUDE).toBeLessThan(SEA_PLANE_DEPTH - 0.1);
    });

    it('uses only positive, finite wave parameters', () => {
      for (const w of WATER_WAVES) {
        expect(Number.isFinite(w.amp) && w.amp > 0).toBe(true);
        expect(Number.isFinite(w.wl) && w.wl > 0).toBe(true);
        expect(Math.hypot(w.dir[0], w.dir[1])).toBeGreaterThan(0);
        expect(Number.isFinite(w.speed) && w.speed > 0).toBe(true);
      }
    });

    it('WATER_WAVES is exactly vertex + fragment octaves (stable order)', () => {
      expect(WATER_WAVES.length).toBe(WATER_VERTEX_WAVES.length + 4); // 4 fragment octaves
      for (const w of WATER_VERTEX_WAVES) {
        expect(WATER_WAVES).toContainEqual(w);
      }
      expect(WATER_WAVES.slice(0, WATER_VERTEX_WAVES.length).map((w) => w.wl)).toEqual(
        WATER_VERTEX_WAVES.map((w) => w.wl),
      );
    });

    it('every vertex-displaced wave clears the Nyquist limit (no moiré)', () => {
      // Undersampled vertex waves linearly interpolate into large-scale
      // moiré beat patches (~16-35 u measured on the old 12.5 u grid) — the
      // source of unnatural patchy sea patterns. Require >= 2 samples per
      // wavelength on the ACTUAL grid.
      const spacing = waterVertexSpacing();
      // Grid is exactly 6.25 u (1200 u / 192 subdivisions).
      expect(spacing).toBeCloseTo(6.25, 5);
      for (const w of WATER_VERTEX_WAVES) {
        expect(w.wl / spacing).toBeGreaterThanOrEqual(2.0);
      }
    });

    it('short-wavelength octaves live in the fragment, not the vertex grid', () => {
      // Waves shorter than the vertex Nyquist limit must be normal-only in
      // the fragment so they can never alias the lattice.
      const spacing = waterVertexSpacing();
      const glsl = dumpWaterGLSL();
      const [vert] = glsl.split('\n----------------\n');
      const vertexPhases = vert.match(/float ph\d+ =/g) ?? [];
      expect(vertexPhases.length).toBe(WATER_VERTEX_WAVES.length);
      for (const w of WATER_WAVES) {
        if (w.wl / spacing < 2.0) {
          expect(WATER_VERTEX_WAVES.map((x) => x.wl)).not.toContain(w.wl);
        }
      }
    });
  });

  it('bakes the depth buffer alongside the default vertex data on the mesh', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const water = new Water(scene, engine);
    expect((water.mesh as Mesh).getVerticesDataKinds()).toEqual(
      expect.arrayContaining(['position', 'normal', 'uv', 'depth']),
    );
    water.dispose();
    scene.dispose();
    engine.dispose();
  });

  describe('shoreline foam (pure TS mirror + GLSL guards)', () => {
    it('stays in [0,1] over a fuzz of samples and is exactly zero over land', () => {
      // Deterministic LCG so the fuzz is reproducible.
      let s = 12345;
      const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
      for (let i = 0; i < 2000; i++) {
        const x = (rnd() - 0.5) * 400;
        const z = (rnd() - 0.5) * 400;
        const d = rnd() * 2.0;
        const crest = (rnd() * 2 - 1);
        const fy = (rnd() - 0.5) * 0.2;
        const t = rnd() * 40;
        const m = foamMask(x, z, d, crest, fy, t);
        expect(m).toBeGreaterThanOrEqual(0);
        expect(m).toBeLessThanOrEqual(1);
      }
      // Land (depth 0): no foam, regardless of wave state.
      for (let t = 0; t < 5; t++) {
        expect(foamMask(1.3, -2.1, 0, 1, 0.1, t)).toBe(0);
        expect(foamMask(-40.7, 99.2, 0, -1, -0.1, t)).toBe(0);
      }
    });

    it('peaks near the wash position in the shallow shelf and never appears in deep water', () => {
      // At the resting wash depth some points of the streak field must be
      // close to full strength.
      let maxShallow = 0;
      for (let x = 0; x < 24; x++) {
        for (let z = 0; z < 24; z++) {
          const m = foamMask(x * 0.7, z * 0.7, WATER_FOAM.washBase, 0, 0, 0.3);
          if (m > maxShallow) maxShallow = m;
        }
      }
      expect(maxShallow).toBeGreaterThan(0.5);

      // Deeper than the documented budget, foam is impossible at ANY wave
      // phase (even full crest + full fine displacement).
      const deep = foamMaxDepth() + 0.2;
      for (let x = 0; x < 12; x++) {
        for (const crest of [-1, 0, 1]) {
          const m = foamMask(x * 3.3, x * 1.1, deep, crest, 0.103, 1.7);
          expect(m).toBe(0);
        }
      }
    });

    it('crest phase pushes the foam band out and trough pulls it in', () => {
      // Pick a point where the streak field is open at t=0.
      let x0 = 0;
      let best = 0;
      for (let x = 0; x < 40; x++) {
        const m = foamMask(x * 0.5, 2.0, WATER_FOAM.washBase, 0, 0, 0);
        if (m > best) { best = m; x0 = x * 0.5; }
      }
      expect(best).toBeGreaterThan(0.5);
      // A depth between the trough wash and the crest wash: the crest must
      // light it more than the trough.
      const midDepth = WATER_FOAM.washBase + WATER_FOAM.crestGain * 0.7;
      const crestOn = foamMask(x0, 2.0, midDepth, 1, 0, 0);
      const crestOff = foamMask(x0, 2.0, midDepth, -1, 0, 0);
      expect(crestOn).toBeGreaterThan(crestOff);
    });

    it('streaks animate over time (foam is not a static texture)', () => {
      let changed = 0;
      for (let x = 0; x < 20; x++) {
        for (let z = 0; z < 20; z++) {
          const a = foamMask(x * 0.9, z * 0.9, WATER_FOAM.washBase, 0, 0, 0);
          const b = foamMask(x * 0.9, z * 0.9, WATER_FOAM.washBase, 0, 0, 1.2);
          if (Math.abs(a - b) > 0.05) changed++;
        }
      }
      expect(changed).toBeGreaterThan(20);
    });

    it('streak field is continuous in space (no grid steps or checker edges)', () => {
      const d = WATER_FOAM.washBase;
      let prev = foamMask(0, 0, d, 0, 0, 0.4);
      let maxStep = 0;
      for (let i = 1; i <= 400; i++) {
        const m = foamMask(i * 0.05, 1.7, d, 0, 0, 0.4);
        maxStep = Math.max(maxStep, Math.abs(m - prev));
        prev = m;
      }
      // A quantised hash checker would produce full 0↔0.85 jumps between
      // adjacent cells; the sine streak field moves far more gently
      // (worst-case step ≈ (0.095 + 0.155) * smoothstep-slope * 0.85).
      expect(maxStep).toBeLessThan(0.35);
    });

    it('GLSL foam block is generated from the TS table and introduces no new uniforms', () => {
      const [ , frag] = dumpWaterGLSL().split('\n----------------\n');
      // Wiring: band from depth + wave phases, streaks from the table.
      expect(frag).toContain('float foamWash =');
      expect(frag).toContain('float foamBand =');
      expect(frag).toContain('float foamA = clamp(foam *');
      expect(frag).toContain('col = mix(col, foamCol,');
      expect(frag).toContain('alpha = max(alpha, foamA);');
      const streaks = frag.match(/float fs\d+ = sin/g) ?? [];
      expect(streaks.length).toBe(WATER_FOAM.streaks.length);
      // The table values must survive into the generated source.
      expect(frag).toContain(`vec2(${WATER_FOAM.streaks[0].dir[0].toFixed(5)}, ${WATER_FOAM.streaks[0].dir[1].toFixed(5)})`);
      expect(frag).toContain(`vec2(${WATER_FOAM.streaks[1].dir[0].toFixed(5)}, ${WATER_FOAM.streaks[1].dir[1].toFixed(5)})`);
      // Still no quantised hash anywhere in the ocean.
      expect(frag).not.toMatch(/h21\s*\(/);
      // No foam-specific uniforms: the registered list is exactly the old set.
      const engine = new NullEngine();
      const scene = new Scene(engine);
      const water = new Water(scene, engine);
      const uniforms = (water.material as unknown as { _options: { uniforms: string[] } })._options.uniforms;
      expect(uniforms).toEqual([
        'world', 'viewProjection', 'cameraPosition', 'sunDir', 'sunColor',
        'time', 'fogColor', 'fogDensity', 'skyTint',
        ...COLOR_GRADE_UNIFORMS, ...SHADOW_UNIFORMS,
      ]);
      water.dispose();
      scene.dispose();
      engine.dispose();
    });
  });
});
