/**
 * Herd animal entities: procedural sheep and cow, grazing/wandering AI and
 * the hunt bookkeeping. Movement is pure game logic (same rule as the NPCs:
 * no LLM touches the position). All combat/loot NUMBERS live in
 * systems/fauna.ts — this file only renders and moves them.
 *
 * Behaviour per frame:
 *  - graze: pick a spot near the herd home, walk there slowly, pause and
 *    "graze" (neck + head dip, head lifts to scan every ~7 s), repeat;
 *  - flee: while a hit set the flee timer, gallop straight away from the
 *    player, tail swishing;
 *  - dying: a short collapse animation (legs fold, body tips over), then the
 *    game removes the animal.
 *
 * The y position follows the terrain sample (groundSurfaceHeight); animals
 * never path into water — a step that would land below the sea line is
 * refused and a new wander target is drawn.
 *
 * MODEL BUILD
 * Both species are built like the villager models: a joint hierarchy of
 * rounded primitives (capsules/spheres), never boxes.
 *
 *   root
 *    ├─ body (capsule, breathing scale) + chest + rump + fleece locks
 *    ├─ neckPivot ─ neck (tapered) ─ headPivot ─ skull, muzzle, nostrils,
 *    │                                             eyes, earPivots, horns, tuft
 *    ├─ legPivot ×4 ─ upper leg ─ kneePivot ─ lower leg ─ hoof
 *    └─ tailPivot ─ tail ─ tailTipPivot ─ tuft
 *
 * The legs are two-segment (hip + knee) and step in DIAGONAL pairs (front
 * left with rear right), which is what a real walk looks like; the neck and
 * the head share a graze dip so the whole forequarters bend, not just a
 * floating skull. Every animal draws from a deterministic palette (dark-faced
 * vs. white-faced sheep, Holstein / Jersey / red-pied cow), so a herd is a
 * herd and not seven copies.
 *
 * The body meshes deliberately keep their world-matrix computation alive:
 * see the comment in the constructor — frozen meshes under an animated parent
 * stay glued to the spawn point.
 */
import {
  Color3,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Scene,
  TransformNode,
} from '@babylonjs/core';
import { mulberry32 } from '../core/noise';
import { groundSurfaceHeight } from '../world/groundSurface';
import { SEA_LEVEL } from '../world/terrain';
import { ANIMALS, AnimalHealth, type AnimalKind } from '../systems/fauna';
import type { SharedMaterials } from '../visual/materials';
import type { PbrTextureSet } from '../visual/textures';

/** Seconds the collapse animation plays before the animal is gone. */
const DEATH_SECONDS = 0.9;

/** One animated leg: hip pivot -> upper -> knee pivot -> lower -> hoof. */
interface Leg {
  pivot: TransformNode;
  knee: TransformNode;
  /** Gait offset: diagonal pairs share a phase (0 or PI). */
  phase: number;
}

interface Palette {
  /** Body covering (wool or hide). */
  coat: Color3;
  /** Head skin (dark on Suffolk sheep, hide-coloured on cattle). */
  face: Color3;
  /** Muzzle / nose leather. */
  muzzle: Color3;
  /** Lower legs. */
  leg: Color3;
  /** Hoof horn. */
  hoof: Color3;
  /** Contrasting pied patches (null = solid-coloured animal). */
  patch: Color3 | null;
  /** Horn cores (null = polled). */
  horn: Color3 | null;
  /** Wool fleece lumps (sheep only). */
  fleece: boolean;
  /** Curly forelock / tail-tuft hair, usually darker than the coat. */
  hair: Color3;
}

export class Animal {
  readonly id: string;
  readonly kind: AnimalKind;
  readonly root: TransformNode;
  private scene: Scene;
  private health: AnimalHealth;
  private mats: PBRMaterial[] = [];
  /** All body parts (dispose + fallback shadow list). */
  private bodyMeshes: Mesh[] = [];
  /** Only the big silhouette parts registered as shadow casters. */
  private shadowParts: Mesh[] = [];
  private legs: Leg[] = [];
  private neckNode: TransformNode | null = null;
  private headNode: TransformNode | null = null;
  private ears: TransformNode[] = [];
  private tailNodes: TransformNode[] = [];
  /** Chest mesh — the only part that gets the idle "breathing" scale. */
  private bodyMesh: Mesh | null = null;
  /** Rest pitch of neck/head; the animated dip is added on top of these. */
  private neckBasePitch = 0;
  private headBasePitch = 0;
  /** Smoothed graze dip in radians (0 = level, positive = muzzle to grass). */
  private headDip = 0;
  /** Herd home — grazing wanders around this point. */
  private homeX: number;
  private homeZ: number;
  private targetX: number;
  private targetZ: number;
  private yaw = 0;
  private walkPhase = 0;
  /** Always-running clock for breathing / tail / ear cycles (never reset). */
  private animT = 0;
  /** Seconds left standing still and grazing (head down). */
  private grazeT = 0;
  /** Seconds left running away from the player. */
  private fleeT = 0;
  /** Set by damage(); drives the quick hit-tick. */
  private hitFlashT = 0;
  private dyingT = 0;
  private bodyY: number;

