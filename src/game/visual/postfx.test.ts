import { describe, expect, it } from 'vitest';
import {
  Effect,
  FreeCamera,
  NullEngine,
  Scene,
  ShaderStore,
  Vector3,
  WebGL2ShaderProcessor,
} from '@babylonjs/core';
import {
  PIPELINE_NAME,
  PostFx,
  UNDERWATER_EFFECT_ID,
  UNDERWATER_MAX_DEPTH,
  dumpUnderwaterGLSL,
} from './postfx';

/** Count (substring) occurrences of `needle` in `source`. */
function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

/**
 * PostFx behaviour tests. Runs on NullEngine: pipeline registration, camera
 * chain wiring, the underwater strength ramp and uniform hand-off are pure
 * scene-state operations, so no WebGL context is required.
 */
describe('PostFx', () => {
  function build(): {
    engine: NullEngine;
    scene: Scene;
    camera: FreeCamera;
    postfx: PostFx;
    dispose: () => void;
  } {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera('cam', new Vector3(0, 5, 0), scene);
    const postfx = new PostFx(scene, camera);
    return {
      engine,
      scene,
      camera,
      postfx,
      dispose: () => {
        postfx.dispose();
        scene.dispose();
        engine.dispose();
      },
    };
  }

  it('registers its pipeline with the scene manager', () => {
    const { scene, dispose } = build();
    const names = scene.postProcessRenderPipelineManager.supportedPipelines.map((p) => p.name);
    expect(names).toContain(PIPELINE_NAME);
    dispose();
  });

  it('wires bloom (4 passes) + underwater tint onto the camera chain in order', () => {
    const { camera, dispose } = build();
    const chain = camera._postProcesses.filter((pp): pp is NonNullable<typeof pp> => pp !== null);
    // Bloom group: highlights, horizontal blur, vertical blur, merge.
    expect(chain.length).toBe(5);
    expect(chain.map((pp) => pp.name)).toContain('highlights');
    expect(chain.map((pp) => pp.name)).toContain('bloomMerge');
    // The underwater tint must be the FINAL pass so it tints the bloomed image.
    expect(chain[chain.length - 1].name).toBe(UNDERWATER_EFFECT_ID);
    dispose();
  });

  it('attaches the game camera to the pipeline', () => {
    const { scene, camera, dispose } = build();
    const pipeline = scene.postProcessRenderPipelineManager.supportedPipelines.find(
      (p) => p.name === PIPELINE_NAME,
    );
    expect(pipeline).toBeDefined();
    expect(pipeline!.cameras).toContain(camera);
    dispose();
  });

  it('ramps strength up while submerged and back down out of water', () => {
    const { postfx, dispose } = build();
    expect(postfx.strength).toBe(0);

    postfx.setUnderwater(3);
    for (let i = 0; i < 40; i++) postfx.update(0.05);
    expect(postfx.strength).toBeGreaterThan(0.9);
    expect(postfx.depthNorm).toBeCloseTo(3 / UNDERWATER_MAX_DEPTH, 5);

    postfx.setUnderwater(0);
    for (let i = 0; i < 40; i++) postfx.update(0.05);
    expect(postfx.strength).toBeLessThan(0.05);
    dispose();
  });

  it('clamps normalised depth at the max depth', () => {
    const { postfx, dispose } = build();
    postfx.setUnderwater(UNDERWATER_MAX_DEPTH + 25);
    expect(postfx.depthNorm).toBe(1);
    postfx.setUnderwater(-5);
    expect(postfx.depthNorm).toBe(0);
    dispose();
  });

  it('passes the smoothed values to the compiled effect on apply', () => {
    const { postfx, dispose } = build();
    postfx.setUnderwater(6);
    for (let i = 0; i < 40; i++) postfx.update(0.05);

    const uniforms = new Map<string, number>();
    const fakeEffect = {
      setFloat: (name: string, value: number) => {
        uniforms.set(name, value);
      },
    } as unknown as Effect;
    postfx.underwater.onApplyObservable.notifyObservers(fakeEffect);

    expect(uniforms.get('uStrength')).toBeCloseTo(postfx.strength, 5);
    expect(uniforms.get('uDepth')).toBeCloseTo(6 / UNDERWATER_MAX_DEPTH, 5);
    dispose();
  });

  it('detaches the tint pass out of water and re-attaches it when submerged', () => {
    const { camera, postfx, dispose } = build();
    const slot = camera._postProcesses.findIndex((pp) => pp?.name === UNDERWATER_EFFECT_ID);
    expect(slot).toBeGreaterThanOrEqual(0);

    // Swim out: strength decays to 0 → pass detached (null slot).
    postfx.setUnderwater(0);
    for (let i = 0; i < 40; i++) postfx.update(0.05);
    expect(camera._postProcesses[slot]).toBeNull();
    expect(camera._postProcesses.filter((pp) => pp !== null).length).toBe(4);

    // Diving again: strength ramps up → pass re-attached at the same slot.
    postfx.setUnderwater(2);
    for (let i = 0; i < 40; i++) postfx.update(0.05);
    expect(camera._postProcesses[slot]?.name).toBe(UNDERWATER_EFFECT_ID);
    expect(camera._postProcesses.filter((pp) => pp !== null).length).toBe(5);
    dispose();
  });

  it('registers the underwater fragment in the engine shader store (PixelShader convention)', () => {
    // Regression: the fragment is registered exactly the way the engine
    // registers its own post-process fragments (kernelBlurPixelShader etc.).
    // Without a registered store entry the engine falls back to a file fetch
    // of the (non-existent) URL and the pass never compiles.
    const stored = ShaderStore.ShadersStore[UNDERWATER_EFFECT_ID + 'PixelShader'];
    expect(stored).toBeDefined();
    expect(stored).toContain('void main()');
    expect(stored).toContain('uStrength');
    // It is the raw GLSL, not a `source:`-prefixed inline blob.
    expect(stored).not.toContain('source:');
    const { dispose } = build();
    dispose();
  });

  it('final fragment GLSL contains the shader exactly once (regression: no double include)', async () => {
    // Regression: when the fragment was passed as a `source:` inline string,
    // `UseFinalCode()` embedded the ENTIRE fragment into the single-line
    // `#define SHADER_NAME fragment:...` header AND appended the migrated
    // code — every declaration (vUV, textureSampler, uStrength, uDepth,
    // fragColor) and `main()` appeared TWICE → guaranteed compile failure.
    // The fix registers the fragment under a short store name instead.
    const { postfx, dispose } = build();
    const effect = postfx.underwater.getEffect() as unknown as {
      isReady: () => boolean;
      _fragmentSourceCode: string;
      _vertexSourceCode: string;
      _rawFragmentSourceCode: string;
      _rawVertexSourceCode: string;
    };
    const deadline = Date.now() + 5000;
    while (!effect.isReady() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(effect.isReady()).toBe(true);

    const finalFragment = effect._fragmentSourceCode;
    for (const decl of [
      'in vec2 vUV;',
      'uniform sampler2D textureSampler;',
      'uniform float uStrength;',
      'uniform float uDepth;',
      'layout(location = 0) out vec4 fragColor;',
    ]) {
      expect(
        countOccurrences(finalFragment, decl),
        `declaration must appear exactly once in the final fragment: ${decl}`,
      ).toBe(1);
    }
    expect(finalFragment.match(/void\s+main\s*\(/g)?.length, 'void main() must appear exactly once').toBe(
      1,
    );

    // The #define SHADER_NAME header must be a single short line containing
    // the effect name — not an embedded copy of the GLSL body.
    const headerLine = finalFragment.split('\n', 1)[0];
    expect(headerLine).toBe(`#define SHADER_NAME fragment:${UNDERWATER_EFFECT_ID}`);
    expect(headerLine).not.toContain('void main');
    expect(headerLine).not.toContain('precision');

    // The raw fragment is the registered store entry; the vertex stage is
    // the engine's built-in `postprocess` shader (GLSL1 before conversion).
    expect(effect._rawFragmentSourceCode).toContain('uStrength');
    expect(effect._rawFragmentSourceCode).not.toContain('source:');
    expect(effect._rawVertexSourceCode).toContain('varying vec2 vUV;');

    // The final vertex is the single built-in pass (one main, single-line
    // header). The GLSL1→3 `attribute`/`varying`→`in`/`out` conversion that
    // makes `out vec2 vUV` match the fragment's `in vec2 vUV` is verified
    // separately against the real WebGL2 processor below (NullEngine runs
    // the GLSL1 processor and does not convert).
    const vertHeader = effect._vertexSourceCode.split('\n', 1)[0];
    expect(vertHeader).toBe('#define SHADER_NAME vertex:postprocess');
    expect(effect._vertexSourceCode.match(/void\s+main\s*\(/g)?.length).toBe(1);
    dispose();
  });

  it('WebGL2 processor yields a matching vertex/fragment interface (no duplicate output)', () => {
    // Regression (browser path): on WebGL2 the engine runs the built-in
    // `postprocess` vertex through WebGL2ShaderProcessor (attribute→in,
    // varying→out) and our native ES 3.00 fragment through postProcessor.
    // The converted vertex `out vec2 vUV` must match the fragment `in vec2
    // vUV`, and the processor must NOT inject a second fragment output
    // (it skips the `glFragColor` declaration when a `layout(location = 0)
    // out` is already present).
    const proc = new WebGL2ShaderProcessor();
    // Built-in postprocess vertex interface (GLSL1 as stored).
    const vertOut = proc.varyingProcessor('varying vec2 vUV;', false); // vertex → out
    const vertIn = proc.attributeProcessor('attribute vec2 position;');
    expect(vertOut).toBe('out vec2 vUV;');
    expect(vertIn).toBe('in vec2 position;');

    // Our fragment (already ES 3.00) survives postProcessor unchanged and
    // keeps exactly one output — no duplicate `glFragColor` is injected.
    const frag = dumpUnderwaterGLSL();
    const out = proc.postProcessor(frag, [], true);
    expect(countOccurrences(out, 'layout(location = 0) out')).toBe(1);
    expect(out).not.toContain('glFragColor');
    expect(countOccurrences(out, 'void main(')).toBe(1);
    expect(countOccurrences(out, 'in vec2 vUV;')).toBe(1);
    // Interface match between the two stages.
    expect(vertOut).toBe('out vec2 vUV;');
    expect(out).toContain('in vec2 vUV;');
  });

  it('underwater fragment is valid GLSL ES 3.00 (no reserved GLSL1 tokens)', () => {
    // Regression (#26): the post-process chain runs as `#version 300 es`
    // shaders on WebGL2, where `varying` is a RESERVED word and
    // `texture2D`/`gl_FragColor` no longer exist. The fragment must be
    // native ES 3.00 so it compiles regardless of which processing path
    // the engine applies.
    const frag = dumpUnderwaterGLSL();
    for (const glsl1Token of ['varying', 'texture2D', 'gl_FragColor', 'attribute ']) {
      expect(frag, `fragment must not contain GLSL1 token ${glsl1Token}`).not.toContain(glsl1Token);
    }
    // Explicit output + the input interface + the texture fetch.
    expect(frag).toContain('layout(location = 0) out vec4 fragColor;');
    expect(frag).toContain('in vec2 vUV;');
    expect(frag).toContain('texture(textureSampler, vUV)');
  });

  it('dispose removes the pipeline, detaches all passes and disposes them', () => {
    const { scene, camera, postfx, dispose } = build();
    postfx.dispose();
    expect(
      scene.postProcessRenderPipelineManager.supportedPipelines.some((p) => p.name === PIPELINE_NAME),
    ).toBe(false);
    expect(camera._postProcesses.filter((pp) => pp !== null).length).toBe(0);
    dispose();
  });
});
