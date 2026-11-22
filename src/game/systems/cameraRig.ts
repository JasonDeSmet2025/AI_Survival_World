/**
 * The camera rig in numbers: how far behind the player the camera hangs, what
 * the scroll wheel does to that distance, and when the distance has become
 * small enough to BE first person.
 *
 * Babylon-free on purpose. The camera is the single most handled thing in this
 * game, so the arithmetic lives here where it is unit-tested, while game.ts
 * only feeds it the frame delta and reads back a height and a distance. The
 * occlusion constants used to be hand-tuned inside game.ts next to the code
 * that used them; they moved here so the pull-in rule and the zoom range can
 * never drift apart (a zoom range that reaches past the pull-in floor is what
 * made this file necessary — see `occlusionFloor`).
 */

/**
 * How far the camera hangs behind the player, in world metres.
 * MIN is 0 on purpose: at 0 the camera IS the player's eyes.
 */
export const CAM_DIST_MIN = 0;
export const CAM_DIST_MAX = 7;
/** The view the game shipped with: a shoulder-cam over the character. */
export const CAM_DIST_DEFAULT = 5.5;
/** One wheel notch is this many metres of zoom (≈14 notches end to end). */
export const CAM_ZOOM_PER_NOTCH = 0.5;
/**
 * Cap on the notches ONE wheel event may request. A violent flick (or a
 * free-spinning mouse wheel) would otherwise skip the entire range in a
 * single frame and read as a jump cut instead of a zoom.
 */
export const MAX_ZOOM_NOTCHES = 4;
/** Below this distance the camera sits in the player's head (first person). */
export const FIRST_PERSON_DIST = 1.05;
/**
 * The body mesh is hidden below BODY_HIDE_DIST and restored above
 * BODY_SHOW_DIST. Two numbers, not one: at a single threshold the smoothed
 * zoom would cross it several times per second and the character would
 * strobe into view and back.
 */
export const BODY_HIDE_DIST = 1.3;
export const BODY_SHOW_DIST = 1.9;
/**
 * Each view keeps its own look angle, and the zoom reframes between them.
 *
 * `CAM_PITCH_DEFAULT` (-0.65 rad, looking 37° down) exists because a shoulder
 * camera must see the ground in front of the player. In first person the same
 * angle points the camera at the player's own boots — leaving the pitch alone
 * produced a wall of grass (seen in a screenshot, not in theory). The fix is
 * deliberately NOT to override the player's aim: the third-person framing and
 * the first-person eye line are stored apart, so zooming out gives back the
 * framing you left and zooming in gives back the horizon.
 */
export const FP_PITCH_REST = -0.06;
/** The reframe happens over the last stretch of the zoom, not from notch one. */
export const FP_PITCH_BLEND = 2.2;
/** Eye height above the feet in first person (the rig targets a ~1.72 m body). */
export const EYE_STANDING = 1.62;
export const EYE_CROUCHING = 1.05;
/**
 * What the third-person camera orbits. These stay at the values the game
 * always used, so pulling the wheel back lands the player exactly in the view
 * they learned — zooming must never silently re-frame the default.
 */
export const PIVOT_STANDING = 1.0;
export const PIVOT_CROUCHING = 0.8;
/** Zoom smoothing: exponential convergence per second (frame-rate safe). */
export const CAM_ZOOM_RATE = 9;
/** The camera stops this far in front of an occluding surface. */
export const CAMERA_SURFACE_OFFSET = 0.35;
/** Never pull the camera closer than this when terrain blocks the view. */
export const CAMERA_MIN_DIST = 2.0;

/**
 * Sanitise a stored or supplied distance: unknown input becomes the shipped
 * default, anything else clamps into range. Same contract as `clampMouseSens`
 * in systems/keybinds.ts — a corrupt settings file may never boot the game
 * into a camera 400 metres behind the player.
 */
export function clampCamDist(v: unknown): number {
  // Only a real number (or a numeric string from a settings file) counts.
  // `Number(null)` is 0 and `Number('')` is 0 as well, so a lax check would
  // read a missing value as "first person" instead of "use the default view".
  if (typeof v !== 'number' && typeof v !== 'string') return CAM_DIST_DEFAULT;
  const n = Number(v);
  if (!Number.isFinite(n)) return CAM_DIST_DEFAULT;
  return Math.min(CAM_DIST_MAX, Math.max(CAM_DIST_MIN, n));
}

/**
 * Wheel delta → zoom notches, sign-normalised so POSITIVE means "zoom out"
 * (scroll down, camera moves away — the direction every engine uses).
 *
 * `deltaMode` is honoured because browsers disagree wildly: 0 is pixels
 * (~100 per notch), 1 is lines (~33 px per line) and 2 is pages. Ignoring it
 * would make one notch on Firefox-with-lines zoom 3× what it does on Chrome.
 */
export function wheelNotches(deltaY: number, deltaMode = 0): number {
  const d = Number(deltaY);
  if (!Number.isFinite(d) || d === 0) return 0;
  const perLine = deltaMode === 1 ? 100 / 3 : deltaMode === 2 ? 800 : 1;
  const px = d * perLine;
  const notches = px / 100;
  return Math.min(MAX_ZOOM_NOTCHES, Math.max(-MAX_ZOOM_NOTCHES, notches));
}

