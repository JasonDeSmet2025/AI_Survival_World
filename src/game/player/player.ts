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

  private mats: SharedMaterials;

  constructor(scene: Scene, mats: SharedMaterials) {
    this.mats = mats;
    this.root = new TransformNode('player', scene);

    this.hips = this.node('playerHips', this.root, 0, 0.92, 0);
    this.torso = this.node('playerTorso', this.hips, 0, 0.26, 0);

    // Torso: capsule + shoulder mass + waist block for a natural silhouette.
    this.addPart(MeshBuilder.CreateCapsule('playerPart_torso', {
      radius: 0.21, height: 0.56, tessellation: 12,
    }, scene), this.torso, new Vector3(0, 0.16, 0), this.mats.playerBody);
    const chest = MeshBuilder.CreateBox('playerPart_chest', { width: 0.46, height: 0.2, depth: 0.3 }, scene);
    this.addPart(chest, this.torso, new Vector3(0, 0.34, 0), this.mats.playerBody);
    const waist = MeshBuilder.CreateBox('playerPart_waist', { width: 0.36, height: 0.16, depth: 0.26 }, scene);
    this.addPart(waist, this.hips, new Vector3(0, -0.02, 0), this.mats.playerPants);

    // Neck + head + hair.
    const neck = MeshBuilder.CreateCylinder('playerPart_neck', { diameter: 0.09, height: 0.1, tessellation: 8 }, scene);
    this.addPart(neck, this.torso, new Vector3(0, 0.5, 0), this.mats.playerSkin);
    const head = MeshBuilder.CreateSphere('playerPart_head', { diameter: 0.27, segments: 12 }, scene);
    this.addPart(head, this.torso, new Vector3(0, 0.66, 0.01), this.mats.playerSkin);
    head.scaling.set(0.92, 1.05, 0.98);
    const hair = MeshBuilder.CreateSphere('playerPart_hair', { diameter: 0.3, segments: 12 }, scene);
    this.addPart(hair, this.torso, new Vector3(0, 0.72, -0.015), this.mats.playerHair);
    hair.scaling.set(0.98, 0.72, 1.0);

    // Backpack: main pack + flap + rolled blanket on top.
    const pack = MeshBuilder.CreateBox('playerPart_pack', { width: 0.34, height: 0.38, depth: 0.15 }, scene);
    this.addPart(pack, this.torso, new Vector3(0, 0.16, -0.21), this.mats.backpack);
    const flap = MeshBuilder.CreateBox('playerPart_flap', { width: 0.3, height: 0.1, depth: 0.06 }, scene);
    this.addPart(flap, this.torso, new Vector3(0, 0.38, -0.22), this.mats.backpack);
    const roll = MeshBuilder.CreateCylinder('playerPart_roll', { diameter: 0.09, height: 0.3, tessellation: 8 }, scene);
    roll.rotation.z = Math.PI / 2;
    this.addPart(roll, this.torso, new Vector3(0, 0.44, -0.21), this.mats.playerBody);

    // Arms: shoulder pivot -> upper arm -> elbow -> forearm -> wrist/hand.
    this.armL = this.node('playerArmL', this.hips, -0.27, 0.42, 0);
    this.armR = this.node('playerArmR', this.hips, 0.27, 0.42, 0);
    for (const [pivot, elbowName] of [[this.armL, 'L'], [this.armR, 'R']] as const) {
      const upper = MeshBuilder.CreateCapsule(`playerPart_upperArm${elbowName}`, {
        radius: 0.075, height: 0.3, tessellation: 10,
      }, scene);
      this.addPart(upper, pivot, new Vector3(0, -0.14, 0), this.mats.playerBody);
      const elbow = this.node(`playerElbow${elbowName}`, pivot, 0, -0.3, 0);
      const fore = MeshBuilder.CreateCapsule(`playerPart_foreArm${elbowName}`, {
        radius: 0.066, height: 0.26, tessellation: 10,
      }, scene);
      this.addPart(fore, elbow, new Vector3(0, -0.12, 0), this.mats.playerBody);
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
      const shin = MeshBuilder.CreateCapsule(`playerPart_shin${kneeName}`, {
        radius: 0.082, height: 0.42, tessellation: 10,
      }, scene);
      this.addPart(shin, knee, new Vector3(0, -0.21, 0), this.mats.playerPants);
      const boot = MeshBuilder.CreateBox(`playerPart_boot${kneeName}`, { width: 0.15, height: 0.09, depth: 0.26 }, scene);
      this.addPart(boot, knee, new Vector3(0, -0.44, 0.045), this.mats.playerBoots);
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
      this.tool.dispose(true);
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
      this.toolMeshes = this.tool.getChildMeshes(true).filter((m): m is Mesh => m instanceof Mesh);
    }
    if (this.onToolShadows) this.onToolShadows(this.toolMeshes, removed);
  }

  /**
   * Advance procedural animation.
   * @param speed current horizontal speed m/s
   * @param harvesting true while the player holds F on a gatherable node.
   */
  update(
    dt: number,
    speed: number,
    onGround: boolean,
    inWater: boolean,
    crouching: boolean,
    harvesting = false,
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

    const ampTarget = target === 'idle' ? 0.05 : target === 'sprint' ? 0.95 : 0.55;
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
      this.legL.rotation.x = 0.45;
      this.legR.rotation.x = 0.45;
      this.kneeL.rotation.x = 1.1;
      this.kneeR.rotation.x = 1.1;
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

    // Body bob + crouch drop (root scale kept, hips move).
    const hipBob = bob ? Math.abs(Math.sin(this.phase)) * 0.05 * a : 0;
    const hipY = (0.92 - this.crouchMix * 0.2) + hipBob;
    this.hips.position.y = hipY;
    // Torso leans forward slightly while moving, back when crouching.
    const leanTarget = bob ? 0.12 * a : this.crouchMix * 0.35;
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
    this.root.dispose(true);
  }
}
