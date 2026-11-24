/**
 * The witch of the tower — an NPC you can TALK to (she shares the whole
 * villager pipeline: ai/chat.ts, memory, save slot, server persona) and who
 * hexes back the moment you make her angry. The mood RULES are pure
 * (systems/witch.ts); this class owns her body and the chase.
 *
 * Behaviour, per frame:
 *  - calm: the inherited Npc wander routine, on a ring patrol around the
 *    tower shell (never through it — the route radius starts outside the
 *    stone);
 *  - hostile (anger >= HOSTILE_AT): she abandons the route, walks at the
 *    player and lands a hex-hand every WITCH_HIT_COOLDOWN inside reach —
 *    the game applies the damage through the shield rule, exactly like a
 *    spider bite;
 *  - overpowered: she does NOT die (steel slides off a witch). She vanishes
 *    in black smoke, the mesh is disabled, and WITCH_RETURN_S later she
 *    crawls back out at her door — still furious.
 */
import { Scene } from '@babylonjs/core';
import { groundSurfaceHeight } from '../world/groundSurface';
import {
  WITCH_CHASE_LIMIT,
  WITCH_SPEED_CHASE,
  appease,
  canHex,
  createWitchState,
  inWitchReach,
  isHidden,
  isHostile,
  strikeWitch,
  tickWitchMood,
  witchAggro,
  type WitchState,
} from '../systems/witch';
import type { SharedMaterials } from '../visual/materials';
import { Npc, type NpcProfile } from './npc';

export class Witch extends Npc {
  /** The living mood — the game reads/saves `state.anger`. */
  readonly state: WitchState = createWitchState();
  /** Tower centre + her floor (the terrain under the doorway). */
  private home: { x: number; z: number; floorY: number };
  private chasing = false;
  /** combatT of the last frame (drives the hidden-until timer). */
  private now = 0;
  /** Arm-raise on the hex swing (seconds remaining). */
  private hexT = 0;
  /**
   * Multiplier on the PASSIVE calming of her mood (perk 'hekenvriend' sets
   * 2). Anger she GAINS is decided by game.ts before it calls angerWitch —
   * this field only ever makes her calm down faster, never angrier.
   */
  moodDecayScale = 1;

  constructor(
    scene: Scene,
    profile: NpcProfile,
    tower: { x: number; z: number; baseY: number },
    seed: number,
    mats: SharedMaterials,
  ) {
    // Patrol ring OUTSIDE the stone shell (TOWER_OUTER is 4).
    super(scene, profile, { x: tower.x, z: tower.z, y: tower.baseY }, seed, mats, {
      ring: [6, 3],
    });
    this.home = { x: tower.x, z: tower.z, floorY: tower.baseY };
  }

  /** Her home spot (the tower door side of the court). */
  get homeXz(): { x: number; z: number } {
    return { x: this.home.x, z: this.home.z };
  }

  /** Restore the saved mood (systems/save.ts `witchAnger`). */
  restoreAnger(anger: number): void {
    this.state.anger = Math.max(0, Math.min(100, Number(anger) || 0));
  }

  /** True while she is physically here (not in the smoke). */
  get present(): boolean {
    return !isHidden(this.state, this.now);
  }

  get hostile(): boolean {
    return isHostile(this.state);
  }

  /**
   * One formal apology paid for (20 gold — the game moves the coins).
   * Returns false when she was not angry or the wallet fell short.
   */
  apologize(gold: number): boolean {
    const ok = appease(this.state, gold);
    if (ok) this.chasing = false;
    return ok;
  }

  /**
   * Land sword hits on her. Returns 'vanished' the frame she blinks away.
   * `now` is the game's combat clock (her return time is stored on it).
   */
  fight(hits: number, now: number): 'hit' | 'vanished' {
    const r = strikeWitch(this.state, hits, now);
    return r.vanished ? 'vanished' : 'hit';
  }

