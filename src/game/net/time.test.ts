/**
 * Unit tests for the client side of the shared clock (src/game/net/time.ts).
 *
 * The property that matters to a player: two browsers in one world show the
 * same sky, without the sun stuttering on every server update.
 */
import { describe, expect, it } from 'vitest';
import { dayDelta, DAY_LENGTH_S, ServerClock, wrapDay } from './time';

describe('wrapDay / dayDelta', () => {
  it('wraps both directions into [0,1)', () => {
    expect(wrapDay(1.25)).toBeCloseTo(0.25);
    expect(wrapDay(-0.1)).toBeCloseTo(0.9);
  });

  it('takes the short way around midnight', () => {
    // 23:00 -> 01:00 is +2 hours, not -22.
    expect(dayDelta(23 / 24, 1 / 24)).toBeCloseTo(2 / 24);
    expect(dayDelta(1 / 24, 23 / 24)).toBeCloseTo(-2 / 24);
  });
});

describe('ServerClock', () => {
  it('is not synced until the first hello/time message', () => {
    const c = new ServerClock();
    expect(c.synced).toBe(false);
    c.sync(0.5, 0);
    expect(c.synced).toBe(true);
  });

  it('extrapolates between server updates at the game day rate', () => {
    const c = new ServerClock(DAY_LENGTH_S);
    c.sync(0.5, 0);
    // A quarter of a 900 s day later: 0.25 of the cycle further.
    expect(c.expected(DAY_LENGTH_S * 1000 * 0.25)).toBeCloseTo(0.75);
    expect(c.expected(DAY_LENGTH_S * 1000), '0.5, 6').toBeCloseTo(0.5, 6);
  });

  it('ignores a malformed time instead of stopping the sun', () => {
    const c = new ServerClock(DAY_LENGTH_S);
    c.sync(0.4, 0);
    c.sync(Number.NaN, 1000);
    c.sync(undefined as unknown as number, 1000);
    // The last good value is kept and keeps running (a corrupt message must
    // never freeze the sky).
    expect(c.expected(1000)).toBeCloseTo(0.4 + 1 / DAY_LENGTH_S, 6);
    c.sync(0.9, 1000);
    expect(c.expected(1000)).toBeCloseTo(0.9);
  });

  it('follow() runs the local clock on its own while unsynced', () => {
    const c = new ServerClock(DAY_LENGTH_S);
    const t = c.follow(0.5, 45, 0); // 45 s of real time = 1/20 of a day
    expect(t).toBeCloseTo(0.5 + 45 / DAY_LENGTH_S);
  });

  it('follow() eases a small error away instead of snapping', () => {
    const c = new ServerClock(DAY_LENGTH_S);
    c.sync(0.502, 0); // server is 0.002 ahead of us
    const t = c.follow(0.5, 0.016, 16);
    // It moved forward (the sun must not stutter backwards) but not all the
    // way to the server value in one frame.
    expect(t).toBeGreaterThan(0.5);
    expect(t).toBeLessThan(0.502 + 1e-9);
    // ...and it keeps closing the gap while real time runs.
    let cur = 0.5;
    for (let i = 1; i <= 400; i++) cur = c.follow(cur, 0.016, i * 16);
    expect(Math.abs(dayDelta(cur, c.expected(6400)))).toBeLessThan(0.0005);
  });

  it('follow() snaps a real desync (laptop lid closed, someone else slept)', () => {
    const c = new ServerClock(DAY_LENGTH_S);
    c.sync(0.75, 0);
    // Local clock still thinks it is night: 0.02 of a day away is beyond the
    // snap threshold, so this frame must already show the server value.
    const t = c.follow(0.7, 0.016, 0);
    expect(Math.abs(dayDelta(t, 0.75))).toBeLessThan(0.005);
  });

  it('a jump broadcast (someone slept) and a routine update are both followable', () => {
    const c = new ServerClock(DAY_LENGTH_S);
    c.sync(0.9, 0); // late night
    c.sync(0.25, 1000); // the world woke up at 06:00
    let cur = 0.9;
    for (let i = 0; i < 40; i++) cur = c.follow(cur, 0.016, 1000 + i * 16);
    expect(Math.abs(dayDelta(cur, 0.25)), '0.01').toBeLessThan(0.01);
  });

  it('never leaves the [0,1) range, whatever comes in', () => {
    const c = new ServerClock(DAY_LENGTH_S);
    for (const bad of [-7.3, 1e6, 0.5]) {
      c.sync(bad, 0);
      const t = c.follow(0.31, 0.25, 500);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(1);
    }
  });

  it('a clock that never receives a time keeps the solo cycle running', () => {
    // Solo play must be untouched by this system: unsynced means "don't
    // interfere", not "freeze the sun at midnight".
    const c = new ServerClock();
    expect(c.synced).toBe(false);
    expect(c.follow(0.4, 10, 0)).toBeCloseTo(0.4 + 10 / DAY_LENGTH_S);
  });
});