  constructor(
    scene: Scene,
    id: string,
    kind: AnimalKind,
    x: number,
    z: number,
    seed: number,
    mats: SharedMaterials,
  ) {
    this.scene = scene;
    this.id = id;
    this.kind = kind;
    this.health = new AnimalHealth(kind);
    this.homeX = x;
    this.homeZ = z;
    this.targetX = x;
    this.targetZ = z;
    const rng = mulberry32(seed);

    this.root = new TransformNode(`animal_${id}`, scene);
    this.bodyY = groundSurfaceHeight(x, z);
    this.root.position.set(x, this.bodyY, z);
    this.yaw = rng() * Math.PI * 2;

    const pal = kind === 'sheep' ? sheepPalette(rng) : cowPalette(rng);
    const fauna = (mats as { fauna?: { wool: FaunaTex; hide: FaunaTex } }).fauna;

    // --- materials --------------------------------------------------------
    // Local PBRMaterials (per-animal tint) borrowing the shared procedural
    // wool/hide maps: albedoColor multiplies the texture, so one texture
    // serves a cream ewe and a sooty black one.
    const pbr = (name: string, albedo: Color3, roughness: number, tex?: FaunaTex): PBRMaterial => {
      const m = new PBRMaterial(`animal_${name}_${id}`, scene);
      m.albedoColor = albedo;
      m.metallic = 0;
      m.roughness = roughness;
      m.environmentIntensity = 0.7;
      if (tex) {
        m.albedoTexture = tex.albedo;
        if (tex.normal) m.bumpTexture = tex.normal;
      }
      // A trace of self-colour keeps the herd readable in forest shade and
      // at night without looking self-lit.
      m.emissiveColor = new Color3(albedo.r * 0.05, albedo.g * 0.05, albedo.b * 0.05);
      this.mats.push(m);
      return m;
    };

    const coat = pbr('coat', pal.coat, kind === 'sheep' ? 0.99 : 0.78, fauna?.wool ?? fauna?.hide);
    const face = pbr('face', pal.face, kind === 'sheep' ? 0.95 : 0.72, fauna?.hide);
    const muzzle = pbr('muzzle', pal.muzzle, 0.5);
    const leg = pbr('leg', pal.leg, 0.85, fauna?.hide);
    const hoof = pbr('hoof', pal.hoof, 0.4);
    const hair = pbr('hair', pal.hair, 0.95, fauna?.wool);
    const dark = pbr('dark', new Color3(0.045, 0.038, 0.035), 0.5);
    const eyeMat = pbr('eye', new Color3(0.03, 0.026, 0.024), 0.16);
    const sclera = pbr('sclera', new Color3(0.52, 0.5, 0.47), 0.3);
    const patch = pal.patch ? pbr('patch', pal.patch, kind === 'sheep' ? 0.98 : 0.8, fauna?.wool) : coat;
    const hornMat = pal.horn ? pbr('horn', pal.horn, 0.55) : hoof;
    const udder = pbr('udder', new Color3(0.82, 0.6, 0.55), 0.55);

    const M: Mats = { coat, face, muzzle, leg, hoof, hair, dark, eye: eyeMat, sclera, patch, horn: hornMat, udder };

    if (kind === 'sheep') this.buildSheep(rng, M, pal);
    else this.buildCow(rng, M, pal);

    // NOTE: the body meshes are deliberately NOT frozen.
    // freezeWorldMatrix() makes Babylon skip the world-matrix computation of
    // that mesh for good — and every body part here hangs under animated
    // parents (root walk/turn, hip+knee pivots, neck, head, tail). A frozen
    // part keeps the matrix it had at spawn, which visually turns the herd
    // into statues on their spawn points while the invisible root walks away.
    // With a herd of 7 there is nothing to win: keep the hierarchy live.
    //
    // The MATERIALS are frozen instead: nothing here changes colour at
    // runtime (the hit-tick is a scale pulse), so Babylon can skip its
    // per-frame material re-check on ~60 animal materials.
    for (const m of this.mats) m.freeze();
  }

  get hp(): number {
    return this.health.hp;
  }

  get alive(): boolean {
    return !this.health.dead;
  }

  /** True once the collapse animation finished — the game removes it. */
  get gone(): boolean {
    return this.health.dead && this.dyingT >= DEATH_SECONDS;
  }

  get position() {
    return this.root.position;
  }

  /** Distance to a world point (used for flee steering + interaction). */
  distanceTo(x: number, z: number): number {
    return Math.hypot(this.root.position.x - x, this.root.position.z - z);
  }

  /**
   * Land one hit. Returns true when this hit killed the animal. A hit (or
   * any nearby shot) always sets the flee timer — herds scatter.
   */
  damage(playerX: number, playerZ: number): boolean {
    if (this.health.dead) return false;
    // Turn away from the player and run, even when the blow misses-adjacent.
    this.fleeT = ANIMALS[this.kind].fleeSeconds;
    this.yaw = Math.atan2(this.root.position.x - playerX, this.root.position.z - playerZ);
    this.hitFlashT = 0.3;
    this.grazeT = 0;
    return this.health.hit();
  }

