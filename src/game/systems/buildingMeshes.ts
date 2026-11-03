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

export interface BuildingHandle {
  id: string;
  dispose: () => void;
  /** Update campfire state (fuel). */
  setFuel?: (fuel: number) => void;
}

export interface MeshHandle {
  meshes: Mesh[];
  dispose: () => void;
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
  private scene: Scene;
  private mats: SharedMaterials;
  private casters: Mesh[] = [];

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
      } else if (h.setFuel) {
        h.setFuel(b.fuel ?? 0);
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
  preview(kind: BuildingData['kind'], x: number, z: number, y: number, rot: number): MeshHandle {
    this.disposePreview();
    const handle = this.buildMesh(kind, x, z, y, rot, true);
    for (const m of handle.meshes) m.material = this.mats.ghost;
    return handle;
  }

  private previewHandle: MeshHandle | null = null;

  private disposePreview(): void {
    this.previewHandle?.dispose();
    this.previewHandle = null;
  }

  // ------------------------------------------------------------------
  // Geometry builders
  // ------------------------------------------------------------------

  private buildMesh(
    kind: BuildingData['kind'],
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
    const meshes: Mesh[] = [];

    /** Add a box relative to the building origin. */
    const box = (w: number, h: number, d: number, mat: PBRMaterial, px: number, py: number, pz: number, rx = 0, rz = 0): Mesh => {
      const m = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene);
      m.parent = root;
      m.position.set(px, py, pz);
      m.rotation.x = rx;
      m.rotation.z = rz;
      m.material = mat;
      if (!ghost) m.freezeWorldMatrix();
      meshes.push(m);
      return m;
    };

    const wood = this.mats.buildingWood;
    const stone = this.mats.buildingStone;

    switch (kind) {
      case 'wall': {
        // Corner posts with slightly varied heights, three stacked planks
        // and a top rail — reads as built timber, not a flat board.
        for (const sx of [-1, 1] as const) {
          const jitter = (rand() - 0.5) * 0.06;
          box(0.24, 2.4 + jitter, 0.24, wood, sx * 0.98, 1.2 + jitter / 2, 0);
        }
        const plankYs = [0.5, 1.22, 1.94];
        for (const py of plankYs) {
          box(2.14, 0.52, 0.16, wood, 0, py + (rand() - 0.5) * 0.05, 0.02);
        }
        box(2.24, 0.14, 0.2, wood, 0, 2.34, 0);
        break;
      }
      case 'floor': {
        // Plank deck on two stringers.
        for (const sx of [-0.72, 0.72] as const) {
          box(0.16, 0.12, 2.24, wood, sx, 0.04, 0);
        }
        for (let i = 0; i < 4; i++) {
          const pz = -0.77 + i * 0.51;
          box(2.0, 0.09, 0.46, wood, (rand() - 0.5) * 0.04, 0.13, pz, 0, (rand() - 0.5) * 0.01);
        }
        break;
      }
      case 'roof': {
        // Two sloped slabs meeting at a ridge beam, with end fascias.
        const pitch = 0.36;
        const halfSpan = 0.72;
        for (const s of [-1, 1] as const) {
          box(2.3, 0.1, 1.34, wood, 0, 3.02, s * halfSpan, s * pitch);
        }
        box(2.32, 0.16, 0.2, wood, 0, 3.22, 0);
        for (const sx of [-1, 1] as const) {
          box(0.18, 0.28, 2.34, wood, sx * 1.13, 3.05, 0);
        }
        // Rafter tails poking below the slabs for silhouette.
        for (const s of [-1, 1] as const) {
          for (let i = 0; i < 3; i++) {
            box(0.1, 0.2, 0.1, wood, -0.8 + i * 0.8, 2.98, s * 1.28, s * pitch);
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
        if (!ghost) hearth.freezeWorldMatrix();
        meshes.push(hearth);
        break;
      }
    }

    const dispose = () => {
      root.dispose(true);
      this.casters = this.casters.filter((m) => !meshes.includes(m));
    };
    if (!ghost) {
      for (const m of meshes) this.casters.push(m);
    }
    return { meshes, dispose };
  }

  // ------------------------------------------------------------------
  // Campfire state
  // ------------------------------------------------------------------

  private create(b: BuildingData): void {
    const handle = this.buildMesh(b.kind, b.x, b.z, b.y, b.rot, false);
    let light: PointLight | null = null;
    let particles: ParticleSystem | null = null;
    let ember: Mesh | null = null;

    if (b.kind === 'campfire') {
      light = new PointLight('fireLight', new Vector3(b.x, b.y + 1, b.z), this.scene);
      light.diffuse = new Color3(1, 0.6, 0.25);
      light.range = 14;
      light.intensity = 0;

      this.fireTex ??= fireTexture(this.scene);
      particles = new ParticleSystem('fireParticles', 120, this.scene);
      particles.particleTexture = this.fireTex;
      particles.emitter = new Vector3(b.x, b.y + 0.4, b.z);
      particles.minEmitBox = new Vector3(-0.25, 0, -0.25);
      particles.maxEmitBox = new Vector3(0.25, 0.3, 0.25);
      particles.color1 = new Color4(1, 0.75, 0.3, 0.9);
      particles.color2 = new Color4(1, 0.4, 0.1, 0.8);
      particles.colorDead = new Color4(0.2, 0.05, 0, 0);
      particles.minSize = 0.1;
      particles.maxSize = 0.3;
      particles.minLifeTime = 0.4;
      particles.maxLifeTime = 1.0;
      particles.emitRate = 60;
      particles.direction1 = new Vector3(-0.3, 1.5, -0.3);
      particles.direction2 = new Vector3(0.3, 2.5, 0.3);
      particles.gravity = new Vector3(0, 1.5, 0);
      particles.blendMode = ParticleSystem.BLENDMODE_ADD;
      particles.start();

      // Glowing embers visible in the hearth while fuel lasts.
      ember = MeshBuilder.CreateCylinder('fireEmber', {
        diameter: 0.3, height: 0.04, tessellation: 10,
      }, this.scene);
      ember.position.set(b.x, b.y + 0.17, b.z);
      ember.material = this.mats.fireGlow;
      ember.freezeWorldMatrix();
    }

    this.handles.set(b.id, {
      id: b.id,
      dispose: () => {
        light?.dispose();
        particles?.dispose();
        ember?.dispose();
        if (this.fireTex && !this.handles.size) this.fireTex.dispose();
        handle.dispose();
      },
      setFuel: (fuel: number) => {
        if (light && particles) {
          const flicker = 0.85 + 0.15 * Math.sin(Date.now() * 0.02 + b.x);
          light.intensity = fuel > 0 ? 1.1 * flicker : 0;
          particles.emitRate = fuel > 0 ? 60 : 0;
          if (ember) ember.setEnabled(fuel > 0);
        }
      },
    });
    this.handles.get(b.id)?.setFuel?.(b.fuel ?? 0);
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
