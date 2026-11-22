/**
 * Regression tests for the herd: model + movement.
 *
 * Two bugs these guard against:
 *  1. the body parts used to be `freezeWorldMatrix()`-ed at construction. A
 *     frozen mesh never recomputes its world matrix, so when the (unfrozen)
 *     root/neck/knee pivots moved, every body part kept the matrix it had at
 *     spawn — the herd walked around as invisible roots while the visible
 *     sheep and cows stayed frozen on their spawn points.
 *  2. the old model was a box barrel with four floating cylinders: hooves
 *     floated above the grass and the head was a cube on a stick. The tests
 *     below pin the envelope (withers height, feet on the ground) so a future
 *     "improvement" cannot silently drift back to a toy.
 */
import { describe, expect, it } from 'vitest';
import { Mesh, NullEngine, Scene, TransformNode } from '@babylonjs/core';
import { Animal } from './animals';
import { groundSurfaceHeight } from '../world/groundSurface';
import { SEA_LEVEL } from '../world/terrain';
import type { SharedMaterials } from '../visual/materials';

// No texture kit in the unit tests: the herd falls back to flat albedo tints.
const MATS = {} as SharedMaterials;

/** Any dry inland point works — the herd AI only needs solid ground. */
function drySpot(): { x: number; z: number } {
  for (let r = 6; r < 90; r += 4) {
    for (let a = 0; a < 8; a++) {
      const x = Math.cos((a / 8) * Math.PI * 2) * r;
      const z = Math.sin((a / 8) * Math.PI * 2) * r;
      if (groundSurfaceHeight(x, z) > SEA_LEVEL + 1.5) return { x, z };
    }
  }
  throw new Error('no dry land found');
}

function makeAnimal(kind: 'sheep' | 'cow', seed = 4242) {
  const scene = new Scene(new NullEngine());
  const { x, z } = drySpot();
  const animal = new Animal(scene, `t_${kind}`, kind, x, z, seed, MATS);
  return { scene, animal, x, z };
}

/** World-space position of a part (cached world matrix = what is rendered). */
const worldPos = (n: Mesh | TransformNode) => {
  const t = n.computeWorldMatrix(true).getTranslation();
  return { x: t.x, y: t.y, z: t.z };
};

const named = (a: Animal, needle: string): Mesh[] =>
  (a.root.getChildMeshes(false) as Mesh[]).filter((m) => m.name.includes(needle));

const nodesNamed = (a: Animal, needle: string): TransformNode[] =>
  a.root.getChildTransformNodes(false).filter((n) => n.name.includes(needle));

/** Lowest point of a part's world bounding box. */
function worldMinY(m: Mesh): number {
  m.computeWorldMatrix(true);
  const b = m.getBoundingInfo().boundingBox;
  let min = Infinity;
  for (const c of [b.minimumWorld, b.maximumWorld]) min = Math.min(min, c.y);
  return min;
}

describe('Animal model', () => {
  it('builds a full jointed body for both species', () => {
    for (const kind of ['sheep', 'cow'] as const) {
      const { scene, animal } = makeAnimal(kind);
      const names = named(animal, '_').map((m) => m.name);
      for (const part of ['body', 'chest', 'rump', 'neck', 'skull', 'muzzle', 'upperLegFL', 'lowerLegRR', 'hoofFL']) {
        expect(names.some((n) => n.includes(`_${part}`)), `${kind} part ${part}`).toBe(true);
      }
      expect(nodesNamed(animal, 'legPivot')).toHaveLength(4);
      expect(nodesNamed(animal, 'kneePivot')).toHaveLength(4);
      expect(nodesNamed(animal, 'earPivot')).toHaveLength(2);
      expect(nodesNamed(animal, 'tailPivot').length).toBeGreaterThan(0);
      expect(nodesNamed(animal, 'headPivot')).toHaveLength(1);
      scene.dispose();
    }
  });

  it('stands on its own hooves: feet at grass level, withers at species height', () => {
    // Relative to the grass: a sheep tops out just under the player's hip (1.72 m), a cow at chest height.
    const expected = { sheep: [0.7, 1.18], cow: [1.05, 1.75] } as const;
    for (const kind of ['sheep', 'cow'] as const) {
      const { scene, animal } = makeAnimal(kind, 31337);
      // Measure against the root: the root sits exactly on the terrain
      // sample, so a relative y of 0 is "at the grass" wherever we spawned.
      const base = animal.position.y;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const m of named(animal, '_')) {
        minY = Math.min(minY, worldMinY(m) - base);
        maxY = Math.max(maxY, worldMaxY(m) - base);
      }
      // The lowest part must touch the ground, but never sink through it.
      expect(minY, `${kind} feet reach the grass`).toBeLessThan(0.09);
      expect(minY, `${kind} does not sink`).toBeGreaterThan(-0.12);
      const [lo, hi] = expected[kind];
      expect(maxY, `${kind} height envelope`).toBeGreaterThan(lo);
      expect(maxY, `${kind} is not a giant`).toBeLessThan(hi);
      scene.dispose();
    }
  });

  it('every species variant stays inside the herd silhouette', () => {
    // Twelve seeds cover every palette roll (dark/white face, holstein,
    // jersey, red pied) — no seed may produce a malformed animal.
    for (let seed = 1; seed <= 12; seed++) {
      for (const kind of ['sheep', 'cow'] as const) {
        const { scene, animal } = makeAnimal(kind, seed * 977);
        const parts = named(animal, '_');
        expect(parts.length, `${kind} seed ${seed} parts`).toBeGreaterThan(25);
        for (const m of parts) {
          const p = worldPos(m);
          // Nothing may stick out more than 1.2 m from the root horizontally
          // (a detached ear/horn would be the symptom of a bad hierarchy).
          expect(Math.abs(p.x - animal.position.x), `${kind} seed ${seed} ${m.name}`).toBeLessThan(1.2);
          expect(Math.abs(p.z - animal.position.z), `${kind} seed ${seed} ${m.name}`).toBeLessThan(1.6);
          expect(Number.isFinite(p.y), `${kind} seed ${seed} ${m.name} y`).toBe(true);
        }
        scene.dispose();
      }
    }
  });

  it('cattle get horns/udders and sheep get fleece — never the other way round', () => {
    const cow = makeAnimal('cow', 4242);
    const sheep = makeAnimal('sheep', 4242);
    expect(named(cow.animal, '_udder').length).toBeGreaterThan(0);
    expect(named(sheep.animal, '_udder')).toHaveLength(0);
    expect(named(sheep.animal, '_fleece').length).toBeGreaterThan(4);
    expect(named(cow.animal, '_fleece')).toHaveLength(0);
    cow.scene.dispose();
    sheep.scene.dispose();
  });
});

