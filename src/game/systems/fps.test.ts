import { describe, expect, it } from 'vitest';
import { FpsMeter } from './fps';

/**
 * The game loop clamps the simulation dt to 0.05 s (20 fps equivalent).
 * The old HUD counter averaged THAT value, so it could never report lower
 * than 20 fps. These tests pin the meter to real, unclamped frame times.
 */
describe('FpsMeter', () => {
  it('reports a genuinely slow frame rate instead of the 20 fps clamp', () => {
    const meter = new FpsMeter();
    // One frame per second = 1 fps. With the old clamped average this read 20.
    let updated = false;
    for (let i = 0; i < 3; i++) updated = meter.tick(1.0);
    expect(updated).toBe(true);
    expect(meter.fps).toBe(1);
  });

  it('counts a 60 fps workload as 60', () => {
    const meter = new FpsMeter();
    let updated = false;
    for (let i = 0; i < 120; i++) updated = meter.tick(1 / 60) || updated;
    expect(updated).toBe(true);
    expect(meter.fps).toBe(60);
  });

  it('only reports an update once the window has elapsed', () => {
    const meter = new FpsMeter(2);
    expect(meter.tick(0.5)).toBe(false);
    expect(meter.tick(0.5)).toBe(false);
    expect(meter.framesInWindow).toBe(2);
    expect(meter.fps).toBe(0); // no completed window yet
    expect(meter.tick(1.0)).toBe(true);
    expect(meter.fps).toBe(2); // 3 frames across 2 seconds (1.5 → rounds to 2)
    expect(meter.framesInWindow).toBe(0);
  });

  it('averages the whole window, not the last frame', () => {
    const meter = new FpsMeter();
    meter.tick(0.9); // one slow frame
    expect(meter.tick(0.2)).toBe(true); // window closes at 1.1 s
    // 2 frames in 1.1 s ≈ 2 fps — a single fast frame must not hide the stall.
    expect(meter.fps).toBe(2);
  });

  it('ignores zero, negative and non-finite frame times', () => {
    const meter = new FpsMeter();
    expect(meter.tick(0)).toBe(false);
    expect(meter.tick(-1)).toBe(false);
    expect(meter.tick(Number.NaN)).toBe(false);
    expect(meter.tick(Number.POSITIVE_INFINITY)).toBe(false);
    expect(meter.framesInWindow).toBe(0);
    expect(meter.tick(0.5)).toBe(false);
    expect(meter.framesInWindow).toBe(1);
  });

  it('reset clears the window and the reported value', () => {
    const meter = new FpsMeter();
    meter.tick(1.2);
    expect(meter.fps).toBe(1);
    meter.reset();
    expect(meter.fps).toBe(0);
    expect(meter.framesInWindow).toBe(0);
  });

  it('falls back to a sane window for a nonsensical constructor argument', () => {
    const meter = new FpsMeter(0);
    expect(meter.windowSeconds).toBe(1);
    expect(meter.tick(1.5)).toBe(true);
  });
});
