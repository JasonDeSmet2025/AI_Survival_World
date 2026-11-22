import { describe, expect, it } from 'vitest';
import { ConfirmFlow } from './confirm';

/**
 * "New world" wipes the save. It used to be a window.confirm() INSIDE the
 * render loop, which blocked the browser thread — the game froze while the
 * dialog was open. The replacement is a timed two-press flow, so the timing
 * contract itself has to be tested.
 */
describe('ConfirmFlow', () => {
  it('arms on the first press and confirms on the second', () => {
    const flow = new ConfirmFlow(5);
    expect(flow.isArmed(0)).toBe(false);
    expect(flow.press(0)).toBe('armed');
    expect(flow.isArmed(0.5)).toBe(true);
    expect(flow.press(1)).toBe('confirmed');
    // Confirmed flows reset: a third press starts over instead of repeating.
    expect(flow.isArmed(1)).toBe(false);
    expect(flow.press(2)).toBe('armed');
  });

  it('expires the arm by itself, so a forgotten key does not wipe later', () => {
    const flow = new ConfirmFlow(5);
    expect(flow.press(10)).toBe('armed');
    expect(flow.remaining(12)).toBeCloseTo(3, 5);
    // Past the window the arm is gone: the next press starts a NEW
    // confirmation instead of wiping the save.
    expect(flow.press(15.001)).toBe('armed');
    expect(flow.remaining(20.002)).toBe(0);
    expect(flow.isArmed(15.001)).toBe(true); // re-armed by that press
  });

  it('cancel() drops a pending arm', () => {
    const flow = new ConfirmFlow(5);
    flow.press(0);
    flow.cancel();
    expect(flow.isArmed(0.1)).toBe(false);
    expect(flow.press(0.2)).toBe('armed');
  });

  it('remaining() is 0 when idle and never negative', () => {
    const flow = new ConfirmFlow(5);
    expect(flow.remaining(0)).toBe(0);
    flow.press(100);
    expect(flow.remaining(104.5)).toBeGreaterThan(0);
    expect(flow.remaining(104.5)).toBeLessThanOrEqual(5);
    expect(flow.remaining(1000)).toBe(0);
    // A clock that jumps backwards can never produce a negative countdown
    // nor a countdown longer than the window itself.
    expect(flow.remaining(-50)).toBe(5);
    expect(flow.remaining(99.9)).toBeCloseTo(5, 5);
  });

  it('sanitises a nonsensical window', () => {
    const flow = new ConfirmFlow(0);
    expect(flow.windowSeconds).toBe(5);
    expect(flow.press(0)).toBe('armed');
    expect(flow.press(4.9)).toBe('confirmed');
  });
});
