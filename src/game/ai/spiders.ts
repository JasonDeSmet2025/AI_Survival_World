/**
 * Tower spiders — the hostile fauna of the witch's tower (ai/animals.ts is
 * the herd twin; same architecture, opposite intent).
 *
 * A spider lives on ONE surface: the terrain court around the tower, or one
 * of the tower's floors. It patrols its leash, and the moment the player
 * steps onto its level within SPIDER_AGGRO_RANGE it scuttles at them and
 * bites (SPIDER_BITE_DAMAGE, gated by the bite cooldown — the numbers and
 * the aggro/floor logic are pure, see systems/combat.ts, and the game shell
 * applies the damage through the shield's absorbDamage).
 *
 * The sword fights back: `damage()` takes the same whole-hit economy as the
 * herd (a stone sword swings removes 2 of SPIDER_HITS hits). A dead spider
 * curls its legs, topples and sinks; the game rolls the loot (spider silk,
 * sometimes a coin) while the collapse plays and removes it at `gone`.
 *
 * MODEL BUILD, same rule as everything else here: a joint hierarchy of
 * rounded primitives, never boxes, and the body meshes deliberately stay
 * UNFROZEN (a frozen mesh under an animated parent glues to its spawn —
 * see the long comment in ai/animals.ts).
 *
 *   root
 *    ├─ abdomen (gland bulb, patterned) ─ spinnerets
 *    ├─ cephalothorax ─ chelicerae (fangs) ×2, eye cluster ×8, pedipalps ×2
 *    └─ legPivot ×8 ─ femur ─ kneePivot ─ tibia ─ tarsus tip
 *
 * Legs 1+2 swing with legs 3+4 out of phase by side: real spiders move four
 * legs at a time and it reads as eight restless lines, not four.
 */
import { Color3, Mesh, MeshBuilder, PBRMaterial, Scene, TransformNode } from '@babylonjs/core';
import { mulberry32 } from '../core/noise';
import {
  SPIDER_BITE_DAMAGE,
  SPIDER_CHASE_LIMIT,
  SPIDER_HITS,
  SPIDER_SPEED_CHASE,
  SPIDER_SPEED_PATROL,
  canBite,
  spiderAggro,
} from '../systems/combat';

/** Seconds of collapse animation before the game may remove the spider. */
const DEATH_SECONDS = 0.8;

/** Where a spider lives. `floorY` is its walk surface; court = terrain. */
export interface SpiderHome {
  x: number;
  z: number;
  floorY: number;
  leash: number;
  /** Court spiders roam the terrain ring; inside spiders stay in the shell. */
  kind: 'court' | 'inside';
}

export class Spider {
  readonly id: string;
  readonly root: TransformNode;
  private home: SpiderHome;
  /** Terrain sampler for court spiders (injected: keeps this file Babylon-only). */
  private groundAt: (x: number, z: number) => number;
  private mats: PBRMaterial[] = [];
  private bodyMeshes: Mesh[] = [];
  private shadowParts: Mesh[] = [];
  private legs: { pivot: TransformNode; knee: TransformNode; phase: number }[] = [];
  private chelicerae: TransformNode[] = [];
  private targetX: number;
  private targetZ: number;
  private yaw: number;
  private walkPhase = 0;
  private animT = 0;
  /** Idle pause seconds (spiders freeze, then dart — ambush predators). */
  private pauseT = 0;
  private chasing = false;
  private hitT = 0;
  private hp = SPIDER_HITS;
  private dead = false;
  private dyingT = 0;
  private lastBiteAt = -999;
  /** Fang-lunge animation seconds remaining (set on a bite). */
  private lungeT = 0;
  private size: number;

