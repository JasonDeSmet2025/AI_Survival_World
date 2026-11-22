/**
 * Shared world clock unit tests.
 * Run with: node --test server/clock.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldClock, DAY_LENGTH_S, MORNING } from './clock.mjs';

const at = (ms) => () => ms;

test('clock: time advances at the client day rate', () => {
  let now = 1000;
  const clock = createWorldClock({ start: 0, now: () => now });
  assert.equal(clock.time(), 0);
  now += DAY_LENGTH_S * 1000 / 2;
  assert.equal(clock.time(), 0.5);
  now += DAY_LENGTH_S * 1000 / 2;
  assert.equal(clock.time(), 0, 'a full day wraps back to midnight');
});

test('clock: start and persisted offset both anchor the cycle', () => {
  const a = createWorldClock({ start: 0.75, now: at(0) });
  assert.equal(a.time(), 0.75);
  // Persisted cycle-seconds survive a restart (the server reboot case).
  const b = createWorldClock({ start: 0, now: at(0), offsetS: DAY_LENGTH_S * 0.25 });
  assert.equal(b.time(), 0.25);
  assert.equal(b.offsetAt(), DAY_LENGTH_S * 0.25);
});

test('clock: setTime re-anchors without time travel', () => {
  let now = 0;
  const clock = createWorldClock({ start: 0.1, now: () => now });
  clock.setTime(0.5);
  assert.equal(clock.time(), 0.5);
  now += DAY_LENGTH_S * 1000 * 0.1;
  assert.equal(clock.time(), 0.6, 'continues forward from the new anchor');
});

test('clock: advanceToMorning always moves forward to 06:00', () => {
  const cases = [
    { start: 0.2, expect: MORNING }, // evening of the same cycle
    { start: 0.9, expect: MORNING }, // late night -> next morning
    { start: 0.25, expect: MORNING }, // exactly at wake time
  ];
  for (const { start } of cases) {
    let now = 0;
    const clock = createWorldClock({ start, now: () => now });
    const before = clock.time();
    const after = clock.advanceToMorning();
    assert.equal(after, MORNING, `lands on 06:00 from ${start}`);
    assert.ok(after >= before || before > MORNING, `never rewinds the world (${start})`);
  }
});

test('clock: sleeping at 05:00 is a short hop, not a full rewind', () => {
  let now = 0;
  const clock = createWorldClock({ start: 5 / 24, now: () => now });
  const t = clock.advanceToMorning();
  assert.equal(t, MORNING);
  // 05:00 -> 06:00 is 1/24 of a day forward (25% of the cycle crossed the
  // long way would be wrong); the clock must have moved at most a day.
  assert.ok(clock.offsetAt() >= 0 && clock.offsetAt() < DAY_LENGTH_S);
});

test('clock: sleeping at exactly 06:00 still lands on a valid morning', () => {
  let now = 0;
  const clock = createWorldClock({ start: MORNING, now: () => now });
  const t = clock.advanceToMorning();
  assert.equal(t, MORNING);
  assert.ok(Number.isFinite(clock.offsetAt()) && clock.offsetAt() >= 0 && clock.offsetAt() < DAY_LENGTH_S);
  // Wrapped time-of-day cannot show it, but the cycle clock itself moved a
  // full day forward: sleeping again must not rewind anything.
  now += 1000;
  assert.ok(clock.time() > MORNING, 'the cycle keeps running after the jump');
});

test('clock: malformed input cannot break the cycle', () => {
  const clock = createWorldClock({ start: 0.4, now: at(0) });
  clock.setTime(Number.NaN);
  assert.equal(clock.time(), 0);
  clock.setTime(12.34);
  assert.ok(clock.time() >= 0 && clock.time() < 1);
  assert.equal(createWorldClock({ dayLengthS: 0, start: 0.5, now: at(0) }).dayLengthS, DAY_LENGTH_S);
});

test('clock: msUntil schedules the next announcement', () => {
  const clock = createWorldClock({ start: 0, now: at(0) });
  assert.equal(clock.msUntil(0.5), DAY_LENGTH_S * 500);
});
