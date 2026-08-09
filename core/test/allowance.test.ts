import { describe, expect, it } from 'vitest';
import {
  bendAllowance,
  bendDeduction,
  kFromBendDeduction,
  kFromFlatLength,
  outsideSetback,
  resolveAllowance,
} from '../src/materials/allowance.js';
import { STAINLESS_304, lookupBendRow, withBendRow } from '../src/materials/material.js';
import { type Bend } from '../src/model/graph.js';
import { bendId, faceId } from '../src/ids.js';
import { toRadians } from '../src/units.js';

const T = 1.2;
const R = 1.2;

function bend(overrides: Partial<Bend> = {}): Bend {
  return {
    id: bendId('b1'),
    faceA: faceId('a'),
    faceB: faceId('b'),
    lineA: { p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 } },
    lineB: { p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 } },
    angleDeg: 90,
    direction: 'down',
    insideRadius: R,
    ...overrides,
  };
}

describe('bend allowance formulae', () => {
  it('computes BA = theta (R + K T)', () => {
    expect(bendAllowance(90, R, T, 0.44)).toBeCloseTo(toRadians(90) * (R + 0.44 * T), 12);
    expect(bendAllowance(45, 2, 1.5, 0.4)).toBeCloseTo(toRadians(45) * (2 + 0.4 * 1.5), 12);
  });

  it('computes setback as tan(theta/2)(R + T), which is R + T at 90 degrees', () => {
    expect(outsideSetback(90, R, T)).toBeCloseTo(R + T, 12);
    expect(outsideSetback(60, 2, 1)).toBeCloseTo(Math.tan(toRadians(30)) * 3, 12);
  });

  it('round-trips K through bend deduction', () => {
    for (const angle of [30, 60, 90, 120]) {
      const bd = bendDeduction(angle, R, T, 0.42);
      expect(kFromBendDeduction(angle, R, T, bd)).toBeCloseTo(0.42, 10);
    }
  });

  it('back-solves K from a measured test strip', () => {
    // Two 50 mm legs measured to the apex, folded to 90 degrees.
    const k = 0.44;
    const bd = bendDeduction(90, R, T, k);
    const flat = 50 + 50 - bd;
    expect(kFromFlatLength(90, R, T, 50, 50, flat)).toBeCloseTo(k, 10);
  });
});

describe('allowance resolution order', () => {
  it('falls back to the material default when nothing else applies', () => {
    const result = resolveAllowance(bend(), STAINLESS_304, T);
    expect(result.source).toBe('material-default');
    expect(result.kFactor).toBeCloseTo(0.44, 12);
    expect(result.bendAllowance).toBeCloseTo(bendAllowance(90, R, T, 0.44), 12);
  });

  it('prefers a bend table K over the material default', () => {
    const material = withBendRow(STAINLESS_304, { thickness: T, kFactor: 0.38 });
    const result = resolveAllowance(bend(), material, T);
    expect(result.source).toBe('bend-table-k');
    expect(result.kFactor).toBeCloseTo(0.38, 12);
  });

  it('prefers a measured bend deduction over a K row', () => {
    let material = withBendRow(STAINLESS_304, { thickness: T, kFactor: 0.38 });
    material = withBendRow(material, {
      thickness: T,
      dieWidth: 8,
      angleDeg: 90,
      insideRadius: R,
      bendDeduction: 1.9,
      note: 'test strip, 2026-08-01',
    });
    const result = resolveAllowance(bend({ dieWidth: 8 }), material, T);
    expect(result.source).toBe('bend-table-deduction');
    expect(result.bendDeduction).toBeCloseTo(1.9, 9);
  });

  it('prefers an override on the bend over everything', () => {
    const material = withBendRow(STAINLESS_304, { thickness: T, kFactor: 0.38 });
    const result = resolveAllowance(bend({ allowanceOverride: 3.14 }), material, T);
    expect(result.source).toBe('bend-override');
    expect(result.bendAllowance).toBe(3.14);
  });

  it('ignores table rows for a different thickness or die', () => {
    let material = withBendRow(STAINLESS_304, { thickness: 2.0, kFactor: 0.3 });
    material = withBendRow(material, { thickness: T, dieWidth: 16, kFactor: 0.31 });
    expect(lookupBendRow(material, T, 8, 90)).toBeUndefined();
    expect(resolveAllowance(bend({ dieWidth: 8 }), material, T).source).toBe('material-default');
  });

  it('picks the most specific matching row', () => {
    let material = withBendRow(STAINLESS_304, { thickness: T, kFactor: 0.30 });
    material = withBendRow(material, { thickness: T, dieWidth: 8, kFactor: 0.35 });
    material = withBendRow(material, { thickness: T, dieWidth: 8, angleDeg: 90, kFactor: 0.40 });
    expect(resolveAllowance(bend({ dieWidth: 8 }), material, T).kFactor).toBeCloseTo(0.4, 12);
    expect(
      resolveAllowance(bend({ dieWidth: 8, angleDeg: 45 }), material, T).kFactor,
    ).toBeCloseTo(0.35, 12);
    expect(resolveAllowance(bend({}), material, T).kFactor).toBeCloseTo(0.3, 12);
  });

  it('replaces rather than duplicates a recalibrated row', () => {
    let material = withBendRow(STAINLESS_304, { thickness: T, dieWidth: 8, kFactor: 0.35 });
    material = withBendRow(material, { thickness: T, dieWidth: 8, kFactor: 0.41 });
    expect(material.bendTable).toHaveLength(1);
    expect(material.bendTable[0]!.kFactor).toBe(0.41);
  });
});
