/**
 * Shader compilation diagnostics.
 *
 * Babylon only logs failed shader compilations through `Logger.Error` and
 * then keeps rendering: the affected material/post-process silently draws
 * nothing, so a single broken include (e.g. an engine `#include` that
 * depends on another include we never pulled in) degrades the whole world
 * to "blue sky + blue sea" with no visible failure at the call site.
 *
 * `attachShaderDiagnostics` hooks the engine's GLOBAL effect-error
 * observable — it catches every shader in the game (terrain, water,
 * vegetation, sky, atmosphere, bloom and the underwater post-process) —
 * and turns each failure into:
 *   1. a prominent, unmissable `console.error` that names the effect and
 *      the exact GLSL compiler/linker log, and
 *   2. an entry in `shaderCompilationFailures` for tests/QA assertions.
 */
import type { AbstractEngine, Effect } from '@babylonjs/core';

export interface ShaderCompilationFailure {
  /** Effect name (material/effect id as known to the engine). */
  effect: string;
  /** The exact GLSL compilation/linking error log. */
  errors: string;
}

/** Every shader compilation failure observed since engine start. */
export const shaderCompilationFailures: ShaderCompilationFailure[] = [];

/**
 * Registers the global shader-error reporter on the engine.
 * @returns a dispose function that removes the observer again.
 */
export function attachShaderDiagnostics(
  engine: AbstractEngine,
): () => void {
  const observer = engine.onEffectErrorObservable.add(
    (data: { effect: Effect; errors: string }) => {
      const entry: ShaderCompilationFailure = {
        // In v9 the effect name may be a string or an IShaderPath object.
        effect: String(data?.effect?.name ?? 'unknown'),
        errors: String(data?.errors ?? ''),
      };
      shaderCompilationFailures.push(entry);
      // eslint-disable-next-line no-console
      console.error(
        '[AI Survival World] SHADER COMPILATION FAILED — effect "' +
          entry.effect +
          '". The renderer behind this effect (terrain / water / ' +
          'vegetation / sky / atmosphere / post-processing) will NOT ' +
          'draw until this is fixed.\n' +
          entry.errors,
      );
    },
  );
  return () => {
    engine.onEffectErrorObservable.remove(observer);
  };
}

/** Test/QA helper: forgets previously recorded failures. */
export function clearShaderCompilationFailures(): void {
  shaderCompilationFailures.length = 0;
}
