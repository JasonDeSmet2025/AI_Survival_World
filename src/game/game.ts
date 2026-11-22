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
  PointLight,
  Scene,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import { Conversation } from './ai/chat';
import { Npc, NPC_PROFILES } from './ai/npc';
import { Animal } from './ai/animals';
import { mulberry32 } from './core/noise';
import { ANIMALS, herdSpot, rollDrops, type AnimalKind } from './systems/fauna';
import { CAVE_SITES, WITCH_HOME, caveKeepOut, witchKeepOut } from './world/caves';
import { buildCaveInterior, buildWitch, buildWitchHut, type Decor } from './visual/decor';
import {
  animalMeleeDamage,
  animalRangedDamage,
  absorbDamage,
  ARROW_AMMO,
  canShoot,
  canSwing,
  inBowRange,
  inSwingRange,
  playerMeleeDamage,
  validIncomingHit,
  SHOOT_ANIM_TIME,
  SHIELD_BLOCK_WEAR,
  SWING_ANIM_TIME,
} from './systems/combat';
import {
  POTION_BUFF_SECONDS,
  SHOP_OFFERS,
  SWIFT_SPEED_MULTIPLIER,
  canAfford as offerAffordable,
  priceLabel,
  trade as performTrade,
} from './systems/shop';
import { harvestSeconds, ITEMS, RECIPES, toolForNode, YIELDS } from './core/items';
import { InputController } from './input';
import { Hud } from './hud/hud';
import { MultiplayerClient, type MpMessage, type MpProfile, type MpStatus } from './net/mp';
import { RemoteAvatars } from './net/avatars';
import { DAY_LENGTH_S, ServerClock } from './net/time';
import { playerName, resolveMpUrl, sanitizeName, setPlayerName, spawnOffset } from './net/identity';
import { PlayerCharacter } from './player/player';
import { clampCameraPitch, CAM_PITCH_DEFAULT, PlayerController } from './player/controller';
import {
  CAM_DIST_DEFAULT,
  FP_PITCH_REST,
  CAMERA_SURFACE_OFFSET,
  blendPitch,
  bodyVisible,
  clampCamDist,
  isFirstPerson,
  eyeBacklash,
  occlusionFloor,
  pivotHeight,
  pitchOwner,
  smoothCamDist,
  zoomDistance,
} from './systems/cameraRig';
import { groundHeight } from './player/ground';
import { consumeItem, isConsumable } from './systems/consume';
import { FpsMeter } from './systems/fps';
import { harvestToast, resolveHarvest } from './systems/harvest';
import { addWood, burnFuel, CAMPFIRE, isLit, justDied, warmthFrom } from './systems/campfire';
import { CookSession, COOK, cookHasRoom, cookOutput, isCokable } from './systems/cook';
import { CraftSession, Crafting, BENCH_SPEED_SCALE, needsTable, nearestWorkbench } from './systems/crafting';
import {
  PLANTER_CROP,
  PLANTER_SECONDS,
  PLANTER_YIELD,
  growPlanter,
  growthOf,
  isPlanter,
  isRipe,
  pickPlanter,
  planterFraction,
} from './systems/farm';
import {
  DEFAULT_BINDINGS,
  clearControls,
  clampMouseSens,
  ACTION_LABEL,
  assign as assignKey,
  keyLabel,
  loadControls,
  saveControls,
  type Action,
  type Bindings,
} from './systems/keybinds';
import {
  buildingPlatforms,
  HEIGHT_GRID,
  MAX_BUILD_LEVEL,
  isBlocking,
  isEdgeKind,
  migrateWallGrid,
  placementBaseY,
  snapToCell,
  snapToWallEdge,
  validatePlacement,
  wallSegment,
  type Platform,
  type WallSegment,
} from './systems/building';
import { BuildingRenderer } from './systems/buildingMeshes';
import { raycastTarget, type InteractTarget } from './systems/interact';
import { Inventory, INVENTORY_SIZE, HOTBAR_SIZE, type Slot } from './systems/inventory';
import { Save } from './systems/save';
import {
  describeGoal,
  QuestLog,
  validateQuest,
  type QuestDef,
  type RawQuest,
} from './systems/quests';
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
import { groundSurfaceHeight } from './world/groundSurface';
import { Atmosphere } from './world/atmosphere';
import { Sky } from './world/sky';
import { Water } from './world/water';
import { populateFlora, type FloraHandle } from './world/flora';
import { SharedWorldState } from './world/worldState';
import { terrainRayHit } from './world/terrainRay';
import { sanitizeReply } from './ai/reply';
import type { BuildingData, Collider } from './world/types';

const KIND_LABEL: Record<string, string> = {
  tree: 'Boom',
  pine: 'Dennenboom',
  rock: 'Steen',
  bush: 'Bessenstruik',
};

const BUILDING_KINDS: ReadonlySet<string> = new Set([
  'campfire',
  'wall',
  'floor',
  'roof',
  'bed',
  'door',
  'stone_wall',
  'torch',
  'carpet',
  'fence',
  'stairs',
  'workbench',
  'planter',
  'sign',
]);

/** How far (metres) the player can reach to place a structure. */
const BUILD_RANGE = 12;

/** Player-facing Dutch text for the placement reasons returned by validatePlacement(). */
const PLACEMENT_MESSAGES: Record<string, string> = {
  'cannot build underwater': 'Hier staat water',
  'not on a valid platform': 'Hier past het niet',
  'roof needs a wall below it': 'Bouw eerst een muur onder je dak',
  'a building already occupies this spot': 'Hier staat al iets',
  'too close to you': 'Te dicht bij jezelf',
  'too far away': 'Te ver weg — loop dichterbij',
};

/**
 * Camera radians per pixel of mouse movement at sensitivity 1 (the shipped
 * feel). The settings menu multiplies it with 0.2 .. 3.
 */
