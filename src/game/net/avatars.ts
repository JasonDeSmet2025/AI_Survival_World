/**
 * Remote player avatars (Multiplayer Agent scope).
 *
 * Other players used to be grey capsules that slid around without rotating:
 * the `r` (facing) the server relayed was never applied, the mesh had its
 * world matrix frozen so the per-frame position update could not reach the
 * renderer, and nothing told you which capsule was "Loki" and which was
 * "Speler-3fb2". That is not a multiplayer game yet — you cannot tell your
 * friends apart.
 *
 * This module owns:
 *  - a real humanoid (the same PlayerCharacter model as the local player, so
 *    everyone looks like they belong to this world),
 *  - smooth position + facing interpolation from ~10 Hz server updates,
 *  - a walk/sprint/idle animation driven by the observed speed,
 *  - a floating nametag, projected from world space to the HUD each frame.
 *
 * Babylon lives only here; the game hands it positions from the network.
 */
import { Matrix, Scene, TransformNode, Vector3, type AbstractMesh, type FreeCamera } from '@babylonjs/core';
import { PlayerCharacter } from '../player/player';
import type { SharedMaterials } from '../visual/materials';

export interface AvatarPose {
  x: number;
  y: number;
  z: number;
  /** Facing yaw in radians (the same convention as the local charYaw). */
  r: number;
}

interface Avatar {
  id: string;
  name: string;
  char: PlayerCharacter;
  root: TransformNode;
  /** Where the server says the player is. */
  target: Vector3;
  targetYaw: number;
  /** Smoothed observed speed (m/s) — drives walk vs. sprint vs. idle. */
  speed: number;
  last: Vector3;
  label: HTMLDivElement | null;
}

export interface AvatarOptions {
  /** Container for the nametags (HUD layer). Optional for headless tests. */
  labelContainer?: HTMLElement | null;
  /** Height above the feet where the nametag floats (metres). */
  labelHeight?: number;
  /** Hide tags beyond this distance (metres) to keep the screen readable. */
  labelMaxDistance?: number;
}

/** Shortest-arc angle interpolation (same maths the local character uses). */
function dampAngle(from: number, to: number, k: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return from + d * k;
}

export class RemoteAvatars {
  private scene: Scene;
  private mats: SharedMaterials;
  private opts: Required<Omit<AvatarOptions, 'labelContainer'>> & { labelContainer: HTMLElement | null };
  private avatars = new Map<string, Avatar>();
  private disposed = false;

  constructor(scene: Scene, mats: SharedMaterials, opts: AvatarOptions = {}) {
    this.scene = scene;
    this.mats = mats;
    this.opts = {
      labelContainer: opts.labelContainer ?? null,
      labelHeight: opts.labelHeight ?? 2.05,
      labelMaxDistance: opts.labelMaxDistance ?? 60,
    };
  }

  get size(): number {
    return this.avatars.size;
  }

  ids(): string[] {
    return [...this.avatars.keys()];
  }

  nameOf(id: string): string | null {
    return this.avatars.get(id)?.name ?? null;
  }

  /**
   * Read-only view of one avatar: where it is RENDERED (interpolated), where
   * the server says it should be, and how fast it is moving. Nothing in the
   * game reads this — it exists so the QA script (and a future debug overlay)
   * can tell "the avatar is lagging behind the stream" apart from "the stream
   * never arrived", which is invisible from the outside.
   */
  poseOf(id: string): {
    name: string;
    x: number;
    y: number;
    z: number;
    yaw: number;
    speed: number;
    target: { x: number; y: number; z: number; r: number };
    meshes: number;
  } | null {
    const a = this.avatars.get(id);
    if (!a) return null;
    return {
      name: a.name,
      x: a.root.position.x,
      y: a.root.position.y,
      z: a.root.position.z,
      yaw: a.root.rotation.y,
      speed: a.speed,
      target: { x: a.target.x, y: a.target.y, z: a.target.z, r: a.targetYaw },
      meshes: a.root.getChildMeshes().length,
    };
  }

  /** Names of everyone in the world right now, for the HUD roster. */
  roster(): Array<{ id: string; name: string }> {
    return [...this.avatars.values()].map((a) => ({ id: a.id, name: a.name }));
  }

  add(id: string, name: string, pose: AvatarPose): void {
    if (this.disposed || this.avatars.has(id)) return;
    const char = new PlayerCharacter(this.scene, this.mats);
    const root = char.root;
    root.name = `remote_${id}`;
    root.setEnabled(true);
    root.position.set(pose.x, pose.y, pose.z);
    root.rotation.y = pose.r;
    const a: Avatar = {
      id,
      name,
      char,
      root,
      target: new Vector3(pose.x, pose.y, pose.z),
      targetYaw: pose.r,
      speed: 0,
      last: new Vector3(pose.x, pose.y, pose.z),
      label: this.makeLabel(name),
    };
    this.avatars.set(id, a);
  }

