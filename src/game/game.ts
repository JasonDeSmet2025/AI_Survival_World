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
import { harvestSeconds, ITEMS, RECIPES, toolForNode, YIELDS } from './core/items';
import { InputController } from './input';
import { Hud } from './hud/hud';
import { MultiplayerClient, type MpMessage, type MpStatus } from './net/mp';
import { PlayerCharacter } from './player/player';
import { PlayerController } from './player/controller';
import { groundHeight } from './player/ground';
import { consumeItem, isConsumable } from './systems/consume';
import { addWood, burnFuel, CAMPFIRE, isLit, justDied, warmthFrom } from './systems/campfire';
import { CookSession, COOK, isCokable } from './systems/cook';
import { CraftSession, Crafting } from './systems/crafting';
import {
  buildingPlacementHeight,
  validatePlacement,
  wallSegment,
  type WallSegment,
} from './systems/building';
import { BuildingRenderer } from './systems/buildingMeshes';
import { raycastTarget, type InteractTarget } from './systems/interact';
import { Inventory, INVENTORY_SIZE, HOTBAR_SIZE, type Slot } from './systems/inventory';
import { Save } from './systems/save';
import { computeRest, type RestResult } from './systems/rest';
import { MAX_LEVEL, Progression, XP_SOURCE, gatherXp, recipeUnlockLevel } from './systems/progress';
import { SurvivalStats } from './systems/stats';
import { computeFallDamage } from './systems/fallDamage';
import { isEffectiveTool, wearTool } from './systems/tools';
import { Lighting } from './visual/lighting';
import { PostFx } from './visual/postfx';
import { attachShaderDiagnostics } from './visual/shaderDiagnostics';
import { createSharedMaterials, type SharedMaterials } from './visual/materials';
import {
  createTerrain,
  findCampPoint,
  findSpawnPoint,
  SEA_LEVEL,
  terrainHeight,
  WORLD_SEED,
  type TerrainHandle,
} from './world/terrain';
import { Atmosphere } from './world/atmosphere';
import { Sky } from './world/sky';
import { Water } from './world/water';
import { populateFlora, type FloraHandle } from './world/flora';
import { SharedWorldState } from './world/worldState';
import { terrainRayHit } from './world/terrainRay';
import type { BuildingData, Collider } from './world/types';

const KIND_LABEL: Record<string, string> = {
  tree: 'Boom',
  pine: 'Dennenboom',
  rock: 'Steen',
  bush: 'Bessenstruik',
};

const BUILDING_KINDS: ReadonlySet<string> = new Set(['campfire', 'wall', 'floor', 'roof', 'bed']);

/** The camera stops this far in front of an occluding surface (world units). */
const CAMERA_SURFACE_OFFSET = 0.35;
/** The camera never comes closer than this to the player (world units). */
const CAMERA_MIN_DIST = 2.0;
/** Keep the third-person view angled down enough to show the ground. */

interface RemotePlayer {
  mesh: Mesh;
  target: Vector3;
}

export class Game {
  private engine: Engine;
  private scene: Scene;
  private camera: FreeCamera;

  private mats: SharedMaterials;
  private terrain: TerrainHandle;
  private sky: Sky;
  private water: Water;
  private atmosphere: Atmosphere;
  private lighting: Lighting;
  private postfx: PostFx;
  private disposeShaderDiagnostics: () => void;
  private world: SharedWorldState;
  private renderer: BuildingRenderer;

  private colliders: Collider[] = [];
  private camp: { x: number; z: number; y: number };

  private controller: PlayerController;
  private character: PlayerCharacter;
  private charYaw = 0;

