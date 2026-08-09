/**
 * Units and tolerances.
 *
 * INVARIANT: every length in the public API is millimetres, expressed as a
 * JS number. There is no unit system, no inches, no internal "document units".
 * The only other representation that exists is the fixed-point integer used
 * when handing geometry to the boolean kernel (see `geometry/boolean.ts`),
 * and that never escapes that module.
 */

/** Fixed-point resolution used for boolean operations: 1 integer unit = 1 nm. */
export const BOOLEAN_SCALE = 1_000_000;

/**
 * General geometric tolerance in mm. Two points closer than this are the same
 * point. Chosen well below the ~0.05 mm that a laser + press brake can hold,
 * and well above the 1 nm boolean grid.
 */
export const TOL = 1e-6;

/** Tolerance for "is this angle zero / are these directions parallel", radians. */
export const ANGLE_TOL = 1e-9;

/**
 * Chord tolerance used when an arc must be approximated by line segments
 * (boolean input only — arcs are re-fitted afterwards and are never
 * linearised on the way to DXF).
 */
export const CHORD_TOL = 0.002;

export const DEG = Math.PI / 180;

export function toRadians(deg: number): number {
  return deg * DEG;
}

export function toDegrees(rad: number): number {
  return rad / DEG;
}

/** True when `a` and `b` are within `tol` of each other. */
export function nearly(a: number, b: number, tol: number = TOL): boolean {
  return Math.abs(a - b) <= tol;
}

/** Clamp helper used by die/tonnage lookups. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Round to a sane number of decimals for output/comparison. Geometry is kept
 * at full precision internally; this exists for DXF text and reporting.
 */
export function round(v: number, decimals = 6): number {
  const f = 10 ** decimals;
  // `+ 0` normalises -0 to 0 so golden files never differ on sign of zero.
  return Math.round(v * f) / f + 0;
}
