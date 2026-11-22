import { describe, expect, it } from 'vitest';
import {
  BODY_HIDE_DIST,
  BODY_SHOW_DIST,
  CAM_DIST_DEFAULT,
  CAM_DIST_MAX,
  CAM_DIST_MIN,
  CAM_ZOOM_PER_NOTCH,
  CAMERA_MIN_DIST,
  EYE_STANDING,
  FIRST_PERSON_DIST,
  FP_PITCH_REST,
  MAX_ZOOM_NOTCHES,
  PIVOT_CROUCHING,
  PIVOT_STANDING,
  blendPitch,
  bodyVisible,
  clampCamDist,
  eyeBacklash,
  isFirstPerson,
  occlusionFloor,
  pitchBlend,
  pitchOwner,
  pivotHeight,
  smoothCamDist,
  wheelNotches,
  zoomDistance,
} from './cameraRig';
// The third-person rest angle lives with the player controller (it is also the
// angle the save file stores). Imported rather than copied, so this suite
// cannot go green while the shipped rest angle drifts underneath it.
import { CAM_PITCH_DEFAULT } from '../player/controller';

describe('zoom range', () => {
  it('keeps a stored or supplied distance inside the rig', () => {
    expect(clampCamDist(3)).toBe(3);
    expect(clampCamDist(-12)).toBe(CAM_DIST_MIN);
    expect(clampCamDist(400)).toBe(CAM_DIST_MAX);
    // A corrupt settings file must fall back to the shipped view, not to 0
    // (which would drop the player face-first into their own skull).
    expect(clampCamDist('vijf')).toBe(CAM_DIST_DEFAULT);
    expect(clampCamDist(undefined)).toBe(CAM_DIST_DEFAULT);
    expect(clampCamDist(Number.NaN)).toBe(CAM_DIST_DEFAULT);
    expect(clampCamDist(null)).toBe(CAM_DIST_DEFAULT);
  });

  it('reaches first person and a wide pull-out', () => {
    expect(CAM_DIST_MIN).toBe(0);
    expect(zoomDistance(CAM_DIST_DEFAULT, -99)).toBe(CAM_DIST_MIN);
    expect(zoomDistance(CAM_DIST_DEFAULT, 99)).toBe(CAM_DIST_MAX);
    expect(isFirstPerson(CAM_DIST_MIN)).toBe(true);
    expect(isFirstPerson(CAM_DIST_MAX)).toBe(false);
  });
});

describe('wheel input', () => {
  it('scrolling up zooms in, scrolling down zooms out', () => {
    const d = zoomDistance(CAM_DIST_DEFAULT, wheelNotches(-100, 0));
    expect(d).toBeCloseTo(CAM_DIST_DEFAULT - CAM_ZOOM_PER_NOTCH, 9);
    const out = zoomDistance(CAM_DIST_DEFAULT, wheelNotches(100, 0));
    expect(out).toBeCloseTo(CAM_DIST_DEFAULT + CAM_ZOOM_PER_NOTCH, 9);
  });

  it('honours the deltaMode browsers disagree about', () => {
    // One notch is ~100 px, ~3 lines, or a page. Normalising by mode is what
    // makes the same gesture zoom the same amount in every browser.
    expect(wheelNotches(-100, 0)).toBeCloseTo(-1, 9);
    expect(wheelNotches(-3, 1)).toBeCloseTo(-1, 9);
    // A page scroll is far more than one notch, so it hits the cap. That is
    // the point of the cap, not a rounding accident.
    expect(wheelNotches(-1, 2)).toBe(-MAX_ZOOM_NOTCHES);
    expect(wheelNotches(100, 0)).toBeCloseTo(1, 9);
    expect(wheelNotches(0, 0)).toBe(0);
    expect(wheelNotches(Number.NaN, 0)).toBe(0);
  });

  it('caps one violent flick so the zoom cannot skip the whole range', () => {
    expect(wheelNotches(-100000, 0)).toBe(-MAX_ZOOM_NOTCHES);
    const one = zoomDistance(CAM_DIST_DEFAULT, wheelNotches(-100000, 0));
    expect(one).toBeCloseTo(CAM_DIST_DEFAULT - MAX_ZOOM_NOTCHES * CAM_ZOOM_PER_NOTCH, 9);
  });

  it('walks from third person to first person in a sane number of notches', () => {
    let d = CAM_DIST_DEFAULT;
    let notches = 0;
    while (d > CAM_DIST_MIN && notches < 60) {
      d = zoomDistance(d, wheelNotches(-100, 0));
      notches++;
    }
    expect(d).toBe(CAM_DIST_MIN);
    // Too few notches and zooming feels twitchy; too many and the player
    // cranks the wheel for ten seconds before reaching their own eyes.
    expect(notches).toBeGreaterThanOrEqual(8);
    expect(notches).toBeLessThanOrEqual(20);
  });
});