  /**
   * Per-frame update. `frozen` pauses the herd (open chat/death/sleep).
   * Returns nothing; the game removes the animal once `gone` is true.
   */
  update(dt: number, _playerX: number, _playerZ: number, frozen: boolean): void {
    if (this.health.dead) {
      // Collapse: fold the legs, tip over + sink slightly into the grass.
      this.dyingT += dt;
      const k = Math.min(1, this.dyingT / DEATH_SECONDS);
      const e = k * k * (3 - 2 * k); // smoothstep, so the fall has weight
      this.root.rotation.z = (Math.PI / 2) * e * 0.9;
      this.root.position.y = this.bodyY - 0.12 * e;
      for (const l of this.legs) {
        l.pivot.rotation.x = 0.5 * e;
        l.knee.rotation.x = 0.95 * e;
      }
      if (this.headNode) this.headNode.rotation.x = this.headBasePitch + 0.5 * e;
      if (this.tailNodes[0]) this.tailNodes[0].rotation.x -= dt * 1.6;
      return;
    }
    if (frozen) return;

    const fleeing = this.fleeT > 0;
    this.fleeT = Math.max(0, this.fleeT - dt);
    this.hitFlashT = Math.max(0, this.hitFlashT - dt);
    this.animT += dt;

    // --- steering ----------------------------------------------------------
    let speed: number;
    let moving = true;
    if (fleeing) {
      speed = 3.4;
      // Keep running straight away until the timer runs out.
    } else {
      speed = 1.0;
      // Graze pause first, then walk to the current target.
      if (this.grazeT > 0) {
        this.grazeT -= dt;
        moving = false;
      } else {
        const d = Math.hypot(this.targetX - this.root.position.x, this.targetZ - this.root.position.z);
        if (d < 0.35) {
          // Arrived: eat for a while, then pick a new spot near home. The
          // pause is deliberately short — a herd that stands still for ten
          // seconds reads as a decoration, not as livestock.
          this.grazeT = 0.8 + Math.random() * 2;
          const ang = Math.random() * Math.PI * 2;
          const r = 4 + Math.random() * 7;
          const tx = this.homeX + Math.cos(ang) * r;
          const tz = this.homeZ + Math.sin(ang) * r;
          // Stay on dry land and inside the herd range.
          if (
            groundSurfaceHeight(tx, tz) > SEA_LEVEL + 0.4 &&
            Math.hypot(tx - this.homeX, tz - this.homeZ) < 11
          ) {
            this.targetX = tx;
            this.targetZ = tz;
          } else {
            this.targetX = this.homeX;
            this.targetZ = this.homeZ;
          }
          moving = false;
        } else {
          this.yaw = Math.atan2(this.targetX - this.root.position.x, this.targetZ - this.root.position.z);
        }
      }
    }

    // --- integrate ----------------------------------------------------------
    if (moving) {
      const nx = this.root.position.x + Math.sin(this.yaw) * speed * dt;
      const nz = this.root.position.z + Math.cos(this.yaw) * speed * dt;
      const surface = groundSurfaceHeight(nx, nz);
      if (surface > SEA_LEVEL + 0.25) {
        this.root.position.set(nx, surface, nz);
      } else {
        // Shoreline: bounce inland, and reroll the wander target next pause.
        this.yaw += 2.2;
        this.grazeT = 0;
        this.targetX = this.homeX;
        this.targetZ = this.homeZ;
      }
      this.bodyY = this.root.position.y;
      // Stride frequency scales with speed: a gallop is longer AND faster.
      this.walkPhase += dt * speed * (fleeing ? 4.6 : 3.2);
    } else {
      this.walkPhase = 0;
    }
    // Bounded turn-in: instantly snapping the yaw every frame makes the
    // body jitter when a new graze target appears behind the animal.
    this.root.rotation.y = this.yaw;

    // --- animation -----------------------------------------------------------
    // Legs: diagonal gait (front-left swings with rear-right). Knees only
    // bend on the back swing — a quadruped's hock never bends forwards.
    const amp = fleeing ? 0.68 : 0.44;
    for (const l of this.legs) {
      if (moving) {
        const s = Math.sin(this.walkPhase + l.phase);
        l.pivot.rotation.x = s * amp;
        l.knee.rotation.x = Math.max(0, -s) * (fleeing ? 0.85 : 0.5);
      } else {
        l.pivot.rotation.x = 0;
        l.knee.rotation.x = 0;
      }
    }

    // Neck + head share the graze dip, so the forequarters bend.
    // Grazing is NOT standing still: the muzzle works through the grass and
    // every ~7 s the animal lifts its head to scan — prey animals check for
    // danger even while eating. Walking: head level. Fleeing: head up.
    let wanted: number;
    if (!moving && !fleeing) {
      const lift = this.animT % 7 < 1.3 ? -0.75 : 0;
      wanted = 0.9 + lift + Math.sin(this.animT * 1.6) * 0.14;
    } else {
      wanted = fleeing ? -0.42 : 0.14;
    }
    this.headDip += (wanted - this.headDip) * Math.min(1, dt * (moving ? 6 : 4));
    if (this.headNode) {
      this.headNode.rotation.x = this.headBasePitch + this.headDip;
      // While grazing the head also turns slowly over the grazing patch,
      // as if it works its way along the grass.
      this.headNode.rotation.y = !moving && !fleeing ? Math.sin(this.animT * 0.5) * 0.35 : 0;
    }
    if (this.neckNode) {
      this.neckNode.rotation.x = this.neckBasePitch + this.headDip * 0.34;
      this.neckNode.rotation.y = this.headNode ? this.headNode.rotation.y * 0.4 : 0;
    }

    // Tail: a lazy swish at rest, a panic lash while running.
    const rate = fleeing ? 8.5 : moving ? 3.4 : 1.5;
    if (this.tailNodes[0]) this.tailNodes[0].rotation.z = Math.sin(this.animT * rate) * (fleeing ? 0.45 : 0.26);
    if (this.tailNodes[1]) this.tailNodes[1].rotation.z = Math.sin(this.animT * rate - 0.7) * (fleeing ? 0.4 : 0.22);

    // Ears: idle flick every few seconds, plus a soft breathing sway.
    const flick = !moving && !fleeing && this.animT % 4.6 < 0.26 ? Math.sin(this.animT * 42) * 0.45 : 0;
    for (let i = 0; i < this.ears.length; i++) {
      const sign = i % 2 === 0 ? -1 : 1;
      const base = sign * (this.kind === 'sheep' ? 0.95 : 1.05);
      const twitch = flick * sign + Math.sin(this.animT * (1.7 + i * 0.3)) * 0.05;
      this.ears[i].rotation.z = base + twitch;
    }

    // Breathing: slow chest swell so even a fully standing animal reads as
    // alive; a gallop huffs.
    if (this.bodyMesh) {
      const a = fleeing ? 0.032 : 0.015;
      const b = 1 + Math.sin(this.animT * (fleeing ? 6.4 : 1.8)) * a;
      this.bodyMesh.scaling.set(b, 1 / b, b);
    }

    // Vertical bob: one dip per stride pair, deeper at a gallop.
    this.root.position.y =
      this.bodyY + (moving ? Math.abs(Math.sin(this.walkPhase)) * (fleeing ? 0.06 : 0.022) : 0);

    // Quick hit-tick: a shrink pulse (cheap, no material swap).
    const flash = this.hitFlashT > 0 ? 1 + this.hitFlashT * 0.25 : 1;
    this.root.scaling.set(flash, 1 / flash, flash);
  }