/** Apply wheel input to a distance: scrolling up zooms IN toward the eyes. */
export function zoomDistance(dist: number, notches: number): number {
  const cur = clampCamDist(dist);
  const steps = Number.isFinite(notches) ? notches : 0;
  return clampCamDist(cur + steps * CAM_ZOOM_PER_NOTCH);
}

/**
 * One smoothing step toward `target`. Exponential (not a fixed lerp factor)
 * so 30 fps and 144 fps converge in the same wall-clock time — a frame-rate
 * dependent zoom would feel like a different game on a different machine.
 */
export function smoothCamDist(current: number, target: number, dt: number): number {
  const to = clampCamDist(target);
  if (!Number.isFinite(current) || dt <= 0) return to;
  const cur = clampCamDist(current);
  const k = 1 - Math.exp(-CAM_ZOOM_RATE * dt);
  const next = cur + (to - cur) * k;
  return Math.abs(to - next) < 1e-4 ? to : next;
}

/** True when the camera is close enough to count as first person. */
export function isFirstPerson(dist: number): boolean {
  return clampCamDist(dist) <= FIRST_PERSON_DIST;
}

/** How far behind the eye point the camera is drawn at full zoom (metres). */
export const CAM_EYE_BACKLASH = 0.05;

/**
 * The distance to actually place the camera at.
 *
 * At a zoom of exactly 0 the camera position equals its target, and Babylon
 * then builds the look-at matrix from a zero-length vector: the rotation turns
 * into NaN and never recovers (a QA probe caught the camera's own forward ray
 * coming back NaN). Five centimetres of backlash is invisible and keeps the
 * matrix well-defined.
 */
export function eyeBacklash(dist: number): number {
  return Math.max(clampCamDist(dist), CAM_EYE_BACKLASH);
}

/** 0 = third-person framing, 1 = first-person eye line (smoothstep, no kink). */
export function pitchBlend(dist: number): number {
  const d = clampCamDist(dist);
  const t = Math.min(1, Math.max(0, 1 - d / FP_PITCH_BLEND));
  return t * t * (3 - 2 * t);
}

/** The pitch to render at a given zoom, from the two per-view pitches. */
export function blendPitch(third: number, first: number, dist: number): number {
  const t = pitchBlend(dist);
  // A non-finite pitch must never reach the direction vector: NaN in cos/sin
  // gives a NaN camera that never comes back. FP_PITCH_REST is the neutral
  // angle to fall back to — the one angle that is never wrong in either view.
  const a = Number.isFinite(third) ? third : FP_PITCH_REST;
  const b = Number.isFinite(first) ? first : FP_PITCH_REST;
  return a + (b - a) * t;
}

/**
 * Which view owns the mouse this frame: whichever one the render is nearest.
 * Without this, moving the mouse halfway through a zoom would write to the
 * view being faded OUT, so the pointer would appear to fight the reframe.
 */
export function pitchOwner(dist: number): 'third' | 'first' {
  return pitchBlend(dist) > 0.5 ? 'first' : 'third';
}

/**
 * Is the character mesh allowed to be seen? Hidden deep in the zoom (you are
 * looking OUT of it), visible again once the camera has pulled back past
 * BODY_SHOW_DIST — and unchanged in between (hysteresis).
 */
export function bodyVisible(dist: number, wasVisible: boolean): boolean {
  const d = clampCamDist(dist);
  if (d < BODY_HIDE_DIST) return false;
  if (d > BODY_SHOW_DIST) return true;
  return wasVisible;
}

/**
 * Height of the point the camera looks at / sits at, above the feet.
 *
 * Far out this is exactly the old orbit pivot; as the zoom approaches the
 * head it blends up to the eye line. Blending matters: a hard switch would
 * make the world jump ~60 cm at one instant of the zoom, and the player would
 * feel that as a stumble rather than as stepping into their own body.
 */
export function pivotHeight(crouching: boolean, dist: number): number {
  const orbit = crouching ? PIVOT_CROUCHING : PIVOT_STANDING;
  const eye = crouching ? EYE_CROUCHING : EYE_STANDING;
  const t = 1 - Math.min(1, Math.max(0, clampCamDist(dist) / FIRST_PERSON_DIST));
  return orbit + (eye - orbit) * t;
}

/**
 * How close the terrain pull-in may bring the camera.
 *
 * This is the trap the zoom introduced: the old pull-in floor was a constant
 * 2.0 m, chosen because the camera could never be nearer than that. Once the
 * player CAN zoom past it, "never closer than 2.0" stops being a floor and
 * becomes a ceiling — a hill would push the camera BACK OUT past the distance
 * the player just asked for. The floor may therefore never exceed the distance
 * the player actually wants.
 */
export function occlusionFloor(dist: number): number {
  return Math.min(clampCamDist(dist), CAMERA_MIN_DIST);
}