describe('Animal movement', () => {
  it('walks away from its spawn point while grazing', () => {
    const { scene, animal, x, z } = makeAnimal('sheep', 11);
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 30; i++) animal.update(dt, x + 50, z + 50, false);
    const moved = Math.hypot(animal.position.x - x, animal.position.z - z);
    expect(moved, 'grazing animal must leave its spawn point').toBeGreaterThan(0.5);
    // And it stays on the surface it stands on, never under the sea line.
    expect(animal.position.y).toBeGreaterThan(SEA_LEVEL);
    scene.dispose();
  });

  it('body parts follow the moving root (no frozen world matrices)', () => {
    const { scene, animal } = makeAnimal('cow', 77);
    const parts = animal.shadowMeshes;
    expect(parts.length).toBeGreaterThan(6);

    // Baseline: right after construction the visible body is where the root is.
    const before = parts.map(worldPos);
    animal.root.position.x += 12;
    animal.root.position.z += 9;
    const after = parts.map(worldPos);

    let shifted = 0;
    for (let i = 0; i < parts.length; i++) {
      if (Math.hypot(after[i].x - before[i].x, after[i].z - before[i].z) > 1) shifted++;
    }
    expect(shifted, 'every body part must translate with the root').toBe(parts.length);
    scene.dispose();
  });

  it('swings its legs while walking and holds them still while grazing', () => {
    const { scene, animal, x, z } = makeAnimal('sheep', 5);
    const dt = 1 / 60;
    const pivots = nodesNamed(animal, 'legPivot');
    const knees = nodesNamed(animal, 'kneePivot');
    const gait = (nodes: TransformNode[]) => nodes.reduce((a, n) => a + Math.abs(n.rotation.x), 0);

    animal.damage(x - 1, z - 1); // flee -> guaranteed movement for a while
    let maxSwing = 0;
    let minSwing = Infinity;
    let maxKnee = 0;
    for (let i = 0; i < 60 * 25; i++) {
      animal.update(dt, x, z, false);
      maxSwing = Math.max(maxSwing, gait(pivots));
      minSwing = Math.min(minSwing, gait(pivots));
      maxKnee = Math.max(maxKnee, gait(knees));
    }
    expect(maxSwing, 'leg pivots must swing during the gait').toBeGreaterThan(0.8);
    expect(maxKnee, 'knees must bend during the gait').toBeGreaterThan(0.5);
    // And the herd still pauses to graze: legs fully straight at some point.
    expect(minSwing, 'the animal must come to a standstill to graze').toBeLessThan(0.05);
    scene.dispose();
  });

  it('steps in diagonal pairs, not in a table-crawl', () => {
    const { scene, animal, x, z } = makeAnimal('cow', 909);
    const dt = 1 / 60;
    animal.damage(x - 1, z - 1);
    const leg = (label: string) => nodesNamed(animal, `legPivot_${label}`)[0];
    let samples = 0;
    let against = 0; // front-left opposite to front-right (correct gait)
    let diagonal = 0; // front-left in phase with rear-right (correct gait)
    for (let i = 0; i < 240; i++) {
      animal.update(dt, x, z, false);
      const fl = leg('FL').rotation.x;
      const fr = leg('FR').rotation.x;
      const rr = leg('RR').rotation.x;
      if (Math.abs(fl) < 0.2) continue; // only judge frames with a real swing
      samples++;
      if (Math.sign(fl) !== Math.sign(fr)) against++;
      if (Math.sign(fl) === Math.sign(rr)) diagonal++;
    }
    expect(samples, 'the gait must be sampled').toBeGreaterThan(40);
    expect(against / samples, 'front legs alternate').toBeGreaterThan(0.8);
    expect(diagonal / samples, 'front-left lands with rear-right').toBeGreaterThan(0.8);
    scene.dispose();
  });

  it('neck and head dip together while grazing, head up while fleeing', () => {
    const { scene, animal, x, z } = makeAnimal('cow', 2024);
    const dt = 1 / 60;
    const neck = nodesNamed(animal, 'neckPivot')[0];
    const head = nodesNamed(animal, 'headPivot')[0];
    // Run long enough to cover walk + graze + head-up-scan poses.
    let maxDip = -Infinity;
    let neckRange = 0;
    let minNeck = Infinity;
    let maxNeck = -Infinity;
    for (let i = 0; i < 60 * 40; i++) {
      animal.update(dt, x + 60, z + 60, false);
      maxDip = Math.max(maxDip, neck.rotation.x + head.rotation.x);
      minNeck = Math.min(minNeck, neck.rotation.x);
      maxNeck = Math.max(maxNeck, neck.rotation.x);
      neckRange = maxNeck - minNeck;
    }
    // Grazing: neck and head together point the muzzle at the grass.
    expect(maxDip, 'grazing bends neck + head down').toBeGreaterThan(1.1);
    // And the neck really articulates (walking vs grazing vs scanning).
    expect(neckRange, 'the neck must bend, not stay bolted').toBeGreaterThan(0.3);

    animal.damage(x, z);
    for (let i = 0; i < 40; i++) animal.update(dt, x, z, false);
    expect(neck.rotation.x + head.rotation.x, 'running animal carries its head up').toBeLessThan(0);
    scene.dispose();
  });

  it('swishes its tail and flicks its ears while standing', () => {
    const { scene, animal, x, z } = makeAnimal('cow', 606);
    const dt = 1 / 60;
    const tail = nodesNamed(animal, 'tailPivot')[0];
    const ears = nodesNamed(animal, 'earPivot');
    for (let i = 0; i < 60 * 12; i++) animal.update(dt, x + 60, z + 60, false);
    const tailAngles = new Set<number>();
    const earAngles = new Set<number>();
    for (let i = 0; i < 60 * 10; i++) {
      animal.update(dt, x + 60, z + 60, false);
      tailAngles.add(Number(tail.rotation.z.toFixed(3)));
      earAngles.add(Number(ears[0].rotation.z.toFixed(3)));
    }
    expect(tailAngles.size, 'tail must swish').toBeGreaterThan(30);
    expect(earAngles.size, 'ears must twitch/sway').toBeGreaterThan(10);
    scene.dispose();
  });

  it('breathes while standing still', () => {
    const { scene, animal, x, z } = makeAnimal('sheep', 9);
    const body = named(animal, '_body')[0];
    const dt = 1 / 60;
    // Let it settle into a graze pause first.
    for (let i = 0; i < 60 * 8; i++) animal.update(dt, x + 40, z + 40, false);
    const scales = new Set<number>();
    for (let i = 0; i < 120; i++) {
      animal.update(dt, x + 40, z + 40, false);
      scales.add(Number(body.scaling.x.toFixed(4)));
    }
    expect(scales.size, 'chest must swell with the breathing cycle').toBeGreaterThan(20);
    scene.dispose();
  });

  it('freezes only while chatting/dead and keeps the tip-over on death', () => {
    const { scene, animal, x, z } = makeAnimal('cow', 31);
    const p = { x: animal.position.x, y: animal.position.y, z: animal.position.z };
    for (let i = 0; i < 30; i++) animal.update(1 / 60, x, z, true);
    expect(animal.position.x).toBe(p.x);
    expect(animal.position.z).toBe(p.z);

    let died = false;
    for (let i = 0; i < 10 && !died; i++) died = animal.damage(x, z);
    while (!died) died = animal.damage(x, z);
    for (let i = 0; i < 30; i++) animal.update(1 / 60, x, z, false);
    expect(animal.root.rotation.z, 'collapse tips the body over').toBeGreaterThan(0.2);
    const knees = nodesNamed(animal, 'kneePivot');
    expect(knees.reduce((a, n) => a + n.rotation.x, 0), 'legs fold on death').toBeGreaterThan(1);
    for (let i = 0; i < 60 * 2; i++) animal.update(1 / 60, x, z, false);
    expect(animal.gone).toBe(true);
    scene.dispose();
  });
});

function worldMaxY(m: Mesh): number {
  m.computeWorldMatrix(true);
  const b = m.getBoundingInfo().boundingBox;
  let max = -Infinity;
  for (const c of [b.minimumWorld, b.maximumWorld]) max = Math.max(max, c.y);
  return max;
}
