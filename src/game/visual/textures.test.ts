import { afterEach, describe, expect, it } from 'vitest';
import { NullEngine, Scene } from '@babylonjs/core';
import { createSharedMaterials } from './materials';
import { createTextureKit } from './textures';

/**
 * Procedural texture kit + shared materials tests.
 *
 * The painters run on 2D canvases, which Node does not provide. A minimal
 * canvas stub below captures every putImageData so we can validate the
 * generated pixel data (contrast, bounds, no degenerate output) without a
 * browser.
 */

interface CapturedCanvas {
  width: number;
  height: number;
  last?: Uint8ClampedArray;
}

function installCanvasStub(): CapturedCanvas[] {
  const canvases: CapturedCanvas[] = [];
  const makeCtx = (canvas: CapturedCanvas) => ({
    fillStyle: '',
    globalCompositeOperation: 'source-over',
    createImageData(w: number, h: number) {
      return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
    },
    putImageData(img: { data: Uint8ClampedArray }) {
      canvas.last = img.data;
    },
    fillRect(): void {},
    createLinearGradient() {
      return { addColorStop(): void {} };
    },
    createRadialGradient() {
      return { addColorStop(): void {} };
    },
    getImageData(_x: number, _y: number, w: number, h: number) {
      // heightToNormal reads the painted albedo back as a height map.
      return { data: canvas.last ?? new Uint8ClampedArray(w * h * 4), width: w, height: h };
    },
  });
  (globalThis as Record<string, unknown>).document = {
    createElement(tag: string) {
      if (tag !== 'canvas') throw new Error('stub only creates canvases');
      const canvas: CapturedCanvas = { width: 0, height: 0 };
      (canvas as unknown as { getContext: (k: string) => unknown }).getContext = (k: string) =>
        k === '2d' ? makeCtx(canvas) : null;
      (canvas as unknown as { toDataURL: () => string }).toDataURL = () => 'data:image/png;base64,AA==';
      canvases.push(canvas);
      return canvas as unknown as HTMLCanvasElement;
    },
  };
  return canvases;
}

/** Mean luminance and luminance range of a captured RGBA buffer. */
function luminanceStats(data: Uint8ClampedArray): { mean: number; range: number } {
  let sum = 0;
  let min = 255;
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    sum += l;
    if (l < min) min = l;
    if (l > max) max = l;
  }
  return { mean: sum / (data.length / 4), range: max - min };
}

describe('procedural texture kit + shared materials', () => {
  const engine = new NullEngine();
  let scene: Scene;

  afterEach(() => {
    scene?.dispose();
    delete (globalThis as Record<string, unknown>).document;
  });

  it('paints every kit texture with real tonal variation (no flat fills)', () => {
    const canvases = installCanvasStub();
    scene = new Scene(engine);
    const kit = createTextureKit(scene);
    const painted = canvases.filter((c) => c.last !== undefined);
    // 9 sets x (albedo + normal) = 18 painted canvases, pairs in order.
    expect(painted.length).toBe(18);
    for (const name of Object.keys(kit) as Array<keyof typeof kit>) {
      const set = kit[name];
      expect(set.albedo.name.length).toBeGreaterThan(0);
      if (set.normal) expect(set.normal.name.length).toBeGreaterThan(0);
    }
    for (let p = 0; p < painted.length; p += 2) {
      const albedo = luminanceStats(painted[p].last!);
      const normal = luminanceStats(painted[p + 1].last!);
      // Albedos: mid-lit (not black/white) with visible tonal variation.
      // (Cloth textures are intentionally subtle, so the floor is low.)
      expect(albedo.mean).toBeGreaterThan(12);
      expect(albedo.mean).toBeLessThan(235);
      expect(albedo.range).toBeGreaterThan(8);
      // Normal maps: centred on neutral grey, never pure black/white.
      expect(normal.mean).toBeGreaterThan(100);
      expect(normal.mean).toBeLessThan(160);
      expect(normal.range).toBeGreaterThan(2);
    }
  });

  it('keeps the flora palette natural: muted greens, earthy browns, grey rock', () => {
    installCanvasStub();
    scene = new Scene(engine);
    const mats = createSharedMaterials(scene);
    const c = (m: { albedoColor: { r: number; g: number; b: number } }) => m.albedoColor;

    // Broadleaf: olive green — green dominant, warm red keeps it muted.
    const leaf = c(mats.leaf);
    expect(leaf.g).toBeGreaterThan(leaf.r);
    expect(leaf.g).toBeLessThan(0.65); // muted, not neon
    expect(leaf.r).toBeGreaterThan(0.3); // olive, not blue-green

    // Grass: dry field green, blue is the least channel.
    const grass = c(mats.grass);
    expect(grass.g).toBeGreaterThan(grass.r);
    expect(grass.b).toBeLessThan(grass.r);

    // Bark/rock: earth tones, low saturation (channels close together).
    const bark = c(mats.bark);
    expect(bark.r).toBeGreaterThan(0.15);
    expect(bark.r).toBeLessThan(0.45);
    expect(Math.max(bark.r, bark.g, bark.b) - Math.min(bark.r, bark.g, bark.b)).toBeLessThan(0.2);
    const rock = c(mats.rock);
    expect(Math.max(rock.r, rock.g, rock.b) - Math.min(rock.r, rock.g, rock.b)).toBeLessThan(0.1);

    // Berries: deep red, not neon.
    const berry = c(mats.berry);
    expect(berry.r).toBeGreaterThan(0.3);
    expect(berry.r).toBeLessThan(0.6);
    expect(berry.g).toBeLessThan(0.1);

    // PBR plausibility: vegetation is matte, no metal.
    for (const m of [mats.bark, mats.leaf, mats.grass, mats.rock]) {
      expect(m.metallic).toBe(0);
      expect(m.roughness).toBeGreaterThan(0.6);
    }
  });

  it('is deterministic across rebuilds (same seed -> same pixels)', () => {
    const canvases = installCanvasStub();
    scene = new Scene(engine);
    const kitA = createTextureKit(scene);
    const first = canvases.filter((c) => c.last).map((c) => c.last!.slice(0, 256));
    kitA.planks.albedo.dispose();
    for (const set of Object.values(kitA)) {
      set.albedo.dispose();
      set.normal?.dispose();
    }
    const canvases2 = canvases.slice();
    const kitB = createTextureKit(scene);
    const second = canvases.slice(canvases2.length).filter((c) => c.last).map((c) => c.last!.slice(0, 256));
    expect(second.length).toBe(first.length);
    for (let i = 0; i < first.length; i++) {
      expect(Array.from(second[i])).toEqual(Array.from(first[i]));
    }
    for (const set of Object.values(kitB)) {
      set.albedo.dispose();
      set.normal?.dispose();
    }
  });
});