  /**
   * All body meshes for shadow registration. Only the silhouette-defining
   * parts: 7 animals × ~16 casters already covers the shadow cost, and eyes
   * or nostrils cast nothing worth the shadow-map texel.
   */
  get shadowMeshes(): Mesh[] {
    return this.shadowParts;
  }

  dispose(): void {
    // The game unregisters shadowMeshes from the shadow generator before
    // calling dispose, so the casters can never point at disposed meshes.
    this.root.dispose(false, true);
    for (const m of this.mats) m.dispose();
  }

  // ------------------------------------------------------------------
  // Hierarchy helpers
  // ------------------------------------------------------------------

  private node(name: string, parent: TransformNode, x: number, y: number, z: number): TransformNode {
    const n = new TransformNode(`animal_${name}_${this.id}`, this.scene);
    n.parent = parent;
    n.position.set(x, y, z);
    return n;
  }

  /** Attach a part. `casts` adds it to the shadow-caster subset. */
  private part(mesh: Mesh, mat: PBRMaterial, parent: TransformNode, name: string, x: number, y: number, z: number, casts = true): Mesh {
    mesh.name = `animalPart_${this.id}_${name}`;
    mesh.parent = parent;
    mesh.position.set(x, y, z);
    mesh.material = mat;
    mesh.receiveShadows = false;
    this.bodyMeshes.push(mesh);
    if (casts) this.shadowParts.push(mesh);
    return mesh;
  }

  /**
   * Two-segment leg with a real knee and a cloven hoof block. Named
   * `legPivot` / `kneePivot` (the gait test and the AI both look these up).
   */
  private buildLeg(
    M: Mats,
    label: string,
    x: number,
    z: number,
    hipY: number,
    r1: number,
    l1: number,
    r2: number,
    l2: number,
    hoofD: number,
    hoofH: number,
    phase: number,
    trouser?: { d: number; mat: PBRMaterial },
  ): Leg {
    const pivot = this.node(`legPivot_${label}`, this.root, x, hipY, z);
    this.part(
      MeshBuilder.CreateCapsule('u', { radius: r1, height: l1 + r1 * 2, tessellation: 8 }, this.scene),
      M.coat, pivot, `upperLeg${label}`, 0, -l1 / 2, 0,
    );
    if (trouser) {
      // Sheep carry wool down to the hock: a soft lump over the thigh.
      const t = this.part(
        MeshBuilder.CreateSphere('t', { diameter: trouser.d, segments: 8 }, this.scene),
        trouser.mat, pivot, `fleeceThigh${label}`, 0, -l1 * 0.35, 0, false,
      );
      t.scaling.set(0.9, 1.15, 0.9);
    }
    const knee = this.node(`kneePivot_${label}`, pivot, 0, -l1, 0);
    this.part(
      MeshBuilder.CreateCapsule('l', { radius: r2, height: l2 + r2 * 2, tessellation: 8 }, this.scene),
      M.leg, knee, `lowerLeg${label}`, 0, -l2 / 2, 0,
    );
    // Ankle knub + hoof: cattle and sheep have cloven hooves, so the block
    // is split by a hair-line gap in the middle (two narrow boxes).
    for (const s of [-1, 1] as const) {
      this.part(
        MeshBuilder.CreateBox('h', { width: hoofD * 0.44, height: hoofH, depth: hoofD * 1.15 }, this.scene),
        M.hoof, knee, `hoof${label}${s < 0 ? 'L' : 'R'}`, s * hoofD * 0.24, -l2 - hoofH / 2, hoofD * 0.12, false,
      );
    }
    return { pivot, knee, phase };
  }

  /**
   * Neck -> head chain. Returns the two pivots; the caller bolts the skull
   * furniture onto `head`. `neckPitch` is the rest lean (radians, positive =
   * forwards), which the animation adds its graze dip on top of.
   */
  private buildNeck(
    baseX: number,
    baseY: number,
    baseZ: number,
    neckPitch: number,
    neckLen: number,
    dBottom: number,
    dTop: number,
    mat: PBRMaterial,
  ): { neck: TransformNode; head: TransformNode } {
    const neck = this.node('neckPivot', this.root, baseX, baseY, baseZ);
    neck.rotation.x = neckPitch;
    const m = this.part(
      MeshBuilder.CreateCylinder('neck', {
        diameterTop: dTop, diameterBottom: dBottom, height: neckLen, tessellation: 10,
      }, this.scene),
      mat, neck, 'neck', 0, neckLen / 2, 0,
    );
    void m; // the cylinder axis already follows the pivot's local +Y
    const head = this.node('headPivot', neck, 0, neckLen, 0);    this.neckBasePitch = neckPitch;
    this.neckNode = neck;
    this.headNode = head;
    return { neck, head };
  }

