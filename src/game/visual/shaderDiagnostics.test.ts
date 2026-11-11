import { describe, expect, it, vi } from 'vitest';
import { Effect, NullEngine } from '@babylonjs/core';
import {
  attachShaderDiagnostics,
  clearShaderCompilationFailures,
  shaderCompilationFailures,
} from './shaderDiagnostics';

/**
 * Shader compilation diagnostics: a broken shader must never fail silently
 * (it degrades the whole world to sky+sea). The engine's global
 * `onEffectErrorObservable` is the single funnel for EVERY failed
 * compilation (terrain, water, vegetation, sky, atmosphere, bloom,
 * underwater post-process), so the reporter is tested through it.
 */
describe('shader diagnostics', () => {
  it('records every failed effect compilation with its GLSL error log', () => {
    const engine = new NullEngine();
    clearShaderCompilationFailures();
    const dispose = attachShaderDiagnostics(engine);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const effect = { name: 'terrainMat' } as unknown as Effect;
    engine.onEffectErrorObservable.notifyObservers({
      effect,
      errors: 'getRand : no matching overloaded function found',
    });

    expect(shaderCompilationFailures.length).toBe(1);
    expect(shaderCompilationFailures[0]).toEqual({
      effect: 'terrainMat',
      errors: 'getRand : no matching overloaded function found',
    });
    // The failure is announced clearly, not just collected.
    expect(consoleSpy).toHaveBeenCalled();
    const logged = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('SHADER COMPILATION FAILED');
    expect(logged).toContain('terrainMat');
    expect(logged).toContain('getRand : no matching overloaded function found');
    consoleSpy.mockRestore();

    dispose();
    engine.dispose();
  });

  it('dispose stops reporting (observer removed)', () => {
    const engine = new NullEngine();
    clearShaderCompilationFailures();
    const dispose = attachShaderDiagnostics(engine);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    dispose();
    engine.onEffectErrorObservable.notifyObservers({
      effect: { name: 'x' } as unknown as Effect,
      errors: 'late',
    });

    expect(shaderCompilationFailures.length).toBe(0);
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
    engine.dispose();
  });

  it('tolerates malformed payloads', () => {
    const engine = new NullEngine();
    clearShaderCompilationFailures();
    const dispose = attachShaderDiagnostics(engine);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // v9 observables always receive the notified value, but the handler
    // must not throw on a partial payload.
    engine.onEffectErrorObservable.notifyObservers({} as { effect: Effect; errors: string });

    expect(shaderCompilationFailures.length).toBe(1);
    expect(shaderCompilationFailures[0].effect).toBe('unknown');
    expect(typeof shaderCompilationFailures[0].errors).toBe('string');
    consoleSpy.mockRestore();

    dispose();
    engine.dispose();
  });
});
