/**
 * NPC entity: procedural humanoid villager, simple wander/sit routine
 * around the camp, and a conversation hook. Routines are pure game logic -
 * the LLM is only used for conversation text (see ai/chat.ts), never for
 * movement decisions.
 *
 * The villager model deliberately shares the player character's visual
 * language (same primitive vocabulary, proportions ~1.72 m, PBR material
 * family, two-segment arms/legs with knee+elbow pivots, face features)
 * so villagers read as fellow survivors instead of abstract blobs.
 * Each profile adds small silhouette details (Mara: ponytail + skirt,
 * Tomas: beard + flat cap) so the two are distinguishable from behind.
 */
import {
  Color3,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Scene,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import { mulberry32 } from '../core/noise';
import { groundSurfaceHeight } from '../world/groundSurface';
import type { SharedMaterials } from '../visual/materials';

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
      'Hé, die schapen en koeien hier zijn geen decor. Slacht ze af, bak het vlees, en wol en leer zijn bouwstof.',
    ],
    shirt: new Color3(0.55, 0.34, 0.22),
    pants: new Color3(0.3, 0.27, 0.3),
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
      'Wol en leer, dat is het nou. Van de schapen en koeien buiten. Een deur en een stenen muur maak je ervan.',
    ],
    shirt: new Color3(0.27, 0.38, 0.42),
    pants: new Color3(0.4, 0.33, 0.23),
    skin: new Color3(0.78, 0.6, 0.46),
    hair: new Color3(0.17, 0.14, 0.11),
  },
];

interface NpcRoutinePoint {
  x: number;
  z: number;
  /** Seconds to idle here when arrived. */
  dwell: number;
}

/**
 * The witch's persona. Deliberately NOT part of NPC_PROFILES: that array
 * spawns the villagers at the camp, and she does not live at the camp — she
 * lives in her tower (world/tower.ts) and the game spawns her there. She is
 * still a full `Npc`: same conversation pipeline (ai/chat.ts), same memory,
 * same save slot, same server persona (server/npc.mjs `heks`).
 */
export const WITCH_PROFILE: NpcProfile = {
  id: 'heks',
  name: 'De Heks',
  persona:
    'Je speelt de heks van de stenen toren, een oude, sarkastische vrouwenhandelaar die drankjes ruilt ' +
    'tegen jachtbuit. Ze is trots, grommend en gehecht aan haar spullen, praat in korte stekige zinnen ' +
    'met een grijns, en waarschuwt iedereen die een zwaard naar haar trekt. Ze is geen vriendin — ze is ' +
    'een zaak.',
  fallbackLines: [
    'Materialen. Wol, leer, steen, bessen. Drankjes. Zo werkt handel.',
    'Aan mijn spullen zitten, jong? De toren bewaakt zichzelf.',
    'Mara en Tomas praten te veel. Ik ruil. Dat is het hele geheim.',
    'Een zwaard voor mijn deur? Tel tot tien en loop weg.',
  ],
  shirt: new Color3(0.16, 0.11, 0.22),
  pants: new Color3(0.12, 0.09, 0.16),
  skin: new Color3(0.72, 0.66, 0.5),
  hair: new Color3(0.78, 0.78, 0.82),
};

/**
 * The three islanders of the second island (world/villageIsle.ts). They are
 * ordinary `Npc`s — same wander route, same conversation pipeline — but they
 * do not live at the camp, so game.ts spawns them at their own home spots and
 * they are not in `NPC_PROFILES` (which drives the camp pair).
 *
 * Server personas for them live in server/npc.mjs; if the server does not know
 * one, the `fallbackLines` below carry the voice — which is why they are
 * written as things these three would actually say about their own island.
 */