  /** Skull furniture for both species: eyes, muzzle, nostrils, ear pivots. */
  private buildHead(
    M: Mats,
    head: TransformNode,
    cfg: {
      skull: [number, number, number];
      skullY: number;
      skullZ: number;
      muzzle: [number, number, number];
      muzzleY: number;
      muzzleZ: number;
      muzzleMat: PBRMaterial;
      nostrilD: number;
      nostrilSpread: number;
      nostrilY: number;
      nostrilZ: number;
      eyeD: number;
      eyeX: number;
      eyeY: number;
      eyeZ: number;
      earD: number;
      earScale: [number, number, number];
      earX: number;
      earY: number;
      earZ: number;
      earPitch: number;
    },
  ): void {
    const skull = this.part(
      MeshBuilder.CreateSphere('skull', { diameter: 1, segments: 12 }, this.scene),
      M.face, head, 'skull', 0, cfg.skullY, cfg.skullZ,
    );
    skull.scaling.set(cfg.skull[0], cfg.skull[1], cfg.skull[2]);
    const muz = this.part(
      MeshBuilder.CreateSphere('muzzle', { diameter: 1, segments: 10 }, this.scene),
      cfg.muzzleMat, head, 'muzzle', 0, cfg.muzzleY, cfg.muzzleZ,
    );
    muz.scaling.set(cfg.muzzle[0], cfg.muzzle[1], cfg.muzzle[2]);
    for (const s of [-1, 1] as const) {
      // Nose leather: the muzzle ends in a wet, dark nose pad with two
      // visible nostrils. Without this the head reads as a ball from 5 m.
      if (s === -1) {
        this.part(
          MeshBuilder.CreateSphere('nose', { diameter: cfg.nostrilD * 2.6, segments: 8 }, this.scene),
          cfg.muzzleMat, head, 'nosePad', 0, cfg.muzzleY + 0.012, cfg.muzzleZ + cfg.muzzle[2] * 0.6, false,
        );
      }
      this.part(
        MeshBuilder.CreateSphere('nostril', { diameter: cfg.nostrilD, segments: 6 }, this.scene),
        M.dark, head, `nostril${s < 0 ? 'L' : 'R'}`, s * cfg.nostrilSpread, cfg.nostrilY, cfg.nostrilZ, false,
      );
      this.part(
        MeshBuilder.CreateSphere('eye', { diameter: cfg.eyeD, segments: 8 }, this.scene),
        M.eye, head, `eye${s < 0 ? 'L' : 'R'}`, s * cfg.eyeX, cfg.eyeY, cfg.eyeZ, false,
      );
      // A sliver of sclera at the top-front of the eye makes the eye catch
      // light — the single cheapest "it's alive" cue at 10 m. Kept dim grey
      // (never the white pied colour) so it does not read as a headlight at
      // dusk.
      this.part(
        MeshBuilder.CreateSphere('eyeGlint', { diameter: cfg.eyeD * 0.34, segments: 6 }, this.scene),
        M.sclera, head, `eyeGlint${s < 0 ? 'L' : 'R'}`, s * (cfg.eyeX + cfg.eyeD * 0.18), cfg.eyeY + cfg.eyeD * 0.2, cfg.eyeZ + cfg.eyeD * 0.2, false,
      );
      const ear = this.node(`earPivot${s < 0 ? 'L' : 'R'}`, head, s * cfg.earX, cfg.earY, cfg.earZ);
      ear.rotation.x = cfg.earPitch;
      const pinna = this.part(
        MeshBuilder.CreateSphere('ear', { diameter: cfg.earD, segments: 8 }, this.scene),
        M.face, ear, `ear${s < 0 ? 'L' : 'R'}`, s * cfg.earD * 0.7, 0, 0, false,
      );
      pinna.scaling.set(cfg.earScale[0], cfg.earScale[1], cfg.earScale[2]);
      this.ears.push(ear);
    }
  }

