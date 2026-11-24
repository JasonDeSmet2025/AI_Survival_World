import { describe, expect, it } from 'vitest';
import {
  APPEASE_COST,
  HOSTILE_AT,
  WITCH_ANGER,
  WITCH_HIT_COOLDOWN,
  WITCH_HITS,
  WITCH_RETURN_S,
  angerWitch,
  appease,
  canHex,
  chatMoodDelta,
  createWitchState,
  inWitchReach,
  isHidden,
  isHostile,
  moodLabel,
  strikeWitch,
  tickWitchMood,
  witchAggro,
} from './witch';

describe('witch mood rules', () => {
  it('starts neutral: present, in one piece, not hostile', () => {
    const s = createWitchState();
    expect(s.anger).toBe(0);
    expect(s.hits).toBe(WITCH_HITS);
    expect(isHostile(s)).toBe(false);
    expect(isHidden(s, 0)).toBe(false);
  });

  it('two sword blows make her hostile, and the flip is reported once', () => {
    const s = createWitchState();
    expect(angerWitch(s, WITCH_ANGER.BLOW)).toBe(false); // 34
    expect(isHostile(s)).toBe(false);
    expect(angerWitch(s, WITCH_ANGER.BLOW)).toBe(true); // 68 ≥ 60
    expect(isHostile(s)).toBe(true);
    expect(angerWitch(s, WITCH_ANGER.BLOW), 'already hostile is not a new flip').toBe(false);
  });

  it('clamps at both ends — she cannot be angrier than furious or nice by numbers', () => {
    const s = createWitchState();
    angerWitch(s, 500);
    expect(s.anger).toBe(100);
    angerWitch(s, -500);
    expect(s.anger).toBe(0);
  });

  it('calms down by itself while the world leaves her alone', () => {
    const s = createWitchState(50);
    tickWitchMood(s, 20); // 20 × 0.25 = 5 points of peace
    expect(s.anger).toBeCloseTo(45);
    tickWitchMood(s, 10_000);
    expect(s.anger, 'peace is patient but it does go negative-proof').toBe(0);
  });

  it('a paid apology resets her completely; a cheap one does not', () => {
    const s = createWitchState(80);
    expect(appease(s, APPEASE_COST - 1)).toBe(false);
    expect(s.anger, 'pride is not on discount').toBe(80);
    expect(appease(s, APPEASE_COST)).toBe(true);
    expect(s.anger).toBe(0);
    expect(appease(s, 1000), 'you cannot apologise at someone who is not angry').toBe(false);
  });

  it('steel does not kill her: it makes her angrier and blinks her away', () => {
    const s = createWitchState();
    let vanished = false;
    for (let blows = 0; blows < 20 && !vanished; blows++) {
      vanished = strikeWitch(s, 2, 10 + blows).vanished; // stone sword: 2 hits
    }
    expect(vanished).toBe(true);
    expect(s.hits, 'she comes back whole').toBe(WITCH_HITS);
    expect(isHidden(s, 10 + 20)).toBe(true);
    expect(isHidden(s, 10 + 20 + WITCH_RETURN_S), 'back at the door after 25s').toBe(false);
    expect(s.anger, 'and NOT in a better mood').toBeGreaterThanOrEqual(HOSTILE_AT);
  });

  it('the hex-hand obeys its cooldown, reach and floor', () => {
    const s = createWitchState(90);
    expect(canHex(s, 5)).toBe(true);
    s.lastHitAt = 5;
    expect(canHex(s, 5 + WITCH_HIT_COOLDOWN - 0.01)).toBe(false);
    expect(canHex(s, 5 + WITCH_HIT_COOLDOWN)).toBe(true);
    expect(inWitchReach(1.8)).toBe(true);
    expect(inWitchReach(2.0)).toBe(false);
  });

  it('she chases on her own floor only — the top of her tower is safe', () => {
    const home = { x: 128, z: 44, y: 0 };
    expect(witchAggro(133, 44, 0, home)).toBe(true);
    expect(witchAggro(145, 44, 0, home), 'out of sight range').toBe(false);
    expect(witchAggro(130, 44, 12, home), 'safe on the tower top').toBe(false);
  });

  it('the chat gate reads insults and apologies, never the walls', () => {
    expect(chatMoodDelta('jij domme heks!')).toBe(WITCH_ANGER.INSULT);
    expect(chatMoodDelta('ik ben op zoek naar een zak aardappelen'), 'a BAG, not an insult').toBe(0);
    expect(chatMoodDelta('dit is volledig dominee-waardig'), 'DOM inside DOMINEE').toBe(0);
    expect(chatMoodDelta('sorry, ik was grof')).toBe(-WITCH_ANGER.APOLOGY);
    expect(chatMoodDelta('sorry, jij domme kwakzalver'), 'insults outvote pity').toBe(WITCH_ANGER.INSULT);
    expect(chatMoodDelta('hoe gaan we handelen vandaag?')).toBe(0);
  });

  it('mood has words for the shop header', () => {
    expect(moodLabel(createWitchState(0))).toBe('gedienstig');
    expect(moodLabel(createWitchState(40))).toBe('geprikkeld');
    expect(moodLabel(createWitchState(75))).toBe('kookt van woede');
  });
});
