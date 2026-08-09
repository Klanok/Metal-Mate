/**
 * The whole pipeline in one call: part -> graph -> flat -> validation -> DXF.
 *
 * This is what the application layer drives on every parameter change, and
 * what the tests exercise end to end. Keeping it here rather than in the UI
 * means the pipeline order — and in particular the rule that validation gates
 * export — is part of the core, not a thing the UI has to remember.
 */

import { type Part } from './features/types.js';
import { regenerate } from './features/regen.js';
import { type MachineProfile } from './machine/machineProfile.js';
import { type Material, findMaterial } from './materials/material.js';
import { type FaceBendGraph } from './model/graph.js';
import { type FlatPattern, unfold } from './unfold/unfold.js';
import { type FoldedPart, fold } from './unfold/fold.js';
import { type ValidationOptions, validate } from './validate/validate.js';
import { type ValidationReport } from './validate/report.js';
import { type ExportProfile } from './io/exportProfile.js';
import { writeDxfR12 } from './io/dxfR12Writer.js';

export interface BuildOptions {
  readonly machine: MachineProfile;
  /** Materials beyond the built-in list, e.g. ones edited by the user. */
  readonly materials?: readonly Material[];
  readonly validation?: ValidationOptions;
  /** Fold fraction for the 3D view, 0 flat .. 1 folded. Omit to skip folding. */
  readonly foldFraction?: number;
}

export interface BuildResult {
  readonly part: Part;
  readonly graph: FaceBendGraph;
  readonly material: Material;
  readonly flat: FlatPattern;
  readonly folded: FoldedPart | undefined;
  readonly report: ValidationReport;
  /** Mass of the finished part in kg, from flat area and density. */
  readonly massKg: number;
}

export class MaterialNotFoundError extends Error {
  constructor(id: string) {
    super(`no material with id ${JSON.stringify(id)}`);
    this.name = 'MaterialNotFoundError';
  }
}

export class ExportBlockedError extends Error {
  constructor(public readonly report: ValidationReport) {
    const errors = report.findings.filter((f) => f.severity === 'error');
    super(
      `export blocked by ${errors.length} validation error(s):\n  ${errors
        .map((e) => e.message)
        .join('\n  ')}`,
    );
    this.name = 'ExportBlockedError';
  }
}

export function resolveMaterial(id: string, extra: readonly Material[] = []): Material {
  const found = extra.find((m) => m.id === id) ?? findMaterial(id);
  if (found === undefined) throw new MaterialNotFoundError(id);
  return found;
}

/** Regenerate, unfold, and validate. Never throws on a merely invalid part. */
export function build(part: Part, options: BuildOptions): BuildResult {
  const material = resolveMaterial(part.parameters.materialId, options.materials ?? []);
  const { graph } = regenerate(part);
  const flat = unfold(graph, { material });
  const report = validate({
    graph,
    flat,
    material,
    machine: options.machine,
    ...(options.validation !== undefined ? { options: options.validation } : {}),
  });
  const folded =
    options.foldFraction === undefined
      ? undefined
      : fold(graph, { material, fraction: options.foldFraction });
  const volumeMm3 = flat.areaMm2 * graph.thickness;
  return {
    part,
    graph,
    material,
    flat,
    folded,
    report,
    massKg: (volumeMm3 / 1e9) * material.densityKgM3,
  };
}

export interface ExportOptions {
  readonly exportProfile?: ExportProfile;
  readonly dateStamp?: string;
  /**
   * Export despite validation errors. There is deliberately no UI for this —
   * it exists so tests can inspect the output of a part that fails a rule.
   */
  readonly ignoreValidationErrors?: boolean;
}

/**
 * Produce the DXF for a built part.
 *
 * INVARIANT: validation errors block export. This is the check that keeps an
 * unfoldable part from reaching the laser, and it lives here so no caller can
 * route around it.
 */
export function exportDxf(result: BuildResult, options: ExportOptions = {}): string {
  if (!result.report.exportAllowed && options.ignoreValidationErrors !== true) {
    throw new ExportBlockedError(result.report);
  }
  return writeDxfR12({
    flat: result.flat,
    part: result.part.parameters,
    ...(options.exportProfile !== undefined ? { profile: options.exportProfile } : {}),
    ...(options.dateStamp !== undefined ? { dateStamp: options.dateStamp } : {}),
  });
}
