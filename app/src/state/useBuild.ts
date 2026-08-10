/**
 * Application state.
 *
 * The whole app is one derivation: benchtop parameters -> `build()` -> a
 * result that every panel reads. Geometry is never stored in React state,
 * matching the core's rule that geometry is derived and the parameters are the
 * source of truth. Editing a field and re-deriving is the only way anything
 * changes shape.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import wasmUrl from 'clipper2-wasm/dist/es/clipper2z.wasm?url';
import type { BenchtopParams, BuildResult, MachineProfile, Material } from '@metal-mate/core';
import { DEFAULT_BENCHTOP, benchtopPart, build, initBooleans } from '@metal-mate/core';

export interface BuildState {
  /** Null until the boolean kernel has loaded. */
  readonly result: BuildResult | null;
  /**
   * Why the last regeneration failed, if it did. Parameters that make no
   * physical sense (a 2 mm drop that its own setback swallows) throw out of the
   * template, and the user needs to see that rather than a blank screen.
   */
  readonly error: string | null;
  readonly ready: boolean;
}

export function useBooleanKernel(): { ready: boolean; error: string | null } {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    initBooleans({ wasmUrl })
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(`could not load the geometry kernel: ${String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return { ready, error };
}

export function useBenchtopBuild(
  params: BenchtopParams,
  machine: MachineProfile,
  /**
   * The shop's materials, which override the built-in ones. Calibrated bend
   * tables live here, so this is how a measured K reaches the flat pattern.
   */
  materials: readonly Material[],
  foldFraction: number,
  ready: boolean,
): BuildState {
  return useMemo(() => {
    if (!ready) return { result: null, error: null, ready: false };
    try {
      const result = build(benchtopPart(params), { machine, materials, foldFraction });
      return { result, error: null, ready: true };
    } catch (e) {
      return { result: null, error: messageOf(e), ready: true };
    }
  }, [params, machine, materials, foldFraction, ready]);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Immutable parameter editing, so every change is one new object. */
export function useBenchtopParams(initial: BenchtopParams = DEFAULT_BENCHTOP): {
  params: BenchtopParams;
  set: <K extends keyof BenchtopParams>(key: K, value: BenchtopParams[K]) => void;
  replace: (next: BenchtopParams) => void;
} {
  const [params, setParams] = useState<BenchtopParams>(initial);
  const set = useCallback(
    <K extends keyof BenchtopParams>(key: K, value: BenchtopParams[K]): void => {
      setParams((current) => ({ ...current, [key]: value }));
    },
    [],
  );
  return { params, set, replace: setParams };
}
