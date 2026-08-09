/**
 * Bend allowance.
 *
 *   BA   = theta * (R + K*T)          developed length of the bend zone
 *   OSSB = tan(theta/2) * (R + T)     outside setback
 *   BD   = 2*OSSB - BA                bend deduction
 *
 * theta is the bend angle (departure from flat), R the inside radius, T the
 * thickness, K the neutral-axis position as a fraction of T.
 *
 * The unfold engine works in bend allowance: it places the two faces' tangent
 * lines BA apart. Bend deduction is the same information expressed against
 * apex dimensions, and is what a measured test strip gives you, so both
 * directions are supported.
 */

import { type Bend } from '../model/graph.js';
import { toRadians } from '../units.js';
import { GLOBAL_DEFAULT_K, type Material, lookupBendRow } from './material.js';

export type AllowanceSource =
  | 'bend-override'
  | 'bend-table-deduction'
  | 'bend-table-k'
  | 'material-default'
  | 'global-default';

export interface AllowanceResult {
  /** Developed length of the bend zone, mm. */
  readonly bendAllowance: number;
  /** Equivalent bend deduction, mm. */
  readonly bendDeduction: number;
  /** Outside setback, mm. */
  readonly outsideSetback: number;
  /** K actually used. Undefined only when a raw allowance was overridden in. */
  readonly kFactor: number | undefined;
  readonly source: AllowanceSource;
}

export function bendAllowance(angleDeg: number, radius: number, thickness: number, k: number): number {
  return toRadians(angleDeg) * (radius + k * thickness);
}

/**
 * Outside setback. The usual closed form is exact for bend angles up to 90
 * degrees; past that the tangent grows without bound as the bend approaches
 * flat-back, which is why acute bends are normally driven from a measured
 * deduction instead.
 */
export function outsideSetback(angleDeg: number, radius: number, thickness: number): number {
  return Math.tan(toRadians(angleDeg) / 2) * (radius + thickness);
}

export function bendDeduction(angleDeg: number, radius: number, thickness: number, k: number): number {
  return 2 * outsideSetback(angleDeg, radius, thickness) - bendAllowance(angleDeg, radius, thickness, k);
}

/** Back-solve K from a bend deduction measured on a real folded test strip. */
export function kFromBendDeduction(
  angleDeg: number,
  radius: number,
  thickness: number,
  measuredBD: number,
): number {
  const ba = 2 * outsideSetback(angleDeg, radius, thickness) - measuredBD;
  return (ba / toRadians(angleDeg) - radius) / thickness;
}

/** Back-solve K from a measured developed (flat) length of a test strip. */
export function kFromFlatLength(
  angleDeg: number,
  radius: number,
  thickness: number,
  legA: number,
  legB: number,
  measuredFlatLength: number,
): number {
  // Legs measured to the apex, so flat = legA + legB - BD.
  const bd = legA + legB - measuredFlatLength;
  return kFromBendDeduction(angleDeg, radius, thickness, bd);
}

/**
 * Resolve the allowance for one bend.
 *
 * Order, most specific first: an override on the bend itself, then a calibrated
 * bend-table row for this material/thickness/die, then the material's default
 * K, then the global default. The result records which rule fired so the
 * validation report and the PDF bend table can say where the number came from.
 */
export function resolveAllowance(
  bend: Bend,
  material: Material,
  thickness: number,
): AllowanceResult {
  const { angleDeg, insideRadius: radius } = bend;
  const ossb = outsideSetback(angleDeg, radius, thickness);

  if (bend.allowanceOverride !== undefined) {
    const ba = bend.allowanceOverride;
    return {
      bendAllowance: ba,
      bendDeduction: 2 * ossb - ba,
      outsideSetback: ossb,
      kFactor: (ba / toRadians(angleDeg) - radius) / thickness,
      source: 'bend-override',
    };
  }

  const row = lookupBendRow(material, thickness, bend.dieWidth, angleDeg);
  if (row !== undefined && row.bendDeduction !== undefined) {
    // A measured deduction is calibrated at the row's own radius; if the bend
    // uses a different radius the setback differs, so recover K and re-apply.
    const rowRadius = row.insideRadius ?? radius;
    const k = kFromBendDeduction(row.angleDeg ?? angleDeg, rowRadius, thickness, row.bendDeduction);
    const ba = bendAllowance(angleDeg, radius, thickness, k);
    return {
      bendAllowance: ba,
      bendDeduction: 2 * ossb - ba,
      outsideSetback: ossb,
      kFactor: k,
      source: 'bend-table-deduction',
    };
  }
  if (row !== undefined && row.kFactor !== undefined) {
    const ba = bendAllowance(angleDeg, radius, thickness, row.kFactor);
    return {
      bendAllowance: ba,
      bendDeduction: 2 * ossb - ba,
      outsideSetback: ossb,
      kFactor: row.kFactor,
      source: 'bend-table-k',
    };
  }

  const k = material.defaultK ?? GLOBAL_DEFAULT_K;
  const source: AllowanceSource =
    material.defaultK === undefined ? 'global-default' : 'material-default';
  const ba = bendAllowance(angleDeg, radius, thickness, k);
  return {
    bendAllowance: ba,
    bendDeduction: 2 * ossb - ba,
    outsideSetback: ossb,
    kFactor: k,
    source,
  };
}
