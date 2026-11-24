import { describe, expect, it } from 'vitest';
import { NullEngine, Scene } from '@babylonjs/core';
import { createTool } from './tools';
import type { SharedMaterials } from '../visual/materials';
import { Color3, PBRMaterial } from '@babylonjs/core';

function matSet(scene: Scene): SharedMaterials {
  return new Proxy({} as Record<string, PBRMaterial>, {
    get: (t, k: string) => {
      if (!t[k]) { const m = new PBRMaterial(k, scene); m.albedoColor = new Color3(0.5, 0.5, 0.5); t[k] = m; }
      return t[k];
    },
  }) as unknown as SharedMaterials;
}

/**
 * The bug this guards: Babylon's `.parent =` / `addChild()` keep the WORLD
 * transform when re-parenting, so every part positioned BEFORE parenting got
 * silently recomputed against the world origin — the axe/pick heads "sank"
 * by exactly the head-node height and hung out of the fist, i.e. the tool
 * looked upside down. The convention the models must keep: the head part
 * sits ABOVE the origin (the fist), the handle butt BELOW.
 */
describe('tool models follow the fist-pivot convention', () => {
  for (const [id, head, butt] of [
    ['stone_axe', 'axeStone', 'handleButt'],
    ['stone_pick', 'pickBoss', 'handleButt'],
    ['sword', 'swordBlade', 'swordPommel'],
  ] as const) {
    it(`${id}: head above the fist, butt below`, () => {
      const scene = new Scene(new NullEngine());
      const tool = createTool(id, scene, matSet(scene));
      const find = (n: string) => tool.getChildMeshes(false).find((m) => m.name === n)!;
      // Absolute positions with the tool still at the identity origin:
      // the whole chain must survive parenting intact.
      const chain: import('@babylonjs/core').Node[] = [];
      const headMesh = find(head);
      let nd: import('@babylonjs/core').Nullable<import('@babylonjs/core').Node> = headMesh;
      while (nd) { chain.unshift(nd); nd = nd.parent; }
      for (const n of chain) n.computeWorldMatrix(true);
      const hy = headMesh.getAbsolutePosition().y;
      expect(hy, `${head} must be above the fist origin (local Y ${hy})`).toBeGreaterThan(0.2);
      const buttMesh = find(butt);
      chain.length = 0; nd = buttMesh;
      while (nd) { chain.unshift(nd); nd = nd.parent; }
      for (const n of chain) n.computeWorldMatrix(true);
      const by = buttMesh.getAbsolutePosition().y;
      expect(by, `handle butt must hang at/below the fist (local Y ${by})`).toBeLessThan(0.1);
      tool.dispose();
    });
  }
});
