import {
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Scene,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import { createTool, type ToolKind } from '../visual/tools';
import type { SharedMaterials } from '../visual/materials';

export type PlayerPose = 'idle' | 'walk' | 'sprint' | 'jump' | 'swim' | 'crouch';

/**
 * Third-person survivor character built from primitives (no external
 * assets) with two-segment limbs, boots, backpack and a held tool.
 *
 * Proportions target a ~1.72 m adult: hips at 0.92, head top near 1.72.
 * All joints are TransformNode pivots so procedural animation drives
 * thighs/knees and shoulders/elbows independently.
 */
export class PlayerCharacter {
  /** Root transform at the character's feet. */
  readonly root: TransformNode;
  /**
   * Pivot between root and hips that the sleep blend rotates (-90° around
   * the character's forward axis) to lay the body down on a bed.
   */
  readonly sleepPivot: TransformNode;
  /** Meshes to register as shadow casters. */
  readonly shadowMeshes: Mesh[] = [];

  private hips: TransformNode;
  private torso: TransformNode;
  private legL: TransformNode;
  private legR: TransformNode;
  private kneeL!: TransformNode;
  private kneeR!: TransformNode;
  private armL: TransformNode;
  private armR: TransformNode;
  private elbowL!: TransformNode;
  private elbowR!: TransformNode;
  private wristR!: TransformNode;

  private tool: TransformNode | null = null;
  private toolKind: ToolKind | null = null;
  private harvestT = 0;

  private phase = 0;
  private activity = 0;
  private crouchMix = 0;
  /** Smoothed 0..1 lie-down blend (driven by the `sleeping` update param). */
  private sleepBlend = 0;
  private sleepTarget = 0;
  /** Smoothed 0..1 landing dip (driven by the `landing` update param). */
  private landBlend = 0;
  /** Knee offset applied last frame (removed before the pose branch so the dip never accumulates). */
  private kneeDip = 0;

  private mats: SharedMaterials;

  constructor(scene: Scene, mats: SharedMaterials) {
    this.mats = mats;
    this.root = new TransformNode('player', scene);
    // Sleep pivot sits between root and hips so the lie-down rotation
    // happens in the character's LOCAL frame (after the root yaw), which
    // is what lets the body lay along a bed at any placement rotation.
    this.sleepPivot = this.node('playerSleepPivot', this.root, 0, 0, 0);

    this.hips = this.node('playerHips', this.sleepPivot, 0, 0.92, 0);
    this.torso = this.node('playerTorso', this.hips, 0, 0.26, 0);

    // Torso: capsule + shoulder mass + waist block for a natural silhouette.
    this.addPart(MeshBuilder.CreateCapsule('playerPart_torso', {
      radius: 0.21, height: 0.74, tessellation: 12,
    }, scene), this.torso, new Vector3(0, 0.1, 0), this.mats.playerBody);
    const chest = MeshBuilder.CreateBox('playerPart_chest', { width: 0.46, height: 0.2, depth: 0.3 }, scene);
    this.addPart(chest, this.torso, new Vector3(0, 0.34, 0), this.mats.playerBody);
    const waist = MeshBuilder.CreateBox('playerPart_waist', { width: 0.38, height: 0.2, depth: 0.28 }, scene);
    this.addPart(waist, this.hips, new Vector3(0, -0.005, 0), this.mats.playerPants);

    // Field jacket details: collar, front closure, chest pockets and belt.
    for (const [side, label] of [[-1, 'L'], [1, 'R']] as const) {
      const collar = MeshBuilder.CreateBox(`playerPart_collar${label}`, {
        width: 0.15, height: 0.045, depth: 0.09,
      }, scene);
      this.addPart(collar, this.torso, new Vector3(side * 0.065, 0.455, 0.055), this.mats.playerAccent);
      collar.rotation.z = side * 0.28;

      const pocket = MeshBuilder.CreateBox(`playerPart_pocket${label}`, {
        width: 0.105, height: 0.09, depth: 0.025,
      }, scene);
      this.addPart(pocket, this.torso, new Vector3(side * 0.13, 0.285, 0.157), this.mats.playerBody);
      const flap = MeshBuilder.CreateBox(`playerPart_pocketFlap${label}`, {
        width: 0.115, height: 0.035, depth: 0.032,
      }, scene);
      this.addPart(flap, this.torso, new Vector3(side * 0.13, 0.33, 0.16), this.mats.playerAccent);
    }

    const zipper = MeshBuilder.CreateBox('playerPart_zipper', {
      width: 0.012, height: 0.2, depth: 0.012,
    }, scene);
    this.addPart(zipper, this.torso, new Vector3(0, 0.29, 0.158), this.mats.playerPants);
    for (let i = 0; i < 3; i++) {
      const button = MeshBuilder.CreateSphere(`playerPart_button${i}`, { diameter: 0.018, segments: 6 }, scene);
      this.addPart(button, this.torso, new Vector3(0.018, 0.22 + i * 0.055, 0.168), this.mats.playerAccent);
    }

    const belt = MeshBuilder.CreateBox('playerPart_belt', { width: 0.38, height: 0.065, depth: 0.28 }, scene);
    this.addPart(belt, this.hips, new Vector3(0, 0.025, 0), this.mats.playerBoots);
    const buckle = MeshBuilder.CreateBox('playerPart_buckle', { width: 0.07, height: 0.055, depth: 0.025 }, scene);
    this.addPart(buckle, this.hips, new Vector3(0, 0.025, 0.15), this.mats.playerAccent);

    // Neck + head + hair.
    const neck = MeshBuilder.CreateCylinder('playerPart_neck', { diameter: 0.09, height: 0.1, tessellation: 8 }, scene);
    this.addPart(neck, this.torso, new Vector3(0, 0.5, 0), this.mats.playerSkin);
    const head = MeshBuilder.CreateSphere('playerPart_head', { diameter: 0.27, segments: 12 }, scene);
    this.addPart(head, this.torso, new Vector3(0, 0.66, 0.01), this.mats.playerSkin);
    head.scaling.set(0.92, 1.05, 0.98);
    const hair = MeshBuilder.CreateSphere('playerPart_hair', { diameter: 0.3, segments: 12 }, scene);
    this.addPart(hair, this.torso, new Vector3(0, 0.72, -0.015), this.mats.playerHair);
    hair.scaling.set(0.98, 0.72, 1.0);

    // Simple face features make the head read clearly when seen from the front.
    for (const [side, label] of [[-1, 'L'], [1, 'R']] as const) {
      const eye = MeshBuilder.CreateSphere(`playerPart_eye${label}`, { diameter: 0.025, segments: 6 }, scene);
      this.addPart(eye, this.torso, new Vector3(side * 0.048, 0.68, 0.132), this.mats.playerHair);
      const brow = MeshBuilder.CreateBox(`playerPart_brow${label}`, {
        width: 0.055, height: 0.012, depth: 0.018,
      }, scene);
      this.addPart(brow, this.torso, new Vector3(side * 0.048, 0.705, 0.128), this.mats.playerHair);
      const ear = MeshBuilder.CreateSphere(`playerPart_ear${label}`, { diameter: 0.055, segments: 6 }, scene);
      this.addPart(ear, this.torso, new Vector3(side * 0.13, 0.66, 0), this.mats.playerSkin);
    }
    const nose = MeshBuilder.CreateSphere('playerPart_nose', { diameter: 0.035, segments: 6 }, scene);
    this.addPart(nose, this.torso, new Vector3(0, 0.65, 0.142), this.mats.playerSkin);

    // Backpack: main pack + flap + rolled blanket on top.
    const pack = MeshBuilder.CreateBox('playerPart_pack', { width: 0.34, height: 0.38, depth: 0.15 }, scene);
    this.addPart(pack, this.torso, new Vector3(0, 0.16, -0.21), this.mats.backpack);
    const flap = MeshBuilder.CreateBox('playerPart_flap', { width: 0.3, height: 0.1, depth: 0.06 }, scene);
    this.addPart(flap, this.torso, new Vector3(0, 0.38, -0.22), this.mats.backpack);
    const roll = MeshBuilder.CreateCylinder('playerPart_roll', { diameter: 0.09, height: 0.3, tessellation: 8 }, scene);
    roll.rotation.z = Math.PI / 2;
    this.addPart(roll, this.torso, new Vector3(0, 0.44, -0.21), this.mats.playerAccent);
    for (const [side, label] of [[-1, 'L'], [1, 'R']] as const) {
      const strap = MeshBuilder.CreateBox(`playerPart_packStrap${label}`, {
        width: 0.045, height: 0.38, depth: 0.025,
      }, scene);
      this.addPart(strap, this.torso, new Vector3(side * 0.14, 0.17, -0.3), this.mats.playerBoots);
      const pouch = MeshBuilder.CreateBox(`playerPart_packPouch${label}`, {
        width: 0.075, height: 0.14, depth: 0.12,
      }, scene);
      this.addPart(pouch, this.torso, new Vector3(side * 0.18, 0.12, -0.21), this.mats.backpack);
    }
    const packPatch = MeshBuilder.CreateBox('playerPart_packPatch', {
      width: 0.075, height: 0.075, depth: 0.018,
    }, scene);
    this.addPart(packPatch, this.torso, new Vector3(0, 0.17, -0.294), this.mats.playerAccent);

    // Arms: shoulder pivot -> upper arm -> elbow -> forearm -> wrist/hand.
    // Pivots live on the TORSO (not the hips) so the shoulders track the
    // torso lean and arms can never visually detach from the body.
    // Torso-space y = 0.42 (hips space) - 0.26 (torso offset) = 0.16.
    this.armL = this.node('playerArmL', this.torso, -0.27, 0.16, 0);
    this.armR = this.node('playerArmR', this.torso, 0.27, 0.16, 0);
    for (const [pivot, elbowName] of [[this.armL, 'L'], [this.armR, 'R']] as const) {
      // Shoulder cap closes the gap between the torso capsule and the
      // arm so the joint always reads as connected.
      const shoulder = MeshBuilder.CreateSphere(`playerPart_shoulder${elbowName}`, { diameter: 0.17, segments: 10 }, scene);
      this.addPart(shoulder, pivot, new Vector3(0, 0, 0), this.mats.playerBody);
      const upper = MeshBuilder.CreateCapsule(`playerPart_upperArm${elbowName}`, {
        radius: 0.075, height: 0.3, tessellation: 10,
      }, scene);
      this.addPart(upper, pivot, new Vector3(0, -0.14, 0), this.mats.playerBody);
      const elbow = this.node(`playerElbow${elbowName}`, pivot, 0, -0.3, 0);
      const fore = MeshBuilder.CreateCapsule(`playerPart_foreArm${elbowName}`, {
        radius: 0.066, height: 0.26, tessellation: 10,
      }, scene);
      this.addPart(fore, elbow, new Vector3(0, -0.12, 0), this.mats.playerBody);
      const cuff = MeshBuilder.CreateCylinder(`playerPart_cuff${elbowName}`, {
        diameter: 0.14, height: 0.035, tessellation: 8,
      }, scene);
      this.addPart(cuff, elbow, new Vector3(0, -0.225, 0), this.mats.playerAccent);
      const wrist = this.node(`playerWrist${elbowName}`, elbow, 0, -0.26, 0);
      const hand = MeshBuilder.CreateSphere(`playerPart_hand${elbowName}`, { diameter: 0.09, segments: 8 }, scene);
      this.addPart(hand, wrist, new Vector3(0, -0.03, 0), this.mats.playerSkin);
      if (elbowName === 'L') this.elbowL = elbow;
      else { this.elbowR = elbow; this.wristR = wrist; }
    }
    this.elbowL.rotation.x = -0.25;
    this.elbowR.rotation.x = -0.25;

    // Legs: hip pivot -> thigh -> knee -> shin -> boot.
    this.legL = this.node('playerLegL', this.hips, -0.115, 0.0, 0);
    this.legR = this.node('playerLegR', this.hips, 0.115, 0.0, 0);
    for (const [pivot, kneeName] of [[this.legL, 'L'], [this.legR, 'R']] as const) {
      const thigh = MeshBuilder.CreateCapsule(`playerPart_thigh${kneeName}`, {
        radius: 0.105, height: 0.44, tessellation: 10,
      }, scene);
      this.addPart(thigh, pivot, new Vector3(0, -0.22, 0), this.mats.playerPants);
      const knee = this.node(`playerKnee${kneeName}`, pivot, 0, -0.44, 0);
      const kneePad = MeshBuilder.CreateBox(`playerPart_kneePad${kneeName}`, {
        width: 0.14, height: 0.1, depth: 0.04,
      }, scene);
      this.addPart(kneePad, knee, new Vector3(0, -0.12, 0.075), this.mats.backpack);
      const shin = MeshBuilder.CreateCapsule(`playerPart_shin${kneeName}`, {
        radius: 0.082, height: 0.42, tessellation: 10,
      }, scene);
      this.addPart(shin, knee, new Vector3(0, -0.21, 0), this.mats.playerPants);
      const boot = MeshBuilder.CreateBox(`playerPart_boot${kneeName}`, { width: 0.15, height: 0.09, depth: 0.26 }, scene);
      this.addPart(boot, knee, new Vector3(0, -0.44, 0.045), this.mats.playerBoots);
      const toeCap = MeshBuilder.CreateBox(`playerPart_toeCap${kneeName}`, {
        width: 0.13, height: 0.04, depth: 0.07,
      }, scene);
      this.addPart(toeCap, knee, new Vector3(0, -0.44, 0.14), this.mats.backpack);
      if (kneeName === 'L') this.kneeL = knee;
      else this.kneeR = knee;
    }
  }

  private node(name: string, parent: TransformNode, x: number, y: number, z: number): TransformNode {
    const n = new TransformNode(name, this.root.getScene());
    n.parent = parent;
    n.position.set(x, y, z);
    return n;
  }

  private addPart(mesh: Mesh, parent: TransformNode, pos: Vector3, mat: PBRMaterial): Mesh {
    mesh.parent = parent;
    mesh.position.copyFrom(pos);
    mesh.material = mat;
    this.shadowMeshes.push(mesh);
    return mesh;
  }

  get facing(): number {
    return this.root.rotation.y;
  }

  setFacing(yaw: number): void {
    this.root.rotation.y = yaw;
  }

  /** Equip a hand tool (inventory item id) or empty hands (null). */
  onToolShadows: ((added: Mesh[], removed: Mesh[]) => void) | null = null;
  private toolMeshes: Mesh[] = [];

  setTool(itemId: string | null): void {
    const kind: ToolKind | null =
      itemId === 'stone_axe' ? 'stone_axe'
        : itemId === 'stone_pick' ? 'stone_pick'
          : null;
    if (kind === this.toolKind) return;
    const removed = this.toolMeshes;
    if (this.tool) {
      // NOTE: in Babylon 9.33 the first dispose argument is `doNotRecurse`,
      // so `dispose(true)` would leak every tool part. Bare call recurses.
      this.tool.dispose();
      this.tool = null;
      this.toolMeshes = [];
    }
    this.toolKind = kind;
    if (kind) {
      this.tool = createTool(kind, this.root.getScene(), this.mats);
      this.tool.parent = this.wristR;
      // Grip: handle points up out of the hand, angled slightly forward.
      this.tool.position.set(0, -0.02, 0.01);
      this.tool.rotation.x = 0.15;
      this.tool.rotation.z = 0.1;
      // NOTE: in Babylon 9.33 getChildMeshes(true) means DIRECT children
      // only; tool parts (handle grip/butt, axe head) are nested deeper, so
      // false is required to register every part as a shadow caster.
      this.toolMeshes = this.tool.getChildMeshes(false).filter((m): m is Mesh => m instanceof Mesh);
    }
    if (this.onToolShadows) this.onToolShadows(this.toolMeshes, removed);
  }

  /**
   * Advance procedural animation.
   * @param speed current horizontal speed m/s
   * @param harvesting true while the player holds F on a gatherable node.
   * @param eating true for a short window after consuming food; blends the
   *   right arm into an eat pose (hand at the mouth).
   * @param crafting true while a timed craft is in progress; the character
   *   bends over a work spot in front and works with a rhythmic strike.
   * @param sleeping true while the player lies in a bed; the body blends
   *   onto its back along the character's forward axis.
   * @param landing true for a short window after a hard landing; the body
   *   dips (hips drop, knees flex) as if absorbing the impact.
   * @param cooking true while a timed campfire cook is in progress; the
   *   character leans over the fire with both hands extended and a gentle
   *   stirring bob.
   */
  update(
    dt: number,
    speed: number,
    onGround: boolean,
    inWater: boolean,
    crouching: boolean,
    harvesting = false,
    eating = false,
    crafting = false,
    sleeping = false,
    landing = false,
    cooking = false,
  ): void {
    const target: PlayerPose = inWater
      ? 'swim'
      : !onGround
        ? 'jump'
        : crouching && speed < 0.5
          ? 'crouch'
          : speed > 6.5
            ? 'sprint'
            : speed > 0.4
              ? 'walk'
              : 'idle';

    const ampTarget = sleeping
      ? 0.03 // shallow breathing while lying down
      : target === 'idle' ? 0.05 : target === 'sprint' ? 0.95 : 0.55;

    // Sleep blend: rotate the whole body -90° around the forward axis so
    // the character lies on its back with the head toward local -Z (the
    // bed's headboard end) and the face pointing up. Feet stay at the
    // root (the bed's foot end).
    this.sleepTarget = sleeping ? 1 : 0;
    this.sleepBlend += (this.sleepTarget - this.sleepBlend) * Math.min(1, dt * 6);
    this.sleepPivot.rotation.x = -this.sleepBlend * (Math.PI / 2);

    // Landing dip: quick attack, quick release — reads as the knees
    // absorbing the impact. Skipped while sleeping (lying in a bed).
    if (sleeping) this.landBlend = 0;
    else this.landBlend += ((landing ? 1 : 0) - this.landBlend) * Math.min(1, dt * 12);
    // Strip last frame's knee offset so the pose branch below works from a
    // clean value (the idle pose smooths instead of overwriting, so a raw
    // "+=" each frame would accumulate instead of stay constant).
    if (this.kneeDip !== 0) {
      this.kneeL.rotation.x -= this.kneeDip;
      this.kneeR.rotation.x -= this.kneeDip;
      this.kneeDip = 0;
    }

    this.activity += (ampTarget - this.activity) * Math.min(1, dt * 8);
    const a = this.activity;
    const bob = target === 'walk' || target === 'sprint';
    this.phase += dt * (3.2 + speed * 0.9);

    // Crouch blend (smooth).
    const crouchTarget = target === 'crouch' ? 1 : 0;
    this.crouchMix += (crouchTarget - this.crouchMix) * Math.min(1, dt * 10);

    if (target === 'jump') {
      this.legL.rotation.x = -0.7 * a;
      this.legR.rotation.x = 0.35 * a;
      this.kneeL.rotation.x = 0.9 * a;
      this.kneeR.rotation.x = 0.5 * a;
      this.armL.rotation.x = -2.3 * a;
      this.armR.rotation.x = -2.3 * a;
      this.elbowL.rotation.x = -0.5 * a;
      this.elbowR.rotation.x = -0.5 * a;
    } else if (target === 'swim') {
      const s = Math.sin(this.phase) * 0.5 * a;
      this.legL.rotation.x = s;
      this.legR.rotation.x = -s;
      this.kneeL.rotation.x = 0.4 + Math.max(0, Math.sin(this.phase + Math.PI / 2)) * 0.5;
      this.kneeR.rotation.x = 0.4 + Math.max(0, Math.sin(this.phase + 1.5)) * 0.5;
      this.armL.rotation.x = Math.sin(this.phase + Math.PI / 2) * 0.7;
      this.armR.rotation.x = Math.sin(this.phase + 1.5) * 0.7;
      this.elbowL.rotation.x = -0.4;
      this.elbowR.rotation.x = -0.4;
    } else if (target === 'crouch') {
      // Squat geometry tuned so the boots stay on the ground while the
      // hips drop 0.14 m: thigh forward 0.3 rad, knee flex 0.47 rad keeps
      // boot bottom at y ~= 0 instead of floating or clipping.
      this.legL.rotation.x = 0.3;
      this.legR.rotation.x = 0.3;
      this.kneeL.rotation.x = 0.47;
      this.kneeR.rotation.x = 0.47;
      this.armL.rotation.x = 0.15;
      this.armR.rotation.x = harvesting ? this.harvestArmX(dt) : 0.2;
      this.elbowL.rotation.x = -0.3;
      this.elbowR.rotation.x = -0.3;
    } else if (bob) {
      const s = Math.sin(this.phase) * a;
      this.legL.rotation.x = s;
      this.legR.rotation.x = -s;
      // Knees flex on the back-swing.
      this.kneeL.rotation.x = Math.max(0, -Math.sin(this.phase + 0.6)) * 0.9 * a;
      this.kneeR.rotation.x = Math.max(0, Math.sin(this.phase + 0.6)) * 0.9 * a;
      this.armL.rotation.x = -s * 0.85;
      if (harvesting) {
        this.armR.rotation.x = this.harvestArmX(dt);
      } else {
        this.armR.rotation.x = s * 0.85;
      }
      this.elbowL.rotation.x = -0.35 - Math.abs(s) * 0.2;
      this.elbowR.rotation.x = harvesting ? -0.25 : -0.35 - Math.abs(s) * 0.2;
      this.armL.rotation.z = 0.06;
      this.armR.rotation.z = harvesting ? -0.35 : -0.06;
    } else {
      // Idle: relaxed breathing + tool-hold posture on the right arm.
      const idle = Math.sin(this.phase * 0.5) * 0.03;
      const k = Math.min(1, dt * 6);
      this.legL.rotation.x += (idle - this.legL.rotation.x) * k;
      this.legR.rotation.x += (-idle - this.legR.rotation.x) * k;
      this.kneeL.rotation.x += (0.06 - this.kneeL.rotation.x) * k;
      this.kneeR.rotation.x += (0.06 - this.kneeR.rotation.x) * k;
      this.armL.rotation.x += (-idle - this.armL.rotation.x) * k;
      this.elbowL.rotation.x += (-0.3 - this.elbowL.rotation.x) * k;
      this.armL.rotation.z += (0.06 - this.armL.rotation.z) * k;
      if (this.toolKind && !harvesting) {
        // Holding a tool: right arm rests forward and slightly out, ready to strike.
        const tx = -0.6 + idle;
        const tz = 0.35;
        const ex = -0.4;
        this.armR.rotation.x += (tx - this.armR.rotation.x) * k;
        this.armR.rotation.z += (tz - this.armR.rotation.z) * k;
        this.elbowR.rotation.x += (ex - this.elbowR.rotation.x) * k;
      } else if (harvesting) {
        this.armR.rotation.x = this.harvestArmX(dt);
      } else {
        this.armR.rotation.x += (idle - this.armR.rotation.x) * k;
        this.armR.rotation.z += (-0.06 - this.armR.rotation.z) * k;
        this.elbowR.rotation.x += (-0.3 - this.elbowR.rotation.x) * k;
      }
    }

    // Craft pose: the player works on something on the ground in front —
    // torso leans forward, left arm braces low, right arm drives a
    // rhythmic strike (sinusoid so it reads as hammering/shaping). The
    // motion derives from `this.phase`, which keeps advancing with the
    // same clock as the walk cycle, so it stays lively while standing.
    // Applied after the pose branches, before the eat pose (eating wins
    // the ~0.7 s overlap window).
    if (crafting) {
      const k = Math.min(1, dt * 10);
      const strike = (Math.sin(this.phase * 2.6) + 1) / 2; // 0..1, periodic
      const armXT = -0.45 - strike * 1.0; // brace low -> lift up
      this.armR.rotation.x += (armXT - this.armR.rotation.x) * k;
      this.armR.rotation.z += (-0.15 - this.armR.rotation.z) * k;
      this.elbowR.rotation.x += (-0.45 - strike * 0.55 - this.elbowR.rotation.x) * k;
      this.armL.rotation.x += (-0.55 - this.armL.rotation.x) * k;
      this.armL.rotation.z += (0.12 - this.armL.rotation.z) * k;
      this.elbowL.rotation.x += (-0.7 - this.elbowL.rotation.x) * k;
    }

    // Cook pose: the player stands over the fire with both hands extended
    // forward-down, a gentle alternating stir bob (the phase clock keeps it
    // lively while standing still). Applied after the pose branches, before
    // the eat pose (eating wins the overlap window).
    if (cooking) {
      const k = Math.min(1, dt * 8);
      const stir = Math.sin(this.phase * 1.8) * 0.06;
      this.armL.rotation.x += (-0.95 + stir - this.armL.rotation.x) * k;
      this.armR.rotation.x += (-0.95 - stir - this.armR.rotation.x) * k;
      this.armL.rotation.z += (0.18 - this.armL.rotation.z) * k;
      this.armR.rotation.z += (-0.18 - this.armR.rotation.z) * k;
      this.elbowL.rotation.x += (-0.55 - this.elbowL.rotation.x) * k;
      this.elbowR.rotation.x += (-0.55 - this.elbowR.rotation.x) * k;
    }

    // Eat pose: blend the right hand up to the mouth with a slight chew
    // bob. Applied after the pose branches so it works while idle, walking,
    // crouching or swimming; the blend keeps the transition smooth.
    if (eating) {
      const chew = Math.sin(this.phase * 2.4) * 0.05;
      const ek = Math.min(1, dt * 12);
      this.armR.rotation.x += (-1.2 + chew - this.armR.rotation.x) * ek;
      this.elbowR.rotation.x += (-1.9 - this.elbowR.rotation.x) * ek;
      this.armR.rotation.z += (0.2 - this.armR.rotation.z) * ek;
    }

    // Body bob + crouch drop (root scale kept, hips move).
    // The 0.14 drop matches the crouch leg pose above (boots stay planted).
    // The landing dip lowers the hips a touch more and flexes the knees
    // (applied additively on top of every pose branch above).
    const hipBob = bob ? Math.abs(Math.sin(this.phase)) * 0.05 * a : 0;
    const hipY = (0.92 - this.crouchMix * 0.14) + hipBob - this.landBlend * 0.04;
    this.hips.position.y = hipY;
    if (this.landBlend > 0.001) {
      this.kneeDip = this.landBlend * 0.2;
      this.kneeL.rotation.x += this.kneeDip;
      this.kneeR.rotation.x += this.kneeDip;
    }
    // Torso leans forward slightly while moving, back when crouching,
    // furthest forward while crafting (work pose wins over crouch) and
    // forward over the fire while cooking.
    const leanTarget = crafting
      ? 0.38
      : cooking
        ? 0.3
        : bob
          ? 0.12 * a
          : this.crouchMix * 0.35;
    this.torso.rotation.x += (leanTarget - this.torso.rotation.x) * Math.min(1, dt * 6);
  }

  /** Right-arm swing X rotation for the harvest cycle.
   * Sign convention: positive rotation.x pulls the arm back/up, negative swings it forward.
   */
  private harvestArmX(dt: number): number {
    this.harvestT += dt;
    const T = 0.85;
    const t = (this.harvestT % T) / T;
    const smooth = (p: number) => p * p * (3 - 2 * p);
    if (t < 0.34) {
      // Wind-up: raise the tool back over the shoulder.
      const p = smooth(t / 0.34);
      return -0.6 + p * 2.9; // hold (-0.6) -> raised back (+2.3)
    } else if (t < 0.5) {
      // Strike: snap through forward and down.
      const p = (t - 0.34) / 0.16;
      const e = p * p * (3 - 2 * p);
      return 2.3 - e * 3.9; // -> -1.6 (forward-down)
    } else {
      // Recover to the hold position.
      const p = (t - 0.5) / 0.5;
      const e = smooth(p);
      return -1.6 + e * 1.0; // -> -0.6
    }
  }

  dispose(): void {
    // Recurse into every joint and body part (Babylon 9.33: dispose(true)
    // would mean doNotRecurse and leak the whole character).
    this.root.dispose();
  }
}