const BASE_MOUSE_LOOK = 0.0022;
/** Keep the third-person view angled down enough to show the ground. */

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
  /**
   * The herd: procedural sheep and cows around the camp (see ai/animals.ts
   * + systems/fauna.ts). Deliberately NOT saved: they respawn deterministically
   * from WORLD_SEED each session, and a killed animal stays killed for as
   * long as you play. Multiplayer: every client runs its own local herd —
   * hunting is not (yet) a shared protocol, unlike doors and fuel.
   */
  private animals: Animal[] = [];
  // --- landmarks + combat state (see world/caves.ts, systems/combat.ts) ---
  private decor: Decor[] = [];
  private witchRoot: TransformNode | null = null;
  private witchTick: ((dt: number, t: number) => void) | null = null;
  private witchAt = new Vector3(0, -100, 0);
  private shopOpen = false;
  /** Combat clock (seconds of survived play) — swing/hit rate gates. */
  private combatT = 0;
  private lastSwingAt = -1e9;
  /** Same clock for the bow: a draw takes SHOOT_COOLDOWN seconds. */
  private lastShotAt = -1e9;
  private lastHitTakenAt = -1e9;
  private swingT = 0;
  /** Potion buff timers (seconds remaining). */
  private swiftT = 0;
  private nightT = 0;
  private nightLight: PointLight | null = null;
  private animalSeq = 0;
  /** In-progress hunt on an animal (hold F), mirrors `gathering`. */
  private hunting: { id: string; progress: number } | null = null;
  /** Animal id we already warned about while the bag had no room for loot. */
  private animalBlockedNotified: string | null = null;
  private conversations = new Map<string, Conversation>();
  /**
   * Quest log. The LLM can only PROPOSE whitelisted quests (server);
   * progress and rewards are pure game logic here (systems/quests.ts) —
   * a chat sentence alone never completes anything.
   */
  private quests = new QuestLog();
  private activeNpc: Npc | null = null;

  private mp: MultiplayerClient | null = null;
  /** MP chat exchange awaiting its server-side npc_reply/npc_error. */
  private pendingChat: { npcId: string; name: string; text: string } | null = null;
  private chatTimer: ReturnType<typeof setTimeout> | null = null;
  private mpUrl: string | null;
  private localId: string;
  /** Remote players: real bodies, facing and nametags (see net/avatars.ts). */
  private avatars!: RemoteAvatars;
  /** Display name other players see; also the NPC memory key on the server. */
  private mpName = 'Speler';
  /** The shared day/night clock — the server owns it, we follow it. */
  private readonly worldClock = new ServerClock(DAY_LENGTH_S);
  /** Join order, translated into a spot on the camp ring. */
  private spawnIndex = 0;

  private camYaw = 0;
  private camPitch = CAM_PITCH_DEFAULT;
  /**
   * Camera rig: how far behind the player the camera hangs. `camDistTarget`
   * is what the wheel asked for, `camDist` what the frame renders (smoothed).
   * 0 = first person. Both live in the device controls (see keybinds.ts), so
   * the view a player trained yesterday is the view they wake up in.
   */
  private camDist = CAM_DIST_DEFAULT;
  private camDistTarget = CAM_DIST_DEFAULT;
  /**
   * First person's own look angle (see cameraRig's FP_PITCH_REST). Deliberately
   * NOT stored in the settings file: the zoom level is a habit worth
   * remembering, the exact degrees you were looking at are not — and every
   * stored number is a number a stale file can poison.
   */
  private camPitchFirst = FP_PITCH_REST;
  /** Is the player's own body mesh allowed to be seen? (hidden in FP) */
  private bodyShown = true;
  /**
   * Seconds left that the "first/third person" pill stays up after the last
   * wheel gesture — a control you only ever need to explain once per zoom.
   */
  private camPillT = 0;
  /** Debounce for saving the zoom: one write per gesture burst, not per event. */
  private camSaveT = 0;
  /** Last pointer-lock state pushed to the HUD (push only on change). */
  private pointerShown = false;
  /**
   * Honest fps counter — fed the UNCLAMPED frame time (the simulation uses
   * a clamped dt, which used to make the HUD report ~20 fps in a 1 fps
   * build). See systems/fps.ts.
   */
  private readonly fpsMeter = new FpsMeter();
  /**
   * Every window listener the game registers, kept so `dispose()` can
   * actually remove them. `removeEventListener(() => this.persist())` used
   * to pass a NEW function (and the five `hud-*` listeners were never
   * removed at all), so each `Game` instance leaked listeners for the life
   * of the page.
   */
  private readonly windowListeners: Array<{ type: string; handler: EventListener }> = [];
  /** Node id we already warned about while the bag had no room for it. */
  private harvestBlockedNotified: string | null = null;
  private craftBlockedNotified = false;
  private cookBlockedNotified = false;
  private disposed = false;
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
  /** Settings panel (O) — controls, mouse sensitivity and the world reset. */
  private settingsOpen = false;
  /**
   * Device-level control setup (key map + mouse sensitivity). Lives in its own
   * localStorage entry, NOT in the world save: it must survive a world reset
   * and must never be uploaded as someone's progress in multiplayer.
   */
  private bindings: Bindings = { ...DEFAULT_BINDINGS };
  /** Mouse look multiplier (see systems/keybinds.ts clampMouseSens). */
  private mouseSens = 1;
  /**
   * True while the settings menu waits for the next key to bind. The frame
   * loop then throws away every queued press: the key you press to rebind
   * must not also perform the action it now drives.
   */
  private rebinding = false;
  /** Full inventory panel state (all 24 slots + UI mouse-cursor). */
  private invOpen = false;
  /** Stack currently held by the inventory UI cursor (outside all slots). */
  private invCursor: Slot | null = null;
  /** Slot index the cursor stack was picked up from (for re-placement on close). */
  private invCursorFrom: number | null = null;
  /** Campfires whose "the fire has gone out" toast has already been shown. */
  private fireDiedShown = new Set<string>();
  /**
   * Planters whose crop just turned ripe (announce once per crop, so the
   * prompt is not the only thing telling you the berries are ready).
   */
  private planterRipe = new Set<string>();
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
  /** PgUp/PgDn: how many HEIGHT_GRID steps the next placement is lifted. */
  private buildLevel = 0;
  private deathShown = false;
  private wasExhausted = false;
  private saveTimer = 0;
  private hudTimer = 0;

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
      ...caveKeepOut(),
      witchKeepOut(),
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

    // HUD + input. The saved key map is read BEFORE the input controller is
    // built, so the very first frame already answers to the player's own keys.
    const controls = loadControls();
    this.bindings = controls.bindings;
    this.mouseSens = controls.mouseSens;
    // The saved zoom is restored for BOTH fields: starting a session already
    // halfway zoomed in means the target, not just the rendered distance, or
    // the first frame would smooth back to the default view.
    this.camDist = this.camDistTarget = clampCamDist(controls.camDist);
    this.hud = new Hud(hudContainer, () => this.respawn());
    this.input = new InputController(canvas, this.bindings);
    this.hud.setControls(this.bindings, this.mouseSens);
    this.bindHudEvents();

    // NPCs at the camp
    NPC_PROFILES.forEach((profile, i) => {
      const npc = new Npc(this.scene, profile, this.camp, WORLD_SEED + i * 977, this.mats);
      this.npcs.push(npc);
      this.conversations.set(profile.id, new Conversation(profile, '/api/chat'));
      // false = ALL descendant meshes (Babylon 9 argument semantics): the
      // body parts live under nested joint nodes, not directly on the root.
      for (const m of npc.root.getChildMeshes(false)) this.lighting.addShadowCaster(m);
    });

    // The herd — killable sheep and cows grazing around the camp.
    this.spawnFauna();
    this.buildCaves();
    this.buildWitchSite();
    // Night-sight potion: a soft aura light riding the camera, zero when
    // the buff is down so it costs nothing on normal frames.
    this.nightLight = new PointLight('nightEye', new Vector3(0, -100, 0), this.scene);
    this.nightLight.diffuse = new Color3(0.72, 0.82, 1);
    this.nightLight.specular = new Color3(0.4, 0.45, 0.6);
    this.nightLight.range = 15;
    this.nightLight.intensity = 0;

    // Multiplayer
    //
    // ON by default: a second person only has to open the same URL. The old
    // rule (`params.has('mp')`) meant everyone who did not know the secret
    // query flag silently played in a private world and called it broken.
    // '?solo=1' opts out; '?mp=wss://host/ws' points at another server.
    this.mpUrl = opts?.mpUrl ?? resolveMpUrl(window.location);
    this.mpName = playerName(typeof localStorage !== 'undefined' ? localStorage : null);
    this.localId = Math.random().toString(36).slice(2, 10);
    this.avatars = new RemoteAvatars(this.scene, this.mats, { labelContainer: this.hud.mpTagLayer });
    this.hud.setMpName(this.mpName);
    if (this.mpUrl) this.initMultiplayer();
    else this.hud.setMpStatus('Solo — offline');

    // Restore save (solo only: in multiplayer progress lives on the server,
    // keyed by the player token — see the 'hello' handler).
    if (!this.mpUrl) this.restoreSave();

    // Starter items on a fresh world
    if (!this.mpUrl && !Save.read()) {
      this.inventory.add('wood', 5);
      this.inventory.add('stone', 2);
      this.inventory.add('berry', 3);
      this.welcomeNudge();
    }

    this.refreshHud(true);
    this.scene.onBeforeRenderObservable.add(() => this.frame(this.engine.getDeltaTime() / 1000));

    // Start Babylon.js rendering and game updates.
    this.engine.runRenderLoop(() => {
      this.scene.render();
    });

    window.addEventListener('beforeunload', this.persistOnUnload);
    this.windowListeners.push({ type: 'beforeunload', handler: this.persistOnUnload });

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
      this.mpName,
      (m: MpMessage) => this.handleMpMessage(m),
      (s: MpStatus) => this.onMpStatus(s),
      { storage: typeof localStorage !== 'undefined' ? localStorage : null },
    );
    mp.connect();
    this.mp = mp;
  }

  /**
   * Connection state, in words a player understands. "connected" alone told
   * you nothing about whether you were sharing the world with anyone.
   */
  private onMpStatus(s: MpStatus): void {
    if (s === 'connected') {
      this.refreshRoster();
    } else if (s === 'connecting') {
      this.hud.setMpStatus('Verbinden…');
    } else {
      this.hud.setMpStatus('Offline — solo');
      this.hud.setMpPlayers([]);
      for (const id of this.avatars.ids()) this.avatars.remove(id);
    }
  }

  /** Push the roster (names + count) to the HUD. */
  private refreshRoster(): void {
    this.hud.setMpPlayers(this.avatars.roster().map((r) => r.name));
    if (this.mp?.status === 'connected') {
      this.hud.setMpStatus(`Online — ${this.avatars.size + 1} speler${this.avatars.size === 0 ? '' : 's'}`);
    }
  }

  /** True while the multiplayer link is up and the server is authoritative. */
  private get mpConnected(): boolean {
    return !!this.mp && this.mp.status === 'connected';
  }

  private handleMpMessage(m: MpMessage): void {
    switch (m.t) {
      case 'hello': {
        this.world.apply(
          { version: 1, seed: m.seed, depleted: m.depleted, hp: m.hp, buildings: m.buildings },
          m.seed,
        );
        migrateWallGrid(this.world.buildings);
        this.renderer.sync(this.world.buildings);
        this.floraRefresh();
        // From now on the SERVER-assigned id identifies us (harvest echoes
        // carry it as `by`); the pre-join random id is no longer authoritative.
        this.localId = m.playerId;
        // Shared clock + join-order spawn: without the ring offset a second
        // player materialised inside the first one and both cameras clipped
        // through the same body.
        if (typeof m.time === 'number') this.worldClock.sync(m.time);
        this.spawnIndex = Number.isFinite(m.spawnIndex) ? (m.spawnIndex as number) : 0;
        for (const p of m.players) {
          if (p.id !== this.localId) this.addRemote(p.id, p.name, p.p[0], p.p[1], p.p[2], p.r ?? 0);
        }
        this.refreshRoster();
        this.restoreProfile(m.me ?? null);
        break;
      }
      case 'joined':
        // Spawn at the joiner's real position — (0,0,0) made every remote
        // player pop at the world origin and then teleport.
        this.addRemote(m.id, m.name, m.p?.[0] ?? 0, m.p?.[1] ?? 5, m.p?.[2] ?? 0, m.r ?? 0);
        this.refreshRoster();
        break;
      case 'left':
        this.avatars.remove(m.id);
        this.refreshRoster();
        break;
      case 'world-reset':
        // The server wiped the shared world. Everyone starts over: local
        // save out first, then a clean reload. (Saves written after the
        // broadcast but before this reload die with the tab anyway.)
        Save.clear();
        window.location.reload();
        return;
      case 'renamed':
        this.avatars.rename(m.id, m.name);
        this.refreshRoster();
        break;
      case 'time':
        // Someone slept (jump) or the routine 2 s clock refresh. Both are
        // handled by the follow logic in frame(): only the source differs.
        if (Number.isFinite(m.time)) this.worldClock.sync(m.time);
        if (m.jump) this.lighting.setTimeOfDay(this.worldClock.expected());
        break;
      case 'fuel': {
        // Shared campfire fuel: a log thrown on the fire by anyone keeps it
        // burning (and cooking) for everyone.
        const b = this.world.buildings.find((x) => x.id === m.id);
        if (b && b.kind === 'campfire') {
          b.fuel = Math.max(0, m.fuel);
          if (b.fuel > 0) this.fireDiedShown.delete(b.id);
          this.renderer.setFireState(b.id, b.fuel, 0);
          if (m.by && m.by !== this.localId) this.hud.toast('Iemand heeft het kampvuur gevoed');
        }
        break;
      }
      case 'saved':
        // Silent in the happy case; only a rejected upload is worth a toast.
        if (!m.ok) this.hud.toast('Voortgang niet opgeslagen op de server');
        break;
      case 'p': {
        this.avatars.setTarget(m.id, { x: m.p[0], y: m.p[1], z: m.p[2], r: m.r ?? 0 });
        break;
      }
      case 'placed':
        this.world.addBuilding(m.b);
        this.renderer.sync(this.world.buildings);
        break;
      case 'toggle': {
        // A door someone else swung: apply the shared flag and let the
        // renderer's per-sync setOpen drive the hinge.
        const b = this.world.buildings.find((x) => x.id === m.id);
        if (b && b.kind === 'door') {
          b.open = m.open;
          this.renderer.sync(this.world.buildings);
        }
        break;
      }
      case 'hit': {
        // A melee hit the server just validated and forwarded. Only the
        // VICTIM subtracts its own health; re-validate range + rate so a
        // tampered client cannot deal damage from across the map.
        if (m.id !== this.localId) break;
        const atk = this.avatars.poseOf(m.by);
        const d = atk
          ? Math.hypot(atk.x - this.controller.pos.x, atk.z - this.controller.pos.z)
          : Number.POSITIVE_INFINITY;
        if (!validIncomingHit(d, m.dmg, this.combatT - this.lastHitTakenAt)) break;
        this.lastHitTakenAt = this.combatT;
        // A raised shield (selected hotbar slot) eats half of the blow and
        // pays durability for it — the victim still decides what it takes.
        const taken = this.absorb(m.dmg);
        this.stats.takeDamage(taken);
        this.hurtT = Math.max(this.hurtT, 0.7);
        this.hud.toast(
          taken < m.dmg
            ? `Geraakt — je Schild vangt de klap (-${taken} gezondheid)`
            : `Geraakt door een aanval (-${taken} gezondheid)!`,
        );
        break;
      }
      case 'harvested': {
        // The server owns hp AND yield. hp is applied as an ABSOLUTE value
        // (setNodeHp is idempotent, so the initiator seeing their own
        // broadcast can no longer double-damage the node) and the items/XP
        // are granted only to the harvester the server named in `by`.
        const node = this.world.node(m.id);
        const remaining = this.world.setNodeHp(m.id, m.hp);
        if (node && m.by === this.localId && (m.amount ?? 0) > 0) {
          const yieldDef = YIELDS[node.kind];
          if (yieldDef) {
            // The server decided the amount; report honestly how much of it
            // reached the bag instead of claiming the full stack. In MP the
            // server owns node hp (the harvest itself is authoritative),
            // while bag capacity is per-player client knowledge.
            const notFitted = this.inventory.add(yieldDef.itemId, m.amount as number);
            const got = (m.amount as number) - notFitted;
            this.hud.toast(
              notFitted > 0
                ? `+${got} ${ITEMS[yieldDef.itemId].name} — rugzak vol (${notFitted} gemist)`
                : `+${got} ${ITEMS[yieldDef.itemId].name}`,
            );
            this.grantXp(gatherXp(node.kind));
          }
        }
        if (remaining <= 0) this.floraRefresh();
        break;
      }
      case 'depleted':
        this.floraRefresh();
        break;
      case 'regrow': {
        // Server-authoritative bush regrowth: the local-only timer used to
        // regrow bushes here while every other player kept them depleted.
        const node = this.world.node(m.id);
        if (node) {
          this.world.setNodeHp(m.id, m.hp > 0 ? m.hp : node.maxHp);
          this.bushRegrow.delete(m.id);
          this.floraRefresh();
        }
        break;
      }
      case 'reject':
        this.hud.toast(m.msg);
        break;
      case 'npc_reply': {
        // Multiplayer replies come straight from the model: they get the
        // same in-character hygiene the single-player Conversation applies.
        const text = sanitizeReply(m.text) ?? '(onbegrijpelijk gepraat)';
        this.hud.addChatLine(m.npc, text, false, m.speaker);
        // A quest offer was validated by the server against its template
        // table AND is re-validated client-side before the log sees it.
        if (m.quest) this.offerQuest(m.quest as RawQuest);
        this.settlePendingChat(m.npcId, m.npc, text);
        break;
      }
      case 'npc_error':
        this.hud.addChatLine(m.npc, m.reason === 'rate_limited' ? '(te veel berichten — even wachten)' : '(server onbereikbaar)', true);
        this.settlePendingChat(m.npcId, m.npc, null);
        break;
      default:
        break;
    }
  }

  /**
   * Releases the chat-busy state when the server answers the pending
   * exchange (matched by npc id, falling back to display name — replies
   * broadcast for OTHER players' questions must not clear our busy flag).
   * The exchange is mirrored into the local conversation transcript so MP
   * chats keep carrying history across reconnects.
   */
  private settlePendingChat(npcId: string | undefined, npcName: string, reply: string | null): void {
    const pending = this.pendingChat;
    if (!pending) return;
    if (!((npcId && npcId === pending.npcId) || npcName === pending.name)) return;
    if (this.chatTimer) {
      clearTimeout(this.chatTimer);
      this.chatTimer = null;
    }
    this.pendingChat = null;
    this.hud.setChatBusy(false);
    const conv = this.conversations.get(pending.npcId);
    if (conv) {
      conv.history.push({ role: 'user', content: pending.text });
      if (reply) conv.history.push({ role: 'assistant', content: reply });
    }
  }

  /**
   * The first minute of a NEW world only: the tekentafel is the real starting
   * line of the game (everything beyond hand work waits for it), so a fresh
   * player is told what to aim for. A save file means they already know — the
   * nudge is never repeated, and it is not state: nothing is persisted.
   */
  private welcomeNudge(): void {
    this.hud.toast(
      'Nieuw werk: verzamel 6 hout en maak je eerste TEKENTAFEL (B → Tekentafel, dan E erbij) — aan de tafel maak je de rest',
    );
  }

  private addRemote(id: string, name: string, x: number, y: number, z: number, r = 0): void {
    this.avatars.add(id, name || 'Speler', { x, y, z, r });
    for (const mesh of this.avatars.shadowMeshes()) this.lighting.addShadowCaster(mesh);
    this.refreshRoster();
  }

  /**
   * The progress the server handed back for THIS player (hello.me). This is
   * what multiplayer never had: a reload used to start every player from an
   * empty bag at the camp, while solo play had a save file.
   */
  private restoreProfile(me: MpProfile | null): void {
    if (!me) {
      // First visit to this server: the starter kit solo players get too.
      this.inventory.add('wood', 5);
      this.inventory.add('stone', 2);
      this.inventory.add('berry', 3);
      this.welcomeNudge();
      this.refreshHud(true);
      return;
    }
    if (me.name) {
      this.mpName = me.name;
      this.hud.setMpName(me.name);
    }
    this.inventory.restore(me.inventory, me.selected);
    if (me.progress) this.progress.restore(me.progress);
    // A player never reloads into a corpse: the server may have stored them
    // mid-death, so respawn at the camp instead of showing the death overlay.
    if (me.stats.dead) {
      this.stats.respawn();
      this.inventory.applyDeathPenalty();
    } else {
      this.stats.restore(me.stats);
    }
    const off = spawnOffset(this.spawnIndex);
    const x = Number.isFinite(me.pos?.x) ? me.pos.x : this.camp.x + off.x;
    const z = Number.isFinite(me.pos?.z) ? me.pos.z : this.camp.z + off.z;
    const y = groundHeight(x, z) + 1.2;
    this.controller.respawn(x, y, z);
    if (Number.isFinite(me.yaw)) this.camYaw = me.yaw;
    this.renderer.sync(this.world.buildings);
    this.refreshHud(true);
    this.hud.toast('Wel terug, ' + (me.name ?? this.mpName));
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
    // The saved pitch must be clamped to the PLAYABLE look range, not to the
    // default value: Math.min(pitch, -0.65) flattened every saved upward (and
    // most downward) glance back to the horizon on each load.
    this.camPitch = clampCameraPitch(data.pitch);
    this.lighting.setTimeOfDay(data.elapsed);
    this.world.apply(data.world, data.world.seed || WORLD_SEED);
    // Old saves carry stone walls on the floor grid (see systems/building.ts);
    // re-snap them before anything reads the buildings, so physics, support
    // and meshes all agree with the ghost preview.
    migrateWallGrid(this.world.buildings);
    if (data.progress) this.progress.restore(data.progress);
    this.renderer.sync(this.world.buildings);
    this.floraRefresh();
    for (const [id, conv] of this.conversations) {
      const saved = data.npcs?.[id];
      if (saved) conv.restore(saved);
    }
    this.quests.restore(data.quests);
    this.hud.setQuests(this.questHudList());
    if (this.stats.dead) {
      this.stats.respawn();
      this.inventory.applyDeathPenalty();
    }
  }

  private persist(): void {
    if (this.stats.dead) return;
    if (this.mp) {
      // Multiplayer: progress belongs to the SERVER, not to this browser —
      // writing it to localStorage would mix several players' saves into one
      // file. Closing the tab still counts as a save, so flush a snapshot.
      if (this.mp.status === 'connected') this.mp.sendSave(this.profileSnapshot());
      return;
    }
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
    data.quests = this.quests.serialize();
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
    // Registered through `listen()` so dispose() detaches every one of them.
    this.listen('hud-hotbar-click', (e: Event) => {
      this.inventory.select((e as CustomEvent<number>).detail);
      this.refreshHud(true);
    });
    this.listen('hud-craft-click', (e: Event) => this.doCraft((e as CustomEvent<string>).detail));
    this.listen('hud-inv-slot-click', (e: Event) => this.handleInvSlotClick((e as CustomEvent<number>).detail));
    this.listen('hud-chat-send', (e: Event) => void this.sendChat((e as CustomEvent<string>).detail));
    this.listen('hud-chat-close', () => this.closeChat());
    this.listen('hud-quest-accept', (e: Event) => this.onQuestAccept((e as CustomEvent<string>).detail));
    this.listen('hud-quest-decline', (e: Event) => this.onQuestDecline((e as CustomEvent<string>).detail));
    this.listen('hud-mp-name', (e: Event) => this.setPlayerName((e as CustomEvent<string>).detail));
    this.listen('hud-settings-close', () => this.setSettingsOpen(false));
    this.listen('hud-reset-world', () => this.resetWorld());
    this.listen('hud-shop-close', () => this.setShopOpen(false));
    this.listen('hud-trade', (e: Event) => this.doTrade((e as CustomEvent<string>).detail));
    // --- Settings menu: controls. The HUD only captures the pressed key and
    // reports it; validating, applying and storing it is decided here (the
    // rules live in systems/keybinds.ts, which is unit-tested).
    this.listen('hud-rebind-start', () => this.beginRebind());
    this.listen('hud-rebind-cancel', () => this.endRebind());
    this.listen('hud-rebind', (e: Event) =>
      this.applyRebind((e as CustomEvent<{ action: Action; code: string }>).detail),
    );
    this.listen('hud-sensitivity', (e: Event) => {
      this.mouseSens = clampMouseSens((e as CustomEvent<number>).detail);
      this.hud.setControls(this.bindings, this.mouseSens);
      this.saveControls();
    });
    this.listen('hud-keybinds-reset', () => {
      this.bindings = { ...DEFAULT_BINDINGS };
      this.mouseSens = 1;
      // The zoom lives in the same stored file as the keys and the
      // sensitivity, so the button that clears that file must clear the view
      // too — a "reset controls" that left the player stuck in first person
      // would feel like the button only half-worked.
      this.camDist = this.camDistTarget = CAM_DIST_DEFAULT;
      this.camSaveT = 0;
      this.input.setBindings(this.bindings);
      this.hud.setControls(this.bindings, this.mouseSens);
      clearControls();
      this.hud.toast('Besturing teruggezet naar standaard');
    });
  }

  /**
   * Persist the device-level control setup (key map, mouse sensitivity and how
   * far the camera hangs). All three are preferences of this machine, not of
   * the world, so they survive a world reset and never travel in multiplayer.
   */
  private saveControls(): void {
    saveControls({
      bindings: this.bindings,
      mouseSens: this.mouseSens,
      camDist: this.camDistTarget,
    });
  }

  /** The settings menu is listening for a key. Freeze all game presses. */
  private beginRebind(): void {
    this.rebinding = true;
    this.input.clearPresses();
  }

  private endRebind(): void {
    if (!this.rebinding) return;
    this.rebinding = false;
    this.input.clearPresses();
    this.hud.setRebinding(null);
  }

  /**
   * Apply a captured key to an action. Refused binds (a key another action
   * already answers to) leave the map untouched and say why, in the panel.
   */
  private applyRebind(detail: { action: Action; code: string }): void {
    if (!detail || !detail.action || !detail.code) return;
    const result = assignKey(this.bindings, detail.action, detail.code);
    this.rebinding = false;
    this.input.clearPresses();
    this.hud.setRebinding(null);
    if (!result.ok) {
      this.hud.setControls(this.bindings, this.mouseSens, result.reason);
      this.hud.toast(result.reason ?? 'Kan die toets niet gebruiken');
      return;
    }
    this.bindings = result.bindings;
    this.input.setBindings(this.bindings);
    this.saveControls();
    this.hud.setControls(this.bindings, this.mouseSens);
    this.hud.toast(`${keyLabel(detail.code)} — ${ACTION_LABEL[detail.action]}`);
  }

  /**
   * Open/close the settings panel. Opening releases the pointer lock (the
   * same courtesy the MP name field gives): pointing a button and steering
   * the camera are mutually exclusive.
   */
  private setSettingsOpen(open: boolean): void {
    this.settingsOpen = open;
    if (!open) this.endRebind();
    this.hud.setSettings(open, this.mpConnected);
    if (open) {
      // The panel shows the LIVE key map, so what you see is what you play.
      this.hud.setControls(this.bindings, this.mouseSens);
      try {
        document.exitPointerLock?.();
      } catch {
        /* not locked, nothing to release */
      }
    }
  }

  /**
   * The settings-panel world reset. The HUD button made the player confirm
   * twice, so this is decisive. Since every session is MP-connected (the
   * server owns the world), the wipe goes THROUGH the server: it clears the
   * shared state and broadcasts world-reset, and every client — this one
   * included — clears its local save and reloads. True solo (?solo=1) just
   * wipes localStorage.
   */
  private resetWorld(): void {
    if (this.mpConnected) {
      this.mp!.sendReset();
      this.hud.toast('Serverwereld wordt gewist…');
      return; // the world-reset broadcast reloads us like everyone else
    }
    Save.clear();
    window.location.reload();
  }

  /** Rename yourself for everyone (and remember it for the next visit). */
  private setPlayerName(raw: string): void {
    const clean = sanitizeName(raw);
    if (!clean) {
      this.hud.toast('Die naam is leeg — niets gewijzigd');
      return;
    }
    this.mpName = clean;
    setPlayerName(clean, typeof localStorage !== 'undefined' ? localStorage : null);
    this.hud.setMpName(clean);
    if (this.mp) this.mp.setName(clean);
    this.hud.toast(`Je speelt nu als ${clean}`);
  }

  /** This player's progress in the shape the server store validates. */
  private profileSnapshot(): MpProfile {
    return {
      name: this.mpName,
      stats: this.stats.snapshot(),
      inventory: this.inventory.serialize(),
      selected: this.inventory.selected,
      pos: { x: this.controller.pos.x, y: this.controller.pos.y, z: this.controller.pos.z },
      yaw: this.camYaw,
      progress: this.progress.snapshot(),
    };
  }

  /** Register a window listener that `dispose()` is guaranteed to remove. */
  private listen(type: string, handler: EventListener): void {
    window.addEventListener(type, handler);
    this.windowListeners.push({ type, handler });
  }

  /** Stable identity for the unload hook (a new arrow function per call
   *  could never be removed again, which leaked the whole Game). */
  private readonly persistOnUnload: EventListener = () => this.persist();

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
    // The station gate: beyond hand work you need your OWN tekentafel nearby
    // (systems/crafting.ts). Checked before the material complaint, because
    // "loop naar je tafel" is the actionable answer, not "je hebt X niet".
    if (needsTable(recipe) && !this.atWorkbench()) {
      this.hud.toast('Dit maak je alleen aan je tekentafel — loop erheen (of druk E bij je tafel)');
      return;
    }
    if (!recipe.inputs.every((i) => this.inventory.has(i.id, i.count))) {
      this.hud.toast('Niet genoeg materialen');
      return;
    }
    const session = CraftSession.start(
      this.inventory,
      recipeId,
      this.progress.level,
      this.benchScale(),
    );
    if (!session) {
      // Unlocked + affordable (checked above), so the only reason left is
      // that the finished item has nowhere to go.
      this.hud.toast(`Rugzak vol — geen ruimte voor ${ITEMS[recipe.output.id].name}`);
      return;
    }
    this.craft = session;
    this.hud.toast(`Maken: ${ITEMS[session.recipe.output.id].name} (${Math.round(session.duration)}s) — B/Esc om af te breken`);
    this.refreshHud(true);
  }

  /**
   * True while the player stands within BENCH_RADIUS of their OWN tekentafel
   * (workbench). One question, two consequences: the table recipes become
   * craftable here and the craft timer runs BENCH_SPEED_SCALE faster.
   */
  private atWorkbench(): boolean {
    return nearestWorkbench(this.world.buildings, this.controller.pos, this.localId) !== null;
  }

  /**
   * Craft-speed multiplier for the session about to start: 1.4x while the
   * player stands at their OWN workbench (systems/crafting.ts). Asked and
   * answered once, at the start — walking away mid-craft does not retroactively
   * undo the workshop's help.
   */
  private benchScale(): number {
    return this.atWorkbench() ? BENCH_SPEED_SCALE : 1;
  }

  /**
   * What a blow really costs while a shield is in hand: half the damage, and
   * the shield pays durability for absorbing it. Everything else (bare hands,
   * a pickaxe) takes the full amount.
   */
  private absorb(amount: number): number {
    if (!(amount > 0)) return 0;
    const held = this.selectedItemId();
    const after = absorbDamage(amount, held);
    if (after < amount) {
      const wear = wearTool(this.inventory, this.inventory.selected, SHIELD_BLOCK_WEAR);
      if (wear.broke) this.hud.toast('Je schild is aan gruzelementen geslagen!');
    }
    return after;
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
    // Real conversation = real quest progress (talk goals). Counted here,
    // never inferred from chat content.
    this.settleQuests(this.quests.progress({ type: 'talk', target: npc.profile.id, count: 1 }));
    this.hud.addChatLine('Jij', text);
    this.hud.setChatBusy(true);
    if (this.mpConnected) {
      // Multiplayer: the server performs THE single LLM call and answers
      // with npc_reply/npc_error (also broadcast, so other players see the
      // conversation). This path used to run conv.send() AND mp.sendChat(),
      // producing two gateway calls and two reply bubbles per message.
      this.pendingChat = { npcId: npc.profile.id, name: npc.profile.name, text };
      if (this.chatTimer) clearTimeout(this.chatTimer);
      this.chatTimer = setTimeout(() => {
        this.chatTimer = null;
        if (!this.pendingChat) return;
        this.hud.addChatLine(this.pendingChat.name, '(server onbereikbaar)', true);
        this.pendingChat = null;
        this.hud.setChatBusy(false);
      }, 20_000);
      this.mp!.sendChat(
        { id: npc.profile.id, name: npc.profile.name, personality: npc.profile.persona },
        text,
        { playerState: this.playerStateSummary(), quests: this.questContext() },
        conv.history.slice(-12),
      );
      return;
    }
    const res = await conv.send(text, { playerState: this.playerStateSummary(), quests: this.questContext() });
    this.hud.addChatLine(npc.profile.name, res.reply, res.source === 'fallback');
    this.hud.setChatBusy(false);
    if (res.quest) this.offerQuest(res.quest satisfies RawQuest);
  }

  // ------------------------------------------------------------------
  // Quests (systems/quests.ts does the counting; this is the wiring)
  // ------------------------------------------------------------------

  /** Id lists the server uses ONLY to suppress duplicate quest offers. */
  private questContext(): { active: string[]; completed: string[] } {
    return { active: this.quests.activeIds(), completed: this.quests.completedIds };
  }

  private questHudList(): Array<{ id: string; title: string; text: string }> {
    return this.quests.list().map((a) => ({
      id: a.quest.id,
      title: a.quest.title,
      text: describeGoal(a.quest, a.progress),
    }));
  }

  /** A (server-validated) quest offer arrives from chat: show it in the HUD. */
  private offerQuest(raw: RawQuest | null | undefined): void {
    const q = this.quests.offer(validateQuest(raw));
    if (!q) return;
    this.hud.showQuestOffer(q.id, q.title, q.desc, describeGoal(q, 0), q.reward.xp);
  }

  private onQuestAccept(id: string): void {
    const q = this.quests.accept(id);
    if (!q) return;
    this.hud.toast(`Missie aangenomen: ${q.title}`);
    this.hud.setQuests(this.questHudList());
    this.conversations.get(q.npc)?.absorbEvent(`De speler heeft je missie "${q.title}" aangenomen.`);
  }

  private onQuestDecline(id: string): void {
    const q = this.quests.decline(id);
    if (!q) return;
    this.hud.setQuests(this.questHudList());
    this.conversations.get(q.npc)?.absorbEvent(`De speler heeft je missie "${q.title}" afgewezen.`);
  }

  /** Pay out completed quests exactly once (XP + validated items). */
  private settleQuests(done: QuestDef[]): void {
    if (!done.length) return;
    for (const q of done) {
      this.hud.toast(`Missie voltooid: ${q.title} (+${q.reward.xp} XP)`);
      if (q.reward.xp > 0) this.grantXp(q.reward.xp);
      for (const it of q.reward.items) {
        // Inventory.add returns what did NOT fit — a full bag must not
        // silently destroy quest rewards (the old capacity bug class).
        const left = this.inventory.add(it.id, it.count);
        if (left > 0) {
          this.hud.toast(`Rugzak vol — ${left} × ${ITEMS[it.id]?.name ?? it.id} niet ontvangen`);
        }
      }
      // The NPC who gave it heard about the deed through the game, not
      // through the model: this is a durable memory note, fed into prompts.
      this.conversations.get(q.npc)?.addMemory(`Missie voltooid: ${q.title}.`);
    }
    this.hud.setQuests(this.questHudList());
    this.refreshHud(true);
  }

  private playerStateSummary(): string {
    const t = this.lighting.timeOfDay;
    const hh = Math.floor(t * 24);
    const mm = Math.floor((t * 24 - hh) * 60);
    const has = [...new Set(this.inventory.slots.filter(Boolean).map((s) => s!.id))].slice(0, 8);
    const aq = this.quests.list();
    return (
      `Honger ${Math.round(this.stats.hunger)}%, dorst ${Math.round(this.stats.thirst)}%, ` +
      `gezonddend ${Math.round(this.stats.health)}%, temperatuur ${this.stats.temperature.toFixed(0)}°C, ` +
      `uur ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}, niveau ${this.progress.level}. ` +
      (aq.length
        ? `Lopende missies: ${aq.map((a) => `${a.quest.title} (${a.progress}/${a.quest.goal.count})`).join('; ')}. `
        : 'De speler heeft geen openstaande missies. ')
    ) +
      `Bezit: ${has.length ? has.map((id) => ITEMS[id].name).join(', ') : 'niets'}.`;
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
      } else if (b.kind === 'door') {
        targets.push({ kind: 'door', id: b.id, x: b.x, y: b.y + 1, z: b.z, radius: 1.3 });
      } else if (b.kind === 'planter') {
        targets.push({ kind: 'planter', id: b.id, x: b.x, y: b.y + 0.5, z: b.z, radius: 1.2 });
      } else if (b.kind === 'workbench' && b.ownerId === this.localId) {
        // Own table only, exactly like the speed bonus: a friend's table is
        // not a station you built, earned or can lose.
        targets.push({ kind: 'workbench', id: b.id, x: b.x, y: b.y + 0.9, z: b.z, radius: 1.8 });
      }
    }
    for (const a of this.animals) {
      if (!a.alive) continue;
      const p = a.position;
      targets.push({
        kind: 'animal',
        id: a.id,
        x: p.x,
        y: p.y + (a.kind === 'cow' ? 0.8 : 0.55),
        z: p.z,
        radius: a.kind === 'cow' ? 1.15 : 0.85,
      });
    }
    // The witch stands by her cauldron and always trades.
    if (this.witchRoot) {
      targets.push({ kind: 'witch', x: this.witchAt.x, y: this.witchAt.y, z: this.witchAt.z, radius: 1.6 });
    }
    // In multiplayer a friend is only a target while you hold the sword:
    // otherwise they would shadow the campfire/bed prompts behind them.
    if (this.mpConnected && this.selectedItemId() === 'sword') {
      for (const id of this.avatars.ids()) {
        const pose = this.avatars.poseOf(id);
        if (!pose) continue;
        if (Math.hypot(pose.x - this.controller.pos.x, pose.z - this.controller.pos.z) > 12) continue;
        targets.push({ kind: 'player', id, x: pose.x, y: pose.y + 1.1, z: pose.z, radius: 0.8 });
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
          // No room for the cooked result? Say so instead of silently
          // falling through to the "add wood" branch (which used to eat the
          // player's wood when the cook could never finish).
          if (!cookHasRoom(this.inventory, sel)) {
            const out = cookOutput(sel);
            const name = out ? (ITEMS[out]?.name ?? out) : 'het gerecht';
            this.hud.toast(`Rugzak vol — geen ruimte voor ${name}`);
            return;
          }
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
        // Fuel is world state: tell the server, or your friend's fire stays
        // out (and their cooking cancels) while yours burns merrily.
        if (this.mpConnected) this.mp!.sendFuel(b.id, b.fuel);
        this.hud.toast(`Hout toegevoegd (+${CAMPFIRE.fuelPerWood}s)`);
        break;
      }
      case 'water': {
        if (this.stats.thirst >= 96) {
          this.hud.toast('Niet dorst');
          return;
        }
        this.stats.thirst = Math.min(100, this.stats.thirst + 30);
        this.hud.toast('Gedronken (+30 dorst)');
        break;
      }
      case 'bed': {
        const b = this.world.buildings.find((x) => x.id === target.id);
        if (b) this.startSleep(b);
        break;
      }
      case 'door': {
        const b = this.world.buildings.find((x) => x.id === target.id);
        if (!b) break;
        b.open = !b.open;
        // The renderer swings the live hinge on the next sync — no rebuild.
        this.renderer.sync(this.world.buildings);
        // A shut door blocks your friend too: the flag is shared world state.
        if (this.mpConnected) this.mp!.sendToggle(b.id, !!b.open);
        this.hud.toast(b.open ? 'Deur geopend' : 'Deur gesloten');
        break;
      }
      case 'planter': {
        const b = this.world.buildings.find((x) => x.id === target.id);
        if (!b) break;
        if (!isRipe(b)) {
          const pct = Math.round(planterFraction(b) * 100);
          this.hud.toast(`De bessen zijn nog niet rijp (${pct}%)`);
          break;
        }
        const r = pickPlanter(b, this.inventory);
        if (!r.picked) {
          this.hud.toast(
            r.reason === 'no-room'
              ? `Rugzak vol — de bessen blijven aan de plant`
              : 'Hier is niets te plukken',
          );
          break;
        }
        this.hud.toast(
          `Oogst uit de bloempot: ${r.gained} ${ITEMS[PLANTER_CROP].name}` +
            (r.missed > 0 ? ` (${r.missed} past niet in de rugzak)` : ''),
        );
        // Same XP rule as picking a wild bush, scaled to what arrived.
        this.grantXp(Math.max(1, Math.round(gatherXp('bush') * (r.gained / PLANTER_YIELD))));
        this.settleQuests(this.quests.progress({ type: 'gather', target: PLANTER_CROP, count: r.gained }));
        this.refreshHud(true);
        break;
      }
      case 'workbench': {
        // Standing at your own tekentafel and pressing E opens the station
        // menu — the same list B shows, but now every row is unlocked because
        // the station question is answered by actually being there.
        this.craftingOpen = !this.craftingOpen;
        if (this.craftingOpen) {
          this.hud.toast('Tekentafel — alle recepten zijn nu beschikbaar (B of Esc sluit)');
        }
        this.refreshHud(true);
        break;
      }
      case 'witch': {
        this.setShopOpen(!this.shopOpen);
        if (this.shopOpen) this.hud.toast('De heks grijnst: "Materialen ruil ik, geen vriendjes."');
        break;
      }
      case 'player':
        // Attacking is LMB (see tryMeleeAttack); E on a person does nothing.
        break;
      default:
        break;
    }
  }

  /**
   * Where a building item would land: the grid cell the camera aims at, the
   * quarter-turn rotation, and the base height — the ground snapped to the
   * shared height grid (plus the PgUp/PgDn build level), or the exact top of
   * whatever already stands there (a wall on a deck, a second storey, a roof
   * on its walls).
   *
   * Floors, roofs, beds and fires snap to cell CENTRES; walls snap to cell
   * EDGES (snapToWallEdge), so a wall stands on the border line of the deck
   * instead of in the middle of the floor.
   *
   * The ghost preview and the actual placement read this ONE function, so a
   * green ghost always lands exactly where it is shown.
   */
  private placementFor(kind: BuildingData['kind']): {
    x: number;
    z: number;
    rot: number;
    baseY: number;
    groundY: number;
    error: string | null;
  } | null {
    const ground = this.groundUnderCamera(BUILD_RANGE + 2);
    if (!ground) return null;
    // Snap to the construction grid: floors and roofs land on cell centres,
    // walls and doors on the cell edges between them, all exactly one module wide.
    const edge = isEdgeKind(kind) ? snapToWallEdge(ground.x, ground.z) : null;
    const centre = edge ?? snapToCell(ground.x, ground.z);
    const cell = { x: centre.x, z: centre.z };
    const dx = cell.x - this.controller.pos.x;
    const dz = cell.z - this.controller.pos.z;
    const rot = edge
      ? edge.rot
      : ((Math.round(Math.atan2(dx, dz) / (Math.PI / 2)) % 4) + 4) % 4;
    const groundY = groundHeight(cell.x, cell.z);
    const baseY = placementBaseY(
      kind,
      cell.x,
      cell.z,
      rot,
      this.world.buildings,
      groundHeight,
      this.buildLevel,
    );
    let error: string | null = null;
    if (Math.hypot(dx, dz) > BUILD_RANGE) error = 'too far away';
    else if (groundY < SEA_LEVEL) error = 'cannot build underwater';
    else
      error = validatePlacement(
        kind,
        cell.x,
        cell.z,
        baseY,
        this.world.buildings,
        this.controller.pos,
        groundHeight,
        SEA_LEVEL,
        rot,
      );
    return { x: cell.x, z: cell.z, rot, baseY, groundY, error };
  }

  /** PgUp/PgDn: lift or lower the next placement by one HEIGHT_GRID step. */
  private adjustBuildLevel(delta: number): void {
    const next = Math.min(MAX_BUILD_LEVEL, Math.max(0, this.buildLevel + delta));
    if (next === this.buildLevel) {
      if (this.buildLevel !== 0) this.hud.toast('Bouwhoogte: maximaal');
      return;
    }
    this.buildLevel = next;
    const m = (this.buildLevel * HEIGHT_GRID).toFixed(1).replace('.', ',');
    this.hud.toast(
      this.buildLevel === 0 ? 'Bouwhoogte: grondniveau' : `Bouwhoogte: +${m} m`,
    );
  }

  private tryPlaceBuilding(kind: BuildingData['kind']): void {
    const spot = this.placementFor(kind);
    if (!spot) {
      this.hud.toast('Richt je blik op de grond om te bouwen');
      return;
    }
    if (spot.error) {
      this.hud.toast(PLACEMENT_MESSAGES[spot.error] ?? 'Hier past het niet');
      return;
    }
    if (this.inventory.remove(kind, 1) === 1) {
      const b: BuildingData = {
        id: `b_${this.localId}_${++this.buildSeq}`,
        kind,
        x: spot.x,
        z: spot.z,
        y: spot.baseY,
        rot: spot.rot,
        ownerId: this.localId,
        fuel: kind === 'campfire' ? CAMPFIRE.initialFuel : undefined,
        // A planter starts as an empty tray: growth is owned by whoever
        // planted it (systems/farm.ts), so it needs a number from day zero.
        growth: kind === 'planter' ? 0 : undefined,
      };
      this.world.addBuilding(b);
      this.renderer.sync(this.world.buildings);
      this.renderer.clearPreview();
      this.mp?.sendPlace(b.kind, b.x, b.z, b.y, b.rot, b.id);
      this.hud.toast('Gebouwd');
      // Progression: placing a structure pays XP.
      this.grantXp(XP_SOURCE.build);
      this.settleQuests(this.quests.progress({ type: 'build', target: kind, count: 1 }));
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
      if (this.gathering || this.hunting) {
        this.gathering = null;
        this.hunting = null;
      }
      return;
    }
    // While the inventory panel is open no slot may change underneath the
    // UI cursor: a gathered stack landing in the cursor's origin slot would
    // make the held stack unplaceable when the panel closes (silent item
    // loss). Gathering pauses for the duration the panel is open.
    if (this.invOpen) {
      if (this.gathering || this.hunting) {
        this.gathering = null;
        this.hunting = null;
      }
      this.hud.setProgress(null);
      return;
    }
    if (!target || !this.input.harvest) {
      if (this.gathering || this.hunting) {
        this.gathering = null;
        this.hunting = null;
      }
      this.hud.setProgress(null);
      return;
    }
    // Hunting rides the SAME hold-F key as gathering — one branch per
    // target kind, sharing the progress bar and the no-loss bag rules.
    if (target.target.kind === 'animal') {
      if (this.gathering) this.gathering = null;
      this.updateHunting(dt, target.target);
      return;
    }
    if (target.target.kind !== 'node') {
      if (this.gathering || this.hunting) {
        this.gathering = null;
        this.hunting = null;
      }
      this.hud.setProgress(null);
      return;
    }
    if (this.hunting) this.hunting = null;
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
    if (g.progress < 1) return;

    // The effective tool grants a +1 bonus item (toolForNode is the
    // single source of truth, shared with harvest speed and wear).
    const bonus = toolForNode(node.kind) === tool ? 1 : 0;
    if (this.mpConnected) {
      // Server-authoritative mode: hp, yield AND XP are decided by the
      // server and echoed back through 'harvested'. Nothing is applied
      // locally — the old local damage + yield + fire-and-forget send is
      // what made nodes deplete twice as fast and inventories diverge.
      this.gathering = null;
      this.hud.setProgress(null);
      this.mp!.sendHarvest(node.id, bonus);
      return;
    }

    // systems/harvest.ts decides the roll, the tool bonus, the bag capacity
    // and the XP in one tested place. The old inline code threw away the
    // return value of `Inventory.add()` — which IS the number of units that
    // did not fit — so in a full bag resources silently vanished while the
    // node was still damaged and the XP still paid out.
    const outcome = resolveHarvest({ kind: node.kind, inventory: this.inventory, toolId: tool });
    if (outcome.status === 'unknown') {
      this.gathering = null;
      this.hud.setProgress(null);
      return;
    }
    if (outcome.status === 'blocked') {
      // Not even one unit fits: the swing never finishes, so no node hp and
      // no XP is wasted. Progress sticks at 100 % and the harvest completes
      // the instant the player frees space (drop/place something).
      g.progress = 1;
      this.hud.setProgress(1);
      if (this.harvestBlockedNotified !== node.id) {
        this.harvestBlockedNotified = node.id;
        const name = outcome.itemId ? (ITEMS[outcome.itemId]?.name ?? outcome.itemId) : 'de opbrengst';
        this.hud.toast(`Rugzak vol — maak ruimte voor ${name}`);
      }
      return;
    }
    this.harvestBlockedNotified = null;
    this.gathering = null;
    this.hud.setProgress(null);
    const line = harvestToast(outcome);
    if (line) this.hud.toast(line);
    // Progression: gathering pays XP per node kind, scaled to what actually
    // reached the bag. Quest goals count the same REAL amount that entered
    // the bag (granted), never the rolled amount.
    this.grantXp(outcome.xp);
    if (outcome.itemId && outcome.granted > 0) {
      this.settleQuests(
        this.quests.progress({ type: 'gather', target: outcome.itemId, count: outcome.granted }),
      );
    }
    const remaining = this.world.damageNode(node.id, 1);
    if (remaining <= 0) {
      this.floraRefresh();
      if (node.kind === 'bush') {
        this.bushRegrow.set(node.id, performance.now() + 90_000);
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

    if (s.phase === 'fall' && this.input.consumePress('close')) {
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
        // Tell the server: sleeping moves the WORLD's clock, not just yours,
        // so everyone else in this world wakes up too (and cannot be left
        // standing in a night that only existed on their own screen).
        if (this.mpConnected) this.mp!.sendSleep();
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
    // Potions do not survive death, and a fresh corpse gets a short
    // immunity window (validIncomingHit gates on lastHitTakenAt).
    this.swiftT = 0;
    this.nightT = 0;
    this.lastHitTakenAt = this.combatT;
    if (this.shopOpen) this.setShopOpen(false);
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
    /**
     * Presentation clock. The simulation above runs on a 50 ms clamp so a
     * stutter cannot teleport the player, but that clamp also means a slow
     * machine plays the world in slow motion — and the things a PLAYER judges
     * by eye (how fast the zoom follows the wheel, how long a chip stays up)
     * must not inherit it, or a 4 fps laptop would take ten seconds to reach
     * first person. Capped at 250 ms so a tab that was in the background
     * cannot make the camera jump the whole way in one frame.
     */
    const viewDt = Math.min(rawDt, 0.25);
    this.lighting.update(dt);
    this.water.update(dt);
    this.atmosphere.update(dt, this.lighting.dayFactor);
    this.postfx.update(dt);

    // Shared clock. The server owns the day/night cycle now (see
    // server/clock.mjs): we run the clock ourselves between the 2 s updates
    // and ease towards the server value, so two players in one world always
    // see the same sky — instead of each running their own private sun.
    if (this.worldClock.synced && !this.sleep) {
      this.lighting.setTimeOfDay(this.worldClock.follow(this.lighting.timeOfDay, dt));
    }

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

    // Planters: the owner's crops grow while the owner is nearby, and the
    // toast announces the moment a tray turns ripe (see systems/farm.ts).
    for (const b of this.world.buildings) {
      if (!isPlanter(b)) continue;
      const before = growthOf(b);
      const after = growPlanter(b, dt, this.localId, this.controller.pos);
      if (before < PLANTER_SECONDS && after >= PLANTER_SECONDS && !this.planterRipe.has(b.id)) {
        this.planterRipe.add(b.id);
        this.hud.toast(`De bessen in je bloempot zijn rijp — E om te plukken`);
      }
      if (after < PLANTER_SECONDS) this.planterRipe.delete(b.id);
    }

    // Mouse look. The delta goes to whichever view is being rendered (see
    // pitchOwner), because the two views keep separate look angles — and each
    // view integrates its OWN deltas. Reading the other view's angle as a base
    // would copy the shoulder-cam's 37° down-angle into the first-person one on
    // any frame without movement, which is exactly what the first build did.
    if (this.input.pointerLocked && !dead) {
      const m = this.input.consumeMouseDelta();
      const dy = m.y * BASE_MOUSE_LOOK * this.mouseSens;
      this.camYaw += m.x * BASE_MOUSE_LOOK * this.mouseSens;
      if (pitchOwner(this.camDist) === 'first') {
        this.camPitchFirst = clampCameraPitch(this.camPitchFirst - dy);
      } else {
        this.camPitch = clampCameraPitch(this.camPitch - dy);
      }
    } else {
      this.input.consumeMouseDelta();
    }

    // Scrollwheel: zoom the camera, all the way into first person and back out.
    // Read every frame, also while dead or unlocked: a wheel gesture must never
    // end up scrolling the page instead (input.ts preventDefaults it either
    // way), and "dead but still zooming" is cheaper than a special case.
    const wheel = this.input.consumeWheelZoom();
    if (wheel !== 0) {
      this.camDistTarget = zoomDistance(this.camDistTarget, wheel);
      // A zoom is a deliberate gesture: say which view it produced.
      this.camPillT = 1.6;
      this.hud.setCameraView(isFirstPerson(this.camDistTarget), true);
      // …and remember it for the next session — but only once the gesture
      // burst is over. A trackpad delivers dozens of wheel events per second,
      // and localStorage is synchronous: writing per event would stall frames.
      this.camSaveT = 0.7;
    }
    if (this.camSaveT > 0) {
      this.camSaveT = Math.max(0, this.camSaveT - viewDt);
      if (this.camSaveT === 0) this.saveControls();
    }
    if (this.camPillT > 0) {
      this.camPillT = Math.max(0, this.camPillT - viewDt);
      if (this.camPillT === 0) this.hud.setCameraView(isFirstPerson(this.camDistTarget), false);
    }
    this.camDist = smoothCamDist(this.camDist, this.camDistTarget, viewDt);

    // Right mouse button: give the mouse BACK to the browser, so the cursor
    // can reach the HUD buttons (hotbar slots, panel close crosses). Left
    // click on the world takes it again (input.ts onClick). Asymmetric on
    // purpose: if RMB also re-grabbed, a stray right-click during an inventory
    // click would throw the cursor away mid-click.
    if (this.input.consumeInterfacePress('Mouse2')) this.input.releasePointer();
    // The lock can also end without us: Esc, alt-tab, clicking another window.
    // The HUD chip must follow the REAL state, not the state we requested.
    const pointerFree = !this.input.pointerLocked;
    if (pointerFree !== this.pointerShown) {
      this.pointerShown = pointerFree;
      this.hud.setPointerReleased(pointerFree);
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
        if (result === 'crafting' || result === 'blocked') {
          this.hud.setProgress(this.craft.progress);
          if (result === 'blocked' && !this.craftBlockedNotified) {
            this.craftBlockedNotified = true;
            const out = this.craft.recipe.output.id;
            this.hud.toast(`Rugzak vol — maak ruimte voor ${ITEMS[out]?.name ?? out}`);
          }
        } else {
          const recipe = this.craft.recipe;
          this.craft = null;
          this.craftBlockedNotified = false;
          this.hud.setProgress(null);
          if (result === 'done') {
            this.hud.toast(`Gemaakt: ${ITEMS[recipe.output.id].name} x${recipe.output.count}`);
            // Progression: a completed craft pays XP.
            this.grantXp(XP_SOURCE.craft);
            this.settleQuests(
              this.quests.progress({
                type: 'craft',
                target: recipe.output.id,
                count: recipe.output.count,
              }),
            );
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
        if (result === 'cooking' || result === 'blocked') {
          this.hud.setProgress(this.cook.progress);
          if (result === 'blocked' && !this.cookBlockedNotified) {
            this.cookBlockedNotified = true;
            const out = this.cook.outputId;
            this.hud.toast(`Rugzak vol — maak ruimte voor ${ITEMS[out]?.name ?? out}`);
          }
        } else {
          // Grab the cooked output id BEFORE the session is cleared: the
          // 'Gekookt' toast below (and cook quest goals) need it.
          const cookedOut = this.cook.outputId;
          this.cook = null;
          this.cookBlockedNotified = false;
          this.hud.setProgress(null);
          if (result === 'done') {
            this.hud.toast('Gekookt');
            // Progression: a completed cook pays XP.
            this.grantXp(XP_SOURCE.cook);
            this.settleQuests(this.quests.progress({ type: 'cook', target: cookedOut, count: 1 }));
          } else {
            this.hud.toast('Het vuur is gedoofd — koken afgebroken');
          }
          this.refreshHud(true);
        }
      }

      // Player physics (movement locked while crafting — standing still).
      // Walls block the player horizontally within their own height band;
      // floors and roofs are the horizontal surfaces to stand on. Both come
      // straight from world state, so a friend's house is solid here too.
      const walls: WallSegment[] = this.world.buildings
        .filter((b) => isBlocking(b.kind, !!b.open))
        .map(wallSegment);
      const platforms: Platform[] = this.world.buildings.flatMap(buildingPlatforms);
      this.controller.crouching = this.input.crouch;
      this.controller.update(
        dt,
        this.input,
        this.camYaw,
        this.colliders,
        this.stats.canSprint(),
        walls,
        platforms,
        !(this.craft || this.cook),
      );

      // Fall impact: the controller reports each solid landing after a
      // genuine airborne fall (water landings are absorbed, no event).
      // Fall damage is local per player; no MP protocol change needed.
      const impact = this.controller.consumeImpact();
      if (impact) {
        const raw = computeFallDamage(impact.distance, impact.crouching);
        // A raised shield eats half of a hard landing (and pays wear for it).
        const fall = this.absorb(raw);
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

      // Combat + potion buff timers. combatT only runs while ALIVE (this
      // whole block is skipped on death), so a corpse can neither swing
      // nor be re-hit.
      this.combatT += dt;
      if (this.swiftT > 0) this.swiftT = Math.max(0, this.swiftT - dt);
      if (this.nightT > 0) this.nightT = Math.max(0, this.nightT - dt);
      if (this.swingT > 0) this.swingT = Math.max(0, this.swingT - dt);
      this.controller.speedScale = this.swiftT > 0 ? SWIFT_SPEED_MULTIPLIER : 1;
      if (this.nightLight) {
        this.nightLight.intensity =
          this.nightT > 0 ? Math.min(1, Math.min(this.nightT, 2) / 2) * 1.2 : 0;
      }

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
      // player stands still and works: only the cancel key and Esc are
      // honoured, everything else is ignored. While a REBIND is open the
      // presses are discarded outright: the captured key must not also act.
      if (this.rebinding) {
        this.input.clearPresses();
      } else if (this.craft || this.cook) {
        if (this.input.consumePress('craft') || this.input.consumePress('close')) {
          if (this.craft) this.cancelCraft('Afgebroken');
          else this.cancelCook('Afgebroken');
          this.craftingOpen = false;
          this.refreshHud(true);
        }
      } else {
        // E/R mutate the inventory (add wood, drink, eat) — while the panel
        // is open the player is managing items blind (no prompt shown), so
        // those are ignored; the bag key and the close key still work. B also
        // stays closed while the panel is open (one Esc closes one layer).
        if (!this.invOpen && this.input.consumePress('interact')) this.handleEPress(pick?.target ?? null);
        if (!this.invOpen && this.input.consumePress('craft')) {
          this.craftingOpen = !this.craftingOpen;
          this.refreshHud(true);
        }
        if (this.input.consumePress('drop')) {
          // While the inventory is open, drop works from the UI cursor.
          if (this.invOpen && this.invCursor) this.dropFromCursor();
          else if (!this.invOpen) this.dropSelected();
        }
        if (this.input.consumePress('inventory') || (this.invOpen && this.input.consumePress('close'))) {
          this.toggleInventory();
        }
        if (!this.invOpen && this.input.consumePress('consume')) this.tryConsume();
        // The attack key swings the selected weapon: a sword punches what the
        // crosshair rests on, a Jachtboog shoots it (up to BOW_RANGE). Remote
        // players are only ever hit by a melee swing — see tryMeleeAttack.
        if (!this.invOpen && this.input.consumePress('attack')) {
          if (this.selectedItemId() === 'bow') this.tryShoot(pick?.target ?? null);
          else this.tryMeleeAttack(pick?.target ?? null);
        }
        // Settings panel: holds the controls, the mouse sensitivity and the
        // world reset behind a two-click confirm. Deliberately not tied to
        // Ctrl+R: browsers hard-reload on that, and a lost save was one
        // keystroke away.
        if (this.input.consumePress('settings')) {
          this.setSettingsOpen(!this.settingsOpen);
        }
        if (this.settingsOpen && this.input.consumePress('close')) {
          this.setSettingsOpen(false);
        }
        // Hotbar: the eight slot keys are one group (rebindable per slot).
        const slot = this.input.consumeSlotPress();
        if (slot >= 0) {
          this.inventory.select(slot);
          this.refreshHud(true);
        }
        // Build height: lifts the next placement one grid step (0.3 m) at a
        // time, so floors can be levelled on uneven terrain.
        if (this.input.consumePress('buildUp')) this.adjustBuildLevel(1);
        if (this.input.consumePress('buildDown')) this.adjustBuildLevel(-1);
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
    this.updateAnimals(dt);
    this.witchTick?.(dt, this.combatT);
    this.updateRemotes(dt);
    this.updateFps(rawDt);
    this.syncBuildingShadows();

    // Multiplayer position relay
    if (this.mp && !dead) {
      this.mp.sendPos(
        this.controller.pos.x,
        this.controller.pos.y,
        this.controller.pos.z,
        this.charYaw,
      );
      // Progress relay needs no extra timer: the 15 s autosave tick calls
      // persist(), which uploads a snapshot here instead of writing
      // localStorage (see persist()), and does the same on unload.
    }
  }

  private updateBuildingPreview(_pick: { target: InteractTarget } | null): void {
    const sel = this.selectedItemId();
    if (!sel || !BUILDING_KINDS.has(sel)) {
      this.renderer.clearPreview();
      return;
    }
    const kind = sel as BuildingData['kind'];
    const spot = this.placementFor(kind);
    if (!spot) {
      this.renderer.clearPreview();
      return;
    }
    this.renderer.setPreviewValid(spot.error === null);
    this.renderer.preview(kind, spot.x, spot.z, spot.baseY, spot.rot);
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
        case 'door': {
          const b = this.world.buildings.find((x) => x.id === t.id);
          text = b?.open ? 'Druk E — Deur sluiten' : 'Druk E — Deur openen';
          break;
        }
        case 'planter': {
          const b = this.world.buildings.find((x) => x.id === t.id);
          if (b) {
            text = isRipe(b)
              ? `Druk E — Rijpe bessen plukken (${PLANTER_YIELD})`
              : `Bessen in de bloempot groeien (${Math.round(planterFraction(b) * 100)}%)`;
          }
          break;
        }
        case 'workbench':
          text = this.craftingOpen
            ? 'Tekentafel — menu is open (B/Esc sluit)'
            : 'Druk E — Aan de tekentafel alles maken';
          break;
        case 'animal': {
          const a = this.animals.find((x) => x.id === t.id);
          text = a
            ? `Houd F — ${ANIMALS[a.kind].name} jagen (vlees${a.kind === 'sheep' ? ' + wol' : ' + leder'})`
            : null;
          break;
        }
        case 'witch':
          text = 'Druk E — Ruilen met de heks (drankjes)';
          break;
        case 'player':
          text = 'LMB — Aanvallen';
          break;
      }
    }
    // Fallback hint: a building item in the selected slot explains the grid.
    if (text === null) {
      const sel = this.selectedItemId();
      if (isConsumable(sel)) text = `Druk R — ${ITEMS[sel].name} eten`;
      else if (sel && BUILDING_KINDS.has(sel)) text = 'Druk E — Plaatsen op het bouwraster · PgUp/PgDn — hoogte (muren op vloer-randen)';
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
      // The witch's timed buffs (systems/shop.ts POTION_BUFF_SECONDS).
      const buff = POTION_BUFF_SECONDS[itemId];
      if (buff) {
        if (itemId === 'potion_swift') {
          this.swiftT = buff;
          this.hud.toast('Drankje werkt — je bent sneller dan de wind (90s)');
        } else if (itemId === 'potion_night') {
          this.nightT = buff;
          this.hud.toast('Drankje werkt — het donker kan je nu niets schelen (120s)');
        }
      }
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

  /**
   * The rig for this frame. Kept separate from the frame loop so the rules the
   * zoom introduced (sleep, caves, the body mesh) each have one obvious home
   * instead of five conditions spread over the math.
   */
  private updateCamera(): void {
    if (this.nightLight) {
      // Night-sight aura rides the camera (intensity gated in update()).
      this.nightLight.position.copyFrom(this.camera.position);
      this.nightLight.position.y += 0.5;
    }
    const target = this.sleep
      ? new Vector3(this.sleep.bed.x, this.sleep.bed.y + 0.9, this.sleep.bed.z)
      : new Vector3(
          this.controller.pos.x,
          this.controller.pos.y + pivotHeight(this.controller.crouching, this.renderDist()),
          this.controller.pos.z,
        );
    const dist = this.renderDist();
    // Each view has its own pitch; the zoom blends between them (cameraRig).
    const pitch = blendPitch(this.camPitch, this.camPitchFirst, dist);
    const cp = Math.cos(pitch);
    const dir = new Vector3(Math.sin(this.camYaw) * cp, Math.sin(pitch), Math.cos(this.camYaw) * cp);

    // Terrain occlusion: cast the look ray from the player TOWARD the camera
    // against the rendered mesh. When a hill sits between them, pull the
    // camera in to just in front of the surface so the player never looks
    // through terrain (a plain min-height clamp at the camera position can
    // still let the sightline dip under a slope).
    //
    // Skipped in first person: there is nothing between the eyes and the
    // world, and the pull-in exists only to keep the CHARACTER on screen —
    // running it here would shove the camera out of the player's own head.
    let effDist = dist;
    const fp = isFirstPerson(dist);
    if (!fp) {
      const hit = terrainRayHit(target.x, target.y, target.z, -dir.x, -dir.y, -dir.z, dist);
      if (hit && hit.t < dist) {
        effDist = Math.max(occlusionFloor(dist), hit.t - CAMERA_SURFACE_OFFSET);
      }
    }

    let px = target.x - dir.x * effDist;
    let py = target.y - dir.y * effDist;
    let pz = target.z - dir.z * effDist;
    // At full zoom the eye point IS the camera; five centimetres of backlash
    // keeps it from coinciding with its own target (see eyeBacklash).
    if (fp) {
      const back = eyeBacklash(effDist);
      px = target.x - dir.x * back;
      py = target.y - dir.y * back;
      pz = target.z - dir.z * back;
    }

    // Final safety net: keep the camera above the RENDERED mesh height
    // (triangulated), not the analytic curve, so it never dips under the
    // ground the player can see.
    //
    // Not applied in first person. There the eye height is not a guess to be
    // corrected — it is the physics body, which already stands on whatever
    // surface is really there, including a cave floor BELOW the terrain curve.
    // Clamping to the terrain there would lift the player out of the cave and
    // straight up through the hillside.
    if (!fp) {
      const minY = Math.max(groundHeight(px, pz) + 0.5, SEA_LEVEL + 0.25);
      if (py < minY) py = minY;
    }

    this.camera.position.set(px, py, pz);
    this.camera.setTarget(target);

    // The character mesh must disappear before the camera reaches the head;
    // the hysteresis lives in cameraRig so the zoom cannot strobe it.
    const showBody = this.sleep ? true : bodyVisible(dist, this.bodyShown);
    if (showBody !== this.bodyShown) {
      this.bodyShown = showBody;
      this.character.root.setEnabled(showBody);
    }
  }

  /**
   * The distance to render this frame. Sleeping always pulls back to the
   * shipped shoulder-cam: the sleep animation is something the player watches
   * FROM OUTSIDE, and a first-person close-up of the inside of a bedroll is
   * not the intent of pressing E on a bed. The saved zoom is untouched, so
   * waking up returns to exactly the view the player zoomed to.
   */
  private renderDist(): number {
    return this.sleep ? CAM_DIST_DEFAULT : this.camDist;
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

  /**
   * Place the herd: 4 sheep + 3 cows on dry ground in a ring around the
   * camp, deterministic from WORLD_SEED (same world, same herd spots). A
   * spot over the sea line or crowding the villagers is re-drawn.
   */
  private spawnFauna(): void {
    const rng = mulberry32((WORLD_SEED ^ 0x5eed17) >>> 0);
    const roster: AnimalKind[] = ['sheep', 'sheep', 'sheep', 'sheep', 'cow', 'cow', 'cow'];
    for (const kind of roster) {
      for (let tries = 0; tries < 32; tries++) {
        const spot = herdSpot(this.camp, rng, 16, 46);
        if (groundSurfaceHeight(spot.x, spot.z) < SEA_LEVEL + 0.5) continue;
        const a = new Animal(
          this.scene,
          `an_${++this.animalSeq}`,
          kind,
          spot.x,
          spot.z,
          (WORLD_SEED + this.animalSeq * 7919) >>> 0,
          this.mats,
        );
        for (const m of a.shadowMeshes) this.lighting.addShadowCaster(m);
        this.animals.push(a);
        break;
      }
    }
  }

  private updateAnimals(dt: number): void {
    // The herd freezes during conversations, death and sleep — the same
    // courtesy the villagers get, and no animal can be hunted mid-cutscene.
    const frozen = this.activeNpc !== null || !!this.sleep || this.stats.dead;
    const p = this.controller.pos;
    for (const a of this.animals) a.update(dt, p.x, p.z, frozen);
    // Remove animals whose collapse animation finished.
    for (let i = this.animals.length - 1; i >= 0; i--) {
      const a = this.animals[i];
      if (a.gone) {
        for (const m of a.shadowMeshes) this.lighting.removeShadowCaster(m);
        a.dispose();
        this.animals.splice(i, 1);
      }
    }
  }

  /**
   * Hold-F hunting, the animal twin of updateGathering: one landed hit per
   * `hitSeconds`, a hit animal flees, a dead one drops its loot table.
   * A killing blow only lands while the bag can still receive the main
   * item (same no-silent-loss rule as harvesting).
   */
  private updateHunting(dt: number, target: { kind: 'animal'; id: string }): void {
    const animal = this.animals.find((a) => a.id === target.id && a.alive);
    if (!animal) {
      this.hunting = null;
      this.hud.setProgress(null);
      return;
    }
    const g =
      this.hunting && this.hunting.id === animal.id
        ? this.hunting
        : (this.hunting = { id: animal.id, progress: 0 });
    g.progress += dt / ANIMALS[animal.kind].hitSeconds;
    this.hud.setProgress(Math.min(1, g.progress));
    if (g.progress < 1) return;

    const def = ANIMALS[animal.kind];
    const mainDrop = def.drops[0].itemId;
    if (!this.inventory.canAdd(mainDrop, 1)) {
      g.progress = 1;
      this.hud.setProgress(1);
      if (this.animalBlockedNotified !== animal.id) {
        this.animalBlockedNotified = animal.id;
        this.hud.toast(`Rugzak vol — maak ruimte voor ${ITEMS[mainDrop].name}`);
      }
      return;
    }
    this.animalBlockedNotified = null;
    this.hunting = null;
    this.hud.setProgress(null);

    const died = animal.damage(this.controller.pos.x, this.controller.pos.z);
    if (!died) {
      this.hud.toast(`${def.name} slaat op de vlucht!`);
      return;
    }
    this.finishAnimalKill(animal);
  }

  /**
   * Loot + XP for a dead animal — shared by the F-harvest flow and sword
   * kills. Everything drops; the inventory reports what did not fit and
   * the toast says so honestly instead of pretending.
   */
  private finishAnimalKill(animal: Animal): void {
    const def = ANIMALS[animal.kind];
    const got: string[] = [];
    let missed = 0;
    for (const d of rollDrops(animal.kind, Math.random)) {
      const left = this.inventory.add(d.itemId, d.count);
      const fit = d.count - left;
      missed += left;
      if (fit > 0) {
        got.push(`${fit} ${ITEMS[d.itemId].name}`);
        this.settleQuests(this.quests.progress({ type: 'gather', target: d.itemId, count: fit }));
      }
    }
    this.hud.toast(
      `Gestrikt: ${def.name.toLowerCase()} — ${got.join(', ') || 'niets meegekregen'}` +
        (missed > 0 ? ` (${missed} past niet in de rugzak)` : ''),
    );
    this.grantXp(XP_SOURCE.kill);
    this.refreshHud(true);
  }

  /**
   * A sword (or fist) swing at the aimed target. Animals take weapon
   * damage in whole hits; remote players get a `hit` message the server
   * validates and the VICTIM applies to its own stats.
   */
  private tryMeleeAttack(target: InteractTarget | null): void {
    if (!target) return;
    if (!canSwing(this.combatT, this.lastSwingAt)) return;
    const p = this.controller.pos;
    if (!inSwingRange(Math.hypot(target.x - p.x, target.z - p.z))) return;
    const sel = this.selectedItemId();
    if (target.kind === 'animal') {
      const dmg = animalMeleeDamage(sel);
      if (dmg <= 0) return; // F remains the unarmed way to hunt
      const animal = this.animals.find((a) => a.id === target.id && a.alive);
      if (!animal) return;
      this.lastSwingAt = this.combatT;
      this.beginSwing();
      let died = false;
      for (let i = 0; i < dmg; i++) {
        died = animal.damage(p.x, p.z);
        if (died) break;
      }
      if (!died) {
        this.hud.toast(`${ANIMALS[animal.kind].name} slaat op de vlucht!`);
        return;
      }
      this.finishAnimalKill(animal);
    } else if (target.kind === 'player') {
      this.lastSwingAt = this.combatT;
      this.beginSwing();
      if (this.mpConnected) this.mp!.sendHit(target.id, playerMeleeDamage(sel));
    }
  }

  /**
   * An arrow from the Jachtboog at whatever the crosshair rests on, up to
   * BOW_RANGE metres (systems/combat.ts). The shot is paid for twice: one
   * arrow out of the quiver and one draw animation of bow wear, so ammo and
   * durability limit hunting rather than a cooldown you can spam past.
   *
   * Animals only, deliberately: PvP damage is applied by the VICTIM after a
   * server check that gates on melee reach (PVP_MAX_HIT_DISTANCE), so a ranged
   * claim would be rejected by design. An arrow is still the honest answer to
   * a herd you would rather not walk into.
   */
  private tryShoot(target: InteractTarget | null): void {
    if (!canShoot(this.combatT, this.lastShotAt)) return;
    const sel = this.selectedItemId();
    const dmg = animalRangedDamage(sel);
    if (dmg <= 0 || !target || target.kind !== 'animal') return;
    const p = this.controller.pos;
    if (!inBowRange(Math.hypot(target.x - p.x, target.z - p.z))) return;
    const animal = this.animals.find((a) => a.id === target.id && a.alive);
    if (!animal) return;
    if (this.inventory.count(ARROW_AMMO) <= 0) {
      this.hud.toast('Geen pijlen meer — maak nieuwe (B → Pijl)');
      // Costing the draw anyway keeps that toast from repeating every frame.
      this.lastShotAt = this.combatT;
      return;
    }

    this.lastShotAt = this.combatT;
    this.swingT = SHOOT_ANIM_TIME;
    this.character.startSwing();
    this.inventory.remove(ARROW_AMMO, 1);
    const wear = wearTool(this.inventory, this.inventory.selected, SHOOT_ANIM_TIME);
    if (wear.broke) this.hud.toast('Je boog is uit elkaar geklapt!');

    let died = false;
    for (let i = 0; i < dmg; i++) {
      died = animal.damage(p.x, p.z);
      if (died) break;
    }
    if (!died) {
      this.hud.toast(`${ANIMALS[animal.kind].name} slaat op de vlucht!`);
      return;
    }
    this.finishAnimalKill(animal);
  }

  /**
   * Start the slash animation and pay the swing's tool wear (one swing
   * animation of `wearPerSec` — the sword outlives ~200 strikes, then
   * shatters like any other tool).
   */
  private beginSwing(): void {
    this.swingT = SWING_ANIM_TIME;
    this.character.startSwing();
    const wear = wearTool(this.inventory, this.inventory.selected, SWING_ANIM_TIME);
    if (wear.broke) this.hud.toast('Je zwaard is gebroken!');
  }

  /**
   * Close a carved cave chamber (ceiling plug + crystals + light) for
   * every site in world/caves.ts. The floor itself is terrain: the height
   * field carving makes mesh, physics and flora agree automatically.
   */
  private buildCaves(): void {
    for (const site of CAVE_SITES) {
      this.decor.push(buildCaveInterior(this.scene, this.mats, site));
    }
  }

  /**
   * The witch's cottage: hut + figure on a scanned flat pad, facing the
   * NPC camp so players walking over see the door and the cauldron.
   */
  private buildWitchSite(): void {
    const gy = groundHeight(WITCH_HOME.x, WITCH_HOME.z);
    const { root, decor } = buildWitchHut(this.scene, this.mats);
    root.position.set(WITCH_HOME.x, gy - 0.12, WITCH_HOME.z);
    root.rotation.y = Math.atan2(this.camp.x - WITCH_HOME.x, this.camp.z - WITCH_HOME.z);
    this.decor.push(decor);

    const witch = buildWitch(this.scene);
    // Standing at the cauldron (local offset, rotated with the hut).
    const cos = Math.cos(root.rotation.y);
    const sin = Math.sin(root.rotation.y);
    const lx = 3.1;
    const lz = 3.9;
    witch.root.position.set(
      WITCH_HOME.x + lx * cos + lz * sin,
      gy,
      WITCH_HOME.z - lx * sin + lz * cos,
    );
    witch.root.rotation.y = root.rotation.y + Math.PI; // face her cauldron
    this.witchRoot = witch.root;
    this.witchTick = witch.update;
    this.witchAt.set(witch.root.position.x, gy + 1.1, witch.root.position.z);
  }

  /** Open/close the witch's barter panel (releases the pointer lock). */
  private setShopOpen(open: boolean): void {
    this.shopOpen = open;
    this.hud.setShop(open, this.shopRows());
    if (open) {
      try {
        document.exitPointerLock?.();
      } catch {
        /* not locked, nothing to release */
      }
    }
  }

  private shopRows(): Array<{ id: string; name: string; price: string; afford: boolean }> {
    return SHOP_OFFERS.map((o) => ({
      id: o.id,
      name: ITEMS[o.gives].name,
      price: priceLabel(o, (id) => (ITEMS[id]?.name ?? id).toLowerCase()),
      afford: offerAffordable(this.inventory, o),
    }));
  }

  private doTrade(offerId: string): void {
    const offer = SHOP_OFFERS.find((o) => o.id === offerId);
    if (!offer) return;
    if (performTrade(this.inventory, offer)) {
      this.hud.toast(`Geruild: ${ITEMS[offer.gives].name}`);
      this.hud.setShop(true, this.shopRows());
      this.refreshHud(true);
    } else {
      this.hud.toast('Ruild niet — te weinig materiaal of te volle rugzak');
    }
  }

  private updateRemotes(dt: number): void {
    this.avatars.update(dt);
    this.avatars.project(this.camera);
  }

  /**
   * FPS display. Deliberately fed the RAW frame time (see frame()): the
   * simulation clamps dt to 50 ms, and averaging that clamped value made
   * the HUD report ~20 fps even when the engine rendered at 1 fps.
   */
  private updateFps(rawDt: number): void {
    if (this.fpsMeter.tick(rawDt)) this.hud.setFps(this.fpsMeter.fps);
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
    const atTable = this.atWorkbench();
    const can = new Set(
      RECIPES.filter((r) => Crafting.canCraft(this.inventory, r, this.progress.level, atTable)).map((r) => r.id),
    );
    this.hud.setCrafting(
      this.craftingOpen,
      can,
      this.craft ? this.craft.recipe.id : null,
      this.progress.level,
      atTable,
    );
    // Keep the witch's affordability columns honest while her panel is open
    // (the player could trade from the hotbar side, or consume materials).
    if (this.shopOpen) this.hud.setShop(true, this.shopRows());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Remove EVERY listener this game added, with the exact handler identity
    // it was added with (the old code passed a fresh arrow function, so the
    // unload hook — and all five hud-* hooks — stayed attached forever).
    window.removeEventListener('beforeunload', this.persistOnUnload);
    for (const { type, handler } of this.windowListeners) {
      window.removeEventListener(type, handler);
    }
    this.windowListeners.length = 0;
    if (this.chatTimer) {
      clearTimeout(this.chatTimer);
      this.chatTimer = null;
    }
    this.pendingChat = null;
    this.mp?.disconnect();
    this.input.detach();
    this.character.dispose();
    for (const npc of this.npcs) npc.dispose();
    this.avatars.dispose();    this.atmosphere.dispose();
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