export const VILLAGER_PROFILES: NpcProfile[] = [
  {
    id: 'sien',
    name: 'Sien',
    persona:
      'Je speelt Sien, de vissersvrouw van het eildorp. Ze is nuchter, lachend en handig met knopen, ' +
      'praat over het water, het getij en wat de zee vandaag geeft, in korte gewone zinnen. Ze kent de ' +
      'brug en de overkant, en waarschuwt voor de nachten.',
    fallbackLines: [
      'De boten liggen droog. Te veel wind, te weinig vissen.',
      'Over die brug kun je. Vlak en recht, hij staat stevig.',
      'Aan de overkant is bos en vuur. Hier is water en zout.',
      'Nacht is geen tijd om rond te lopen, vreemdeling. Maar hier ben je veilig.',
    ],
    shirt: new Color3(0.24, 0.42, 0.46),
    pants: new Color3(0.2, 0.24, 0.3),
    skin: new Color3(0.79, 0.63, 0.47),
    hair: new Color3(0.11, 0.09, 0.09),
  },
  {
    id: 'ansel',
    name: 'Ansel',
    persona:
      'Je speelt Ansel, de oudste van het eildorp. Hij praat traag en bedaard over de kerk, de geschiedenis ' +
      'van het dorp en wat men van de speler verwacht. Vriendelijk, formeel, een beetje zweverig, in ' +
      'volle zinnen.',
    fallbackLines: [
      'Wij zijn hier gebleven, toen de zee steeg. De toren blijft staan.',
      'Binnen de kerk is het stil. Dat is de hele reden van een kerk.',
      'Wie voor het eerst over de brug komt, hoort bij het dorp. Geef het tijd.',
      'De put is oud, de straat is ouder, de brug is nieuw. Schik je.',
    ],
    shirt: new Color3(0.42, 0.36, 0.28),
    pants: new Color3(0.26, 0.23, 0.2),
    skin: new Color3(0.82, 0.68, 0.53),
    hair: new Color3(0.86, 0.85, 0.82),
  },
  {
    id: 'joris',
    name: 'Joris',
    persona:
      'Je speelt Joris, de metselaar van het eildorp. Hij praat over steen, metselwerk, daken en wat er ' +
      'nodig is om iets te laten staan. Hij is direct en tevreden over zijn eigen werk, en vertelt graag ' +
      'waar hij zelf aan heeft gebouwd. Korte nuchtere zinnen.',
    fallbackLines: [
      'Die huizen stehen. Zestien jaar, geen barst. Ik heb ze gezet.',
      'Steen op steen, met een gat voor de deur. Zo werkt metselen.',
      'De brug is van balken, niet van steen. Op drijfhout heb je niets.',
      'Twee boten, vijf huizen, één kerk. Meer heeft een dorp niet nodig.',
    ],
    shirt: new Color3(0.5, 0.44, 0.36),
    pants: new Color3(0.3, 0.28, 0.24),
    skin: new Color3(0.75, 0.58, 0.42),
    hair: new Color3(0.2, 0.13, 0.09),
  },
];

export class Npc {
  readonly profile: NpcProfile;
  readonly root: TransformNode;
  private scene: Scene;
  // Joint hierarchy — `protected` so ai/witch.ts can drive a hostile chase
  // cycle without reaching around the base class.
  protected hipL: TransformNode;
  protected hipR: TransformNode;
  protected kneeL: TransformNode;
  protected kneeR: TransformNode;
  protected shoulderL: TransformNode;
  protected shoulderR: TransformNode;
  protected elbowL: TransformNode;
  protected elbowR: TransformNode;
  protected headNode: TransformNode;
  protected yaw = 0;
  protected route: NpcRoutinePoint[];
  protected routeIndex = 0;
  protected dwellTimer = 0;
  protected phase = 0;
  protected idleTime = 0;
  protected speed: number;
  protected materials: PBRMaterial[] = [];

