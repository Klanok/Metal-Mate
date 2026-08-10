/**
 * The whole pipeline in one call: part -> graph -> flat -> validation -> DXF.
 *
 * This is what the application layer drives on every parameter change, and
 * what the tests exercise end to end. Keeping it here rather than in the UI
 * means the pipeline order — and in particular the rule that validation gates
 * export — is part of the core, not a thing the UI has to remember.
 */

import { type Part } from './features/types.js';
import { type PartId, partId } from './ids.js';
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

/* ------------------------------------------------------- whole documents -- */

/**
 * One part's outcome inside a document.
 *
 * A part whose parameters make no physical sense throws out of regeneration,
 * and in a document that must not take the other parts down with it — the user
 * needs to see which one broke, with the rest still building.
 */
export type PartBuild =
  | { readonly key: PartId; readonly part: Part; readonly ok: true; readonly result: BuildResult }
  | { readonly key: PartId; readonly part: Part; readonly ok: false; readonly error: string };

export interface DocumentProblem {
  readonly key: PartId | undefined;
  readonly message: string;
}

export interface DocumentBuild {
  readonly parts: readonly PartBuild[];
  /** Wrong at the document level rather than inside any one part. */
  readonly problems: readonly DocumentProblem[];
  /** True when every part built, passed validation, and the document is sound. */
  readonly exportAllowed: boolean;
  readonly errorCount: number;
  readonly warningCount: number;
  /** Mass of everything, counting each part's quantity. */
  readonly totalMassKg: number;
  readonly totalCutLengthMm: number;
}

/** How many of this part the document wants. Absent means one. */
export function quantityOf(part: Part): number {
  return part.parameters.quantity ?? 1;
}

/**
 * The document-unique handle for a part: its part number if it has one.
 *
 * A blank part number counts as not having one. The field is a text box, so
 * clearing it leaves an empty string rather than nothing, and treating that as
 * an identity would give the part no id at all.
 */
export function keyOf(part: Part): PartId {
  const numbered = part.parameters.partId?.trim();
  return partId(numbered !== undefined && numbered !== '' ? numbered : part.parameters.name);
}

/**
 * Build every part in a document and roll the results up.
 *
 * `foldFraction` is deliberately not applied here: folding is the expensive
 * step and only the part on screen needs it, so the application layer folds
 * that one on its own.
 */
export function buildDocument(
  parts: readonly Part[],
  options: BuildOptions,
): DocumentBuild {
  const problems: DocumentProblem[] = [];
  if (parts.length === 0) {
    problems.push({ key: undefined, message: 'the document has no parts in it' });
  }

  const builds: PartBuild[] = [];
  const seen = new Map<PartId, number>();

  for (const part of parts) {
    let key: PartId;
    try {
      key = keyOf(part);
    } catch (e) {
      problems.push({ key: undefined, message: messageOf(e) });
      continue;
    }
    seen.set(key, (seen.get(key) ?? 0) + 1);

    const quantity = quantityOf(part);
    if (!Number.isInteger(quantity) || quantity < 1) {
      problems.push({ key, message: `quantity must be a whole number of one or more` });
    }

    try {
      // Fold fraction is dropped on purpose; see the note above.
      const { foldFraction: _fold, ...rest } = options;
      builds.push({ key, part, ok: true, result: build(part, rest) });
    } catch (e) {
      builds.push({ key, part, ok: false, error: messageOf(e) });
    }
  }

  for (const [key, count] of seen) {
    if (count > 1) {
      problems.push({
        key,
        message: `${count} parts are called "${key}"; give each one its own name or part number so they can be told apart`,
      });
    }
  }

  let errorCount = 0;
  let warningCount = 0;
  let totalMassKg = 0;
  let totalCutLengthMm = 0;
  for (const b of builds) {
    if (!b.ok) {
      errorCount += 1;
      continue;
    }
    const n = quantityOf(b.part);
    errorCount += b.result.report.errorCount;
    warningCount += b.result.report.warningCount;
    totalMassKg += b.result.massKg * n;
    totalCutLengthMm += b.result.flat.cutLengthMm * n;
  }

  return {
    parts: builds,
    problems,
    exportAllowed:
      problems.length === 0 &&
      builds.length > 0 &&
      builds.every((b) => b.ok && b.result.report.exportAllowed),
    errorCount: errorCount + problems.length,
    warningCount,
    totalMassKg,
    totalCutLengthMm,
  };
}

export class DocumentExportBlockedError extends Error {
  constructor(public readonly reasons: readonly string[]) {
    super(`export blocked:\n  ${reasons.join('\n  ')}`);
    this.name = 'DocumentExportBlockedError';
  }
}

export interface DocumentExportOptions extends ExportOptions {
  /** Export only these parts. Omit for all of them. */
  readonly only?: readonly PartId[];
}

export interface ExportedPart {
  readonly key: PartId;
  readonly fileName: string;
  readonly dxf: string;
  /** How many of this one to cut. Carried for the cut list, not the DXF. */
  readonly quantity: number;
}

/**
 * Produce one DXF per part.
 *
 * INVARIANT: validation errors block export, and at document level that means
 * *all or nothing* for the parts asked for. Writing the good files and quietly
 * skipping the bad one is how half an assembly reaches the laser.
 */
export function exportDocumentDxf(
  document: DocumentBuild,
  options: DocumentExportOptions = {},
): ExportedPart[] {
  const wanted =
    options.only === undefined
      ? document.parts
      : document.parts.filter((p) => options.only!.includes(p.key));

  if (options.ignoreValidationErrors !== true) {
    const reasons = document.problems.map((p) => p.message);
    for (const b of wanted) {
      if (!b.ok) reasons.push(`${b.key}: ${b.error}`);
      else if (!b.result.report.exportAllowed) {
        const errors = b.result.report.findings.filter((f) => f.severity === 'error');
        reasons.push(`${b.key}: ${errors.map((e) => e.message).join('; ')}`);
      }
    }
    if (reasons.length > 0) throw new DocumentExportBlockedError(reasons);
  }
  if (wanted.length === 0) {
    throw new DocumentExportBlockedError(['no parts matched the selection']);
  }

  return wanted.flatMap((b) =>
    b.ok
      ? [
          {
            key: b.key,
            fileName: `${b.key}.dxf`,
            dxf: exportDxf(b.result, options),
            quantity: quantityOf(b.part),
          },
        ]
      : [],
  );
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