describe('zoom smoothing', () => {
  it('converges in wall-clock time, not in frames', () => {
    // 1/30 s twice must land where two 1/60 s steps ... would not: what has to
    // match is the RESULT after the same amount of time, at any frame rate.
    let slow = CAM_DIST_DEFAULT;
    for (let i = 0; i < 2; i++) slow = smoothCamDist(slow, CAM_DIST_MIN, 1 / 30);
    let fast = CAM_DIST_DEFAULT;
    for (let i = 0; i < 4; i++) fast = smoothCamDist(fast, CAM_DIST_MIN, 1 / 60);
    expect(Math.abs(fast - slow)).toBeLessThan(0.05);
    // And both are actually moving toward the target.
    expect(slow).toBeLessThan(CAM_DIST_DEFAULT);
    expect(slow).toBeGreaterThan(CAM_DIST_MIN);
  });

  it('settles exactly on the target and survives junk', () => {
    let d = CAM_DIST_DEFAULT;
    for (let i = 0; i < 200; i++) d = smoothCamDist(d, CAM_DIST_MAX, 1 / 60);
    expect(d).toBe(CAM_DIST_MAX);
    expect(smoothCamDist(Number.NaN, 3, 0.016)).toBe(3);
    expect(smoothCamDist(3, 2, 0)).toBe(2); // no delta: jump, never divide by it
  });
});

describe('the pivot as the camera closes in', () => {
  it('keeps the shipped third-person framing', () => {
    // At the default distance the pivot must be EXACTLY what it always was,
    // or shipping the zoom silently re-frames the whole game.
    expect(pivotHeight(false, CAM_DIST_DEFAULT)).toBe(PIVOT_STANDING);
    expect(pivotHeight(true, CAM_DIST_DEFAULT)).toBe(PIVOT_CROUCHING);
    expect(pivotHeight(false, CAM_DIST_MAX)).toBe(PIVOT_STANDING);
  });

  it('lands on the eye line in first person', () => {
    expect(pivotHeight(false, 0)).toBe(EYE_STANDING);
    expect(pivotHeight(true, 0)).toBeLessThan(EYE_STANDING);
  });

  it('blends instead of snapping halfway in', () => {
    const mid = pivotHeight(false, FIRST_PERSON_DIST / 2);
    expect(mid).toBeGreaterThan(PIVOT_STANDING);
    expect(mid).toBeLessThan(EYE_STANDING);
    // Monotonic: no bump, no dip, nothing that could read as a stumble.
    let prev = PIVOT_STANDING;
    const steps = 24;
    for (let i = 1; i <= steps; i++) {
      const h = pivotHeight(false, FIRST_PERSON_DIST * (1 - i / steps));
      expect(h).toBeGreaterThanOrEqual(prev);
      prev = h;
    }
    expect(prev).toBe(EYE_STANDING);
  });
});

describe('hiding the body you are looking out of', () => {
  it('is invisible in first person, visible from behind', () => {
    expect(bodyVisible(0, true)).toBe(false);
    expect(bodyVisible(CAM_DIST_DEFAULT, false)).toBe(true);
  });

  it('does not strobe while the zoom crosses the threshold', () => {
    // Hysteresis: inside the band the answer is whatever it already was.
    expect(bodyVisible(1.5, false)).toBe(false);
    expect(bodyVisible(1.5, true)).toBe(true);
    expect(BODY_HIDE_DIST).toBeLessThan(BODY_SHOW_DIST);
    expect(BODY_HIDE_DIST).toBeGreaterThanOrEqual(FIRST_PERSON_DIST);
    // The body must already be gone before the camera reaches the head, or
    // the player stares through the back of their own skull.
    expect(BODY_HIDE_DIST).toBeGreaterThan(FIRST_PERSON_DIST * 1.1);
  });

  it('survives junk input', () => {
    expect(bodyVisible(Number.NaN, true)).toBe(true);
    expect(bodyVisible('x' as unknown as number, true)).toBe(true);
  });
});