  // ------------------------------------------------------------------
  // Sheep: 0.9 m at the withers, barrel of wool on stick legs, dark or
  // white face depending on the "breed" roll.
  // ------------------------------------------------------------------
  private buildSheep(rng: () => number, M: Mats, pal: Palette): void {
    const s = 0.9 + rng() * 0.2; // individual size spread
    const backTop = 0.92 * s;
    const bodyR = 0.25 * s;
    const bodyL = 0.5 * s; // cylinder length between the capsule caps

    // Body capsule lying along +Z (facing). Named exactly "body": the
    // breathing scale and the herd tests address it by that name.
    const body = MeshBuilder.CreateCapsule('body', { radius: bodyR, height: bodyL + bodyR * 2, tessellation: 12 }, this.scene);
    this.part(body, M.coat, this.root, 'body', 0, backTop - bodyR * 0.95, 0);
    body.rotation.x = Math.PI / 2;
    this.bodyMesh = body;

    // Chest and rump give the barrel shoulders and hips instead of a tube.
    const chest = this.part(
      MeshBuilder.CreateSphere('chest', { diameter: bodyR * 2.15, segments: 10 }, this.scene),
      M.coat, this.root, 'chest', 0, backTop - bodyR * 0.85, bodyL * 0.55,
    );
    chest.scaling.set(0.95, 0.92, 0.85);
    const rump = this.part(
      MeshBuilder.CreateSphere('rump', { diameter: bodyR * 2.05, segments: 10 }, this.scene),
      M.coat, this.root, 'rump', 0, backTop - bodyR * 0.8, -bodyL * 0.58,
    );
    rump.scaling.set(1.02, 0.9, 0.9);

    // Fleece locks: chunky lumps packed around the barrel, so the outline
    // is a cloud rather than a sausage. Distributed on a helix over the
    // capsule surface, including the belly line.
    const locks = 9;
    for (let i = 0; i < locks; i++) {
      const t = i / (locks - 1);
      const ang = i * 2.399963; // golden angle -> even coverage, no seams
      const z = -bodyL * 0.62 + t * bodyL * 1.24;
      const d = bodyR * (0.72 + rng() * 0.42);
      const rad = bodyR * (0.78 + rng() * 0.14);
      const lump = this.part(
        MeshBuilder.CreateSphere('fleece', { diameter: d, segments: 8 }, this.scene),
        M.coat, this.root, `fleece${i}`,
        Math.cos(ang) * rad * 0.92,
        backTop - bodyR * 0.95 + Math.sin(ang) * rad * 0.86,
        z,
        i % 2 === 0,
      );
      lump.scaling.set(1, 0.92, 1.12);
    }

    // --- neck + head -------------------------------------------------------
    const { head } = this.buildNeck(0, backTop - bodyR * 0.35, bodyL * 0.62, 0.62, 0.24 * s, 0.24 * s, 0.16 * s,
      // A woolled breed carries fleece over the neck; a bare-necked dark-faced
      // breed shows skin there.
      pal.fleece ? M.coat : M.face);
    this.headBasePitch = -0.5;
    head.rotation.x = this.headBasePitch;
    this.buildHead(M, head, {
      skull: [0.2 * s, 0.21 * s, 0.28 * s],
      skullY: 0.02,
      skullZ: 0.045,
      muzzle: [0.15, 0.13, 0.17],
      muzzleY: -0.035,
      muzzleZ: 0.135,
      muzzleMat: M.muzzle,
      nostrilD: 0.022,
      nostrilSpread: 0.032,
      nostrilY: -0.03,
      nostrilZ: 0.196,
      eyeD: 0.046,
      eyeX: 0.082,
      eyeY: 0.045,
      eyeZ: 0.075,
      earD: 0.1,
      earScale: [0.42, 0.24, 0.72],
      earX: 0.09,
      earY: 0.062,
      earZ: -0.02,
      earPitch: -0.35,
    });
    if (pal.fleece) {
      // Wool bonnet on the poll: the face stays small in a cloud of fleece,
      // exactly like a real ewe.
      const cap = this.part(
        MeshBuilder.CreateSphere('woolCap', { diameter: 0.17, segments: 8 }, this.scene),
        M.coat, head, 'woolCap', 0, 0.1, -0.03, false,
      );
      cap.scaling.set(1.05, 0.62, 1.1);
    }

    // --- legs (diagonal gait pairs) -----------------------------------------
    const hipY = 0.53 * s;
    const ux = 0.115 * s;
    this.legs = [
      this.buildLeg(M, 'FL', -ux, bodyL * 0.42, hipY, 0.052, 0.24, 0.04, 0.2, 0.088, 0.075, 0, { d: 0.15, mat: M.coat }),
      this.buildLeg(M, 'FR', ux, bodyL * 0.42, hipY, 0.052, 0.24, 0.04, 0.2, 0.088, 0.075, Math.PI, { d: 0.15, mat: M.coat }),
      this.buildLeg(M, 'RL', -ux, -bodyL * 0.48, hipY, 0.055, 0.24, 0.04, 0.2, 0.092, 0.075, Math.PI, { d: 0.16, mat: M.coat }),
      this.buildLeg(M, 'RR', ux, -bodyL * 0.48, hipY, 0.055, 0.24, 0.04, 0.2, 0.092, 0.075, 0, { d: 0.16, mat: M.coat }),
    ];

    // --- tail (a docked fluffy stub) ----------------------------------------
    const tail = this.node('tailPivot', this.root, 0, backTop - 0.1, -bodyL * 0.72);
    tail.rotation.x = -0.7;
    this.part(
      MeshBuilder.CreateSphere('tail', { diameter: 0.12, segments: 8 }, this.scene),
      M.coat, tail, 'tail', 0, -0.06, 0, false,
    ).scaling.set(0.72, 1.2, 0.72);
    this.part(
      MeshBuilder.CreateSphere('tailTuft', { diameter: 0.09, segments: 8 }, this.scene),
      M.hair, tail, 'tailTuft', 0, -0.14, 0.01, false,
    );
    this.tailNodes = [tail];
  }