  constructor(
    scene: Scene,
    id: string,
    home: SpiderHome,
    seed: number,
    groundAt: (x: number, z: number) => number,
  ) {
    this.id = id;
    this.home = home;
    this.groundAt = groundAt;
    const rng = mulberry32(seed);
    this.size = 0.92 + rng() * 0.22;
    this.root = new TransformNode(`spider_${id}`, scene);
    this.root.position.set(home.x, home.floorY, home.z);
    this.root.scaling.set(this.size, this.size, this.size);
    this.yaw = rng() * Math.PI * 2;
    this.targetX = home.x;
    this.targetZ = home.z;

    // --- materials ----------------------------------------------------------
    const pbr = (name: string, albedo: Color3, rough: number, metallic = 0): PBRMaterial => {
      const m = new PBRMaterial(`spider_${name}_${id}`, scene);
      m.albedoColor = albedo;
      m.metallic = metallic;
      m.roughness = rough;
      m.environmentIntensity = 0.7;
      m.emissiveColor = new Color3(albedo.r * 0.06, albedo.g * 0.06, albedo.b * 0.06);
      this.mats.push(m);
      return m;
    };
    // Wet tar-purple chitin, horn-brown legs, dull ember eyes: this thing is
    // not a garden spider and should not look friendly at 2 metres.
    const sheen = 0.18 + rng() * 0.12;
    const chitin = pbr('chitin', new Color3(0.09 + sheen * 0.2, 0.06, 0.11 + sheen * 0.3), 0.34, 0.25);
    const legMat = pbr('leg', new Color3(0.13, 0.09, 0.1), 0.42, 0.15);
    const belly = pbr('belly', new Color3(0.16, 0.1, 0.13), 0.5);
    const eye = pbr('eye', new Color3(0.55, 0.09, 0.06), 0.15);
    eye.emissiveColor = new Color3(0.32, 0.03, 0.02);
    const fang = pbr('fang', new Color3(0.35, 0.3, 0.24), 0.25);

    const p = (mesh: Mesh, mat: PBRMaterial, parent: TransformNode, name: string, x: number, y: number, z: number, casts = false): Mesh => {
      mesh.name = `spiderPart_${id}_${name}`;
      mesh.parent = parent;
      mesh.position.set(x, y, z);
      mesh.material = mat;
      mesh.receiveShadows = false;
      this.bodyMeshes.push(mesh);
      if (casts) this.shadowParts.push(mesh);
      return mesh;
    };

    // Body sits low — a spider is a plate of legs with a payload.
    const hipY = 0.17;
    // Abdomen: big gland bulb carried slightly high and BACK.
    const abd = p(
      MeshBuilder.CreateSphere('abdomen', { diameter: 0.36, segments: 10 }, scene),
      chitin, this.root, 'abdomen', 0, hipY + 0.1, -0.2, true,
    );
    abd.scaling.set(0.86, 0.8, 1.15);
    // Pale dorsal mark: the witch's towers breed the hourglass kind.
    const mark = p(
      MeshBuilder.CreateSphere('mark', { diameter: 0.16, segments: 6 }, scene),
      belly, this.root, 'mark', 0, hipY + 0.22, -0.24, false,
    );
    mark.scaling.set(0.5, 0.5, 1.5);
    const cephal = p(
      MeshBuilder.CreateSphere('cephalothorax', { diameter: 0.22, segments: 10 }, scene),
      chitin, this.root, 'cephalothorax', 0, hipY + 0.04, 0.09, true,
    );
    cephal.scaling.set(0.95, 0.72, 1.05);

    // Eye cluster: two big primaries + six specks, all catching light.
    for (const s of [-1, 1] as const) {
      p(MeshBuilder.CreateSphere('eyeL', { diameter: 0.045, segments: 6 }, scene), eye, this.root, `eye${s}`, s * 0.045, hipY + 0.12, 0.185, false);
      p(MeshBuilder.CreateSphere('eyes', { diameter: 0.024, segments: 6 }, scene), eye, this.root, `eyes${s}`, s * 0.08, hipY + 0.11, 0.17, false);
    }

    // Chelicerae: two fang-pivots the lunge animation swings.
    for (const s of [-1, 1] as const) {
      const jaw = new TransformNode(`chelicera${s}_${id}`, scene);
      jaw.parent = this.root;
      jaw.position.set(s * 0.05, hipY - 0.01, 0.21);
      p(
        MeshBuilder.CreateSphere('chel', { diameter: 0.07, segments: 6 }, scene),
        chitin, jaw, `chel${s}`, 0, 0.01, 0, false,
      );
      const f = p(
        MeshBuilder.CreateCylinder('fang', { diameterTop: 0.006, diameterBottom: 0.022, height: 0.075, tessellation: 6 }, scene),
        fang, jaw, `fang${s}`, 0, -0.05, 0.012, false,
      );
      f.rotation.x = 0.5;
      this.chelicerae.push(jaw);
    }

    // --- eight legs, four per side, two segments each -----------------------
    // Hip row along the cephalothorax; segment 1&2 face forward, 3&4 back.
    const hips: Array<[side: number, z: number, len1: number, len2: number, yaw0: number]> = [
      [-1, 0.14, 0.3, 0.3, -0.7],
      [-1, 0.06, 0.32, 0.3, -0.25],
      [-1, -0.02, 0.32, 0.3, 0.3],
      [-1, -0.1, 0.3, 0.32, 0.75],
      [1, 0.14, 0.3, 0.3, 0.7],
      [1, 0.06, 0.32, 0.3, 0.25],
      [1, -0.02, 0.32, 0.3, -0.3],
      [1, -0.1, 0.3, 0.32, -0.75],
    ];
    hips.forEach(([side, z, l1, l2, yaw0], i) => {
      const pivot = new TransformNode(`legPivot${i}_${id}`, scene);
      pivot.parent = this.root;
      pivot.position.set(side * 0.08, hipY + 0.05, z);
      pivot.rotation.y = yaw0 * side * -1;
      const femur = p(
        MeshBuilder.CreateCapsule('femur', { radius: 0.017, height: l1 + 0.034, tessellation: 6 }, scene),
        legMat, pivot, `femur${i}`, 0, 0, side * l1 * 0.32, false,
      );
      femur.rotation.z = side * 1.15; // thigh raises out and up
      const knee = new TransformNode(`kneePivot${i}_${id}`, scene);
      knee.parent = pivot;
      knee.position.set(side * l1 * 0.82, 0.075, 0);
      const tibia = p(
        MeshBuilder.CreateCapsule('tibia', { radius: 0.014, height: l2 + 0.028, tessellation: 6 }, scene),
        legMat, knee, `tibia${i}`, 0, 0, side * l2 * 0.3, false,
      );
      tibia.rotation.z = -side * 0.9; // shin angles back down to the floor
      tibia.rotation.x = side * 0.0;
      this.legs.push({ pivot, knee, phase: (i % 4) * (Math.PI / 2) + (side > 0 ? Math.PI / 4 : 0) });
    });

    for (const m of this.mats) m.freeze();
  }

