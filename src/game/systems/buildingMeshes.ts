import {
  Color3,
  Color4,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  PBRMaterial,
  PointLight,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import type { SharedMaterials } from '../visual/materials';
import type { BuildingData } from '../world/types';
import {
  BUILDING_MODULE,
  FENCE_HEIGHT,
  FLOOR_SURFACE_OFFSET,
  ROOF_PITCH,
  ROOF_RIDGE_OFFSET,
  ROOF_SPAN,
  STAIRS_RISE,
  WALL_HEIGHT,
  type BuildingKind,
} from './building';

export interface BuildingHandle {
  id: string;
  dispose: () => void;
  /** Update campfire/torch state (fuel, flicker). */
  setFuel?: (fuel: number, time: number) => void;
  /** Swing a door open or shut (rotates the live hinge — no rebuild). */
  setOpen?: (open: boolean) => void;
}

export interface MeshHandle {
  meshes: Mesh[];
  dispose: () => void;
  /** Door only: the live hinge node the open/close rotation drives. */
  hinge?: TransformNode;
}

/** Small radial-gradient texture for fire particles (procedural, no assets). */
function fireTexture(scene: Scene): DynamicTexture {
  const dt = new DynamicTexture('fireTex', { width: 64, height: 64 }, scene, false);
  const ctx = dt.getContext();
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(255, 240, 180, 1)');
  g.addColorStop(0.4, 'rgba(255, 140, 40, 0.9)');
  g.addColorStop(1, 'rgba(120, 30, 0, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  dt.update();
  return dt;
}

/** Deterministic 32-bit string hash (FNV-1a). */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Renders placed buildings from world state with hand-built timber and
 * stone geometry (posts, planks, sloped roof slabs, stone rings) instead
 * of flat boxes. Each building gets deterministic micro-variation from its
 * id so structures look handmade but are stable across reloads.
 */
export class BuildingRenderer {
  private handles = new Map<string, BuildingHandle>();
  private standalone = new Set<string>();
  private fireTex: DynamicTexture | null = null;
  private char: StandardMaterial;
  private woodVars: PBRMaterial[] | null = null;
  private roofTiles: PBRMaterial | null = null;
  private mattress: PBRMaterial | null = null;
  private pillow: PBRMaterial | null = null;
  private rugMat: PBRMaterial | null = null;
  private rugTrimMat: PBRMaterial | null = null;
  private leatherMat: PBRMaterial | null = null;
  private scene: Scene;
  private mats: SharedMaterials;
  private casters: Mesh[] = [];
  /** Seconds of fire time used for the light flicker (driven by the game loop). */
  private fireTime = 0;

  constructor(scene: Scene, mats: SharedMaterials) {
    this.scene = scene;
    this.mats = mats;
    this.char = new StandardMaterial('charMat', scene);
    this.char.diffuseColor = new Color3(0.06, 0.05, 0.045);
    this.char.specularColor = new Color3(0.02, 0.02, 0.02);
  }

  /** All solid building meshes, for shadow registration. */
  getShadowCasters(): Mesh[] {
    return this.casters;
  }

  /**
   * Per-frame campfire state push: light intensity, particle rate and the
   * ember bed follow the fuel (the fire fades out during its final
   * seconds and goes fully dark at zero). O(1) map lookup, cheap enough
   * to run for every fire every frame.
   */
  setFireState(id: string, fuel: number, dt: number): void {
    this.fireTime += dt;
    this.handles.get(id)?.setFuel?.(fuel, this.fireTime);
  }

  /** Render all buildings not yet present. */
  sync(buildings: BuildingData[]): void {
    for (const b of buildings) {
      if (!this.handles.has(b.id)) this.create(b);
    }
    for (const [id, h] of this.handles) {
      if (this.standalone.has(id)) continue;
      const b = buildings.find((x) => x.id === id);
      if (!b) {
        h.dispose();
        this.handles.delete(id);
      } else {
        if (h.setFuel) h.setFuel(b.fuel ?? 0, this.fireTime);
        // A door toggled by anyone (E locally or a 'toggle' in MP) swings
        // the live hinge — cheap, and the open flag rides on world state.
        if (h.setOpen) h.setOpen(!!b.open);
      }
    }
  }

  /** Create a fire/structure that is NOT part of world state (decorative). */
  createStandalone(data: BuildingData): void {
    if (this.handles.has(data.id)) return;
    this.standalone.add(data.id);
    this.create(data);
  }

  /** Ghost preview for a building item the player is about to place. */
  preview(kind: BuildingKind, x: number, z: number, y: number, rot: number): MeshHandle {
    if (!this.previewHandle || this.previewKind !== kind) {
      this.disposePreview();
      this.previewHandle = this.buildMesh(kind, x, z, y, rot, true);
      this.previewKind = kind;
      for (const m of this.previewHandle.meshes) m.material = this.mats.ghost;
      // A footprint ring on the ground: at build distance the 3D ghost alone
      // is hard to read — the ring shows exactly which module you will fill.
      const footRoot = this.previewHandle.meshes[0]?.parent;
      if (footRoot instanceof TransformNode) {
        const ring = MeshBuilder.CreateDisc('ghostFoot', { radius: 0.94, tessellation: 28 }, this.scene);
        ring.parent = footRoot;
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.04;
        ring.material = this.mats.ghost;
      }
    }

    const root = this.previewHandle.meshes[0]?.parent;
    if (root instanceof TransformNode) {
      root.position.set(x, y, z);
      root.rotation.y = (rot / 4) * Math.PI * 2;
    }
    return this.previewHandle;
  }

  setPreviewValid(valid: boolean): void {
    this.mats.ghost.diffuseColor.set(
      valid ? 0.42 : 0.72,
      valid ? 0.62 : 0.16,
      valid ? 0.48 : 0.12,
    );
    // Unlit already, but a touch of glow keeps the ghost readable at night
    // and marks an illegal spot in angry red even in shadow.
    this.mats.ghost.emissiveColor.set(
      valid ? 0.04 : 0.22,
      valid ? 0.13 : 0.03,
      valid ? 0.09 : 0.02,
    );
  }

  clearPreview(): void {
    this.disposePreview();
  }

  private previewHandle: MeshHandle | null = null;
  private previewKind: BuildingKind | null = null;

  private disposePreview(): void {
    this.previewHandle?.dispose();
    this.previewHandle = null;
    this.previewKind = null;
  }

  // ------------------------------------------------------------------
  // Geometry builders
  // ------------------------------------------------------------------

  private buildMesh(
    kind: BuildingKind,
    x: number,
    z: number,
    y: number,
    rot: number,
    ghost: boolean,
  ): MeshHandle {
    const scene = this.scene;
    const name = ghost ? 'ghost' : `building_${kind}`;
    const root = new TransformNode(name + '_root', scene);
    root.position.set(x, y, z);
    root.rotation.y = (rot / 4) * Math.PI * 2;

    const rand = mulberry(hashStr(kind + '_' + x.toFixed(1) + '_' + z.toFixed(1)));
    // One wood tone per building (from its own id-hash), so a camp of four
    // walls reads as four buildings and not one cloned prefab. The variants
    // are shared singletons — tinted clones of the plank material, no
    // per-building material churn, no disposal bookkeeping.
    const wood = this.woodVariant(rand);
    const meshes: Mesh[] = [];
    /** Door only: the live hinge node, handed back to create(). */
    let hingeOut: TransformNode | undefined;

    /** Add a box relative to the building origin. */
    const box = (w: number, h: number, d: number, mat: PBRMaterial, px: number, py: number, pz: number, rx = 0, rz = 0): Mesh => {
      const m = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene);
      m.parent = root;
      m.position.set(px, py, pz);
      m.rotation.x = rx;
      m.rotation.z = rz;
      m.material = mat;
      m.receiveShadows = false;
      if (!ghost) m.freezeWorldMatrix();
      meshes.push(m);
      return m;
    };

    const stone = this.mats.buildingStone;
    // Fence posts, bench legs and sign legs are debarked trunks, not milled
    // planks — the bark material is what makes them read as cut from a tree.
    const barkMat = this.mats.bark;
    // Thatch-and-clay roof tone: slabs read as a roof, not as a flat wall
    // that got tilted.
    const roofMat = (): PBRMaterial => {
      this.roofTiles ??= this.makeFabric('roofTilesMat', 0.36, 0.17, 0.12, 0.92);
      return this.roofTiles;
    };

    // Bed fabrics (lazily created, shared by all beds).
    const mattress = (): PBRMaterial => {
      this.mattress ??= this.makeFabric('bedMat', 0.78, 0.72, 0.6, 0.95);
      return this.mattress;
    };
    const pillow = (): PBRMaterial => {
      this.pillow ??= this.makeFabric('bedPillowMat', 0.88, 0.85, 0.76, 0.92);
      return this.pillow;
    };
    // Carpet wool + leather straps (lazily created, shared).
    const rug = (): PBRMaterial => {
      this.rugMat ??= this.makeFabric('rugMat', 0.66, 0.24, 0.26, 0.98);
      return this.rugMat;
    };
    const rugTrim = (): PBRMaterial => {
      this.rugTrimMat ??= this.makeFabric('rugTrimMat', 0.85, 0.76, 0.55, 0.98);
      return this.rugTrimMat;
    };
    const leather = (): PBRMaterial => {
      this.leatherMat ??= this.makeFabric('leatherMat', 0.42, 0.27, 0.14, 0.8);
      return this.leatherMat;
    };

    switch (kind) {
      case 'wall': {
        // Built to the exact grid module (BUILDING_MODULE wide) so two walls
        // butt together with no seam. Corner posts with slightly varied
        // heights, three stacked planks and a top rail — reads as built
        // timber, not a flat board.
        const edge = BUILDING_MODULE / 2;
        for (const sx of [-1, 1] as const) {
          const jitter = (rand() - 0.5) * 0.06;
          box(0.24, WALL_HEIGHT + jitter, 0.24, wood, sx * (edge - 0.12), WALL_HEIGHT / 2 + jitter / 2, 0);
        }
        const plankYs = [0.5, 1.22, 1.94];
        for (const py of plankYs) {
          box(BUILDING_MODULE - 0.08, 0.52, 0.16, wood, 0, py + (rand() - 0.5) * 0.05, 0.02);
        }
        box(BUILDING_MODULE, 0.14, 0.2, wood, 0, WALL_HEIGHT - 0.07, 0);
        break;
      }
      case 'stone_wall': {
        // Same footprint as the wooden wall, but courses of neatly squared
        // blocks — three lifts of alternating stones with mortar gaps, a
        // heavier cap row on top. Reads as a mason's wall from 20 m away.
        const edge = BUILDING_MODULE / 2;
        for (const sx of [-1, 1] as const) {
          box(0.28, WALL_HEIGHT + 0.04, 0.28, stone, sx * (edge - 0.14), WALL_HEIGHT / 2, 0);
        }
        const courseH = 0.3;
        const rows = Math.floor((WALL_HEIGHT - 0.3) / courseH);
        for (let r = 0; r < rows; r++) {
          // Offset every other course by half a block (running bond).
          const offset = (r % 2) * 0.42;
          for (let i = 0; i < 3; i++) {
            const cx = -edge + 0.4 + offset + i * 0.84 + (rand() - 0.5) * 0.05;
            if (Math.abs(cx) > edge - 0.24) continue;
            box(
              0.78 + (rand() - 0.5) * 0.08,
              courseH - 0.03,
              0.2 + (rand() - 0.5) * 0.02,
              stone,
              cx,
              0.18 + r * courseH + courseH / 2,
              0,
            );
          }
        }
        // Coping row.
        box(BUILDING_MODULE - 0.1, 0.16, 0.26, stone, 0, WALL_HEIGHT - 0.08, 0);
        break;
      }
      case 'floor': {
        // One full cell of decking: four planks that tile edge to edge, on two
        // stringers. The plank top lands exactly on FLOOR_SURFACE_OFFSET, the
        // height the physics uses to stand on — so feet and visuals agree.
        const edge = BUILDING_MODULE / 2;
        const plankDepth = BUILDING_MODULE / 4;
        const plankHalfThick = 0.05;
        for (const sx of [-0.72, 0.72] as const) {
          box(0.16, 0.12, BUILDING_MODULE, wood, sx, 0.05, 0);
        }
        for (let i = 0; i < 4; i++) {
          const pz = -edge + plankDepth * (i + 0.5);
          box(
            BUILDING_MODULE,
            plankHalfThick * 2,
            plankDepth,
            wood,
            (rand() - 0.5) * 0.04,
            FLOOR_SURFACE_OFFSET - plankHalfThick,
            pz,
            0,
            (rand() - 0.5) * 0.008,
          );
        }
        break;
      }
      case 'roof': {
        // Sits ON TOP of the walls (its base y is the wall tops), not floating
        // above them. Two pitched slabs of exactly ROOF_PITCH meet at a ridge
        // beam at ROOF_RIDGE_OFFSET — the same numbers buildingPlatforms()
        // uses, so walking the roof matches what you see.
        const edge = BUILDING_MODULE / 2;
        const grade = Math.tan(ROOF_PITCH);
        const slabCenter = (ROOF_SPAN - 0.02) / 2; // horizontal mid-point of one slope
        // A hair short of the platform span: the visible eave must never poke
        // past the surface the player can stand on.
        const slabDepth = (ROOF_SPAN - 0.02) / Math.cos(ROOF_PITCH);
        const halfThick = 0.045;
        // Centre height so the TOP face of the slab passes through the ridge
        // height at z = ridge (see the plane maths in the comment above).
        const slabY =
          ROOF_RIDGE_OFFSET - halfThick / Math.cos(ROOF_PITCH) - grade * slabCenter;
        for (const s of [-1, 1] as const) {
          box(BUILDING_MODULE + 0.1, halfThick * 2, slabDepth, roofMat(), 0, slabY, s * slabCenter, s * ROOF_PITCH);
        }
        box(BUILDING_MODULE + 0.15, 0.14, 0.22, wood, 0, ROOF_RIDGE_OFFSET - 0.07, 0);
        // Gable fascias at the two ends of the ridge.
        for (const sx of [-1, 1] as const) {
          box(0.16, 0.3, ROOF_SPAN * 2 - 0.1, roofMat(), sx * (edge + 0.02), ROOF_RIDGE_OFFSET - 0.2, 0);
        }
        // Rafter tails poking below the eaves for silhouette.
        for (const s of [-1, 1] as const) {
          for (let i = 0; i < 3; i++) {
            box(0.1, 0.18, 0.1, wood, -0.7 + i * 0.7, ROOF_RIDGE_OFFSET - 0.32, s * (ROOF_SPAN - 0.06), s * ROOF_PITCH);
          }
        }
        break;
      }
      case 'campfire': {
        // Stone ring: 8 irregular stones.
        for (let i = 0; i < 8; i++) {
          const ang = (i / 8) * Math.PI * 2 + rand() * 0.3;
          const r = 0.56 + (rand() - 0.5) * 0.08;
          const st = MeshBuilder.CreateCylinder(name, {
            diameter: 0.24 + rand() * 0.1,
            height: 0.2 + rand() * 0.1,
            tessellation: 6,
          }, scene);
          st.parent = root;
          st.position.set(Math.cos(ang) * r, 0.11, Math.sin(ang) * r);
          st.rotation.y = rand() * Math.PI;
          st.scaling.set(1, 1, 0.78 + rand() * 0.2);
          st.material = stone;
          st.receiveShadows = false;
          if (!ghost) st.freezeWorldMatrix();
          meshes.push(st);
        }
        // Crossed log bundle leaning toward the centre.
        for (let i = 0; i < 4; i++) {
          const ang = (i / 4) * Math.PI * 2 + 0.4;
          const log = MeshBuilder.CreateCylinder(name + 'log', {
            diameter: 0.11, height: 0.85, tessellation: 6,
          }, scene);
          log.parent = root;
          log.position.set(Math.cos(ang) * 0.16, 0.3, Math.sin(ang) * 0.16);
          log.rotation.set(0.55, ang, 0.3);
          log.material = wood;
          log.receiveShadows = false;
          if (!ghost) log.freezeWorldMatrix();
          meshes.push(log);
        }
        // Charred hearth bed.
        const hearth = MeshBuilder.CreateCylinder(name + 'hearth', {
          diameter: 0.42, height: 0.03, tessellation: 12,
        }, scene);
        hearth.parent = root;
        hearth.position.y = 0.15;
        hearth.material = this.char;
        hearth.receiveShadows = false;
        if (!ghost) hearth.freezeWorldMatrix();
        meshes.push(hearth);
        break;
      }
      case 'bed': {
        // Timber frame bed, long axis along local Z (2.3 m), sleeping
        // surface (mattress top) at y ≈ 0.65 above the building origin.
        for (const sx of [-1, 1] as const) {
          for (const sz of [-1, 1] as const) {
            box(0.12, 0.34, 0.12, wood, sx * 0.42, 0.17, sz * 1.0);
          }
        }
        // Side + end rails.
        for (const sx of [-1, 1] as const) {
          box(0.1, 0.14, 2.16, wood, sx * 0.45, 0.4 + (rand() - 0.5) * 0.02, 0);
        }
        box(0.8, 0.14, 0.1, wood, 0, 0.4, 1.08);
        // Headboard: two posts + top rail.
        for (const sx of [-1, 1] as const) {
          box(0.1, 0.86, 0.1, wood, sx * 0.45, 0.72, -1.08);
        }
        box(0.9, 0.12, 0.1, wood, 0, 1.14, -1.08);
        // Plank base.
        for (let i = 0; i < 4; i++) {
          box(0.86, 0.05, 0.5, wood, (rand() - 0.5) * 0.03, 0.48, -0.75 + i * 0.5);
        }
        // Mattress + pillow at the head (-Z) end.
        box(0.9, 0.16, 2.06, mattress(), 0, 0.58, 0);
        box(0.55, 0.11, 0.38, pillow(), (rand() - 0.5) * 0.05, 0.69, -0.72);
        break;
      }
      case 'door': {
        // Same edge anchor and module as a wall — a door IS a wall segment
        // with an opening. Frame posts + lintel stay fixed; the panel hangs
        // on a live hinge node at the left post and swings without a rebuild
        // (E, or a multiplayer 'toggle', only rotates one TransformNode).
        const edge = BUILDING_MODULE / 2;
        for (const sx of [-1, 1] as const) {
          box(0.22, WALL_HEIGHT, 0.24, wood, sx * (edge - 0.11), WALL_HEIGHT / 2, 0);
        }
        box(BUILDING_MODULE, 0.2, 0.26, wood, 0, WALL_HEIGHT - 0.1, 0);
        const hinge = new TransformNode(name + '_hinge', scene);
        hinge.parent = root;
        hinge.position.set(-edge + 0.22, 0, 0);
        hingeOut = hinge;
        // Panel meshes must NOT be frozen: their world matrix changes every
        // time the hinge swings.
        const loose = (w: number, h: number, d: number, mat: PBRMaterial, px: number, py: number, pz: number): Mesh => {
          const m = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene);
          m.parent = hinge;
          m.position.set(px, py, pz);
          m.material = mat;
          m.receiveShadows = false;
          meshes.push(m);
          return m;
        };
        const panelW = BUILDING_MODULE - 0.5;
        for (let i = 0; i < 4; i++) {
          loose(panelW / 4 - 0.02, WALL_HEIGHT - 0.3, 0.09, wood,
            0.02 + panelW * ((i + 0.5) / 4), (WALL_HEIGHT - 0.3) / 2 + 0.04, 0);
        }
        // Two leather straps (the material the hinges are made of).
        for (const sy of [0.55, WALL_HEIGHT - 0.75]) {
          loose(panelW - 0.06, 0.13, 0.12, leather(), 0.02 + panelW / 2, sy, 0);
        }
        // Wooden handle on the opening side.
        loose(0.07, 0.3, 0.07, leather(), 0.02 + panelW - 0.12, 1.05, 0.09);
        break;
      }
      case 'torch': {
        // Standing torch: iron-bound post with a permanently glowing head.
        // The light + sparks live on the BuildingHandle (create()), mirroring
        // the campfire, so day/night the camp reads as lived-in.
        const post = MeshBuilder.CreateCylinder(name, {
          diameter: 0.09, height: 1.15, tessellation: 6,
        }, scene);
        post.parent = root;
        post.position.y = 0.575;
        post.material = wood;
        post.receiveShadows = false;
        if (!ghost) post.freezeWorldMatrix();
        meshes.push(post);
        const collar = MeshBuilder.CreateCylinder(name + 'collar', {
          diameter: 0.16, height: 0.14, tessellation: 8,
        }, scene);
        collar.parent = root;
        collar.position.y = 1.12;
        collar.material = stone;
        collar.receiveShadows = false;
        if (!ghost) collar.freezeWorldMatrix();
        meshes.push(collar);
        const flame = MeshBuilder.CreateCylinder(name + 'flame', {
          diameterTop: 0.02, diameter: 0.13, height: 0.22, tessellation: 8,
        }, scene);
        flame.parent = root;
        flame.position.y = 1.28;
        flame.material = this.mats.fireGlow;
        flame.receiveShadows = false;
        if (!ghost) flame.freezeWorldMatrix();
        meshes.push(flame);
        break;
      }
      case 'carpet': {
        // Woven rug: a full-cell wool base with a lighter inlaid band and
        // short fringe at the two ends. Decorative — no collision, no step.
        box(BUILDING_MODULE - 0.08, 0.03, BUILDING_MODULE - 0.08, rug(), 0, 0.035, 0);
        box(BUILDING_MODULE - 0.55, 0.02, BUILDING_MODULE - 0.09, rugTrim(), 0, 0.06, 0);
        for (const sz of [-1, 1] as const) {
          for (let i = 0; i < 5; i++) {
            box(0.06, 0.025, 0.1, rug(), -0.7 + i * 0.35, 0.02, sz * (BUILDING_MODULE / 2 - 0.03));
          }
        }
        break;
      }
      case 'fence': {
        // Pasture fence: three driven posts and two rails, at exactly
        // FENCE_HEIGHT — the height buildingPlatforms() blocks movement at.
        // Shorter than a wall on purpose: you can see the wolves coming, you
        // just cannot run through them.
        const edge = BUILDING_MODULE / 2;
        for (const sx of [-1, 0, 1] as const) {
          const jitter = (rand() - 0.5) * 0.05;
          box(0.14, FENCE_HEIGHT + jitter, 0.14, barkMat, sx * (edge - 0.07), (FENCE_HEIGHT + jitter) / 2, 0);
        }
        for (const ry of [0.3, FENCE_HEIGHT - 0.12]) {
          box(BUILDING_MODULE - 0.06, 0.11, 0.09, wood, 0, ry + (rand() - 0.5) * 0.03, 0);
        }
        break;
      }
      case 'stairs': {
        // A broad step up: the visible block is exactly the box physics uses
        // (see STAIRS_RISE), planked on top, so the surface you see IS the
        // surface you stand on. The near edge gets a chamfered nose board so
        // the step reads as "walk onto me" from a distance.
        const edge = BUILDING_MODULE / 2;
        box(BUILDING_MODULE - 0.06, STAIRS_RISE - 0.06, BUILDING_MODULE - 0.06, wood, 0, (STAIRS_RISE - 0.06) / 2, 0);
        const plankDepth = (BUILDING_MODULE - 0.1) / 3;
        for (let i = 0; i < 3; i++) {
          box(
            BUILDING_MODULE - 0.1,
            0.04,
            plankDepth - 0.03,
            this.mats.toolWood,
            0,
            STAIRS_RISE - 0.02,
            -edge + 0.05 + plankDepth * (i + 0.5),
          );
        }
        // Nosing on the low side (the side you approach from).
        box(BUILDING_MODULE - 0.04, 0.1, 0.1, this.mats.bark, 0, STAIRS_RISE - 0.05, edge - 0.05);
        break;
      }
      case 'workbench': {
        // Trestle bench: four barked legs, a thick double-plank top at table
        // height, and the tools that make it a workshop — a whetstone and two
        // pegs. The bench is where crafting goes 40% faster (systems/crafting).
        const edge = BUILDING_MODULE / 2;
        const top = 0.86;
        for (const sx of [-1, 1] as const) {
          for (const sz of [-1, 1] as const) {
            box(0.13, top - 0.06, 0.13, barkMat, sx * (edge - 0.16), (top - 0.06) / 2, sz * (edge - 0.16));
          }
        }
        // Cross braces, so it reads as built rather than stacked.
        box(BUILDING_MODULE - 0.3, 0.1, 0.1, wood, 0, 0.3, 0);
        box(0.1, 0.1, BUILDING_MODULE - 0.3, wood, 0, 0.3, 0);
        box(BUILDING_MODULE - 0.1, 0.12, BUILDING_MODULE - 0.1, wood, 0, top, 0, 0, 0.006);
        box(BUILDING_MODULE - 0.42, 0.07, BUILDING_MODULE - 0.24, this.mats.toolWood, 0.02, top + 0.09, 0);
        // Whetstone + a couple of iron-white pegs lying on the top.
        box(0.3, 0.08, 0.16, stone, -0.18, top + 0.16, 0.16, 0, 0.2);
        box(0.44, 0.05, 0.05, this.mats.toolStone, 0.1, top + 0.15, -0.2, 0, 0.12);
        break;
      }
      case 'planter': {
        // Raised berry tray: four barked sides, a soil floor and a bush that
        // visibly fills the tray as it grows. A handful of berries appears
        // immediately, more as `growth` advances (the count is read from the
        // building's own growth value by the farm system; here the plant just
        // scales with it — see the comment in systems/farm.ts on why the
        // renderer never has to know the exact number).
        const edge = BUILDING_MODULE / 2;
        for (const sx of [-1, 1] as const) {
          box(0.1, 0.34, BUILDING_MODULE - 0.1, barkMat, sx * (edge - 0.05), 0.17, 0);
        }
        for (const sz of [-1, 1] as const) {
          box(BUILDING_MODULE - 0.3, 0.34, 0.1, barkMat, 0, 0.17, sz * (edge - 0.05));
        }
        box(BUILDING_MODULE - 0.2, 0.08, BUILDING_MODULE - 0.2, this.mats.stump, 0, 0.2, 0);
        // The plant itself: a low bush in the middle of the tray.
        const bush = MeshBuilder.CreateSphere(name + 'bush', { diameter: 0.5, segments: 6 }, scene);
        bush.parent = root;
        bush.position.set(0, 0.45, 0);
        bush.scaling.set(1, 0.8, 1);
        bush.material = this.mats.bushLeaf;
        bush.receiveShadows = false;
        if (!ghost) bush.freezeWorldMatrix();
        meshes.push(bush);
        for (let i = 0; i < 5; i++) {
          const ang = (i / 5) * Math.PI * 2;
          const b = MeshBuilder.CreateSphere(name + `berry${i}`, { diameter: 0.1, segments: 4 }, scene);
          b.parent = root;
          b.position.set(Math.cos(ang) * 0.18, 0.52 + (i % 2) * 0.08, Math.sin(ang) * 0.18);
          b.material = this.mats.berry;
          b.receiveShadows = false;
          if (!ghost) b.freezeWorldMatrix();
          meshes.push(b);
        }
        break;
      }
      case 'sign': {
        // Two posted legs and a planked board — the same sign as at the camp
        // gate, so a player sign reads as part of the same world. Decorative:
        // free to walk through, no prompt, nothing to read.
        const edge = BUILDING_MODULE / 2;
        for (const sx of [-1, 1] as const) {
          box(0.11, 1.05, 0.11, barkMat, sx * (edge - 0.1), 0.52, 0);
        }
        box(BUILDING_MODULE - 0.12, 0.5, 0.08, wood, 0, 0.78, 0, 0, 0.012);
        // Two carved grooves, so the board reads as written on.
        box(BUILDING_MODULE - 0.4, 0.045, 0.02, this.mats.stump, 0, 0.86, -0.05);
        box(BUILDING_MODULE - 0.55, 0.045, 0.02, this.mats.stump, -0.05, 0.72, -0.05);
        break;
      }
    }

    const dispose = () => {
      // NOTE: in Babylon 9.33 the first dispose argument is `doNotRecurse`,
      // so `dispose(true)` would leak every child mesh (and the shadow
      // caster list would keep dead meshes). Bare call recurses.
      root.dispose();
      this.casters = this.casters.filter((m) => !meshes.includes(m));
    };
    if (!ghost) {
      for (const m of meshes) this.casters.push(m);
    }
    return { meshes, dispose, hinge: hingeOut };
  }

  /** Simple flat-colour PBR fabric for bed parts (no texture needed at this scale). */
  private makeFabric(name: string, r: number, g: number, b: number, roughness: number): PBRMaterial {
    const m = new PBRMaterial(name, this.scene);
    m.albedoColor = new Color3(r, g, b);
    m.metallic = 0;
    m.roughness = roughness;
    m.environmentIntensity = 0.7;
    return m;
  }

  /**
   * Shared tinted clones of the plank material. clone() keeps the texture
   * references, so every variant draws with the same plank albedo and only
   * the colour multiplier differs — four materials for the whole world.
   */
  private woodVariant(rand: () => number): PBRMaterial {
    this.woodVars ??= [
      this.mats.buildingWood,
      this.tintClone('bwSun', this.mats.buildingWood, 1.18, 1.1, 0.98),
      this.tintClone('bwShade', this.mats.buildingWood, 0.8, 0.78, 0.74),
      this.tintClone('bwWeather', this.mats.buildingWood, 0.84, 0.9, 0.96),
    ];
    return this.woodVars[Math.min(this.woodVars.length - 1, Math.floor(rand() * this.woodVars.length))];
  }

  private tintClone(name: string, base: PBRMaterial, r: number, g: number, b: number): PBRMaterial {
    const m = base.clone(name) as PBRMaterial;
    m.albedoColor = new Color3(
      Math.min(1.3, base.albedoColor.r * r),
      Math.min(1.3, base.albedoColor.g * g),
      Math.min(1.3, base.albedoColor.b * b),
    );
    return m;
  }

  // ------------------------------------------------------------------
  // Campfire state
  // ------------------------------------------------------------------

  private create(b: BuildingData): void {
    const handle = this.buildMesh(b.kind, b.x, b.z, b.y, b.rot, false);
    let light: PointLight | null = null;
    let particles: ParticleSystem | null = null;
    let ember: Mesh | null = null;

    if (b.kind === 'campfire' || b.kind === 'torch') {
      // Both carry a real flame. The campfire dims with its fuel; a torch
      // burns forever (that is what you pay the stone + wood for).
      const torch = b.kind === 'torch';
      const headY = torch ? 1.3 : 1;
      light = new PointLight(torch ? 'torchLight' : 'fireLight', new Vector3(b.x, b.y + headY, b.z), this.scene);
      light.diffuse = new Color3(1, 0.6, 0.25);
      light.range = torch ? 9 : 14;
      light.intensity = 0;

      this.fireTex ??= fireTexture(this.scene);
      particles = new ParticleSystem(torch ? 'torchSmoke' : 'fireParticles', torch ? 40 : 120, this.scene);
      particles.particleTexture = this.fireTex;
      particles.emitter = new Vector3(b.x, b.y + (torch ? 1.35 : 0.4), b.z);
      const spread = torch ? 0.06 : 0.25;
      particles.minEmitBox = new Vector3(-spread, 0, -spread);
      particles.maxEmitBox = new Vector3(spread, 0.3, spread);
      particles.color1 = new Color4(1, 0.75, 0.3, 0.9);
      particles.color2 = new Color4(1, 0.4, 0.1, 0.8);
      particles.colorDead = new Color4(0.2, 0.05, 0, 0);
      particles.minSize = torch ? 0.05 : 0.1;
      particles.maxSize = torch ? 0.16 : 0.3;
      particles.minLifeTime = 0.4;
      particles.maxLifeTime = 1.0;
      particles.emitRate = torch ? 25 : 60;
      particles.direction1 = new Vector3(-0.3, 1.5, -0.3);
      particles.direction2 = new Vector3(0.3, 2.5, 0.3);
      particles.gravity = new Vector3(0, 1.5, 0);
      particles.blendMode = ParticleSystem.BLENDMODE_ADD;
      particles.start();

      if (!torch) {
        // Glowing embers visible in the hearth while fuel lasts.
        ember = MeshBuilder.CreateCylinder('fireEmber', {
          diameter: 0.3, height: 0.04, tessellation: 10,
        }, this.scene);
        ember.position.set(b.x, b.y + 0.17, b.z);
        ember.material = this.mats.fireGlow;
        ember.freezeWorldMatrix();
      }
    }

    // Door: swinging the hinge beats rebuilding the mesh. The rotation is
    // applied on the next sync() from world state (b.open), so toggling in
    // multiplayer rides the normal state push.
    const setOpen = handle.hinge
      ? (open: boolean): void => {
          if (handle.hinge) handle.hinge.rotation.y = open ? -1.9 : 0;
        }
      : undefined;

    this.handles.set(b.id, {
      id: b.id,
      dispose: () => {
        light?.dispose();
        particles?.dispose();
        ember?.dispose();
        if (this.fireTex && !this.handles.size) this.fireTex.dispose();
        handle.dispose();
      },
      setOpen,
      setFuel:
        b.kind === 'campfire'
          ? (fuel: number, time: number) => {
              if (light && particles) {
                // Two offset sines read as organic flame flicker.
                const flicker = 0.85 + 0.1 * Math.sin(time * 7.3 + b.x) + 0.05 * Math.sin(time * 13.1 + b.z);
                // The fire dims during its final seconds of fuel.
                const fade = fuel > 0 ? Math.min(1, fuel / 45) : 0;
                light.intensity = 1.1 * flicker * fade;
                particles.emitRate = 60 * fade;
                if (ember) ember.setEnabled(fade > 0.2);
              }
            }
          : b.kind === 'torch'
            ? (_fuel: number, time: number) => {
                if (light) {
                  light.intensity =
                    0.95 + 0.1 * Math.sin(time * 8.7 + b.x * 3) + 0.04 * Math.sin(time * 15.3 + b.z * 3);
                }
              }
            : undefined,
    });
    this.handles.get(b.id)?.setFuel?.(b.fuel ?? 0, this.fireTime);
    this.handles.get(b.id)?.setOpen?.(!!b.open);
  }
}

function mulberry(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s = Math.imul(s ^ (s >>> 15), s | 1);
    s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
    return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
  };
}