  constructor(
    scene: Scene,
    profile: NpcProfile,
    camp: { x: number; z: number; y: number },
    seed: number,
    mats: SharedMaterials,
    /** Route tuning for landmark dwellers (the witch patrols a ring around
     * her tower shell instead of wandering through it). */
    opts?: { ring?: [min: number, max: number] },
  ) {
    this.profile = profile;
    this.scene = scene;
    const rng = mulberry32(seed);
    this.speed = 1.4 + rng() * 0.5;

    this.root = new TransformNode(`npc_${profile.id}`, scene);
    this.root.position.set(camp.x + (rng() - 0.5) * 6, camp.y, camp.z + (rng() - 0.5) * 6);

    // --- materials -------------------------------------------------------
    // Same PBR family as the player character so lighting reads identically.
    const pbr = (name: string, albedo: Color3, roughness: number): PBRMaterial => {
      const m = new PBRMaterial(`npc_${name}_${profile.id}`, scene);
      m.albedoColor = albedo;
      m.metallic = 0;
      m.roughness = roughness;
      this.materials.push(m);
      return m;
    };
    const dim = (c: Color3, k: number) => new Color3(c.r * k, c.g * k, c.b * k);
    const shirtMat = pbr('shirt', profile.shirt, 0.82);
    const pantsMat = pbr('pants', profile.pants, 0.86);
    const skinMat = pbr('skin', profile.skin, 0.55);
    const hairMat = pbr('hair', profile.hair, 0.72);
    const bootMat = pbr('boots', dim(profile.pants, 0.45), 0.6);
    const eyeMat = pbr('eyes', new Color3(0.05, 0.04, 0.04), 0.3);

    // --- skeleton --------------------------------------------------------
    // Feet on the ground, hips at 0.90, head top near 1.72 — the same
    // height envelope as the player so camera framing stays consistent.
    const hips = this.node('hips', 0, 0.9, 0);
    hips.parent = this.root;
    const torso = this.node('torso', 0, 0.24, 0);
    torso.parent = hips;
    this.headNode = this.node('head', 0, 0.42, 0);
    this.headNode.parent = torso;

    const p = (name: string, mesh: Mesh, parent: TransformNode, y: number, z = 0, x = 0): Mesh => {
      mesh.name = `npcPart_${profile.id}_${name}`;
      mesh.parent = parent;
      mesh.position.set(x, y, z);
      return mesh;
    };

    // Torso: capsule + chest mass + waist block (player silhouette).
    p('torso', MeshBuilder.CreateCapsule('t', { radius: 0.2, height: 0.66, tessellation: 12 }, scene),
      torso, 0.08, 0).material = shirtMat;
    p('chest', MeshBuilder.CreateBox('c', { width: 0.44, height: 0.18, depth: 0.28 }, scene),
      torso, 0.3, 0).material = shirtMat;
    p('waist', MeshBuilder.CreateBox('w', { width: 0.36, height: 0.18, depth: 0.26 }, scene),
      hips, 0, 0).material = pantsMat;
    p('belt', MeshBuilder.CreateBox('b', { width: 0.37, height: 0.06, depth: 0.27 }, scene),
      hips, 0.06, 0).material = bootMat;
    const buckle = p('buckle', MeshBuilder.CreateBox('bk', { width: 0.06, height: 0.05, depth: 0.03 }, scene),
      hips, 0.06, 0.14);
    buckle.material = mats.playerAccent;

    // Head group (neck, skull, hair, face) so idle head-turns move it all.
    p('neck', MeshBuilder.CreateCylinder('n', { diameter: 0.09, height: 0.12, tessellation: 8 }, scene),
      this.headNode, 0).material = skinMat;
    const head = p('head', MeshBuilder.CreateSphere('h', { diameter: 0.27, segments: 12 }, scene),
      this.headNode, 0.14, 0.01);
    head.scaling.set(0.92, 1.05, 0.98);
    head.material = skinMat;
    const hairCap = p('hair', MeshBuilder.CreateSphere('hr', { diameter: 0.3, segments: 12 }, scene),
      this.headNode, 0.2, -0.015);
    hairCap.scaling.set(0.98, 0.72, 1.0);
    hairCap.material = hairMat;
    for (const side of [-1, 1]) {
      const label = side < 0 ? 'L' : 'R';
      p(`eye${label}`, MeshBuilder.CreateSphere('e', { diameter: 0.026, segments: 6 }, scene),
        this.headNode, 0.16, 0.128, side * 0.05).material = eyeMat;
      p(`brow${label}`, MeshBuilder.CreateBox('br', { width: 0.055, height: 0.012, depth: 0.018 }, scene),
        this.headNode, 0.188, 0.124, side * 0.05).material = hairMat;
      p(`ear${label}`, MeshBuilder.CreateSphere('ea', { diameter: 0.055, segments: 6 }, scene),
        this.headNode, 0.14, 0, side * 0.128).material = skinMat;
    }
    p('nose', MeshBuilder.CreateSphere('no', { diameter: 0.035, segments: 6 }, scene),
      this.headNode, 0.13, 0.138).material = skinMat;

    // Silhouette details per villager.
    if (profile.id === 'heks') {
      // The witch: crooked pointed hat, long grey hair falling past the
      // shoulders, and a dark shawl over the robe — readable at 20 metres.
      const shawl = p('shawl', MeshBuilder.CreateCylinder('sh', {
        diameterTop: 0.42, diameterBottom: 0.62, height: 0.34, tessellation: 10,
      }, scene), torso, 0.12);
      shawl.material = shirtMat;
      for (const side of [-1, 1]) {
        const strand = p(`hairFall${side < 0 ? 'L' : 'R'}`,
          MeshBuilder.CreateSphere('hf', { diameter: 0.12, segments: 8 }, scene),
          this.headNode, 0.02, -0.06, side * 0.13);
        strand.scaling.set(0.7, 2.4, 0.7);
        strand.material = hairMat;
      }
      const brim = p('hatBrim', MeshBuilder.CreateCylinder('hb', { diameter: 0.62, height: 0.03, tessellation: 12 }, scene),
        this.headNode, 0.27, 0.01);
      brim.rotation.z = 0.07;
      brim.material = bootMat;
      const cone = p('hatCone', MeshBuilder.CreateCylinder('hc', {
        diameterTop: 0.012, diameterBottom: 0.34, height: 0.7, tessellation: 8,
      }, scene), this.headNode, 0.6, 0.02);
      cone.rotation.z = -0.16; // the crooked tip — a witch's hat is never straight
      cone.material = bootMat;
      const buckleBelt = p('charmBelt', MeshBuilder.CreateTorus('cbt', {
        diameter: 0.4, thickness: 0.03, tessellation: 10,
      }, scene), hips, 0.05);
      buckleBelt.material = mats.playerAccent;
    } else if (profile.id === 'mara') {
      // Ponytail hanging from the back of the hair cap.
      const tail = p('ponytail', MeshBuilder.CreateSphere('pt', { diameter: 0.14, segments: 8 }, scene),
        this.headNode, 0.1, -0.17);
      tail.scaling.set(0.8, 1.7, 0.8);
      tail.rotation.x = -0.35;
      tail.material = hairMat;
      const tie = p('hairTie', MeshBuilder.CreateCylinder('ht', { diameter: 0.05, height: 0.03, tessellation: 6 }, scene),
        this.headNode, 0.16, -0.14);
      tie.rotation.x = Math.PI / 2 - 0.35;
      tie.material = mats.playerAccent;
      // Knee-length skirt over the upper legs.
      const skirt = p('skirt', MeshBuilder.CreateCylinder('sk', {
        diameterTop: 0.36, diameterBottom: 0.5, height: 0.26, tessellation: 12,
      }, scene), hips, -0.08);
      skirt.material = pantsMat;
    } else {
      // Tomas: short beard and a carpenter's flat cap.
      const beard = p('beard', MeshBuilder.CreateSphere('bd', { diameter: 0.21, segments: 8 }, scene),
        this.headNode, 0.06, 0.055);
      beard.scaling.set(0.85, 0.55, 0.9);
      beard.material = hairMat;
      const cap = p('cap', MeshBuilder.CreateCylinder('cp', { diameter: 0.3, height: 0.05, tessellation: 12 }, scene),
        this.headNode, 0.26, 0.01);
      cap.material = bootMat;
      const brim = p('capBrim', MeshBuilder.CreateBox('cb', { width: 0.24, height: 0.02, depth: 0.11 }, scene),
        this.headNode, 0.25, 0.15);
      brim.rotation.x = 0.12;
      brim.material = bootMat;
      // Toolbelt pouch — the carpenter always carries something.
      const pouch = p('pouch', MeshBuilder.CreateBox('po', { width: 0.1, height: 0.12, depth: 0.07 }, scene),
        hips, 0.0, -0.17);
      pouch.material = mats.buildingWood;
    }

    // Arms: shoulder pivot -> upper -> elbow -> forearm -> hand.
    const arm = (name: string, side: number): [TransformNode, TransformNode] => {
      const sh = this.node(`shoulder${name}`, 0.26 * side, 0, 0);
      sh.parent = torso;
      sh.position.set(0.26 * side, 0.16, 0);
      const cap = p(`shoulderPart${name}`, MeshBuilder.CreateSphere('sc', { diameter: 0.16, segments: 10 }, scene),
        sh, 0);
      cap.material = shirtMat;
      p(`upperArm${name}`, MeshBuilder.CreateCapsule('ua', { radius: 0.072, height: 0.28, tessellation: 10 }, scene),
        sh, -0.13).material = shirtMat;
      const elbow = this.node(`elbow${name}`, 0, 0, 0);
      elbow.parent = sh;
      elbow.position.set(0, -0.27, 0);
      p(`foreArm${name}`, MeshBuilder.CreateCapsule('fa', { radius: 0.062, height: 0.24, tessellation: 10 }, scene),
        elbow, -0.11).material = skinMat;
      p(`hand${name}`, MeshBuilder.CreateSphere('hd', { diameter: 0.085, segments: 8 }, scene),
        elbow, -0.26).material = skinMat;
      elbow.rotation.x = -0.22;
      return [sh, elbow];
    };
    [this.shoulderL, this.elbowL] = arm('L', -1);
    [this.shoulderR, this.elbowR] = arm('R', 1);

    // Legs: hip pivot -> thigh -> knee -> shin -> boot.
    const leg = (name: string, side: number): [TransformNode, TransformNode] => {
      const hip = this.node(`hip${name}`, 0, 0, 0);
      hip.parent = hips;
      hip.position.set(0.115 * side, -0.02, 0);
      p(`thigh${name}`, MeshBuilder.CreateCapsule('th', { radius: 0.1, height: 0.44, tessellation: 10 }, scene),
        hip, -0.2).material = pantsMat;
      const knee = this.node(`knee${name}`, 0, 0, 0);
      knee.parent = hip;
      knee.position.set(0, -0.4, 0);
      p(`shin${name}`, MeshBuilder.CreateCapsule('sn', { radius: 0.082, height: 0.38, tessellation: 10 }, scene),
        knee, -0.18).material = pantsMat;
      const boot = p(`boot${name}`, MeshBuilder.CreateBox('bt', { width: 0.14, height: 0.09, depth: 0.25 }, scene),
        knee, -0.41, 0.045);
      boot.material = bootMat;
      return [hip, knee];
    };
    [this.hipL, this.kneeL] = leg('L', -1);
    [this.hipR, this.kneeR] = leg('R', 1);

    // Deterministic wander route around the camp (or a ring around the
    // landmark the NPC lives at — the witch patrols outside her tower shell).
    this.route = [];
    const [rMin, rSpan] = opts?.ring ?? [4, 7];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + rng();
      const r = rMin + rng() * rSpan;
      const x = camp.x + Math.cos(a) * r;
      const z = camp.z + Math.sin(a) * r;
      this.route.push({ x, z, dwell: 2 + rng() * 6 });
    }
    const start = this.route[0];
    this.root.position.x = start.x;
    this.root.position.z = start.z;
    this.root.position.y = groundSurfaceHeight(start.x, start.z);
    this.dwellTimer = 3 + rng() * 5;
  }

  private node(name: string, x: number, y: number, z: number): TransformNode {
    const n = new TransformNode(`npc_${name}_${this.profile.id}`, this.scene);
    n.position.set(x, y, z);
    return n;
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
      // Walk cycle: hips swing, knees bend on the back swing, elbows
      // stay slightly bent and counter-swing.
      this.phase += dt * 4.5;
      const s = Math.sin(this.phase) * 0.5;
      this.hipL.rotation.x = s;
      this.hipR.rotation.x = -s;
      this.kneeL.rotation.x = Math.max(0, -s) * 0.7;
      this.kneeR.rotation.x = Math.max(0, s) * 0.7;
      this.shoulderL.rotation.x = -s * 0.6;
      this.shoulderR.rotation.x = s * 0.6;
      this.elbowL.rotation.x = -0.25 - s * 0.15;
      this.elbowR.rotation.x = -0.25 + s * 0.15;
      this.headNode.rotation.y *= 0.9;
    } else {
      // Relaxed idle: limbs settle, gentle breathing bob, and the head
      // slowly looks around so a standing villager never looks frozen.
      this.idleTime += dt;
      this.dwellTimer -= dt;
      const k = Math.min(1, 6 * dt);
      for (const [joint, target] of [
        [this.hipL, 0], [this.hipR, 0], [this.kneeL, 0], [this.kneeR, 0],
        [this.shoulderL, 0], [this.shoulderR, 0],
        [this.elbowL, -0.22], [this.elbowR, -0.22],
      ] as const) {
        joint.rotation.x += (target - joint.rotation.x) * k;
      }
      this.headNode.rotation.y = Math.sin(this.idleTime * 0.45) * 0.3;
      this.root.position.y += (groundSurfaceHeight(p.x, p.z) - p.y) * Math.min(1, 5 * dt);
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