  get position() {
    return this.root.position;
  }

  get alive(): boolean {
    return !this.dead;
  }

  /** Collapse finished — the game unregisters + disposes. */
  get gone(): boolean {
    return this.dead && this.dyingT >= DEATH_SECONDS;
  }

  distanceTo(x: number, z: number): number {
    return Math.hypot(this.root.position.x - x, this.root.position.z - z);
  }

  /**
   * Land hits on the spider. Returns true when this blow killed it.
   * A bitten/beset spider does NOT flee — it is guarding its tower.
   */
  damage(hits: number): boolean {
    if (this.dead) return false;
    this.hp -= Math.max(1, hits);
    this.hitT = 0.25;
    if (this.hp <= 0) {
      this.dead = true;
      this.chasing = false;
      return true;
    }
    return false;
  }

  /**
   * Per-frame update. Returns true when this frame's bite landed — the game
   * applies SPIDER_BITE_DAMAGE through the shield rule and owns the vignette.
   */
  update(dt: number, px: number, py: number, pz: number, combatT: number, frozen: boolean): boolean {
    if (this.dead) {
      // Curl: legs fold inward, body tips over and sinks a finger-width.
      this.dyingT += dt;
      const k = Math.min(1, this.dyingT / DEATH_SECONDS);
      const e = k * k * (3 - 2 * k);
      for (const l of this.legs) {
        l.pivot.rotation.x = -0.9 * e;
        l.knee.rotation.x = 1.5 * e;
      }
      this.root.rotation.z = Math.PI * 0.85 * e;
      this.root.position.y = this.home.floorY - 0.08 * e;
      return false;
    }
    if (frozen) return false;

    this.animT += dt;
    this.hitT = Math.max(0, this.hitT - dt);
    this.lungeT = Math.max(0, this.lungeT - dt);

    const p = this.root.position;
    const biteRange = this.distanceTo(px, pz);

    // --- aggro / leash -------------------------------------------------------
    if (!this.chasing && spiderAggro(px, pz, py, { x: p.x, z: p.z, y: p.y })) {
      this.chasing = true;
    } else if (this.chasing) {
      const fromHome = Math.hypot(p.x - this.home.x, p.z - this.home.z);
      if (fromHome > SPIDER_CHASE_LIMIT || Math.abs(py - p.y) >= 2.6) this.chasing = false;
    }

    let speed: number;
    let moving = true;
    if (this.chasing) {
      speed = SPIDER_SPEED_CHASE;
      this.targetX = px;
      this.targetZ = pz;
    } else {
      speed = SPIDER_SPEED_PATROL;
      if (this.pauseT > 0) {
        this.pauseT -= dt;
        moving = false;
      } else if (Math.hypot(this.targetX - p.x, this.targetZ - p.z) < 0.3) {
        // New patrol spot somewhere on the leash; pause first (ambush crawl).
        this.pauseT = 0.6 + Math.random() * 1.8;
        const ang = Math.random() * Math.PI * 2;
        const r = Math.random() * this.home.leash;
        this.targetX = this.home.x + Math.cos(ang) * r;
        this.targetZ = this.home.z + Math.sin(ang) * r;
        moving = false;
      }
    }

    // --- integrate on its own floor -------------------------------------------
    if (moving) {
      let nx = p.x + Math.sin(this.yaw) * speed * dt;
      let nz = p.z + Math.cos(this.yaw) * speed * dt;
      if (this.home.kind === 'court') {
        // Keep court spiders OUT of the stone shell (they have no door key).
        const dx = nx - this.home.x;
        const dz = nz - this.home.z;
        const d = Math.hypot(dx, dz);
        const minR = 5.6; // just outside the wall shell
        if (d < minR && d > 1e-4) {
          nx = this.home.x + (dx / d) * minR;
          nz = this.home.z + (dz / d) * minR;
        }
        p.set(nx, this.groundAt(nx, nz), nz);
      } else {
        // Inside: clamp to the interior square so a floor never drops a
        // spider through the staircase hole or out the doorway.
        const inX = Math.min(3.0, Math.max(-3.0, nx - this.home.x));
        const inZ = Math.min(3.0, Math.max(-3.0, nz - this.home.z));
        p.set(this.home.x + inX, this.home.floorY, this.home.z + inZ);
      }
      this.walkPhase += dt * speed * 5.2;
    } else {
      this.walkPhase *= Math.max(0, 1 - dt * 6);
    }

    // Turn towards the target (chase: the player; patrol: the next spot).
    const tx = this.chasing ? px : this.targetX;
    const tz = this.chasing ? pz : this.targetZ;
    if (Math.abs(tx - p.x) + Math.abs(tz - p.z) > 0.05) {
      this.yaw = Math.atan2(tx - p.x, tz - p.z);
    }
    this.root.rotation.y = this.yaw;

    // --- bite -----------------------------------------------------------------
    let bit = false;
    if (this.chasing && biteRange <= 1.25 && Math.abs(py - p.y) < 1.4 && canBite(combatT, this.lastBiteAt)) {
      this.lastBiteAt = combatT;
      this.lungeT = 0.28;
      bit = true;
    }

    // --- animation -------------------------------------------------------------
    // Gait: legs 0-3 (left) and 4-7 (right) in alternating quarter phases.
    const amp = this.chasing ? 0.5 : 0.3;
    for (const l of this.legs) {
      if (moving) {
        const s = Math.sin(this.walkPhase + l.phase);
        l.pivot.rotation.x = s * amp;
        l.knee.rotation.x = -Math.max(0, s) * 0.5;
      } else {
        l.pivot.rotation.x *= Math.max(0, 1 - dt * 5);
        l.knee.rotation.x *= Math.max(0, 1 - dt * 5);
      }
    }
    // Body bob: a shallow per-step dip; the lunge pitches the whole front down.
    p.y =
      (this.home.kind === 'court' ? this.groundAt(p.x, p.z) : this.home.floorY) +
      (moving ? Math.abs(Math.sin(this.walkPhase)) * 0.02 : 0);
    const lunge = this.lungeT > 0 ? Math.sin((this.lungeT / 0.28) * Math.PI) : 0;
    this.root.rotation.x = lunge * 0.5;
    for (const [i, jaw] of this.chelicerae.entries()) {
      jaw.rotation.x = -lunge * 0.9 + Math.sin(this.animT * 3 + i) * 0.05;
    }
    // Abdomen pulse (breathing through the book lungs, unnoticeable at 10 m
    // and deeply unnerving at 2 m).
    const pulse = 1 + Math.sin(this.animT * 1.9) * 0.02;
    const abdMesh = this.bodyMeshes[0];
    if (abdMesh) abdMesh.scaling.set(0.86 * pulse, 0.8 / pulse, 1.15);
    // Hit flinch: a quick shake.
    if (this.hitT > 0) {
      this.root.position.x += (Math.random() - 0.5) * 0.02;
      this.root.position.z += (Math.random() - 0.5) * 0.02;
    }
    return bit;
  }

  get shadowMeshes(): Mesh[] {
    return this.shadowParts;
  }

  dispose(): void {
    this.root.dispose(false, true);
    for (const m of this.mats) m.dispose();
  }
}

/** Spider loot (the game rolls it with its own rng and inventory). */
export const SPIDER_SILK_DROP: [min: number, max: number] = [1, 2];
/** Chance (0..1) a dead spider carried a coin in its web-bag. */
export const SPIDER_COIN_CHANCE = 0.35;
export const SPIDER_COIN_RANGE: [min: number, max: number] = [1, 4];
/**
 * Tower herb: the witch's guards carry a sprig of her grow-bag on them —
 * the drop that seeds the player's own salve craft (core/items.ts). Only
 * tower spiders practically ever have it, but the roll is world-wide on
 * purpose so the volcano den smells like the witch too.
 */
export const SPIDER_HERB_CHANCE = 0.4;
export const SPIDER_HERB_RANGE: [min: number, max: number] = [1, 2];
/** XP source label (progress system keeps spiders worth killing). */
export const SPIDER_XP = 'kill';
/** Damage a spider bite does — re-export so game.ts imports one module. */
export { SPIDER_BITE_DAMAGE };
