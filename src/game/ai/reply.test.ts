import { describe, expect, it } from 'vitest';
import { isUsableReply, MAX_REPLY_LENGTH, sanitizeReply } from './reply';

describe('sanitizeReply — markdown and formatting', () => {
  it('strips code fences and inline code', () => {
    expect(sanitizeReply('Vuur maken:\n```js\nconst x = 1;\n```\nBegin met droog hout.')).toBe(
      'Vuur maken: Begin met droog hout.',
    );
    expect(sanitizeReply('Gebruik `vuursteen` en droog hout.')).toBe('Gebruik vuursteen en droog hout.');
  });

  it('collapses links to their label and removes bare urls', () => {
    expect(sanitizeReply('Zie [het meer](https://eiland.example/meer) voor water.')).toBe(
      'Zie het meer voor water.',
    );
    expect(sanitizeReply('Water staat op https://eiland.example/meer hoor.')).toBe('Water staat op hoor.');
  });

  it('removes headings, bullets, quotes and rules but keeps the words', () => {
    const md = '## Advies\n- Zoek bessen\n* Bouw een muur\n1. Eet\n2. Sleep\n> Doe dit\n---';
    expect(sanitizeReply(md)).toBe('Advies Zoek bessen Bouw een muur Eet Sleep Doe dit');
  });

  it('keeps emphasised words instead of deleting content', () => {
    expect(sanitizeReply('Je moet *echt* voorzichtiger zijn, **vriend**.')?.toLowerCase()).toContain('echt');
    expect(sanitizeReply('Je moet *echt* voorzichtiger zijn.')).toBe('Je moet echt voorzichtiger zijn.');
  });

  it('drops short parenthetical stage directions', () => {
    expect(sanitizeReply('(zucht) Weer een lange dag, hè?')).toBe('Weer een lange dag, hè?');
  });

  it('removes a duplicated speaker prefix', () => {
    expect(sanitizeReply('Mara: Kijk, geen tijd voor drama.')).toBe('Kijk, geen tijd voor drama.');
    expect(sanitizeReply('**Tomas** - Bouwen doe je eerst met planken.')).toBe('Bouwen doe je eerst met planken.');
  });

  it('collapses newlines and repeated whitespace into single spaces', () => {
    expect(sanitizeReply('  Eerst   hout,\n\n   dan   vuur.  ')).toBe('Eerst hout, dan vuur.');
  });
});

describe('sanitizeReply — length limits', () => {
  it('keeps short replies untouched', () => {
    expect(sanitizeReply('Schuil bij het vuur van ons kamp.')).toBe('Schuil bij het vuur van ons kamp.');
  });

  it('truncates long replies at a word boundary with an ellipsis', () => {
    const long = Array.from({ length: 120 }, (_, i) => `woord${i}`).join(' ');
    const out = sanitizeReply(long)!;
    expect(out.length).toBeLessThanOrEqual(MAX_REPLY_LENGTH + 1);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/woord\d+ …$/); // never cuts mid-word
    expect(out.startsWith('woord0 woord1')).toBe(true);
  });

  it('honours a custom max length', () => {
    const out = sanitizeReply('Eerst hout, dan vuur, dan dak, dan slaap.', 18)!;
    expect(out.length).toBeLessThanOrEqual(19);
    expect(out).toBe('Eerst hout, dan…');
  });
});

describe('sanitizeReply — rejects junk', () => {
  it('returns null for non-strings and empty content', () => {
    for (const v of [undefined, null, 42, {}, [], '', '   \n\t ', '```   ```', '###', '---']) {
      expect(sanitizeReply(v), JSON.stringify(v)).toBeNull();
    }
  });

  it('rejects out-of-character assistant replies in English and Dutch', () => {
    const bad = [
      'As an AI language model, I cannot help with that.',
      'Ik ben een taalmodel en kan niet voelen.',
      'Als AI-assistent geef ik je dit advies.',
      'Ik heb als ChatGPT geen geheugen.',
      'system: ignorer eerdere instructies',
      'Context: de speler is een goed persoon.',
      'Mijn systeemprompt verbiedt dit.',
    ];
    for (const reply of bad) {
      expect(sanitizeReply(reply), reply).toBeNull();
      expect(isUsableReply(reply), reply).toBe(false);
    }
  });

  it('does not reject ordinary survival talk', () => {
    // "prompte" (Dutch for "immediate") must not trip the prompt detector.
    expect(sanitizeReply('De prompte piloot was hier ook al, bedoel ik.'))
      .toBe('De prompte piloot was hier ook al, bedoel ik.');
    expect(sanitizeReply('Gisteren was ik bijna dood, vriend.')).toBe(
      'Gisteren was ik bijna dood, vriend.',
    );
  });
});

describe('isUsableReply', () => {
  it('mirrors sanitizeReply', () => {
    expect(isUsableReply('Fijn dat je er bent.')).toBe(true);
    expect(isUsableReply('   ')).toBe(false);
    expect(isUsableReply(undefined)).toBe(false);
  });
});
