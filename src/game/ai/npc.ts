/**
 * NPC entity: procedural humanoid, simple wander/sit routine around the
 * camp, and a conversation hook. Routines are pure game logic - the LLM
 * is only used for conversation text (see chatClient.ts), never for
 * movement decisions.
 */
import {
  Color3,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import { mulberry32 } from '../core/noise';
import { terrainHeight } from '../world/terrain';

export interface NpcProfile {
  id: string;
  name: string;
  /** Personality summary used in the LLM system prompt. */
  persona: string;
  /** Deterministic replies used when the LLM is unavailable. */
  fallbackLines: string[];
  shirt: Color3;
  pants: Color3;
  skin: Color3;
  hair: Color3;
}

export const NPC_PROFILES: NpcProfile[] = [
  {
    id: 'mara',
    name: 'Mara',
    persona:
      'Mara is a practical, warm survivor in her 30s who was stranded on this island. She knows the terrain well, gives direct and helpful advice about gathering, food and building, and has a dry sense of humor. She speaks in short, clear sentences.',
    fallbackLines: [
      'Kijk, geen tijd voor drama. Knap een paar bomen, maak vuur, slaap.',
      'Eten? Zoek struiken met bessen. Water drink je aan het meer, druk E.',
      'Bouw muren om je hut, dan slaap je geruster in de nacht.',
    ],
    shirt: new Color3(0.45, 0.3, 0.18),
    pants: new Color3(0.2, 0.22, 0.25),
    skin: new Color3(0.87, 0.68, 0.52),
    hair: new Color3(0.55, 0.32, 0.15),
  },
  {
    id: 'tomas',
    name: 'Tomas',
    persona:
      'Tomas is a cautious, curious former carpenter. He loves talking about building and shelter, is a bit nervous about the nights, and asks the player how their day went. He speaks friendly but slightly formal.',
    fallbackLines: [
      'Mijn god, was dat net even eng? Maar fijn dat je langs kwam.',
      'Bouwen? Eerst planken, dan muren, pas dan het dak. Die volgorde.',
      'Slaap bij het vuur van ons kamp, dan ben je veilig. Vast.',
    ],
    shirt: new Color3(0.2, 0.3, 0.35),
    pants: new Color3(0.3, 0.25, 0.18),
    skin: new Color3(0.78, 0.6, 0.46),
    hair: new Color3(0.15, 0.12, 0.1),
  },
];

interface NpcRoutinePoint {
  x: number;
  z: number;
  /** Seconds to idle here when arrived. */
  dwell: number;
}

export class Npc {
  readonly profile: NpcProfile;
  readonly root: TransformNode;
  private scene: Scene;
  private hipL: TransformNode;
  private hipR: TransformNode;
  private shoulderL: TransformNode;
  private shoulderR: TransformNode;
  private yaw = 0;
  private route: NpcRoutinePoint[];
  private routeIndex = 0;
  private dwellTimer = 0;
  private phase = 0;
  private speed: number;
  private materials: StandardMaterial[] = [];

  constructor(scene: Scene, profile: NpcProfile, camp: { x: number; z: number; y: number }, seed: number) {
    this.profile = profile;
    this.scene = scene;
    const rng = mulberry32(seed);
    this.speed = 1.4 + rng() * 0.5;

    this.root = new TransformNode(`npc_${profile.id}`, scene);
    this.root.position.set(camp.x + (rng() - 0.5) * 6, camp.y, camp.z + (rng() - 0.5) * 6);

    const shirt = new StandardMaterial(`npcShirt_${profile.id}`, scene);
    shirt.diffuseColor = profile.shirt;
    const pants = new StandardMaterial(`npcPants_${profile.id}`, scene);
    pants.diffuseColor = profile.pants;
    const skin = new StandardMaterial(`npcSkin_${profile.id}`, scene);
    skin.diffuseColor = profile.skin;
    const hair = new StandardMaterial(`npcHair_${profile.id}`, scene);
    hair.diffuseColor = profile.hair;
    this.materials = [shirt, pants, skin, hair];

    const pelvis = new TransformNode('pelvis', scene);
    pelvis.parent = this.root;
    pelvis.position.y = 0.96;

    const torso = MeshBuilder.CreateCapsule('torso', { radius: 0.28, height: 0.58, tessellation: 10 }, scene);
    torso.parent = pelvis;
    torso.position.y = 0.32;
    torso.material = shirt;

    const head = MeshBuilder.CreateSphere('head', { diameter: 0.32, segments: 10 }, scene);
    head.parent = pelvis;
    head.position.y = 0.82;
    head.material = skin;

    const hairMesh = MeshBuilder.CreateSphere('hair', { diameter: 0.36, segments: 10 }, scene);
    hairMesh.parent = pelvis;
    hairMesh.position.set(0, 0.9, 0.03);
    hairMesh.scaling.set(1, 0.75, 1);
    hairMesh.material = hair;

    this.hipL = this.limb('hipL', 0.3, 0.52, pelvis, new Vector3(-0.15, 0, 0), pants);
    this.hipR = this.limb('hipR', 0.3, 0.52, pelvis, new Vector3(0.15, 0, 0), pants);
    this.shoulderL = this.limb('shL', 0.19, 0.34, pelvis, new Vector3(-0.4, 0.6, 0), shirt);
    this.shoulderR = this.limb('shR', 0.19, 0.34, pelvis, new Vector3(0.4, 0.6, 0), shirt);

    // Deterministic wander route around the camp.
    this.route = [];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + rng();
      const r = 4 + rng() * 7;
      const x = camp.x + Math.cos(a) * r;
      const z = camp.z + Math.sin(a) * r;
      this.route.push({ x, z, dwell: 2 + rng() * 6 });
    }
    const start = this.route[0];
    this.root.position.x = start.x;
    this.root.position.z = start.z;
    this.root.position.y = terrainHeight(start.x, start.z);
    this.dwellTimer = 3 + rng() * 5;
  }

  private limb(name: string, radius: number, len: number, parent: TransformNode, offset: Vector3, mat: StandardMaterial): TransformNode {
    const pivot = new TransformNode(name, this.scene);
    pivot.parent = parent;
    pivot.position.copyFrom(offset);
    const upper = MeshBuilder.CreateCapsule(`${name}u`, { radius, height: len * 0.55, tessellation: 7 }, this.scene);
    upper.parent = pivot;
    upper.position.y = -len * 0.27;
    upper.material = mat;
    const lower = MeshBuilder.CreateCapsule(`${name}l`, { radius: radius * 0.8, height: len * 0.5, tessellation: 7 }, this.scene);
    lower.parent = pivot;
    lower.position.y = -len * 0.82;
    lower.material = mat;
    return pivot;
  }

  get position(): Vector3 {
    return this.root.position;
  }

  /** True when the player is in conversation range. */
  inTalkRange(playerPos: { x: number; z: number }): boolean {
    return Math.hypot(this.root.position.x - playerPos.x, this.root.position.z - playerPos.z) < 3.2;
  }

  /** Simple routine: walk between camp waypoints, dwell, repeat. */
  update(dt: number, frozen: boolean): void {
    if (frozen) return; // paused while talking
    const p = this.root.position;
    const goal = this.route[this.routeIndex];
    const dx = goal.x - p.x;
    const dz = goal.z - p.z;
    const dist = Math.hypot(dx, dz);

    if (dist > 0.6) {
      const step = this.speed * dt;
      p.x += (dx / dist) * Math.min(step, dist);
      p.z += (dz / dist) * Math.min(step, dist);
      const targetYaw = Math.atan2(dx, dz);
      let dy = targetYaw - this.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.yaw += dy * Math.min(1, 8 * dt);
      this.phase += dt * 4.5;
      const s = Math.sin(this.phase) * 0.5;
      this.hipL.rotation.x = s;
      this.hipR.rotation.x = -s;
      this.shoulderL.rotation.x = -s * 0.7;
      this.shoulderR.rotation.x = s * 0.7;
    } else {
      // Relaxed idle bob.
      this.dwellTimer -= dt;
      const k = Math.min(1, 6 * dt);
      this.hipL.rotation.x += (0 - this.hipL.rotation.x) * k;
      this.hipR.rotation.x += (0 - this.hipR.rotation.x) * k;
      this.shoulderL.rotation.x += (0 - this.shoulderL.rotation.x) * k;
      this.shoulderR.rotation.x += (0 - this.shoulderR.rotation.x) * k;
      this.root.position.y += (terrainHeight(p.x, p.z) - p.y) * Math.min(1, 5 * dt);
      this.root.scaling.y = 1 + Math.sin(performance.now() * 0.002 + this.routeIndex) * 0.008;
      if (this.dwellTimer <= 0) {
        this.routeIndex = (this.routeIndex + 1) % this.route.length;
        this.dwellTimer = 2 + Math.random() * 6;
      }
    }
    this.root.rotation.y = this.yaw;
  }

  dispose(): void {
    this.root.dispose(true);
    this.materials.forEach((m) => m.dispose());
  }
}
