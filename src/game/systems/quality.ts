/**
 * Adaptive quality — pure state machine, no Babylon.
 *
 * A weak GPU is not the game's fault and must never become unplayable: the
 * frame loop samples the engine's smoothed FPS every second and asks this
 * module for a quality tier. Tiers step DOWN quickly (two bad seconds is
 * enough) and back UP only after a long streak of comfortable frames, with a
 * strict floor and ceiling so the resolution can never chase itself.
 *
 * What the game does with a tier:
 *   - scale    → engine.setHardwareScalingLevel(scale) (render smaller, CSS
 *                keeps the same window; this is THE lever on a weak GPU, it
 *                cuts every fragment pass including MSAA at once)
 *   - bloom    → false from tier 'low' down: the blur chain goes away
 *   - maxLights→ cap on scene lights from tier 'medium' down, so a base
 *                paved with torches cannot explode the PBR shader loop
 */

export type QualityTier = 'high' | 'medium' | 'low' | 'potato';

/**
 * What the shadow generator is allowed to cost per frame — ordered from
 * expensive to free (the generator has no refresh-rate control in this
 * engine build, so what the map IS remains the only lever).
 */
export type ShadowMode = 'full' | 'soft' | 'plain' | 'off';
export const SHADOW_COST: ShadowMode[] = ['full', 'soft', 'plain', 'off'];

export interface QualitySettings {
  /** Hardware scaling level (1 = native, higher = cheaper). */
  scale: number;
  /** Whether the bloom post-process may stay attached. */
  bloom: boolean;
  /** Hard cap on simultaneous scene lights (0 = leave Babylon's default). */
  maxLights: number;
  /** Shadow generator budget (see ShadowMode). */
  shadow: ShadowMode;
}

export const TIERS: QualityTier[] = ['high', 'medium', 'low', 'potato'];

/**
 * Player control: 'auto' lets the fps state machine decide; any fixed tier
 * is an explicit wish the state machine must not overrule. Persisted under
 * the same storage key — old files only ever stored a tier, which simply
 * means 'locked to that tier' — the first auto-friendly load normalises it
 * to 'auto' for players who never touched the setting.
 */
export type QualityMode = 'auto' | QualityTier;

export const QUALITY_BY_TIER: Record<QualityTier, QualitySettings> = {
  // The old ladder scaled the whole render (soft image) while the shadow
  // generator kept drawing every tree into a 2048 blurred map every frame
  // — the player lost sharpness WITHOUT getting the fps, because the
  // shadows were the cost. So the ladder now spends the big levers FIRST:
  // shadows and bloom shrink far before the resolution touches 1.3.
  high: { scale: 1.0, bloom: true, maxLights: 0, shadow: 'full' },
  medium: { scale: 1.0, bloom: true, maxLights: 8, shadow: 'soft' },
  low: { scale: 1.15, bloom: false, maxLights: 6, shadow: 'plain' },
  potato: { scale: 1.3, bloom: false, maxLights: 4, shadow: 'off' },
};

/** Seconds of sample history per decision. */
export const SAMPLE_SECONDS = 2;
/** Below this the tier steps down; above it (sustained) it may step up. */
export const FPS_BAD = 30;
export const FPS_GOOD = 48;
/** Comfortable samples required before stepping back up (≈ 12 s). */
export const GOOD_SAMPLES_TO_RECOVER = 6;

export interface QualityState {
  tier: QualityTier;
  /** Consecutive good samples at the current tier. */
  goodStreak: number;
  /** Consecutive bad samples at the current tier. */
  badStreak: number;
}

export function newQualityState(): QualityState {
  return { tier: 'high', goodStreak: 0, badStreak: 0 };
}

/**
 * Feed one smoothed fps average (taken every SAMPLE_SECONDS) and get the
 * possibly-changed state back. Returns true when the tier changed, so the
 * caller can re-apply the settings and toast the player.
 */
export function stepQuality(state: QualityState, avgFps: number): boolean {
  const idx = TIERS.indexOf(state.tier);
  if (avgFps < FPS_BAD) {
    state.goodStreak = 0;
    state.badStreak += 1;
    // Two bad samples in a row = real, not a single hitch (alt-tab, bake).
    if (state.badStreak >= 2 && idx < TIERS.length - 1) {
      state.tier = TIERS[idx + 1];
      state.badStreak = 0;
      state.goodStreak = 0;
      return true;
    }
    return false;
  }
  if (avgFps > FPS_GOOD) {
    state.badStreak = 0;
    state.goodStreak += 1;
    if (state.goodStreak >= GOOD_SAMPLES_TO_RECOVER && idx > 0) {
      state.tier = TIERS[idx - 1];
      state.goodStreak = 0;
      state.badStreak = 0;
      return true;
    }
    return false;
  }
  // The dead band between BAD and GOOD resets both streaks: a machine that
  // runs at exactly 40 fps keeps whatever it already has.
  state.badStreak = 0;
  state.goodStreak = 0;
  return false;
}

export function settingsFor(state: QualityState): QualitySettings {
  return QUALITY_BY_TIER[state.tier];
}

/** Dutch label for the toast when the tier changes. */
export function tierLabel(tier: QualityTier): string {
  switch (tier) {
    case 'high':
      return 'hoge kwaliteit';
    case 'medium':
      return 'evenwichtige kwaliteit';
    case 'low':
      return 'lage kwaliteit';
    default:
      return 'spaartamodus';
  }
}