describe('per-view look angle', () => {
  it('renders the shipped framing when fully zoomed out', () => {
    // Zooming must not re-frame the view the player learned: at full distance
    // the pitch is exactly the third-person one, whatever first person does.
    expect(pitchBlend(CAM_DIST_MAX)).toBe(0);
    expect(blendPitch(CAM_PITCH_DEFAULT, FP_PITCH_REST, CAM_DIST_MAX)).toBe(CAM_PITCH_DEFAULT);
  });

  it('lands on the horizon when fully zoomed in', () => {
    // The reason this exists: the shoulder-cam rests at -0.65 rad (37° down).
    // Kept in first person that is a wall of grass, which is what the first
    // screenshot of this feature actually showed.
    expect(pitchBlend(0)).toBe(1);
    expect(blendPitch(CAM_PITCH_DEFAULT, FP_PITCH_REST, 0)).toBeCloseTo(FP_PITCH_REST);
  });

  it('reframes monotonically across the whole zoom', () => {
    // The blend falls as the distance grows: fully in at 0 m, fully out at the
    // far end, never a step or a wobble in between.
    let prev = 99;
    for (let d = CAM_DIST_MIN; d <= CAM_DIST_MAX; d += 0.1) {
      const t = pitchBlend(d);
      expect(t).toBeLessThanOrEqual(prev + 1e-9);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
      prev = t;
    }
    // Third person must dominate for most of the range: a camera that starts
    // tilting on the first notch of the wheel is not the same game any more.
    expect(pitchBlend(CAM_DIST_DEFAULT * 0.5)).toBeLessThan(0.05);
  });

  it('hands the mouse to the view being rendered', () => {
    // Halfway through a zoom, writing the mouse to the view that is fading out
    // makes the pointer appear to fight the camera.
    expect(pitchOwner(CAM_DIST_DEFAULT)).toBe('third');
    expect(pitchOwner(0)).toBe('first');
    for (const d of [0, 1.4, 3, 5.5, 7]) {
      // The owner must be the view the blend has already committed to.
      const committed = pitchBlend(d) > 0.5 ? 'first' : 'third';
      expect(pitchOwner(d)).toBe(committed);
    }
  });

  it('never lets the eye camera coincide with its own target', () => {
    // A camera sitting exactly on its target builds its rotation from a
    // zero-length vector → NaN, permanently. Verified in a live probe.
    expect(eyeBacklash(0)).toBeGreaterThan(0);
    expect(Number.isFinite(eyeBacklash(0))).toBe(true);
    // …and it stays invisible: 5 cm out of a 5.5 m view.
    expect(eyeBacklash(0)).toBeLessThan(0.1);
    expect(eyeBacklash(4)).toBe(4);
  });

  it('falls back to a finite angle for junk pitches', () => {
    // A NaN pitch reaching the renderer would put NaN in the direction vector
    // and the camera would vanish for the rest of the session.
    expect(blendPitch(Number.NaN, 0, CAM_DIST_DEFAULT)).toBe(FP_PITCH_REST);
    expect(Number.isFinite(blendPitch(0, Number.POSITIVE_INFINITY, 2))).toBe(true);
  });
});

describe('terrain occlusion against the zoom range', () => {
  it('never pushes the camera further out than the player asked for', () => {
    // The bug this guards: the pull-in floor used to be the constant 2.0 m,
    // fine while the camera could not come closer — but once zooming reaches
    // 0.5 m, a wall would have shoved the view back out to 2.0 m, i.e. the
    // floor would have acted as a ceiling on the player's own zoom.
    expect(occlusionFloor(CAM_DIST_DEFAULT)).toBe(CAMERA_MIN_DIST);
    expect(occlusionFloor(1.2)).toBe(1.2);
    expect(occlusionFloor(0)).toBe(0);
    for (let d = CAM_DIST_MIN; d <= CAM_DIST_MAX; d += 0.25) {
      expect(occlusionFloor(d)).toBeLessThanOrEqual(d + 1e-9);
    }
  });
});
