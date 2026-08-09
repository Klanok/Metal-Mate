/**
 * Validation findings.
 *
 * The rule that makes the tool trustworthy: any finding of severity `error`
 * disables DXF export. A part that cannot be folded on the configured press
 * brake must never reach the laser (see CLAUDE.md).
 */

import { type BendId, type FaceId } from '../ids.js';

export type Severity = 'error' | 'warning' | 'info';

export type FindingCode =
  | 'unfold-overlap'
  | 'flat-disconnected'
  | 'thickness-out-of-range'
  | 'bend-longer-than-bed'
  | 'no-suitable-die'
  | 'flange-below-minimum'
  | 'tonnage-exceeded'
  | 'tonnage-per-metre-exceeded'
  | 'radius-not-achievable'
  | 'fold-collision-risk'
  | 'missing-bend-relief'
  | 'cutout-near-bend'
  | 'blank-exceeds-stock'
  | 'uncalibrated-allowance';

export interface Finding {
  readonly code: FindingCode;
  readonly severity: Severity;
  readonly message: string;
  readonly bendId?: BendId;
  readonly faceId?: FaceId;
  /** What the user should do about it. */
  readonly suggestion?: string;
}

export interface ValidationReport {
  readonly findings: readonly Finding[];
  readonly errorCount: number;
  readonly warningCount: number;
  /** False when any error is present. The export dialog keys off this. */
  readonly exportAllowed: boolean;
}

export function buildReport(findings: readonly Finding[]): ValidationReport {
  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;
  return {
    findings,
    errorCount,
    warningCount,
    exportAllowed: errorCount === 0,
  };
}

export function formatReport(report: ValidationReport): string {
  if (report.findings.length === 0) return 'No problems found.';
  const lines = report.findings.map((f) => {
    const where = f.bendId ?? f.faceId;
    const suffix = f.suggestion === undefined ? '' : `\n      -> ${f.suggestion}`;
    return `  [${f.severity}] ${f.code}${where === undefined ? '' : ` (${where})`}: ${f.message}${suffix}`;
  });
  const verdict = report.exportAllowed ? 'export allowed' : 'EXPORT BLOCKED';
  return `${lines.join('\n')}\n  ${report.errorCount} error(s), ${report.warningCount} warning(s) — ${verdict}`;
}
