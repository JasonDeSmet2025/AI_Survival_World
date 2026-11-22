import { describe, expect, it } from 'vitest';
import { Vector3 } from '@babylonjs/core';
import { raycastTarget, type InteractTarget } from './interact';
import { mulberry32 } from '../core/noise';

/**
 * Reference implementation: the original straightforward vector-based
 * ray/sphere pick. The optimized scalar implementation in interact.ts
 * must agree with this on every input (pinned by fuzz tests below).
 */
function referenceRaycast(
  origin: Vector3,
  dir: Vector3,
  targets: InteractTarget[],
  maxRange = 6,
): { target: InteractTarget; point: Vector3; distance: number } | null {
  let best: { target: InteractTarget; point: Vector3; distance: number } | null = null;
  for (const t of targets) {
    const sphere = new Vector3(t.x, t.y, t.z);
    const toSphere = sphere.subtract(origin);
    const tca = toSphere.dot(dir);
    if (tca < 0) continue;
    const d2 = toSphere.lengthSquared() - tca * tca;
    const r = t.radius;
    if (d2 > r * r) continue;
    const thc = Math.sqrt(r * r - d2);
    const t1 = tca - thc;
    if (t1 < 0) continue;
    const dist = Math.min(t1, maxRange);
    if (!best || dist < best.distance) {
      best = { target: t, point: origin.add(dir.scale(dist)), distance: dist };
    }
  }
  return best;
}

const node = (id: string, x: number, y: number, z: number, radius = 1): InteractTarget => ({
  kind: 'node',
  id,
  x,
  y,
  z,
  radius,
});

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

describe('raycastTarget', () => {
  it('returns null for an empty target list', () => {
    expect(raycastTarget(new Vector3(0, 0, 0), new Vector3(1, 0, 0), [])).toBeNull();
  });

  it('hits a sphere straight ahead and reports entry point + distance', () => {
    const t = node('a', 10, 0, 0, 2);
    const pick = raycastTarget(new Vector3(0, 0, 0), new Vector3(1, 0, 0), [t], 20);
    expect(pick).not.toBeNull();
    expect(pick!.target).toBe(t);
    close(pick!.distance, 8);
    close(pick!.point.x, 8);
    close(pick!.point.y, 0);
  });

  it('misses spheres outside the radius', () => {
    const t = node('a', 10, 5, 0, 1);
    expect(raycastTarget(new Vector3(0, 0, 0), new Vector3(1, 0, 0), [t], 20)).toBeNull();
  });

  it('ignores targets behind the camera', () => {
    const t = node('a', -10, 0, 0, 5);
    expect(raycastTarget(new Vector3(0, 0, 0), new Vector3(1, 0, 0), [t], 20)).toBeNull();
  });

  it('skips a target whose sphere entry is behind the origin (camera inside)', () => {
    const t = node('a', 1, 0, 0, 3);
    expect(raycastTarget(new Vector3(0, 0, 0), new Vector3(1, 0, 0), [t], 20)).toBeNull();
  });

  it('prefers the closest intersection even when listed last', () => {
    const far = node('far', 30, 0, 0, 2);
    const near = node('near', 5, 0, 0, 1);
    const pick = raycastTarget(new Vector3(0, 0, 0), new Vector3(1, 0, 0), [far, near], 50);
    expect(pick!.target).toBe(near);
    close(pick!.distance, 4);
  });

  it('clamps the reported distance to maxRange (entry beyond range)', () => {
    // Sphere spans x=8..16, entry t1=8 with maxRange 5: the reference
    // behaviour is a clamped hit at distance 5.
    const t = node('a', 12, 0, 0, 4);
    const pick = raycastTarget(new Vector3(0, 0, 0), new Vector3(1, 0, 0), [t], 5);
    expect(pick).not.toBeNull();
    close(pick!.distance, 5);
    close(pick!.point.x, 5);
  });

  it('first target wins on an exact distance tie (strict <)', () => {
    const a = node('a', 10, 0, 2, 2); // exactly tangent to the +x ray
    const b = node('b', 10, 0, -2, 2);
    const pick = raycastTarget(new Vector3(0, 0, 0), new Vector3(1, 0, 0), [a, b], 50);
    expect(pick!.target).toBe(a);
  });

  it('handles non-axis-aligned rays', () => {
    const t = node('a', 6, 6, 0, Math.SQRT2);
    const dir = new Vector3(1, 1, 0).normalize();
    const pick = raycastTarget(new Vector3(0, 0, 0), dir, [t], 50);
    expect(pick).not.toBeNull();
    close(pick!.distance, 5 * Math.SQRT2);
  });

  describe('fuzz: agrees with the reference vector implementation', () => {
    const kinds = ['node', 'npc', 'campfire', 'bed', 'water'] as const;

    it('over 5000 deterministic random cases', () => {
      const rnd = mulberry32(0xc0ffee);
      for (let c = 0; c < 5000; c++) {
        const origin = new Vector3(rnd() * 40 - 20, rnd() * 10, rnd() * 40 - 20);
        const dir = new Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
        if (dir.lengthSquared() < 1e-6) continue;
        dir.normalize();
        const maxRange = 1 + rnd() * 10;
        const n = 1 + Math.floor(rnd() * 12);
        const targets: InteractTarget[] = [];
        for (let i = 0; i < n; i++) {
          targets.push({
            kind: kinds[Math.floor(rnd() * kinds.length)],
            id: `t${i}`,
            x: rnd() * 60 - 30,
            y: rnd() * 12 - 2,
            z: rnd() * 60 - 30,
            radius: 0.2 + rnd() * 4,
          } as InteractTarget);
        }
        const a = raycastTarget(origin, dir, targets, maxRange);
        const b = referenceRaycast(origin, dir, targets, maxRange);
        if (a === null || b === null) {
          expect(a === null).toBe(b === null);
          continue;
        }
        expect(a.target).toBe(b.target);
        expect(a.distance).toBeCloseTo(b.distance, 9);
        expect(a.point.x).toBeCloseTo(b.point.x, 9);
        expect(a.point.y).toBeCloseTo(b.point.y, 9);
        expect(a.point.z).toBeCloseTo(b.point.z, 9);
      }
    });
  });
});
