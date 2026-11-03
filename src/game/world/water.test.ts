import { describe, it, expect } from 'vitest';
import { Water } from './water';

describe('Water module', () => {
  it('exports a class with the expected lifecycle/scene API', () => {
    expect(typeof Water).toBe('function');
    for (const method of ['syncSun', 'update', 'dispose']) {
      expect(typeof (Water.prototype as unknown as Record<string, unknown>)[method]).toBe('function');
    }
  });
});