  // ------------------------------------------------------------------
  // Cow: 1.3 m at the withers, deep chest, hollow back, horns, udder and a
  // long switched tail. Pied, Jersey or red-pied depending on the roll.
  // ------------------------------------------------------------------
  private buildCow(rng: () => number, M: Mats, pal: Palette): void {
    const s = 0.94 + rng() * 0.16;
    const backTop = 1.3 * s;
    const bodyR = 0.33 * s;
    const bodyL = 0.8 * s;

    const body = MeshBuilder.CreateCapsule('body', { radius: bodyR, height: bodyL + bodyR * 2, tessellation: 12 }, this.scene);
    this.part(body, M.coat, this.root, 'body', 0, backTop - bodyR * 0.92, 0);
    body.rotation.x = Math.PI / 2;
    this.bodyMesh = body;

    // Deep chest in front, then the withers ridge and a rounded rump — the
    // three lumps are what makes cattle read as cattle at 30 m.
    const chest = this.part(
      MeshBuilder.CreateSphere('chest', { diameter: bodyR * 2.3, segments: 10 }, this.scene),
      M.coat, this.root, 'chest', 0, backTop - bodyR * 1.15, bodyL * 0.52,
    );
    chest.scaling.set(1, 1.05, 0.8);
    const withers = this.part(
      MeshBuilder.CreateSphere('withers', { diameter: bodyR * 1.6, segments: 10 }, this.scene),
      M.coat, this.root, 'withers', 0, backTop - bodyR * 0.2, bodyL * 0.3,
    );
    withers.scaling.set(0.78, 0.62, 1.5);
    const rump = this.part(
      MeshBuilder.CreateSphere('rump', { diameter: bodyR * 2.1, segments: 10 }, this.scene),
      M.coat, this.root, 'rump', 0, backTop - bodyR * 0.95, -bodyL * 0.6,
    );
    rump.scaling.set(1.02, 0.95, 0.95);
    // Belly: cattle are round-bellied, the capsule alone looks athletic.
    const belly = this.part(
      MeshBuilder.CreateSphere('belly', { diameter: bodyR * 2.05, segments: 10 }, this.scene),
      M.coat, this.root, 'belly', 0, backTop - bodyR * 1.5, -bodyL * 0.05, false,
    );
    belly.scaling.set(0.95, 0.72, 1.5);

    // Pied blankets: flattened patches shrink-wrapped on the barrel, each
    // one a hair outside the body surface so there is no z-fighting.
    if (pal.patch) {
      const spots: [number, number, number, number, number][] = [
        // [side, z, y-offset, scale, rotZ]
        [1, 0.24, 0.06, 0.5, 0.2],
        [-1, -0.18, 0.2, 0.42, -0.3],
        [1, -0.52, -0.06, 0.34, 0.45],
      ];
      for (let i = 0; i < spots.length; i++) {
        const [side, z, yo, sc, rz] = spots[i];
        // Sunk DEEP into the barrel (0.62 r instead of just outside it) and
        // flattened hard along x: only a shallow lens of pale hair rises
        // above the coat. Placed on the surface instead, a pied patch reads
        // as a porcelain plate glued to the flank.
        const p = this.part(
          MeshBuilder.CreateSphere('patch', { diameter: sc * 2, segments: 10 }, this.scene),
          M.patch, this.root, `patch${i}`,
          side * bodyR * 0.62, backTop - bodyR * 0.92 + yo * s, z * s, false,
        );
        p.scaling.set(0.44, 0.92, 1.3);
        p.rotation.z = rz;
      }
    }

    // --- neck + head -------------------------------------------------------
    const { head } = this.buildNeck(0, backTop - bodyR * 0.1, bodyL * 0.66, 0.9, 0.4 * s, 0.36 * s, 0.24 * s, M.coat);
    // Cows carry the head low and forwards; the base pitch keeps the muzzle
    // level at rest while the graze dip still has room to travel.
    this.headBasePitch = -0.72;
    head.rotation.x = this.headBasePitch;
    // A cow's head is long and wedge-shaped: broad forehead, narrow muzzle.
    this.buildHead(M, head, {
      skull: [0.3, 0.33, 0.42],
      skullY: 0.02,
      skullZ: 0.06,
      muzzle: [0.26, 0.17, 0.2],
      muzzleY: -0.12,
      muzzleZ: 0.2,
      muzzleMat: M.muzzle,
      nostrilD: 0.05,
      nostrilSpread: 0.075,
      nostrilY: -0.11,
      nostrilZ: 0.278,
      eyeD: 0.062,
      eyeX: 0.14,
      eyeY: 0.055,
      eyeZ: 0.02,
      earD: 0.17,
      earScale: [0.8, 0.3, 0.55],
      earX: 0.15,
      earY: 0.06,
      earZ: -0.06,
      earPitch: -0.25,
    });
    // Curly forelock between the horns.
    const tuft = this.part(
      MeshBuilder.CreateSphere('forelock', { diameter: 0.19, segments: 8 }, this.scene),
      M.hair, head, 'forelock', 0, 0.13, -0.04, false,
    );
    tuft.scaling.set(1.05, 0.62, 0.9);

    // Horns: two segments each, the second curving up and in. Polled
    // individuals (pal.horn == null) simply have nothing here.
    if (pal.horn) {
      for (const sgn of [-1, 1] as const) {
        const rootP = this.node(`hornPivot${sgn < 0 ? 'L' : 'R'}`, head, sgn * 0.13, 0.15, -0.02);
        rootP.rotation.z = -sgn * 0.75; // out and slightly back
        rootP.rotation.y = sgn * 0.25;
        const h1 = this.part(
          MeshBuilder.CreateCylinder('horn1', { diameterTop: 0.05, diameterBottom: 0.085, height: 0.17, tessellation: 8 }, this.scene),
          M.horn, rootP, `horn${sgn < 0 ? 'L' : 'R'}`, 0, 0.085, 0, false,
        );
        h1.rotation.x = 0;
        const tipP = this.node('hornTip', rootP, 0, 0.17, 0);
        tipP.rotation.z = sgn * 0.85; // the classic inward crescent
        this.part(
          MeshBuilder.CreateCylinder('horn2', { diameterTop: 0.012, diameterBottom: 0.05, height: 0.15, tessellation: 8 }, this.scene),
          M.horn, tipP, `hornTip${sgn < 0 ? 'L' : 'R'}`, 0, 0.075, 0, false,
        );
      }
    }

    // --- legs --------------------------------------------------------------
    const hipY = 0.84 * s;
    const ux = 0.155 * s;
    this.legs = [
      this.buildLeg(M, 'FL', -ux, bodyL * 0.5, hipY, 0.078, 0.38, 0.056, 0.34, 0.125, 0.1, 0),
      this.buildLeg(M, 'FR', ux, bodyL * 0.5, hipY, 0.078, 0.38, 0.056, 0.34, 0.125, 0.1, Math.PI),
      this.buildLeg(M, 'RL', -ux * 1.05, -bodyL * 0.6, hipY * 0.98, 0.09, 0.4, 0.056, 0.32, 0.13, 0.1, Math.PI),
      this.buildLeg(M, 'RR', ux * 1.05, -bodyL * 0.6, hipY * 0.98, 0.09, 0.4, 0.056, 0.32, 0.13, 0.1, 0),
    ];
    // Hocks: a small bone lump on the rear legs (legs 2 and 3 are the hind
    // pair — see the roster order in this.legs above).
    for (const [i, lbl] of [[2, 'RL'], [3, 'RR']] as const) {
      this.part(
        MeshBuilder.CreateSphere('hock', { diameter: 0.1, segments: 6 }, this.scene),
        M.leg, this.legs[i].knee, `hock${lbl}`, 0, -0.02, -0.02, false,
      );
    }

    // --- udder -------------------------------------------------------------
    const ud = this.part(
      MeshBuilder.CreateSphere('udder', { diameter: 0.26, segments: 10 }, this.scene),
      M.udder, this.root, 'udder', 0, backTop - bodyR * 2.15, -bodyL * 0.55, false,
    );
    ud.scaling.set(0.85, 0.72, 1.1);
    for (const sgn of [-1, 1] as const) {
      for (const fz of [-1, 1] as const) {
        if (fz === 1) {
          this.part(
            MeshBuilder.CreateCylinder('teat', { diameter: 0.045, height: 0.09, tessellation: 6 }, this.scene),
            M.udder, this.root, `teat${sgn}`, sgn * 0.07, backTop - bodyR * 2.15 - 0.12, -bodyL * 0.55 + fz * 0.05, false,
          );
        }
      }
    }

    // --- tail: two pivots so it actually swings from the root --------------
    const tail = this.node('tailPivot', this.root, 0, backTop - bodyR * 0.55, -bodyL * 0.78);
    tail.rotation.x = -0.35;
    this.part(
      MeshBuilder.CreateCylinder('tail', { diameterTop: 0.055, diameterBottom: 0.03, height: 0.46, tessellation: 6 }, this.scene),
      M.coat, tail, 'tail', 0, -0.23, 0, false,
    );
    const tip = this.node('tailTipPivot', tail, 0, -0.46, 0);
    this.part(
      MeshBuilder.CreateCylinder('tailTuft', { diameterTop: 0.02, diameterBottom: 0.1, height: 0.2, tessellation: 6 }, this.scene),
      M.hair, tip, 'tailTuft', 0, -0.1, 0, false,
    );
    this.tailNodes = [tail, tip];
  }
}