  private stats = new SurvivalStats();
  private inventory = new Inventory();
  private progress = new Progression();
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
  private camPitch = -0.65;
  private gathering: { id: string; progress: number } | null = null;
  /** Active timed-craft session (transient; never persisted). */
  private craft: CraftSession | null = null;
  /** Active timed-cook session at a campfire (transient; never persisted). */
  private cook: CookSession | null = null;
  /**
   * Active sleep in a bed (transient; never persisted). Cosmetic lie-down /
   * wake-up cycle around a single time jump; the rest result is applied
   * once, at the jump, when the screen is fully dark.
   */
  private sleep: { bed: BuildingData; phase: 'fall' | 'rise'; t: number; result: RestResult } | null = null;
  /** Seconds of screen fade in/out at the edges of a sleep. */
  private static readonly SLEEP_FADE_S = 0.9;
  /** Seconds of each sleep phase (lie down / wake up). */
  private static readonly SLEEP_LIE_S = 1.5;
  private shadowedBuildings = new Set<Mesh>();
  private bushRegrow = new Map<string, number>();
  private craftingOpen = false;
  /** Full inventory panel state (all 24 slots + UI mouse-cursor). */
  private invOpen = false;
  /** Stack currently held by the inventory UI cursor (outside all slots). */
  private invCursor: Slot | null = null;
  /** Slot index the cursor stack was picked up from (for re-placement on close). */
  private invCursorFrom: number | null = null;
  /** Campfires whose "the fire has gone out" toast has already been shown. */
  private fireDiedShown = new Set<string>();
  /** Remaining seconds of the eat animation after a successful consume. */
  private eatT = 0;
  /** Remaining seconds of the landing-dip animation after a fall. */
  private landT = 0;
  /**
   * Current damage-flash intensity (0..1), driven by the frame loop:
   * spikes on a fall impact, holds while deprivation damage is ticking,
   * and decays every frame so the vignette always settles to invisible.
   */
  private hurtT = 0;
  private buildSeq = 0;
  private deathShown = false;
  private wasExhausted = false;
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
    // Any failed shader compilation (terrain/water/vegetation/sky/
    // atmosphere/post-processing) is reported clearly + recorded —
    // otherwise a broken material silently draws nothing and the world
    // degrades to sky+sea (see #26).
    this.disposeShaderDiagnostics = attachShaderDiagnostics(this.engine);
    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0.02, 0.03, 0.06, 1);
    this.scene.fogMode = Scene.FOGMODE_EXP2;
    this.scene.fogDensity = 0.0042;
    this.scene.fogColor = new Color3(0.55, 0.64, 0.74);

    // World
    this.mats = createSharedMaterials(this.scene);
    const terrain = createTerrain(this.scene);
    this.terrain = terrain;
    this.sky = new Sky(this.scene);
    this.water = new Water(this.scene, this.engine);
    // Atmospheric layers: drifting clouds + valley mist (purely visual).
    this.atmosphere = new Atmosphere(this.scene);

    const spawn = findSpawnPoint();
    this.camp = findCampPoint(spawn);

    // Camera + lighting (post-processing and IBL run from the lighting module).
    this.camera = new FreeCamera('cam', new Vector3(spawn.x, spawn.y + 4, spawn.z + 8), this.scene);
    this.camera.ellipsoid = new Vector3(0.4, 0.8, 0.4);
    this.lighting = new Lighting(this.scene, this.sky, this.water, terrain.material);
    // Camera post chain: bloom + underwater tint (visual/postfx.ts).
    this.postfx = new PostFx(this.scene, this.camera);

    // Shared world state + flora
    this.world = new SharedWorldState();
    const keepOut = [
      { x: spawn.x, z: spawn.z, r: 5 },
      { x: this.camp.x, z: this.camp.z, r: 8 },
    ];
    this.floraHandle = populateFlora(this.scene, this.mats, this.world, this.colliders, keepOut);
    // The flora wind shader gets the same live sun/ambient values as the
    // terrain shader (Lighting drives both from the day cycle).
    this.lighting.addShaderMaterial(this.floraHandle.material);
    // Flora chunk meshes cast sun shadows (terrain + water receive them —
    // see visual/shadowReceiver.ts); the frame loop keeps the generator's
    // caster list in sync with the LOD state + shadow radius via
    // syncFloraShadowCasters() (and again after every re-bake in
    // floraRefresh()).
    this.syncFloraShadowCasters(this.camera.position.x, this.camera.position.z);

    // Camp fire so the NPCs have a fire to sit by (decorative, always lit)
    this.world.addBuilding({
      id: 'camp_fire',
      kind: 'campfire',
      x: this.camp.x,
      z: this.camp.z,
      y: groundHeight(this.camp.x, this.camp.z),
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
      this.inventory.add('berry', 3);
    }

    this.refreshHud(true);
    this.scene.onBeforeRenderObservable.add(() => this.frame(this.engine.getDeltaTime() / 1000));

    // Start Babylon.js rendering and game updates.
    this.engine.runRenderLoop(() => {
      this.scene.render();
    });

    window.addEventListener('beforeunload', () => this.persist());

    // QA hook: browser-based QA scripts (headless screenshots, state
    // probes) access the live instance through window.__game. The engine
    // render loop + game frame() are driven via public Babylon APIs from
    // those scripts (stopRenderLoop / onBeforeRenderObservable / manual
    // scene.render), so this hook does not change game behaviour.
    (window as unknown as { __game?: Game }).__game = this;
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
    this.camPitch = Math.min(data.pitch, -0.65);
    this.lighting.setTimeOfDay(data.elapsed);
    this.world.apply(data.world, data.world.seed || WORLD_SEED);
    if (data.progress) this.progress.restore(data.progress);
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
    // A stack held by the inventory UI cursor is not in any slot yet; put
    // it back temporarily so the save never loses it. `place()` swaps the
    // cursor stack with whatever sits in the origin slot (or merges into
    // it, returning overflow) — the return value carries the displaced
    // stack, so the operation is reversible with one more place()/pickUp()
    // after the write. Discarding it would silently lose items.
    let cursorFrom: number | null = null;
    if (this.invCursor && this.invCursorFrom !== null) {
      cursorFrom = this.invCursorFrom;
      this.invCursor = this.inventory.place(this.invCursorFrom, this.invCursor);
      this.invCursorFrom = null;
    }
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
      this.progress.snapshot(),
    );
    data.npcs = {};
    for (const [id, conv] of this.conversations) data.npcs[id] = conv.serialize();
    Save.write(data);
    if (cursorFrom !== null) {
      if (this.invCursor) {
        // Swap/overflow case: put the temporarily displaced stack back;
        // the origin slot's content returns to the cursor.
        this.invCursor = this.inventory.place(cursorFrom, this.invCursor);
      } else {
        // Plain pick-up case (origin slot was empty): pick the stack up
        // again exactly as before.
        this.invCursor = this.inventory.pickUp(cursorFrom);
      }
      this.invCursorFrom = cursorFrom;
    }
  }

  private floraRefresh(): void {
    // Re-apply depleted visuals (re-bakes only the changed chunks), then
    // re-sync the shadow casters: chunk meshes are re-created on re-bake,
    // so the lighting generator must swap them in (old meshes disposed).
    this.floraHandle?.applyState();
    this.syncFloraShadowCasters(this.camera.position.x, this.camera.position.z);
  }

  private floraHandle: FloraHandle | null = null;
  /** Chunk batch meshes currently registered as shadow casters. */
  private floraShadowMeshes = new Set<Mesh>();

  /**
   * Diff the registered flora shadow casters against the handle's proximity
   * list (FLORA_SHADOW_RADIUS around the camera + currently-enabled LOD
   * mesh per chunk). v9.33 has no bounding-box caster culling in the
   * shadow pass, so chunks that cannot fall inside the ~130 u shadow
   * frustum are never registered — the shadow pass skips their geometry
   * entirely instead of vertex-shading it and clipping it in the GPU.
   */
  private syncFloraShadowCasters(px: number, pz: number): void {
    if (!this.floraHandle) return;
    const live = this.floraHandle.shadowCasters(px, pz);
    const liveSet = new Set(live);
    for (const mesh of [...this.floraShadowMeshes]) {
      if (!liveSet.has(mesh)) {
        this.lighting.removeShadowCaster(mesh);
        this.floraShadowMeshes.delete(mesh);
      }
    }
    for (const mesh of live) {
      if (!this.floraShadowMeshes.has(mesh)) {
        this.lighting.addShadowCaster(mesh);
        this.floraShadowMeshes.add(mesh);
      }
    }
  }

  // ------------------------------------------------------------------
  // HUD events
  // ------------------------------------------------------------------

  private bindHudEvents(): void {
    window.addEventListener('hud-hotbar-click', (e: Event) => {
      this.inventory.select((e as CustomEvent<number>).detail);
      this.refreshHud(true);
    });
    window.addEventListener('hud-craft-click', (e: Event) => this.doCraft((e as CustomEvent<string>).detail));
    window.addEventListener('hud-inv-slot-click', (e: Event) => this.handleInvSlotClick((e as CustomEvent<number>).detail));
    window.addEventListener('hud-chat-send', (e: Event) => void this.sendChat((e as CustomEvent<string>).detail));
    window.addEventListener('hud-chat-close', () => this.closeChat());
  }

  private doCraft(recipeId: string): void {
    if (this.stats.dead) return;
    // Only one work session at a time; B/Esc cancels the active one.
    if (this.craft || this.cook) {
      this.hud.toast('Nog bezig — B of Esc om af te breken');
      return;
    }
    const recipe = RECIPES.find((r) => r.id === recipeId);
    if (!recipe) {
      this.hud.toast('Onbekend recept');
      return;
    }
    if (!Crafting.isUnlocked(recipe, this.progress.level)) {
      this.hud.toast(`Vergrend — vereist level ${recipeUnlockLevel(recipe)}`);
      return;
    }
    const session = CraftSession.start(this.inventory, recipeId, this.progress.level);
    if (!session) {
      this.hud.toast('Niet genoeg materialen');
      return;
    }
    this.craft = session;
    this.hud.toast(`Maken: ${ITEMS[session.recipe.output.id].name} (${session.duration}s) — B/Esc om af te breken`);
    this.refreshHud(true);
  }

  /** Cancel the active craft: inputs were never consumed, so nothing is lost. */
  private cancelCraft(reason: string): void {
    if (!this.craft) return;
    this.craft = null;
    this.hud.setProgress(null);
    this.hud.toast(reason);
    this.refreshHud(true);
  }

  /** Cancel the active cook: the raw item was never consumed, so nothing is lost. */
  private cancelCook(reason: string): void {
    if (!this.cook) return;
    this.cook = null;
    this.hud.setProgress(null);
    this.hud.toast(reason);
    this.refreshHud(true);
  }

  // ------------------------------------------------------------------
  // Inventory UI (full 24-slot panel, key I)
  // ------------------------------------------------------------------

  private toggleInventory(): void {
    if (this.invOpen) {
      this.closeInventory();
    } else {
      this.invOpen = true;
      // Release the mouse so the panel can be clicked; a canvas click
      // re-locks the pointer for free-look.
      if (document.pointerLockElement) document.exitPointerLock();
      this.hud.setPrompt(null);
      this.refreshHud(true);
    }
  }

  private closeInventory(): void {
    // Anything still on the cursor goes back to where it was picked up
    // (that slot was emptied on pickup, so the place normally fits).
    if (this.invCursor && this.invCursorFrom !== null) {
      if (this.inventory.slots[this.invCursorFrom] === null) {
        this.inventory.place(this.invCursorFrom, this.invCursor);
      } else {
        // The origin slot was refilled while the panel was open (gathering
        // or a finished craft landed there): placing into it would SWAP and
        // the displaced stack would be lost. Stash the cursor stack into
        // any free slot instead — one is guaranteed to exist (the pickup
        // emptied a slot, and only empty slots can fill while the panel is
        // open, so the inventory can never be completely full here).
        const free = this.inventory.slots.findIndex((s) => s === null);
        if (free !== -1) this.inventory.place(free, this.invCursor);
      }
    }
    this.invCursor = null;
    this.invCursorFrom = null;
    this.invOpen = false;
    this.refreshHud(true);
  }

  private handleInvSlotClick(index: number): void {
    if (!this.invOpen || this.stats.dead) return;
    if (this.invCursor) {
      // Down: place / merge / swap (returns the leftover or displaced stack).
      const leftover = this.inventory.place(index, this.invCursor);
      this.invCursor = leftover;
      this.invCursorFrom = leftover ? index : null;
    } else {
      const picked = this.inventory.pickUp(index);
      if (picked) {
        this.invCursor = picked;
        this.invCursorFrom = index;
      } else if (index < HOTBAR_SIZE) {
        // Clicking an empty hotbar slot moves the selection there.
        this.inventory.select(index);
      }
    }
    this.refreshHud(true);
  }

  /** Drop one unit from the stack held by the inventory cursor. */
  private dropFromCursor(): void {
    const c = this.invCursor;
    if (!c) return;
    c.count -= 1;
    if (c.count <= 0) {
      this.invCursor = null;
      this.invCursorFrom = null;
    }
    this.hud.toast(`${ITEMS[c.id].name} weggegooid`);
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
      `uur ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}, niveau ${this.progress.level}. ` +
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
      } else if (b.kind === 'bed') {
        targets.push({ kind: 'bed', id: b.id, x: b.x, y: b.y + 0.6, z: b.z, radius: 1.4 });
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
        const b = this.world.buildings.find((x) => x.id === target.id);
        if (!b) return;
        // Cooking: a cookable item selected in the hotbar, a lit fire and
        // close enough (the interaction prompt only offers this when all
        // three hold). The raw item is consumed only when the cook
        // completes, so cancelling loses nothing.
        // Cooking only when the fire is LIT (matches updatePrompt, which
        // falls back to the add-wood prompt for a dead fire — the wood then
        // re-lights the fire instead of failing on a dead fire).
        const sel = this.selectedItemId();
        if (isLit(b.fuel) && isCokable(sel) && this.inventory.count(sel) > 0 && this.fireDistance(b) <= COOK.radius) {
          const session = CookSession.start(sel, this.inventory, { id: b.id, fuel: b.fuel });
          if (session) {
            this.cook = session;
            this.hud.toast(
              `Koken: ${ITEMS[session.outputId].name} (${Math.round(session.duration)}s) — B/Esc om af te breken`,
            );
            this.refreshHud(true);
            return;
          }
        }
        if (this.inventory.count('wood') <= 0) {
          this.hud.toast('Geen hout voor het vuur');
          return;
        }
        this.inventory.remove('wood', 1);
        b.fuel = addWood(b.fuel);
        // The added log re-lights a dead fire as well.
        this.fireDiedShown.delete(b.id);
        this.renderer.setFireState(b.id, b.fuel, 0);
        this.hud.toast(`Hout toegevoegd (+${CAMPFIRE.fuelPerWood}s)`);
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
      case 'bed': {
        const b = this.world.buildings.find((x) => x.id === target.id);
        if (b) this.startSleep(b);
        break;
      }
      default:
        break;
    }
  }

  private tryPlaceBuilding(kind: BuildingData['kind']): void {
    const ground = this.groundUnderCamera(14);
    if (!ground) {
      this.hud.toast('Richt je blik op de grond om te bouwen');
      return;
    }
    const dx = ground.x - this.controller.pos.x;
    const dz = ground.z - this.controller.pos.z;
    const rot = ((Math.round(Math.atan2(dx, dz) / (Math.PI / 2)) % 4) + 4) % 4;
    // Mesh-exact ground: the building must sit where the player's feet are,
    // not on the (coarser) analytic height curve — that mismatch is what
    // made placed structures float or sink on slopes.
    const centerY = groundHeight(ground.x, ground.z);
    const groundY = buildingPlacementHeight(kind, ground.x, ground.z, rot, groundHeight);
    const placementError = validatePlacement(
      kind, ground.x, ground.z, centerY,
      this.world.buildings, this.controller.pos, groundHeight, SEA_LEVEL,
    );
    if (placementError) {
      this.hud.toast(placementError === 'cannot build underwater' ? 'Hier staat water' : 'Hier past het niet');
      return;
    }
    if (centerY < SEA_LEVEL) {
      this.hud.toast('Hier staat water');
      return;
    }
    if (this.inventory.remove(kind, 1) === 1) {
      const b: BuildingData = {
        id: `b_${this.localId}_${++this.buildSeq}`,
        kind,
        x: ground.x,
        z: ground.z,
        y: groundY,
        rot,
        ownerId: this.localId,
        fuel: kind === 'campfire' ? CAMPFIRE.initialFuel : undefined,
      };
      this.world.addBuilding(b);
      this.renderer.sync(this.world.buildings);
      this.renderer.clearPreview();
      this.mp?.sendPlace(b.kind, b.x, b.z, b.y, b.rot, b.id);
      this.hud.toast('Gebouwd');
      // Progression: placing a structure pays XP.
      this.grantXp(XP_SOURCE.build);
    } else {
      this.hud.toast('Je hebt dit bouwmateriaal niet meer');
    }
  }

  private groundUnderCamera(maxRange: number): { x: number; z: number } | null {
    const cam = this.camera.position;
    const dir = this.camera.getForwardRay().direction;
    const hit = terrainRayHit(cam.x, cam.y, cam.z, dir.x, dir.y, dir.z, maxRange);
    return hit ? { x: hit.x, z: hit.z } : null;
  }

  // ------------------------------------------------------------------
  // Gathering
  // ------------------------------------------------------------------

  private updateGathering(dt: number, target: { target: InteractTarget; distance: number } | null): void {
    // The player stands still and works while a craft or cook is in progress.
    if (this.craft || this.cook) {
      if (this.gathering) this.gathering = null;
      return;
    }
    // While the inventory panel is open no slot may change underneath the
    // UI cursor: a gathered stack landing in the cursor's origin slot would
    // make the held stack unplaceable when the panel closes (silent item
    // loss). Gathering pauses for the duration the panel is open.
    if (this.invOpen) {
      if (this.gathering) this.gathering = null;
      this.hud.setProgress(null);
      return;
    }
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
    // Tool wear: only the tool that works on this node kind wears down,
    // and only while it is actually in use. A broken tool empties its
    // slot, so the very next frame falls back to bare-hand speed and
    // the +1 bonus stops automatically.
    if (isEffectiveTool(tool, node.kind)) {
      const wear = wearTool(this.inventory, this.inventory.selected, dt);
      if (wear.broke && wear.itemId) {
        this.hud.toast(`${ITEMS[wear.itemId].name} is kapot!`);
        this.refreshHud(true);
      }
    }
    this.hud.setProgress(Math.min(1, g.progress));
    if (g.progress >= 1) {
      this.gathering = null;
      this.hud.setProgress(null);
      const yieldDef = YIELDS[node.kind];
      if (!yieldDef) return;
      // The effective tool grants a +1 bonus item (toolForNode is the
      // single source of truth, shared with harvest speed and wear).
      const bonus = toolForNode(node.kind) === tool ? 1 : 0;
      const amount = yieldDef.min + Math.floor(Math.random() * (yieldDef.max - yieldDef.min + 1)) + bonus;
      this.inventory.add(yieldDef.itemId, amount);
      this.hud.toast(`+${amount} ${ITEMS[yieldDef.itemId].name}`);
      // Progression: gathering pays XP per node kind.
      this.grantXp(gatherXp(node.kind));
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

  /**
   * Grant XP from a gameplay action and announce level-ups. Level-ups list
   * the newly unlocked recipes so the player knows what the level earned.
   */
  private grantXp(amount: number): void {
    if (amount <= 0) return;
    const report = this.progress.addXp(amount);
    if (report.levelsGained <= 0) return;
    const unlocks = report.unlocked.map((id) => Crafting.recipeName(id));
    if (report.reachedMax) {
      this.hud.toast(`Max level ${MAX_LEVEL} bereikt!`);
    } else {
      this.hud.toast(
        unlocks.length
          ? `Nieuw level ${this.progress.level}! Ontgrendeld: ${unlocks.join(', ')}`
          : `Nieuw level ${this.progress.level}!`,
      );
    }
    this.refreshHud(true);
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
  // Sleep / rest (beds)
  // ------------------------------------------------------------------

  /**
   * Begin sleeping in a bed: fade to black, jump the clock to morning and
   * apply the precomputed rest result. Esc cancels before the jump; after
   * the jump there is no going back (the night is over).
   */
  private startSleep(bed: BuildingData): void {
    if (this.stats.dead || this.sleep || this.craft || this.cook) return;
    if (this.controller.inWater) {
      this.hud.toast('Hier slapen kan niet');
      return;
    }
    // Sleeping locks the controller; starting a fall mid-air would freeze
    // the player hanging in the bed. Only grounded players may sleep.
    if (!this.controller.onGround) return;
    if (this.invOpen) this.closeInventory();
    if (this.activeNpc) this.closeChat();
    this.gathering = null;
    this.hud.setProgress(null);
    this.sleep = {
      bed,
      phase: 'fall',
      t: 0,
      // Precomputed so a fatal rest is known before the fade completes.
      result: computeRest({
        timeOfDay: this.lighting.timeOfDay,
        health: this.stats.health,
        hunger: this.stats.hunger,
        thirst: this.stats.thirst,
      }),
    };
  }

  /** Advance the sleep state machine (lie down → time jump → wake up). */
  private updateSleep(dt: number): void {
    const s = this.sleep;
    if (!s) return;
    s.t += dt;

    if (s.phase === 'fall' && this.input.consumePress('Escape')) {
      this.sleep = null;
      this.hud.setSleepFade(0);
      this.hud.toast('Wederom wakker');
      this.refreshHud(true);
      return;
    }

    if (s.phase === 'fall') {
      this.hud.setSleepFade(Math.min(1, s.t / Game.SLEEP_FADE_S));
      if (s.t >= Game.SLEEP_LIE_S) {
        // The screen is fully dark: jump the clock and apply the rest.
        this.lighting.setTimeOfDay(s.result.wakeTime);
        this.stats.applyRest(s.result);
        // Progression: surviving a full night pays XP (fatal rests don't).
        if (!s.result.died) this.grantXp(XP_SOURCE.sleep);
        this.refreshHud(true); // bars must already be correct when the screen fades back in
        if (s.result.died) {
          this.sleep = null;
          this.hud.setSleepFade(0);
          this.deathShown = true;
          this.hud.showDeath(true);
          this.closeChat();
          return;
        }
        s.phase = 'rise';
        s.t = 0;
      }
    } else {
      const k = Math.min(1, s.t / Game.SLEEP_FADE_S);
      this.hud.setSleepFade(1 - k);
      if (s.t >= Game.SLEEP_LIE_S) {
        this.sleep = null;
        this.hud.setSleepFade(0);
        this.hud.toast("Wakker — het is 's ochtends");
        this.refreshHud(true);
        return;
      }
    }

    // The character lies on the bed for the whole sleep: feet at the foot
    // end (local +Z), body along the bed's long axis, lying on the back.
    // The lying body's centre line sits at the root height; placing the
    // root just above the mattress top keeps the body resting on the bed
    // (back ~3 cm into the mattress, head cradled in the pillow).
    const bed = s.bed;
    const yaw = (bed.rot / 4) * Math.PI * 2;
    const feetX = bed.x + Math.sin(yaw) * 0.5;
    const feetZ = bed.z + Math.cos(yaw) * 0.5;
    this.character.root.position.set(feetX, bed.y + 0.78, feetZ);
    this.character.root.rotation.y = yaw;
    this.character.update(dt, 0, true, false, false, false, false, false, true);
    this.hud.setPrompt(s.phase === 'fall' ? "Slaapt… (Esc om wakker te worden)" : 'Slaapt…');
  }

  // ------------------------------------------------------------------
  // Death / respawn
  // ------------------------------------------------------------------

  private respawn(): void {
    this.sleep = null;
    this.cook = null;
    this.hud.setProgress(null);
    this.hud.setSleepFade(0);
    this.stats.respawn();
    this.inventory.applyDeathPenalty();
    const p = groundHeight(this.camp.x, this.camp.z);
    this.controller.respawn(this.camp.x, p, this.camp.z);
    this.deathShown = false;
    this.wasExhausted = false;
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
    this.atmosphere.update(dt, this.lighting.dayFactor);
    this.postfx.update(dt);

    const dead = this.stats.dead;

    // Campfire fuel: burn down player fires in real time (also while the
    // death overlay is up — the world keeps going) and push the new state
    // to the renderer (light flicker, particles, embers). The world's
    // camp fire (ownerId 'world') is the always-lit fire the NPCs sit by:
    // it still flickers but never burns fuel.
    for (const b of this.world.buildings) {
      if (b.kind !== 'campfire') continue;
      const prev = b.fuel ?? 0;
      const next = b.ownerId === 'world' ? prev : burnFuel(prev, dt);
      b.fuel = next;
      this.renderer.setFireState(b.id, next, dt);
      if (b.ownerId !== 'world' && justDied(prev, next) && !this.fireDiedShown.has(b.id)) {
        this.fireDiedShown.add(b.id);
        this.hud.toast('Het kampvuur is gedoofd');
      }
    }

    // Mouse look
    if (this.input.pointerLocked && !dead) {
      const m = this.input.consumeMouseDelta();
      this.camYaw += m.x * 0.0022;
      this.camPitch = Math.max(-1.15, Math.min(1.25, this.camPitch - m.y * 0.0022));
    } else {
      this.input.consumeMouseDelta();
    }

    if (!dead) {
      if (this.sleep) {
        // Sleeping in a bed: the player is locked to the bed, the clock is
        // frozen until the jump (fires keep burning in real time).
        this.updateSleep(dt);
      } else {
      // Timed crafting: advance the active session, mirror progress to the
      // HUD and settle the result. Inputs are consumed only on completion,
      // so a cancelled or dead-interrupted craft loses nothing.
      if (this.craft) {
        const result = this.craft.tick(this.inventory, dt);
        if (result === 'crafting') {
          this.hud.setProgress(this.craft.progress);
        } else {
          const recipe = this.craft.recipe;
          this.craft = null;
          this.hud.setProgress(null);
          if (result === 'done') {
            this.hud.toast(`Gemaakt: ${ITEMS[recipe.output.id].name} x${recipe.output.count}`);
            // Progression: a completed craft pays XP.
            this.grantXp(XP_SOURCE.craft);
          }
          this.refreshHud(true);
        }
      }

      // Timed cooking: advance the active cook next to its fire (the fuel
      // tick above already advanced it this frame), mirror progress and
      // settle. The raw item is consumed only on completion; a fire that
      // goes out mid-cook cancels the session without losing the item.
      if (this.cook) {
        const fire = this.world.buildings.find((x) => x.id === this.cook!.fireId);
        const result = this.cook.tick(this.inventory, fire?.fuel, dt);
        if (result === 'cooking') {
          this.hud.setProgress(this.cook.progress);
        } else {
          this.cook = null;
          this.hud.setProgress(null);
          if (result === 'done') {
            this.hud.toast('Gekookt');
            // Progression: a completed cook pays XP.
            this.grantXp(XP_SOURCE.cook);
          } else {
            this.hud.toast('Het vuur is gedoofd — koken afgebroken');
          }
          this.refreshHud(true);
        }
      }

      // Player physics (movement locked while crafting — standing still).
      const walls: WallSegment[] = this.world.buildings
        .filter((b) => b.kind === 'wall')
        .map(wallSegment);
      this.controller.crouching = this.input.crouch;
      this.controller.update(dt, this.input, this.camYaw, this.colliders, this.stats.canSprint(), walls, !(this.craft || this.cook));

      // Fall impact: the controller reports each solid landing after a
      // genuine airborne fall (water landings are absorbed, no event).
      // Fall damage is local per player; no MP protocol change needed.
      const impact = this.controller.consumeImpact();
      if (impact) {
        const fall = computeFallDamage(impact.distance, impact.crouching);
        if (fall > 0) {
          this.stats.takeDamage(fall);
          this.hurtT = 1;
          this.hud.toast(fall >= 30 ? `Zware val! (−${Math.round(fall)} gezondheid)` : `Hard geland (−${Math.round(fall)} gezondheid)`);
        }
        // Landing dip: only for drops the eye actually notices (~0.8 m+).
        if (impact.distance > 0.8) this.landT = 0.3;
      }
      this.landT = Math.max(0, this.landT - dt);

      // Underwater tint follows the physics body (feet below sea level).
      this.postfx.setUnderwater(this.controller.inWater ? SEA_LEVEL - this.controller.pos.y : 0);

      // Character follows physics body
      this.character.root.position.copyFrom(this.controller.pos);
      if (this.controller.speed > 0.5) {
        this.charYaw = dampAngle(this.charYaw, this.controller.moveDir, dt);
      }
      this.character.setFacing(this.charYaw);
      // Hand tool + harvest animation.
      this.character.setTool(this.selectedItemId());
      // Eat animation timer (decays after a successful consume).
      this.eatT = Math.max(0, this.eatT - dt);
      this.character.update(
        dt,
        this.controller.speed,
        this.controller.onGround,
        this.controller.inWater,
        this.controller.crouching,
        this.input.harvest && this.gathering !== null,
        this.eatT > 0,
        this.craft !== null,
        false,
        this.landT > 0,
        this.cook !== null,
      );

      // Survival. `sprinting` is the controller's actual sprint state
      // (Shift + moving + gate passed + not swimming/crouched), so holding
      // Shift while sprint is blocked can no longer drain stamina/cals.
      const env = {
        dayFactor: this.lighting.dayFactor,
        inWater: this.controller.inWater,
        fireWarmth: this.fireWarmth(),
        sprinting: this.controller.sprinting,
      };
      const tickDamage = this.stats.update(dt, env);
      // One-time exhaustion feedback.
      if (this.stats.exhausted && !this.wasExhausted) {
        this.wasExhausted = true;
        this.hud.toast('Uitgeput — even rusten voordat je kunt sprinten');
      }
      if (!this.stats.exhausted) this.wasExhausted = false;

      // Damage vignette: hold a low glow while deprivation (starve /
      // dehydrate / freeze / heat) is ticking, spike to full on impact,
      // and decay every frame so the overlay always settles to invisible.
      if (tickDamage > 0) this.hurtT = Math.max(this.hurtT, 0.5);
      this.hurtT = Math.max(0, this.hurtT - dt * 2.2);
      this.hud.setDamageFlash(this.hurtT);

      // Gathering + interact
      const pick = this.pickInteract();
      this.updateGathering(dt, pick);
      this.updateBushRegrowth();
      this.updateBuildingPreview(pick);
      // The interaction prompt is hidden while the inventory is open.
      if (this.invOpen) this.hud.setPrompt(null);
      else this.updatePrompt(pick);

      // One-press actions. While a timed craft or cook is running the
      // player stands still and works: only B (cancel) and Esc (cancel)
      // are honoured, everything else is ignored.
      if (this.craft || this.cook) {
        if (this.input.consumePress('KeyB') || this.input.consumePress('Escape')) {
          if (this.craft) this.cancelCraft('Afgebroken');
          else this.cancelCook('Afgebroken');
          this.craftingOpen = false;
          this.refreshHud(true);
        }
      } else {
        // E/R mutate the inventory (add wood, drink, eat) — while the panel
        // is open the player is managing items blind (no prompt shown), so
        // those are ignored; I/Esc still close it. B also stays closed while
        // the panel is open (one Esc should always close exactly one layer).
        if (!this.invOpen && this.input.consumePress('KeyE')) this.handleEPress(pick?.target ?? null);
        if (!this.invOpen && this.input.consumePress('KeyB')) {
          this.craftingOpen = !this.craftingOpen;
          this.refreshHud(true);
        }
        if (this.input.consumePress('KeyQ')) {
          // While the inventory is open, Q drops from the UI cursor.
          if (this.invOpen && this.invCursor) this.dropFromCursor();
          else if (!this.invOpen) this.dropSelected();
        }
        if (this.input.consumePress('KeyI') || (this.invOpen && this.input.consumePress('Escape'))) {
          this.toggleInventory();
        }
        if (!this.invOpen && this.input.consumePress('KeyR')) this.tryConsume();
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

      // Death (interrupts any in-progress craft or cook without losing
      // materials)
      if (this.stats.dead && !this.deathShown) {
        this.deathShown = true;
        if (this.craft) {
          this.craft = null;
          this.hud.setProgress(null);
        }
        if (this.cook) {
          this.cook = null;
          this.hud.setProgress(null);
        }
        if (this.invOpen) this.closeInventory();
        this.hud.showDeath(true);
        this.closeChat();
      }
      }
    }

    this.updateCamera();
    // Terrain distance LOD: per-chunk detail swap with hysteresis (cheap O(chunks)).
    this.terrain.updateLod(this.camera.position);
    // Flora distance LOD: per-chunk detail swap with hysteresis (cheap O(chunks)).
    this.floraHandle?.updateLod(this.camera.position);
    // Flora wind: advance the shared wind clock + push uniforms (1 frame).
    this.floraHandle?.updateWind(dt);
    // Shadow-caster proximity culling: only chunks that can intersect the
    // ~130 u shadow frustum are registered as casters (O(chunks) diff).
    this.syncFloraShadowCasters(this.camera.position.x, this.camera.position.z);
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
    if (!sel || !BUILDING_KINDS.has(sel)) {
      this.renderer.clearPreview();
      return;
    }
    const ground = this.groundUnderCamera(14);
    if (!ground) {
      this.renderer.clearPreview();
      return;
    }
    const dx = ground.x - this.controller.pos.x;
    const dz = ground.z - this.controller.pos.z;
    const rot = ((Math.round(Math.atan2(dx, dz) / (Math.PI / 2)) % 4) + 4) % 4;
    const centerY = groundHeight(ground.x, ground.z);
    const groundY = buildingPlacementHeight(sel as BuildingData['kind'], ground.x, ground.z, rot, groundHeight);
    const valid = validatePlacement(
      sel as BuildingData['kind'],
      ground.x,
      ground.z,
      centerY,
      this.world.buildings,
      this.controller.pos,
      groundHeight,
      SEA_LEVEL,
    ) === null && groundY >= SEA_LEVEL;
    this.renderer.setPreviewValid(valid);
    this.renderer.preview(sel as BuildingData['kind'], ground.x, ground.z, groundY, rot);
  }

  private updatePrompt(pick: { target: InteractTarget; distance: number } | null): void {
    if (this.craft) {
      this.hud.setPrompt(`Bezig met maken: ${Crafting.recipeName(this.craft.recipe.id)} — B/Esc om af te breken`);
      return;
    }
    if (this.cook) {
      this.hud.setPrompt(`Bezig met koken: ${ITEMS[this.cook.itemId].name} — B/Esc om af te breken`);
      return;
    }
    let text: string | null = null;
    if (pick) {
      const t = pick.target;
      switch (t.kind) {
        case 'node': {
          const node = this.world.node(t.id);
          text = node ? `Houd F — ${KIND_LABEL[node.kind] ?? node.kind} oogsten` : null;
          break;
        }
        case 'npc':
          text = 'Druk E — Gesprek';
          break;
        case 'campfire': {
          const b = this.world.buildings.find((x) => x.id === t.id);
          const fuel = b?.fuel ?? 0;
          // Cooking takes priority over adding wood in the prompt: it is
          // only offered when a cookable item is selected, the fire is lit
          // and the player stands close enough.
          const sel = this.selectedItemId();
          if (
            b !== undefined &&
            isLit(fuel) &&
            isCokable(sel) &&
            this.inventory.count(sel) > 0 &&
            this.fireDistance(b) <= COOK.radius
          ) {
            text = `Druk E — ${ITEMS[sel].name} koken (${ITEMS[sel].cookable?.seconds ?? 0}s)`;
            if (b.ownerId !== 'world' && fuel > 0) {
              text += ` · nog ${Math.floor(fuel / 60)} min`;
            }
            break;
          }
          if (b?.ownerId === 'world') {
            // The camp's fire is always lit; it has no fuel meter.
            text = 'Het kampvuur brandt';
          } else if (fuel <= 0) {
            text = this.inventory.count('wood') > 0 ? 'Druk E — Hout toevoegen (ontsteken)' : 'Het vuur is gedoofd — je hebt hout nodig';
          } else {
            const min = Math.floor(fuel / 60);
            text = this.inventory.count('wood') > 0
              ? `Druk E — Hout toevoegen (+${Math.round(CAMPFIRE.fuelPerWood / 60)} min) · nog ${min} min`
              : `Het vuur houdt nog ${min} min`; }
          break;
        }
        case 'water':
          text = this.stats.thirst < 96 ? 'Druk E — Drinken' : null;
          break;
        case 'bed':
          text = "Druk E — Slapen tot 's ochtends";
          break;
      }
    }
    // Fallback hint: a consumable in the selected slot can always be used.
    if (text === null) {
      const sel = this.selectedItemId();
      if (isConsumable(sel)) text = `Druk R — ${ITEMS[sel].name} eten`;
    }
    this.hud.setPrompt(text);
  }

  /** Use (eat/drink) the consumable in the selected hotbar slot. */
  private tryConsume(): void {
    const itemId = this.selectedItemId();
    if (!itemId) return;
    const result = consumeItem(itemId, this.inventory, this.stats);
    if (result.ok) {
      this.eatT = 0.7;
      this.hud.toast(result.message);
      this.refreshHud(true);
    } else {
      this.hud.toast(isConsumable(itemId) ? 'Geen voorraad' : 'Dit kan je niet eten');
    }
  }

  /** Horizontal distance (metres) from the player's feet to a fire. */
  private fireDistance(fire: BuildingData): number {
    const p = this.controller.pos;
    return Math.hypot(fire.x - p.x, fire.z - p.z);
  }

  /**
   * Combined warmth target (°C) from every lit player fire at the player's
   * position. The world camp fire is always lit and counts too.
   */
  private fireWarmth(): number {
    const p = this.controller.pos;
    return warmthFrom(
      this.world.buildings
        .filter((b) => b.kind === 'campfire')
        .map((b) => ({ fuel: b.fuel, x: b.x, z: b.z })),
      p.x,
      p.z,
    );
  }

  private dropSelected(): void {
    const slot = this.inventory.slots[this.inventory.selected];
    if (!slot) return;
    this.inventory.remove(slot.id, 1);
    this.hud.toast(`${ITEMS[slot.id].name} weggegooid`);
    this.refreshHud(true);
  }

  private updateCamera(): void {
    const target = this.sleep
      ? new Vector3(this.sleep.bed.x, this.sleep.bed.y + 0.9, this.sleep.bed.z)
      : new Vector3(
          this.controller.pos.x,
          this.controller.pos.y + (this.controller.crouching ? 0.8 : 1.0),
          this.controller.pos.z,
        );
    const dist = 5.5;
    const cp = Math.cos(this.camPitch);
    const dir = new Vector3(Math.sin(this.camYaw) * cp, Math.sin(this.camPitch), Math.cos(this.camYaw) * cp);

    // Terrain occlusion: cast the look ray from the player TOWARD the camera
    // against the rendered mesh. When a hill sits between them, pull the
    // camera in to just in front of the surface so the player never looks
    // through terrain (a plain min-height clamp at the camera position can
    // still let the sightline dip under a slope).
    let effDist = dist;
    const hit = terrainRayHit(target.x, target.y, target.z, -dir.x, -dir.y, -dir.z, dist);
    if (hit && hit.t < dist) {
      effDist = Math.max(CAMERA_MIN_DIST, hit.t - CAMERA_SURFACE_OFFSET);
    }

    let px = target.x - dir.x * effDist;
    let py = target.y - dir.y * effDist;
    let pz = target.z - dir.z * effDist;

    // Final safety net: keep the camera above the RENDERED mesh height
    // (triangulated), not the analytic curve, so it never dips under the
    // ground the player can see.
    const minY = Math.max(groundHeight(px, pz) + 0.5, SEA_LEVEL + 0.25);
    if (py < minY) py = minY;

    this.camera.position.set(px, py, pz);
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
    this.hud.setLevel(this.progress.level, this.progress.fraction);
    this.hud.setInventory(
      this.invOpen,
      this.inventory.slots.slice(0, INVENTORY_SIZE),
      this.inventory.selected,
      this.invCursor,
    );
    const can = new Set(RECIPES.filter((r) => Crafting.canCraft(this.inventory, r, this.progress.level)).map((r) => r.id));
    this.hud.setCrafting(this.craftingOpen, can, this.craft ? this.craft.recipe.id : null, this.progress.level);
  }

  dispose(): void {
    window.removeEventListener('beforeunload', () => this.persist());
    this.mp?.disconnect();
    this.input.detach();
    this.character.dispose();
    for (const npc of this.npcs) npc.dispose();
    for (const r of this.remotes.values()) r.mesh.dispose();
    this.atmosphere.dispose();
    this.postfx.dispose();
    this.disposeShaderDiagnostics();
    this.terrain.dispose();
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
