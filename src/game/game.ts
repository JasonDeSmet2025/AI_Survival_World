/**
 * Game orchestration (Game Director scope).
 *
 * Wires together: terrain/world, shared world state, player controller +
 * character, survival systems, NPC conversations, building placement and
 * the optional server-authoritative multiplayer client. All subsystems
 * live in their own modules; this file only composes and drives them.
 */
import {
  Color3,
  Color4,
  Engine,
  FreeCamera,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';
import { Conversation } from './ai/chat';
import { Npc, NPC_PROFILES } from './ai/npc';
import { harvestSeconds, ITEMS, RECIPES, YIELDS } from './core/items';
import { InputController } from './input';
import { Hud } from './hud/hud';
import { MultiplayerClient, type MpMessage, type MpStatus } from './net/mp';
import { PlayerCharacter } from './player/player';
import { PlayerController } from './player/controller';
import { Crafting } from './systems/crafting';
import {
  validatePlacement,
  wallSegment,
  type WallSegment,
} from './systems/building';
import { BuildingRenderer } from './systems/buildingMeshes';
import { raycastTarget, type InteractTarget } from './systems/interact';
import { Inventory } from './systems/inventory';
import { Save } from './systems/save';
import { SurvivalStats } from './systems/stats';
import { Lighting } from './visual/lighting';
import { createSharedMaterials, type SharedMaterials } from './visual/materials';
import {
  createSeaPlane,
  createTerrain,
  findCampPoint,
  findSpawnPoint,
  SEA_LEVEL,
  terrainHeight,
  WORLD_SEED,
} from './world/terrain';
import { Sky } from './world/sky';
import { Water } from './world/water';
import { populateFlora } from './world/flora';
import { SharedWorldState } from './world/worldState';
import type { BuildingData, Collider } from './world/types';

const KIND_LABEL: Record<string, string> = {
  tree: 'Boom',
  pine: 'Dennenboom',
  rock: 'Steen',
  bush: 'Bessenstruik',
};

const BUILDING_KINDS: ReadonlySet<string> = new Set(['campfire', 'wall', 'floor', 'roof']);

interface RemotePlayer {
  mesh: Mesh;
  target: Vector3;
}

export class Game {
  private engine: Engine;
  private scene: Scene;
  private camera: FreeCamera;

  private mats: SharedMaterials;
  private sky: Sky;
  private water: Water;
  private lighting: Lighting;
  private world: SharedWorldState;
  private renderer: BuildingRenderer;

  private colliders: Collider[] = [];
  private camp: { x: number; z: number; y: number };

  private controller: PlayerController;
  private character: PlayerCharacter;
  private charYaw = 0;

  private stats = new SurvivalStats();
  private inventory = new Inventory();
  private hud: Hud;
  private input: InputController;

  private npcs: Npc[] = [];
  private conversations = new Map<string, Conversation>();
  private activeNpc: Npc | null = null;

  private mp: MultiplayerClient | null = null;
  private mpUrl: string | null;
  private localId: string;
  private remotes = new Map<string, RemotePlayer>();

  private camYaw = 0;
  private camPitch = -0.25;
  private gathering: { id: string; progress: number } | null = null;
  private shadowedBuildings = new Set<Mesh>();
  private bushRegrow = new Map<string, number>();
  private craftingOpen = false;
  private buildSeq = 0;
  private deathShown = false;
  private saveTimer = 0;
  private hudTimer = 0;
  private fpsFrames = 0;
  private fpsTime = 0;

  constructor(
    canvas: HTMLCanvasElement,
    hudContainer: HTMLElement,
    opts?: { mpUrl?: string | null },
  ) {
    // Engine + scene
    this.engine = new Engine(canvas, true, { stencil: true });
    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0.02, 0.03, 0.06, 1);
    this.scene.fogMode = Scene.FOGMODE_EXP2;
    this.scene.fogDensity = 0.0042;
    this.scene.fogColor = new Color3(0.55, 0.64, 0.74);

    // World
    this.mats = createSharedMaterials(this.scene);
    const terrain = createTerrain(this.scene);
    createSeaPlane(this.scene);
    this.sky = new Sky(this.scene);
    this.water = new Water(this.scene, this.engine);

    const spawn = findSpawnPoint();
    this.camp = findCampPoint(spawn);

    // Camera + lighting (post-processing and IBL run from the lighting module).
    this.camera = new FreeCamera('cam', new Vector3(spawn.x, spawn.y + 4, spawn.z + 8), this.scene);
    this.camera.ellipsoid = new Vector3(0.4, 0.8, 0.4);
    this.lighting = new Lighting(this.scene, this.sky, this.water, terrain.material);

    // Shared world state + flora
    this.world = new SharedWorldState();
    const keepOut = [
      { x: spawn.x, z: spawn.z, r: 5 },
      { x: this.camp.x, z: this.camp.z, r: 8 },
    ];
    this.floraHandle = populateFlora(this.scene, this.mats, this.world, this.colliders, keepOut);

    // Camp fire so the NPCs have a fire to sit by (decorative, always lit)
    this.world.addBuilding({
      id: 'camp_fire',
      kind: 'campfire',
      x: this.camp.x,
      z: this.camp.z,
      y: terrainHeight(this.camp.x, this.camp.z),
      rot: 0,
      ownerId: 'world',
      fuel: 999999,
    });
    this.renderer = new BuildingRenderer(this.scene, this.mats);
    this.renderer.sync(this.world.buildings);

    // Player
    this.controller = new PlayerController({ x: spawn.x, y: spawn.y, z: spawn.z });
    this.character = new PlayerCharacter(this.scene, this.mats);
    for (const m of this.character.shadowMeshes) this.lighting.addShadowCaster(m);
    this.character.onToolShadows = (added, removed) => {
      for (const m of added) this.lighting.addShadowCaster(m);
      for (const m of removed) this.lighting.removeShadowCaster(m);
    };

    // HUD + input
    this.hud = new Hud(hudContainer, () => this.respawn());
    this.input = new InputController(canvas);
    this.bindHudEvents();

    // NPCs at the camp
    NPC_PROFILES.forEach((profile, i) => {
      const npc = new Npc(this.scene, profile, this.camp, WORLD_SEED + i * 977);
      this.npcs.push(npc);
      this.conversations.set(profile.id, new Conversation(profile, '/api/chat'));
      for (const m of npc.root.getChildMeshes(true)) this.lighting.addShadowCaster(m);
    });

    // Multiplayer
    const params = new URLSearchParams(window.location.search);
    this.mpUrl = opts?.mpUrl ?? (params.get('mp') ? `ws://${window.location.host}/ws` : null);
    this.localId = Math.random().toString(36).slice(2, 10);
    if (this.mpUrl) this.initMultiplayer();

    // Restore save (solo only)
    if (!this.mpUrl) this.restoreSave();

    // Starter items on a fresh world
    if (!Save.read()) {
      this.inventory.add('wood', 5);
      this.inventory.add('stone', 2);
      this.inventory.add('berries', 3);
    }

    this.refreshHud(true);
    this.scene.onBeforeRenderObservable.add(() => this.frame(this.engine.getDeltaTime() / 1000));

    // Start Babylon.js rendering and game updates.
    this.engine.runRenderLoop(() => {
      this.scene.render();
    });

    window.addEventListener('beforeunload', () => this.persist());
  }

  // ------------------------------------------------------------------
  // Multiplayer
  // ------------------------------------------------------------------

  private initMultiplayer(): void {
    const mp = new MultiplayerClient(
      this.mpUrl as string,
      'Speler',
      (m: MpMessage) => this.handleMpMessage(m),
      (s: MpStatus) => this.hud.setMpStatus(s),
    );
    mp.connect();
    this.mp = mp;
  }

  private handleMpMessage(m: MpMessage): void {
    switch (m.t) {
      case 'hello':
        this.world.apply(
          { version: 1, seed: m.seed, depleted: m.depleted, hp: m.hp, buildings: m.buildings },
          m.seed,
        );
        this.renderer.sync(this.world.buildings);
        this.floraRefresh();
        for (const p of m.players) {
          if (p.id !== this.localId) this.addRemote(p.id, p.p[0], p.p[1], p.p[2]);
        }
        break;
      case 'joined':
        this.addRemote(m.id, 0, 0, 0);
        break;
      case 'left':
        this.removeRemote(m.id);
        break;
      case 'p': {
        const r = this.remotes.get(m.id);
        if (r) r.target.set(m.p[0], m.p[1], m.p[2]);
        break;
      }
      case 'placed':
        this.world.addBuilding(m.b);
        this.renderer.sync(this.world.buildings);
        break;
      case 'harvested':
        this.world.damageNode(m.id, 1);
        if (m.hp <= 0) this.floraRefresh();
        break;
      case 'depleted':
        this.floraRefresh();
        break;
      case 'reject':
        this.hud.toast(m.msg);
        break;
      case 'npc_reply':
        this.hud.addChatLine(m.npc, m.text, false);
        break;
      case 'npc_error':
        this.hud.addChatLine(m.npc, '(server onbereikbaar)', true);
        break;
    }
  }

  private addRemote(id: string, x: number, y: number, z: number): void {
    if (this.remotes.has(id)) return;
    const mesh = MeshBuilder.CreateCapsule(`remote_${id}`, { height: 1.7, radius: 0.32 }, this.scene);
    const mat = new StandardMaterial(`remoteMat_${id}`, this.scene);
    mat.diffuseColor = new Color3(0.55, 0.6, 0.75);
    mesh.material = mat;
    mesh.position.set(x, y, z);
    mesh.freezeWorldMatrix();
    this.lighting.addShadowCaster(mesh);
    this.remotes.set(id, { mesh, target: new Vector3(x, y, z) });
  }

  private removeRemote(id: string): void {
    const r = this.remotes.get(id);
    if (!r) return;
    r.mesh.dispose();
    this.remotes.delete(id);
  }

  // ------------------------------------------------------------------
  // Save / load
  // ------------------------------------------------------------------

  private restoreSave(): void {
    const data = Save.read();
    if (!data) return;
    this.stats.restore(data.stats);
    this.inventory.restore(data.inventory, data.selected);
    this.controller.respawn(data.pos.x, data.pos.y, data.pos.z);
    this.camYaw = data.yaw;
    this.camPitch = data.pitch;
    this.lighting.setTimeOfDay(data.elapsed);
    this.world.apply(data.world, data.world.seed || WORLD_SEED);
    this.renderer.sync(this.world.buildings);
    this.floraRefresh();
    for (const [id, conv] of this.conversations) {
      const saved = data.npcs?.[id];
      if (saved) conv.restore(saved);
    }
    if (this.stats.dead) {
      this.stats.respawn();
      this.inventory.applyDeathPenalty();
    }
  }

  private persist(): void {
    if (this.mp || this.stats.dead) return;
    const ws = this.world.serialize();
    ws.seed = WORLD_SEED;
    const data = Save.toSaveData(
      this.stats.snapshot(),
      this.inventory,
      { x: this.controller.pos.x, y: this.controller.pos.y, z: this.controller.pos.z },
      this.camYaw,
      this.camPitch,
      this.lighting.timeOfDay,
      ws,
    );
    data.npcs = {};
    for (const [id, conv] of this.conversations) data.npcs[id] = conv.serialize();
    Save.write(data);
  }

  private floraRefresh(): void {
    // Re-apply depleted visuals (flora applyState is cheap: instance transforms)
    this.floraHandle?.applyState();
  }

  private floraHandle: { applyState: () => void } | null = null;

  // ------------------------------------------------------------------
  // HUD events
  // ------------------------------------------------------------------

  private bindHudEvents(): void {
    window.addEventListener('hud-hotbar-click', (e: Event) => {
      this.inventory.select((e as CustomEvent<number>).detail);
      this.refreshHud(true);
    });
    window.addEventListener('hud-craft-click', (e: Event) => this.doCraft((e as CustomEvent<string>).detail));
    window.addEventListener('hud-chat-send', (e: Event) => void this.sendChat((e as CustomEvent<string>).detail));
    window.addEventListener('hud-chat-close', () => this.closeChat());
  }

  private doCraft(recipeId: string): void {
    if (this.stats.dead) return;
    const recipe = RECIPES.find((r) => r.id === recipeId);
    if (!recipe) return;
    if (!Crafting.canCraft(this.inventory, recipe)) {
      this.hud.toast('Niet genoeg materialen');
      return;
    }
    Crafting.craft(this.inventory, recipeId);
    this.hud.toast(`Gemaakt: ${ITEMS[recipe.output.id].name} x${recipe.output.count}`);
    this.refreshHud(true);
  }

  private async sendChat(text: string): Promise<void> {
    const npc = this.activeNpc;
    if (!npc) return;
    const conv = this.conversations.get(npc.profile.id);
    if (!conv) return;
    this.hud.addChatLine('Jij', text);
    this.hud.setChatBusy(true);
    const res = await conv.send(text, { playerState: this.playerStateSummary() });
    this.hud.addChatLine(npc.profile.name, res.reply, res.source === 'fallback');
    this.hud.setChatBusy(false);
    this.mp?.sendChat({ id: npc.profile.id, name: npc.profile.name, personality: npc.profile.persona }, text, { playerState: this.playerStateSummary() });
  }

  private playerStateSummary(): string {
    const t = this.lighting.timeOfDay;
    const hh = Math.floor(t * 24);
    const mm = Math.floor((t * 24 - hh) * 60);
    const has = [...new Set(this.inventory.slots.filter(Boolean).map((s) => s!.id))].slice(0, 8);
    return (
      `Honger ${Math.round(this.stats.hunger)}%, dorst ${Math.round(this.stats.thirst)}%, ` +
      `gezonddend ${Math.round(this.stats.health)}%, temperatuur ${this.stats.temperature.toFixed(0)}°C, ` +
      `uur ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}. ` +
      `Bezit: ${has.length ? has.map((id) => ITEMS[id].name).join(', ') : 'niets'}.`
    );
  }

  private openChat(npc: Npc): void {
    this.activeNpc = npc;
    this.hud.openChat(npc.profile.name);
    this.hud.addChatLine(npc.profile.name, '(wacht tot je typ)', true);
  }

  private closeChat(): void {
    this.activeNpc = null;
    this.hud.closeChat();
  }

  // ------------------------------------------------------------------
  // Interaction
  // ------------------------------------------------------------------

  private buildTargets(): InteractTarget[] {
    const targets: InteractTarget[] = [];
    for (const n of this.world.nodes) {
      if (this.world.isDepleted(n.id)) continue;
      targets.push({ kind: 'node', id: n.id, x: n.x, y: n.y + 0.8, z: n.z, radius: n.radius });
    }
    for (const npc of this.npcs) {
      const p = npc.root.position;
      targets.push({ kind: 'npc', id: npc.profile.id, x: p.x, y: p.y + 1, z: p.z, radius: 1.7 });
    }
    for (const b of this.world.buildings) {
      if (b.kind === 'campfire') {
        targets.push({ kind: 'campfire', id: b.id, x: b.x, y: b.y + 0.5, z: b.z, radius: 1.9 });
      }
    }
    // Water: ray vs sea-level plane
    const cam = this.camera;
    const dir = cam.getForwardRay().direction;
    if (dir.y < -0.02) {
      const t = (SEA_LEVEL - cam.position.y) / dir.y;
      if (t > 0 && t < 30) {
        const wx = cam.position.x + dir.x * t;
        const wz = cam.position.z + dir.z * t;
        if (terrainHeight(wx, wz) < SEA_LEVEL + 0.25) {
          targets.push({ kind: 'water', x: wx, y: SEA_LEVEL, z: wz, radius: 4 });
        }
      }
    }
    return targets;
  }

  private pickInteract(maxRange = 8) {
    return raycastTarget(this.camera.position, this.camera.getForwardRay().direction, this.buildTargets(), maxRange);
  }

  private selectedItemId(): string | null {
    const slot = this.inventory.slots[this.inventory.selected];
    return slot ? slot.id : null;
  }

  private handleEPress(target: InteractTarget | null): void {
    // Building placement takes priority when a building item is selected.
    const sel = this.selectedItemId();
    if (sel && BUILDING_KINDS.has(sel)) {
      this.tryPlaceBuilding(sel as BuildingData['kind']);
      return;
    }
    if (!target) return;
    switch (target.kind) {
      case 'npc': {
        const npc = this.npcs.find((n) => n.profile.id === target.id);
        if (npc) this.openChat(npc);
        break;
      }
      case 'campfire': {
        if (this.inventory.count('wood') <= 0) {
          this.hud.toast('Geen hout voor het vuur');
          return;
        }
        const b = this.world.buildings.find((x) => x.id === target.id);
        if (!b) return;
        this.inventory.remove('wood', 1);
        b.fuel = Math.min(3600, (b.fuel ?? 0) + 120);
        this.renderer.sync(this.world.buildings);
        this.hud.toast('Hout toegevoegd (+120s)');
        break;
      }
      case 'water': {
        if (this.stats.thirst >= 96) {
          this.hud.toast('Niet dorst');
          return;
        }
        this.stats.thirst = Math.min(100, this.stats.thirst + 30);
        this.hud.toast('GeDRONKEN (+30)');
        break;
      }
      default:
        break;
    }
  }

  private tryPlaceBuilding(kind: BuildingData['kind']): void {
    const ground = this.groundUnderCamera(14);
    if (!ground) return;
    const dx = ground.x - this.controller.pos.x;
    const dz = ground.z - this.controller.pos.z;
    const rot = ((Math.round(Math.atan2(dx, dz) / (Math.PI / 2)) % 4) + 4) % 4;
    const groundY = terrainHeight(ground.x, ground.z);
    if (groundY < SEA_LEVEL) {
      this.hud.toast('Hier staat water');
      return;
    }
    if (validatePlacement(kind, ground.x, ground.z, groundY, this.world.buildings, this.controller.pos, terrainHeight, SEA_LEVEL)) {
      this.hud.toast('Hier past het niet');
      return;
    }
    if (this.inventory.remove(kind, 1)) {
      const b: BuildingData = {
        id: `b_${this.localId}_${++this.buildSeq}`,
        kind,
        x: ground.x,
        z: ground.z,
        y: groundY,
        rot,
        ownerId: this.localId,
        fuel: kind === 'campfire' ? 300 : undefined,
      };
      this.world.addBuilding(b);
      this.renderer.sync(this.world.buildings);
      this.mp?.sendPlace(b.kind, b.x, b.z, b.y, b.rot, b.id);
      this.hud.toast('Gebouwd');
    }
  }

  private groundUnderCamera(maxRange: number): { x: number; z: number } | null {
    const cam = this.camera.position;
    const dir = this.camera.getForwardRay().direction;
    if (dir.y >= -0.05) return null;
    const t = (this.controller.pos.y - cam.y) / dir.y;
    if (t < 0 || t > maxRange) return null;
    return { x: cam.x + dir.x * t, z: cam.z + dir.z * t };
  }

  // ------------------------------------------------------------------
  // Gathering
  // ------------------------------------------------------------------

  private updateGathering(dt: number, target: { target: InteractTarget; distance: number } | null): void {
    if (!target || target.target.kind !== 'node' || !this.input.harvest) {
      this.gathering = null;
      this.hud.setProgress(null);
      return;
    }
    const node = this.world.node(target.target.id);
    if (!node || this.world.isDepleted(node.id)) {
      this.gathering = null;
      this.hud.setProgress(null);
      return;
    }
    const g = this.gathering && this.gathering.id === node.id ? this.gathering : (this.gathering = { id: node.id, progress: 0 });
    const tool = this.selectedItemId();
    g.progress += dt / harvestSeconds(node.kind, tool);
    this.hud.setProgress(Math.min(1, g.progress));
    if (g.progress >= 1) {
      this.gathering = null;
      this.hud.setProgress(null);
      const yieldDef = YIELDS[node.kind];
      if (!yieldDef) return;
      // Axe helps trees, pickaxe helps rocks: bonus item when used.
      const bonus =
        (node.kind === 'tree' || node.kind === 'pine') && tool === 'axe'
          ? 1
          : node.kind === 'rock' && tool === 'pickaxe'
            ? 1
            : 0;
      const amount = yieldDef.min + Math.floor(Math.random() * (yieldDef.max - yieldDef.min + 1)) + bonus;
      this.inventory.add(yieldDef.itemId, amount);
      this.hud.toast(`+${amount} ${ITEMS[yieldDef.itemId].name}`);
      const remaining = this.world.damageNode(node.id, 1);
      this.mp?.sendHarvest(node.id);
      if (remaining <= 0) {
        this.floraRefresh();
        if (node.kind === 'bush') {
          this.bushRegrow.set(node.id, performance.now() + 90_000);
        }
      }
    }
  }

  private updateBushRegrowth(): void {
    const now = performance.now();
    for (const [id, at] of this.bushRegrow) {
      if (now < at) continue;
      this.bushRegrow.delete(id);
      const node = this.world.node(id);
      if (node) {
        this.world.depleted.delete(id);
        this.world.hp[id] = node.maxHp;
        this.floraRefresh();
      }
    }
  }

  // ------------------------------------------------------------------
  // Death / respawn
  // ------------------------------------------------------------------

  private respawn(): void {
    this.stats.respawn();
    this.inventory.applyDeathPenalty();
    const p = terrainHeight(this.camp.x, this.camp.z);
    this.controller.respawn(this.camp.x, p, this.camp.z);
    this.deathShown = false;
    this.hud.showDeath(false);
    this.hud.toast('Opnieuw bij het kamp');
    this.refreshHud(true);
  }

  // ------------------------------------------------------------------
  // Main loop
  // ------------------------------------------------------------------

  private frame(rawDt: number): void {
    const dt = Math.min(rawDt, 0.05);
    this.lighting.update(dt);
    this.water.update(dt);

    const dead = this.stats.dead;

    // Mouse look
    if (this.input.pointerLocked && !dead) {
      const m = this.input.consumeMouseDelta();
      this.camYaw += m.x * 0.0022;
      this.camPitch = Math.max(-1.15, Math.min(1.25, this.camPitch - m.y * 0.0022));
    } else {
      this.input.consumeMouseDelta();
    }

    if (!dead) {
      // Player physics
      const walls: WallSegment[] = this.world.buildings
        .filter((b) => b.kind === 'wall')
        .map(wallSegment);
      this.controller.crouching = this.input.crouch;
      this.controller.update(dt, this.input, this.camYaw, this.colliders, this.stats.stamina > 5, walls);

      // Character follows physics body
      this.character.root.position.copyFrom(this.controller.pos);
      if (this.controller.speed > 0.5) {
        this.charYaw = dampAngle(this.charYaw, this.controller.moveDir, dt);
      }
      this.character.setFacing(this.charYaw);
      // Hand tool + harvest animation.
      this.character.setTool(this.selectedItemId());
      this.character.update(
        dt,
        this.controller.speed,
        this.controller.onGround,
        this.controller.inWater,
        this.controller.crouching,
        this.input.harvest && this.gathering !== null,
      );

      // Survival
      const env = {
        dayFactor: this.lighting.dayFactor,
        inWater: this.controller.inWater,
        nearFire: this.nearFire(),
        sprinting: this.input.sprint && this.controller.speed > 4,
      };
      this.stats.update(dt, env);

      // Gathering + interact
      const pick = this.pickInteract();
      this.updateGathering(dt, pick);
      this.updateBushRegrowth();
      this.updateBuildingPreview(pick);
      this.updatePrompt(pick);

      // One-press actions
      if (this.input.consumePress('KeyE')) this.handleEPress(pick?.target ?? null);
      if (this.input.consumePress('KeyB')) {
        this.craftingOpen = !this.craftingOpen;
        this.refreshHud(true);
      }
      if (this.input.consumePress('KeyQ')) this.dropSelected();
      if (this.input.consumePress('KeyN')) {
        if (window.confirm('Nieuwe wereld starten? Huidige voortgang wordt gewist.')) {
          Save.clear();
          window.location.reload();
        }
      }
      for (let i = 1; i <= 8; i++) {
        if (this.input.consumePress(`Digit${i}`)) {
          this.inventory.select(i - 1);
          this.refreshHud(true);
        }
      }

      // Throttled HUD + autosave
      this.hudTimer += dt;
      if (this.hudTimer >= 0.15) {
        this.hudTimer = 0;
        this.refreshHud(false);
      }
      this.saveTimer += dt;
      if (this.saveTimer >= 15) {
        this.saveTimer = 0;
        this.persist();
      }

      // Death
      if (this.stats.dead && !this.deathShown) {
        this.deathShown = true;
        this.hud.showDeath(true);
        this.closeChat();
      }
    }

    this.updateCamera();
    this.updateNpcs(dt);
    this.updateRemotes(dt);
    this.updateFps(dt);
    this.syncBuildingShadows();

    // Multiplayer position relay
    if (this.mp && !dead) {
      this.mp.sendPos(
        this.controller.pos.x,
        this.controller.pos.y,
        this.controller.pos.z,
        this.charYaw,
      );
    }
  }

  private updateBuildingPreview(_pick: { target: InteractTarget } | null): void {
    const sel = this.selectedItemId();
    if (!sel || !BUILDING_KINDS.has(sel)) return;
    const ground = this.groundUnderCamera(14);
    if (!ground) return;
    const dx = ground.x - this.controller.pos.x;
    const dz = ground.z - this.controller.pos.z;
    const rot = ((Math.round(Math.atan2(dx, dz) / (Math.PI / 2)) % 4) + 4) % 4;
    const groundY = terrainHeight(ground.x, ground.z);
    const valid =
      validatePlacement(sel as BuildingData['kind'], ground.x, ground.z, groundY, this.world.buildings, this.controller.pos, terrainHeight, SEA_LEVEL) === null &&
      groundY >= SEA_LEVEL;
    // Ghost preview (material swap to red when invalid would need mats; keep default ghost)
    void valid;
    this.renderer.preview(sel as BuildingData['kind'], ground.x, ground.z, groundY, rot);
  }

  private updatePrompt(pick: { target: InteractTarget; distance: number } | null): void {
    if (!pick) {
      this.hud.setPrompt(null);
      return;
    }
    const t = pick.target;
    let text: string | null = null;
    switch (t.kind) {
      case 'node': {
        const node = this.world.node(t.id);
        text = node ? `Houd F — ${KIND_LABEL[node.kind] ?? node.kind} oogsten` : null;
        break;
      }
      case 'npc':
        text = 'Druk E — Gesprek';
        break;
      case 'campfire':
        text = this.inventory.count('wood') > 0 ? 'Druk E — Hout toevoegen (+120s)' : null;
        break;
      case 'water':
        text = this.stats.thirst < 96 ? 'Druk E — Drinken' : null;
        break;
    }
    this.hud.setPrompt(text);
  }

  private nearFire(): boolean {
    const p = this.controller.pos;
    for (const b of this.world.buildings) {
      if (b.kind !== 'campfire' || (b.fuel ?? 0) <= 0) continue;
      if (Math.hypot(b.x - p.x, b.z - p.z) < 6) return true;
    }
    return false;
  }

  private dropSelected(): void {
    const slot = this.inventory.slots[this.inventory.selected];
    if (!slot) return;
    this.inventory.remove(slot.id, 1);
    this.hud.toast(`${ITEMS[slot.id].name} weggegooid`);
    this.refreshHud(true);
  }

  private updateCamera(): void {
    const target = new Vector3(
      this.controller.pos.x,
      this.controller.pos.y + (this.controller.crouching ? 1.2 : 1.55),
      this.controller.pos.z,
    );
    const dist = 5.5;
    const cp = Math.cos(this.camPitch);
    const dir = new Vector3(Math.sin(this.camYaw) * cp, Math.sin(this.camPitch), Math.cos(this.camYaw) * cp);
    const pos = target.subtract(dir.scale(dist));
    const minY = Math.max(terrainHeight(pos.x, pos.z) + 0.5, SEA_LEVEL + 0.25);
    if (pos.y < minY) pos.y = minY;
    this.camera.position.copyFrom(pos);
    this.camera.setTarget(target);
  }

  /** Keep the shadow generator in sync with placed/displaced buildings. */
  private syncBuildingShadows(): void {
    for (const r of this.renderer.getShadowCasters()) {
      if (!this.shadowedBuildings.has(r)) {
        this.lighting.addShadowCaster(r);
        this.shadowedBuildings.add(r);
      }
    }
    for (const r of [...this.shadowedBuildings]) {
      if (r.isDisposed()) {
        this.lighting.removeShadowCaster(r);
        this.shadowedBuildings.delete(r);
      }
    }
  }

  private updateNpcs(dt: number): void {
    for (const npc of this.npcs) {
      npc.update(dt, this.activeNpc === npc);
    }
  }

  private updateRemotes(dt: number): void {
    for (const r of this.remotes.values()) {
      r.mesh.position.x += (r.target.x - r.mesh.position.x) * Math.min(1, 10 * dt);
      r.mesh.position.y += (r.target.y - r.mesh.position.y) * Math.min(1, 10 * dt);
      r.mesh.position.z += (r.target.z - r.mesh.position.z) * Math.min(1, 10 * dt);
    }
  }

  private updateFps(dt: number): void {
    this.fpsFrames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 1) {
      this.hud.setFps(Math.round(this.fpsFrames / this.fpsTime));
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }
  }

  private refreshHud(force: boolean): void {
    void force;
    this.hud.setStats(this.stats.snapshot());
    this.hud.setHotbar(this.inventory.slots.slice(0, 8), this.inventory.selected);
    const can = new Set(RECIPES.filter((r) => Crafting.canCraft(this.inventory, r)).map((r) => r.id));
    this.hud.setCrafting(this.craftingOpen, can);
  }

  dispose(): void {
    window.removeEventListener('beforeunload', () => this.persist());
    this.mp?.disconnect();
    this.input.detach();
    this.character.dispose();
    for (const npc of this.npcs) npc.dispose();
    for (const r of this.remotes.values()) r.mesh.dispose();
    this.lighting.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }
}

/** Shortest-arc angle interpolation. */
function dampAngle(from: number, to: number, dt: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return from + d * Math.min(1, 10 * dt);
}
