/**
 * Calibrating the bend allowance from a folded test strip.
 *
 * Everything the unfold engine does rests on K, and until somebody folds a
 * strip and measures it, K is a textbook number (0.44) rather than a fact
 * about this machine, this die and this material. This module turns the four
 * measurements a shop can actually take into a bend table row.
 *
 * The measuring convention: fold a strip to the angle you care about, then
 * measure each leg **to the apex** — the corner you would get by continuing
 * both flat faces until they cross, not the outside of the radius — and
 * measure the length of the blank you started from. The difference is the bend
 * deduction, and K falls out of that.
 *
 * Pure functions over numbers; the maths itself lives in core.
 */

import type { BendTableRow } from '@metal-mate/core';
import { bendAllowance, bendDeduction, kFromFlatLength } from '@metal-mate/core';

export interface TestStrip {
  readonly angleDeg: number;
  readonly insideRadiusMm: number;
  readonly thicknessMm: number;
  /** First leg, measured to the apex. */
  readonly legAMm: number;
  readonly legBMm: number;
  /** Length of the flat blank the strip was cut from. */
  readonly measuredFlatMm: number;
  /** V opening it was folded in, if the row should only apply to that die. */
  readonly dieWidthMm?: number;
  readonly note?: string;
}

export interface Calibration {
  readonly kFactor: number;
  readonly bendDeductionMm: number;
  readonly bendAllowanceMm: number;
  /** Set when the numbers cannot be a real fold; the result is unusable. */
  readonly error?: string;
  /** Set when the result is possible but surprising, and worth a second look. */
  readonly warning?: string;
}

/** Plausible range for K in air bending. Outside it, something was mismeasured. */
const K_MIN = 0.15;
const K_MAX = 0.6;

export function calibrate(strip: TestStrip): Calibration {
  const { angleDeg, insideRadiusMm: r, thicknessMm: t, legAMm, legBMm, measuredFlatMm } = strip;
  const nil: Omit<Calibration, 'error'> = { kFactor: 0, bendDeductionMm: 0, bendAllowanceMm: 0 };

  if (![angleDeg, r, t, legAMm, legBMm, measuredFlatMm].every((n) => Number.isFinite(n) && n > 0)) {
    return { ...nil, error: 'fill in every measurement with a positive number' };
  }
  if (angleDeg >= 180) {
    return { ...nil, error: 'the bend angle is the departure from flat, so it is under 180' };
  }

  const bd = legAMm + legBMm - measuredFlatMm;
  if (bd <= 0) {
    return {
      ...nil,
      error:
        'the blank was at least as long as the two legs added up, so there is no deduction to solve — check that the legs were measured to the apex, not to the outside of the radius',
    };
  }

  const kFactor = kFromFlatLength(angleDeg, r, t, legAMm, legBMm, measuredFlatMm);
  const result: Calibration = {
    kFactor,
    bendDeductionMm: bd,
    bendAllowanceMm: bendAllowance(angleDeg, r, t, kFactor),
  };

  if (!Number.isFinite(kFactor) || kFactor <= 0) {
    return { ...nil, error: 'those measurements do not describe a fold that can happen' };
  }
  if (kFactor < K_MIN || kFactor > K_MAX) {
    return {
      ...result,
      warning: `K of ${kFactor.toFixed(3)} is outside the ${K_MIN}–${K_MAX} that air bending normally gives; measure again before trusting it`,
    };
  }
  return result;
}

/** The bend table row a calibration produces, provenance and all. */
export function toBendRow(strip: TestStrip, calibration: Calibration): BendTableRow {
  return {
    thickness: strip.thicknessMm,
    angleDeg: strip.angleDeg,
    insideRadius: strip.insideRadiusMm,
    kFactor: calibration.kFactor,
    bendDeduction: calibration.bendDeductionMm,
    ...(strip.dieWidthMm !== undefined ? { dieWidth: strip.dieWidthMm } : {}),
    ...(strip.note !== undefined && strip.note !== '' ? { note: strip.note } : {}),
  };
}

/** What the current default would have predicted, for the before/after line. */
export function predictedDeduction(strip: TestStrip, k: number): number {
  return bendDeduction(strip.angleDeg, strip.insideRadiusMm, strip.thicknessMm, k);
}
