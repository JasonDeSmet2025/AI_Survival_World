import { describe, expect, it } from 'vitest';
import { movementAxes } from './input';

describe('keyboard movement axes', () => {
  it('moves forward with Z or W and backward with S', () => {
    expect(movementAxes(new Set(['KeyZ'])).forward).toBe(1);
    expect(movementAxes(new Set(['KeyW'])).forward).toBe(1);
    expect(movementAxes(new Set(['KeyS'])).forward).toBe(-1);
  });

  it('keeps A/D strafe and arrow-key movement', () => {
    expect(movementAxes(new Set(['KeyA'])).strafe).toBe(-1);
    expect(movementAxes(new Set(['KeyD'])).strafe).toBe(1);
    expect(movementAxes(new Set(['ArrowUp'])).forward).toBe(1);
    expect(movementAxes(new Set(['ArrowDown'])).forward).toBe(-1);
  });
});