  /**
   * Per-frame drive. Returns true when this frame's hex-hand landed — the
   * game applies WITCH_HIT_DAMAGE through the shield rule (spider pattern).
   */
  tick(dt: number, px: number, py: number, pz: number, combatT: number, frozen: boolean): boolean {
    this.now = combatT;
    // Mood physics runs even while she stands frozen mid-argument.
    const ds = Number.isFinite(this.moodDecayScale) && this.moodDecayScale > 0 ? this.moodDecayScale : 1;
    tickWitchMood(this.state, dt * ds);

    // --- hidden in smoke after being overpowered --------------------------
    if (!this.present) {
      this.root.setEnabled(false);
      this.chasing = false;
      return false;
    }
    if (!this.root.isEnabled()) {
      // The return: she crawls back out at the door, whole and still furious.
      this.root.setEnabled(true);
      const p = this.root.position;
      p.x = this.home.x + 5.2;
      p.z = this.home.z;
      p.y = groundSurfaceHeight(p.x, p.z);
    }
    if (frozen) return false;

    const p = this.root.position;
    const hostile = isHostile(this.state);

    // --- chase gate (pure rules in systems/witch.ts) -----------------------
    if (!this.chasing && hostile && witchAggro(px, pz, py, { x: p.x, z: p.z, y: p.y })) {
      this.chasing = true;
    } else if (this.chasing) {
      const fromHome = Math.hypot(p.x - this.home.x, p.z - this.home.z);
      const tooFar = fromHome > WITCH_CHASE_LIMIT;
      const lostSight = Math.hypot(px - p.x, pz - p.z) > 6 || Math.abs(py - p.y) >= 2.2;
      if (tooFar || lostSight || !hostile) this.chasing = false;
    }

    if (this.chasing) return this.chaseStep(dt, px, pz, combatT);
    // Calm (or hostile-but-not-in-range): the ordinary villager routine.
    super.update(dt, false);
    return false;
  }

  /** Walk at the player, swing the hex-hand in reach. */
  private chaseStep(dt: number, px: number, pz: number, combatT: number): boolean {
    const p = this.root.position;
    const dx = px - p.x;
    const dz = pz - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.05) {
      const step = WITCH_SPEED_CHASE * dt;
      let nx = p.x + (dx / dist) * Math.min(step, dist);
      let nz = p.z + (dz / dist) * Math.min(step, dist);
      // Her leash: she never lets you bait her more than WITCH_CHASE_LIMIT
      // from the tower — the court is her shop floor.
      const fromHome = Math.hypot(nx - this.home.x, nz - this.home.z);
      if (fromHome > WITCH_CHASE_LIMIT) {
        const k = WITCH_CHASE_LIMIT / fromHome;
        nx = this.home.x + (nx - this.home.x) * k;
        nz = this.home.z + (nz - this.home.z) * k;
      }
      p.x = nx;
      p.z = nz;
      const targetYaw = Math.atan2(dx, dz);
      let dy = targetYaw - this.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.yaw += dy * Math.min(1, 8 * dt);
    }
    p.y += (groundSurfaceHeight(p.x, p.z) - p.y) * Math.min(1, 6 * dt);
    this.root.rotation.y = this.yaw;

    // Chase gait: legs pump like walking, both arms reach forward — a witch
    // does not punch, she GRABS at you with glowing hands.
    this.phase += dt * 6.5;
    const s = Math.sin(this.phase) * 0.55;
    this.hipL.rotation.x = s;
    this.hipR.rotation.x = -s;
    this.kneeL.rotation.x = Math.max(0, -s) * 0.7;
    this.kneeR.rotation.x = Math.max(0, s) * 0.7;
    this.hexT = Math.max(0, this.hexT - dt);
    const reach = -1.15 - (this.hexT > 0 ? Math.sin((this.hexT / 0.3) * Math.PI) * 0.6 : 0);
    this.shoulderL.rotation.x = reach;
    this.shoulderR.rotation.x = reach;
    this.elbowL.rotation.x = -0.3;
    this.elbowR.rotation.x = -0.3;

    // The hex-hand.
    let hit = false;
    const d = Math.hypot(px - p.x, pz - p.z);
    if (inWitchReach(d) && canHex(this.state, combatT)) {
      this.state.lastHitAt = combatT;
      this.hexT = 0.3;
      hit = true;
    }
    return hit;
  }

  /** Reset her at the world reset (mood back to zero, body whole). */
  calm(): void {
    this.state.anger = 0;
    this.state.hits = 8;
    this.state.returnsAt = 0;
    this.chasing = false;
    this.root.setEnabled(true);
  }
}
