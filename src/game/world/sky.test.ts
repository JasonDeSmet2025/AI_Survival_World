import { describe, it, expect } from 'vitest';
import { Sky } from './sky';

describe('Sky module', () => {
  it('exports a class with the expected day/scene API', () => {
    expect(typeof Sky).toBe('function');
    for (const method of ['setDay', 'centerOn', 'dispose']) {
      expect(typeof (Sky.prototype as unknown as Record<string, unknown>)[method]).toBe('function');
    }
  });
});
