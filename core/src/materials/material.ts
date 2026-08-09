/**
 * Materials and calibrated bend tables.
 *
 * Bend accuracy is the thing most likely to cause an argument with the shop,
 * so calibration is a first-class record rather than a constant buried in the
 * unfold engine: fold a test strip on the actual brake, measure it, back-solve
 * K, and store the result against (material, thickness, V-die).
 */

export type MaterialFamily =
  | 'stainless'
  | 'mild-steel'
  | 'aluminium'
  | 'zincalume'
  | 'colorbond';

/**
 * One calibrated row. `kFactor` and `bendDeduction` are alternative ways to say
 * the same thing; a row may carry either. `bendDeduction` wins when both are
 * present, because it is what a measured test strip yields directly.
 */
export interface BendTableRow {
  readonly thickness: number;
  /** V-die opening in mm. Omit for a row that applies to any die. */
  readonly dieWidth?: number;
  /** Bend angle in degrees this row was calibrated at. Omit for "any angle". */
  readonly angleDeg?: number;
  readonly kFactor?: number;
  /** Measured bend deduction in mm, at `angleDeg` and `insideRadius`. */
  readonly bendDeduction?: number;
  /** Inside radius the row was measured at, mm. */
  readonly insideRadius?: number;
  /** Free-text provenance: who folded the strip, when, on which machine. */
  readonly note?: string;
}

export interface Material {
  readonly id: string;
  readonly name: string;
  readonly family: MaterialFamily;
  /** Ultimate tensile strength in MPa, used for the tonnage estimate. */
  readonly utsMPa: number;
  /** Density in kg/m^3, used for part mass. */
  readonly densityKgM3: number;
  /** Stock thicknesses in mm. */
  readonly thicknesses: readonly number[];
  /** Fallback K when no table row matches. */
  readonly defaultK: number;
  readonly bendTable: readonly BendTableRow[];
}

/** Global fallback when neither the bend, the table, nor the material says. */
export const GLOBAL_DEFAULT_K = 0.44;

export const STAINLESS_304: Material = {
  id: 'ss304',
  name: 'Stainless 304 (2B / No.4 polish)',
  family: 'stainless',
  utsMPa: 520,
  densityKgM3: 8000,
  thicknesses: [0.9, 1.0, 1.2, 1.5, 1.6, 2.0, 3.0],
  defaultK: 0.44,
  bendTable: [],
};

export const STAINLESS_316: Material = {
  id: 'ss316',
  name: 'Stainless 316',
  family: 'stainless',
  utsMPa: 550,
  densityKgM3: 8000,
  thicknesses: [0.9, 1.0, 1.2, 1.5, 1.6, 2.0, 3.0],
  defaultK: 0.44,
  bendTable: [],
};

export const ALUMINIUM_5005: Material = {
  id: 'al5005',
  name: 'Aluminium 5005',
  family: 'aluminium',
  utsMPa: 145,
  densityKgM3: 2700,
  thicknesses: [1.0, 1.2, 1.6, 2.0, 2.5, 3.0],
  defaultK: 0.41,
  bendTable: [],
};

export const ZINCALUME: Material = {
  id: 'zincalume',
  name: 'Zincalume steel',
  family: 'zincalume',
  utsMPa: 340,
  densityKgM3: 7850,
  thicknesses: [0.55, 0.75, 0.95, 1.15],
  defaultK: 0.44,
  bendTable: [],
};

export const MILD_STEEL: Material = {
  id: 'ms',
  name: 'Mild steel',
  family: 'mild-steel',
  utsMPa: 400,
  densityKgM3: 7850,
  thicknesses: [1.0, 1.2, 1.6, 2.0, 3.0, 4.0, 5.0, 6.0],
  defaultK: 0.44,
  bendTable: [],
};

export const BUILT_IN_MATERIALS: readonly Material[] = [
  STAINLESS_304,
  STAINLESS_316,
  ALUMINIUM_5005,
  ZINCALUME,
  MILD_STEEL,
];

export function findMaterial(id: string): Material | undefined {
  return BUILT_IN_MATERIALS.find((m) => m.id === id);
}

/**
 * Best-matching bend table row for a bend, or undefined.
 *
 * Rows are scored so that the most specific match wins: an exact die and angle
 * beats a die-only row, which beats a thickness-only row. Rows for a different
 * thickness never match — thickness is the one dimension we refuse to
 * interpolate, because the shop's calibration data is per-thickness.
 */
export function lookupBendRow(
  material: Material,
  thickness: number,
  dieWidth: number | undefined,
  angleDeg: number,
): BendTableRow | undefined {
  let best: BendTableRow | undefined;
  let bestScore = -1;
  for (const row of material.bendTable) {
    if (Math.abs(row.thickness - thickness) > 1e-9) continue;
    let score = 0;
    if (row.dieWidth !== undefined) {
      if (dieWidth === undefined || Math.abs(row.dieWidth - dieWidth) > 1e-9) continue;
      score += 2;
    }
    if (row.angleDeg !== undefined) {
      if (Math.abs(row.angleDeg - angleDeg) > 1e-6) continue;
      score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  return best;
}

/** Add or replace a calibration row, keyed by thickness + die + angle. */
export function withBendRow(material: Material, row: BendTableRow): Material {
  const same = (a: BendTableRow, b: BendTableRow): boolean =>
    Math.abs(a.thickness - b.thickness) < 1e-9 &&
    a.dieWidth === b.dieWidth &&
    a.angleDeg === b.angleDeg;
  const bendTable = material.bendTable.filter((r) => !same(r, row));
  return { ...material, bendTable: [...bendTable, row] };
}
