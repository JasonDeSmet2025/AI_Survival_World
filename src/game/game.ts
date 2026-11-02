import {
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  FreeCamera,
  HemisphericLight,
  Mesh,
  Scene,
  ShadowGenerator,
  Vector3,
} from '@babylonjs/core';
import { populateFlora } from './flora';
import type { Collider } from './flora';
import { Hud } from './hud';
import { InputController } from './input';
import { Player } from './player';
import { SEA_LEVEL, createOcean, createTerrain, terrainHeight } from './terrain';

const CAM_DISTANCE = 8.5;
const CAM_TARGET_HEIGHT = 1.5;
const MOUSE_SENSITIVITY_YAW = 0.0032;
const MOUSE_SENSITIVITY_PITCH = 0.0024;

/**
 * Owns the Babylon engine, scene graph, lighting, player and camera,
 * and drives the render loop. Call dispose() to free all resources.
 */
export class Game {
  private engine: Engine;
  private scene: Scene;
  private camera: FreeCamera;
  private player: Player;
  private input: InputController;
  private hud: Hud;
  private ocean: Mesh;
  private colliders: Collider[] = [];

  private yaw = 0;
  private pitch = 0.38;
  private elapsed = 0;
  private resizeHandler: () => void;

  constructor(canvas: HTMLCanvasElement, hudContainer: HTMLElement) {
    this.engine = new Engine(canvas, true, {
      stencil: true,
    });
    this.scene = new Scene(this.engine);

    this.setupAtmosphere();
    this.setupLights();

    createTerrain(this.scene);
    this.ocean = createOcean(this.scene);
    populateFlora(this.scene, this.colliders);

    this.player = new Player(this.scene, this.colliders, { x: 0, z: 14 });

    this.camera = new FreeCamera('cam', new Vector3(0, 8, 26), this.scene);
    this.camera.inputs.clear(); // we drive the camera manually
    this.camera.minZ = 0.1;
    this.camera.maxZ = 2000;

    this.enableShadows();

    this.input = new InputController(canvas);
    this.hud = new Hud(hudContainer);

    this.resizeHandler = () => this.engine.resize();
    window.addEventListener('resize', this.resizeHandler);

    this.engine.runRenderLoop(() => {
      const dt = Math.min(this.engine.getDeltaTime() / 1000, 0.1);
      this.elapsed += dt;
      this.update(dt);
      this.scene.render();
    });
  }

  /** Sky color, fog, and a bright sun so the scene reads as a clear day. */
  private setupAtmosphere(): void {
    this.scene.clearColor = new Color4(0.55, 0.78, 0.97, 1);
    this.scene.fogMode = Scene.FOGMODE_EXP2;
    this.scene.fogDensity = 0.0035;
    this.scene.fogColor = new Color3(0.68, 0.83, 0.94);
  }

  /** Ambient sky light plus a warm directional sun. */
  private setupLights(): void {
    const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), this.scene);
    hemi.intensity = 0.45;
    hemi.groundColor = new Color3(0.25, 0.22, 0.18);

    const sun = new DirectionalLight('sun', new Vector3(-0.5, -1, 0.35), this.scene);
    sun.intensity = 1.1;
    sun.diffuse = new Color3(1, 0.96, 0.86);
  }

  /** Blurred shadow map for the sun. */
  private enableShadows(): void {
    const sun = this.scene.lights.find((l) => l.name === 'sun') as DirectionalLight;
    const shadowGen = new ShadowGenerator(2048, sun);
    shadowGen.useBlurExponentialShadowMap = true;
    shadowGen.blurKernel = 32;

    this.scene.meshes.forEach((mesh) => {
      if (mesh.name.startsWith('trunk') ||
          mesh.name.startsWith('canopy') ||
          mesh.name.startsWith('rock') ||
          mesh.name === 'player') {
        shadowGen.addShadowCaster(mesh);
      }
    });
  }

  /** Mouse look + player movement + third-person camera follow. */
  private update(dt: number): void {
    const delta = this.input.consumeMouseDelta();
    if (this.input.pointerLocked) {
      this.yaw += delta.x * MOUSE_SENSITIVITY_YAW;
      this.pitch = Math.max(0.05, Math.min(1.35, this.pitch - delta.y * MOUSE_SENSITIVITY_PITCH));
    }

    this.player.update(dt, this.input, this.yaw);

    // Gentle sea bob.
    this.ocean.position.y = SEA_LEVEL + Math.sin(this.elapsed * 0.8) * 0.06;

    // Third-person camera behind the player.
    const target = this.player.mesh.position;
    const lookAt = new Vector3(target.x, target.y + CAM_TARGET_HEIGHT, target.z);
    const cosP = Math.cos(this.pitch);
    const sinP = Math.sin(this.pitch);
    // Camera sits behind (opposite of forward) and above the player.
    const backX = Math.sin(this.yaw);
    const backZ = Math.cos(this.yaw);
    const camPos = new Vector3(
      lookAt.x + backX * CAM_DISTANCE * cosP,
      lookAt.y + CAM_DISTANCE * sinP,
      lookAt.z + backZ * CAM_DISTANCE * cosP,
    );
    // Never sink the camera below the terrain or the sea.
    const floorY = Math.max(SEA_LEVEL + 0.4, terrainHeight(camPos.x, camPos.z) + 0.6);
    if (camPos.y < floorY) camPos.y = floorY;

    this.camera.position.copyFrom(camPos);
    this.camera.setTarget(lookAt);

    this.hud.setPointerLocked(this.input.pointerLocked);
  }

  /** Frees engine resources, input listeners and HUD DOM. */
  dispose(): void {
    window.removeEventListener('resize', this.resizeHandler);
    this.input.detach();
    this.hud.dispose();
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}