  remove(id: string): void {
    const a = this.avatars.get(id);
    if (!a) return;
    a.label?.remove();
    a.char.dispose();
    this.avatars.delete(id);
  }

  /** New target from the server (`p` / `joined` messages). */
  setTarget(id: string, pose: AvatarPose): void {
    const a = this.avatars.get(id);
    if (!a) return;
    a.target.set(pose.x, pose.y, pose.z);
    a.targetYaw = pose.r;
  }

  rename(id: string, name: string): void {
    const a = this.avatars.get(id);
    if (!a) return;
    a.name = name;
    if (a.label) a.label.textContent = name;
  }

  /**
   * Show what a remote survivor carries in their hand (item id, '' = empty;
   * PlayerCharacter.setTool validates against ITEMS, so a malicious or
   * broken id can never spawn a prop). No-ops when it did not change.
   */
  setHeld(id: string, held: string | undefined): void {
    const a = this.avatars.get(id);
    if (!a) return;
    a.char.setTool(held ? held : null);
  }

  /**
   * Interpolate every avatar. Called once per rendered frame.
   *
   * The old code called `freezeWorldMatrix()` on remote meshes and then
   * wondered why they never moved: a frozen matrix is cached, so writing to
   * `position` never reached the renderer. Avatars move constantly, so they
   * are simply never frozen here.
   */
  update(dt: number): void {
    if (this.disposed) return;
    const k = Math.min(1, 12 * dt);
    for (const a of this.avatars.values()) {
      const p = a.root.position;
      // Distance covered this frame (before the move) → observed speed.
      const dx = a.target.x - p.x;
      const dy = a.target.y - p.y;
      const dz = a.target.z - p.z;
      p.x += dx * k;
      p.y += dy * k;
      p.z += dz * k;
      const moved = Math.hypot(p.x - a.last.x, p.y - a.last.y, p.z - a.last.z);
      a.last.set(p.x, p.y, p.z);
      const inst = dt > 0 ? moved / dt : 0;
      // Asymmetric smoothing: react fast to movement, decay slowly so the
      // walk cycle does not stutter between 10 Hz position packets.
      a.speed += (inst - a.speed) * (inst > a.speed ? Math.min(1, 14 * dt) : Math.min(1, 4 * dt));
      a.root.rotation.y = dampAngle(a.root.rotation.y, a.targetYaw, Math.min(1, 8 * dt));
      const sprinting = a.speed > 6.2;
      a.char.update(dt, sprinting ? 7.2 : a.speed, true, false, false);
    }
  }

  /**
   * Project the nametags to screen space. `camera` is the live FreeCamera;
   * tags behind the camera or beyond `labelMaxDistance` are hidden.
   */
  project(camera: FreeCamera): void {
    if (this.disposed || !this.opts.labelContainer) return;
    const engine = camera.getEngine();
    const w = engine.getRenderWidth();
    const h = engine.getRenderHeight();
    const viewport = camera.viewport.toGlobal(w, h);
    const camPos = camera.position;
    for (const a of this.avatars.values()) {
      if (!a.label) continue;
      const p = a.root.position;
      const dx = p.x - camPos.x;
      const dy = p.y - camPos.y;
      const dz = p.z - camPos.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > this.opts.labelMaxDistance || dist < 0.35) {
        a.label.style.display = 'none';
        continue;
      }
      const world = new Vector3(p.x, p.y + this.opts.labelHeight, p.z);
      const screen = Vector3.Project(world, Matrix.Identity(), this.scene.getTransformMatrix(), viewport);
      // Babylon's Project returns y in a bottom-up viewport space; the DOM is
      // top-down, and a tag whose projected depth is outside [0,1] sits behind
      // the camera or beyond the far plane.
      if (!Number.isFinite(screen.x) || !Number.isFinite(screen.y) || screen.z < 0 || screen.z > 1) {
        a.label.style.display = 'none';
        continue;
      }
      a.label.style.display = 'block';
      a.label.style.transform = `translate(-50%, -50%) translate(${Math.round(screen.x)}px, ${Math.round(h - screen.y)}px)`;
      // Fade with distance so distant tags do not clutter the horizon.
      a.label.style.opacity = String(Math.max(0.25, 1 - dist / (this.opts.labelMaxDistance * 1.25)));
    }
  }

  private makeLabel(name: string): HTMLDivElement | null {
    const c = this.opts.labelContainer;
    if (!c) return null;
    const el = c.ownerDocument.createElement('div');
    el.className = 'mp-tag';
    el.textContent = name;
    c.appendChild(el);
    return el;
  }

  /** Shadow casters for the local lighting system (called by the game). */
  shadowMeshes(): AbstractMesh[] {
    const out: AbstractMesh[] = [];
    for (const a of this.avatars.values()) {
      for (const m of a.char.shadowMeshes) out.push(m);
    }
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.ids()) this.remove(id);
  }
}