// ---------------------------------------------------------------------------
// Materials + palettes
// ---------------------------------------------------------------------------

/** Structural subset of the shared texture kit (visual/textures.ts). */
type FaunaTex = PbrTextureSet;

/** The material set every builder needs; keeps the builders readable. */
interface Mats {
  coat: PBRMaterial;
  face: PBRMaterial;
  muzzle: PBRMaterial;
  leg: PBRMaterial;
  hoof: PBRMaterial;
  hair: PBRMaterial;
  dark: PBRMaterial;
  eye: PBRMaterial;
  sclera: PBRMaterial;
  patch: PBRMaterial;
  horn: PBRMaterial;
  udder: PBRMaterial;
}

/**
 * Sheep: fleece is cream with a per-animal tone spread; 45 % of the flock is
 * a dark-faced breed (Suffolk-style), the rest a white-faced breed — a flock
 * of seven is never seven identical lumps of cotton wool.
 */
function sheepPalette(rng: () => number): Palette {
  const darkFace = rng() < 0.45;
  const warm = 0.9 + rng() * 0.1;
  const coat = new Color3(0.8 * warm + 0.1, 0.78 * warm + 0.08, 0.7 * warm + 0.05);
  return {
    coat,
    face: darkFace
      ? new Color3(0.14 + rng() * 0.05, 0.11 + rng() * 0.04, 0.1)
      : new Color3(0.72, 0.64, 0.55),
    muzzle: darkFace ? new Color3(0.1, 0.08, 0.075) : new Color3(0.55, 0.42, 0.38),
    leg: darkFace ? new Color3(0.12, 0.1, 0.09) : new Color3(0.5, 0.44, 0.37),
    hoof: new Color3(0.12, 0.1, 0.09),
    // A few sheep carry a tan blotch — sheep are not snow.
    patch: !darkFace && rng() < 0.4 ? new Color3(0.68, 0.57, 0.44) : null,
    horn: null, // domesticated flock sheep are polled
    fleece: !darkFace || rng() < 0.5,
    hair: darkFace ? new Color3(0.12, 0.1, 0.09) : new Color3(0.74, 0.7, 0.62),
  };
}

/**
 * Cow: three colour types rolled per animal — black-and-white pied (Holstein),
 * solid fawn (Jersey, polled) and red-and-white pied. All of them share the
 * pink-grey nose leather and the dark switch at the end of the tail.
 */
function cowPalette(rng: () => number): Palette {
  const kind = rng();
  const hoof = new Color3(0.11, 0.09, 0.08);
  if (kind < 0.45) {
    return {
      coat: new Color3(0.1 + rng() * 0.04, 0.092 + rng() * 0.03, 0.085 + rng() * 0.03),
      face: new Color3(0.11, 0.1, 0.09),
      muzzle: new Color3(0.46, 0.34, 0.32),
      leg: new Color3(0.1, 0.092, 0.086),
      hoof,
      patch: new Color3(0.82, 0.8, 0.75),
      horn: null,
      fleece: false,
      hair: new Color3(0.1, 0.09, 0.085),
    };
  }
  if (kind < 0.7) {
    // Jersey: small, fawn, light dorsal stripe, no horns.
    const t = 0.9 + rng() * 0.25;
    return {
      coat: new Color3(0.4 * t, 0.26 * t, 0.14 * t),
      face: new Color3(0.3, 0.2, 0.13),
      muzzle: new Color3(0.5, 0.38, 0.33),
      leg: new Color3(0.3, 0.2, 0.13),
      hoof,
      patch: null,
      horn: null,
      fleece: false,
      hair: new Color3(0.24, 0.15, 0.09),
    };
  }
  // Red pied: rusty red over white.
  return {
    coat: new Color3(0.36 + rng() * 0.08, 0.15 + rng() * 0.05, 0.09 + rng() * 0.03),
    face: new Color3(0.33, 0.15, 0.09),
    muzzle: new Color3(0.48, 0.35, 0.32),
    leg: new Color3(0.3, 0.15, 0.1),
    hoof,
    patch: new Color3(0.84, 0.81, 0.76),
    horn: new Color3(0.76, 0.7, 0.55),
    fleece: false,
    hair: new Color3(0.28, 0.13, 0.08),
  };
}
