/**
 * One passing and one failing fixture for every validation rule.
 *
 * These are the tests that keep the promise in the architecture doc: a part
 * that cannot be folded on the configured brake must not be exportable.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { initBooleans } from '../src/geometry/boolean.js';
import { profile } from '../src/geometry/profile.js';
import { rect } from '../src/geometry/loop.js';
import { bendId, faceId, featureId } from '../src/ids.js';
import { type MachineProfile, GENERIC_2500_40T } from '../src/machine/machineProfile.js';
import { MILD_STEEL, STAINLESS_304, withBendRow } from '../src/materials/material.js';
import { type Bend, buildGraph, makeFace } from '../src/model/graph.js';
import { rectangleEdges, rectangleProfile, regenerate } from '../src/features/regen.js';
import { type Part } from '../src/features/types.js';
import { unfold } from '../src/unfold/unfold.js';
import { validate } from '../src/validate/validate.js';
import { type FindingCode } from '../src/validate/report.js';
import { ExportBlockedError, build, exportDxf } from '../src/pipeline.js';
import { type BenchtopParams, DEFAULT_BENCHTOP, benchtopPart } from '../src/templates/benchtop.js';

beforeAll(async () => {
  await initBooleans();
});

const BASE_BENCHTOP: BenchtopParams = {
  ...DEFAULT_BENCHTOP,
  lengthMm: 1800,
  depthMm: 600,
  thicknessMm: 1.2,
  bendRadiusMm: 1.2,
  frontEdge: { style: 'square-drop', dropMm: 40 },
  splashback: { style: 'integral', heightMm: 100 },
  cutouts: [],
};

function codesFor(params: BenchtopParams, machine = GENERIC_2500_40T): FindingCode[] {
  return build(benchtopPart(params), { machine }).report.findings.map((f) => f.code);
}

/** A simple L bracket built straight from features, for the odd shapes. */
function bracketPart(overrides: {
  width?: number;
  depth?: number;
  flange?: number;
  thickness?: number;
  radius?: number;
  insetStart?: number;
  insetEnd?: number;
  materialId?: string;
}): Part {
  const width = overrides.width ?? 400;
  const depth = overrides.depth ?? 300;
  return {
    parameters: {
      name: 'Bracket',
      materialId: overrides.materialId ?? 'ss304',
      thicknessMm: overrides.thickness ?? 1.2,
      grain: 'none',
    },
    features: [
      {
        kind: 'base-flange',
        id: featureId('base'),
        profile: rectangleProfile(width, depth),
        edges: rectangleEdges(width, depth),
      },
      {
        kind: 'edge-flange',
        id: featureId('flange'),
        edge: { faceId: faceId('base'), edgeName: 'front' },
        lengthMm: overrides.flange ?? 40,
        angleDeg: 90,
        direction: 'down',
        insideRadiusMm: overrides.radius ?? 1.2,
        ...(overrides.insetStart !== undefined ? { insetStartMm: overrides.insetStart } : {}),
        ...(overrides.insetEnd !== undefined ? { insetEndMm: overrides.insetEnd } : {}),
      },
    ],
  };
}

describe('bed length', () => {
  it('passes when the bend fits the bed', () => {
    expect(codesFor(BASE_BENCHTOP)).not.toContain('bend-longer-than-bed');
  });

  it('fails when the bend is longer than the bed', () => {
    const codes = codesFor({ ...BASE_BENCHTOP, lengthMm: 3000 });
    expect(codes).toContain('bend-longer-than-bed');
  });
});

describe('die availability and radius', () => {
  it('passes with a normal rack', () => {
    expect(codesFor(BASE_BENCHTOP)).not.toContain('no-suitable-die');
  });

  it('fails when the rack has nothing suitable for the thickness', () => {
    const smallRack: MachineProfile = {
      ...GENERIC_2500_40T,
      dies: [{ width: 6 }, { width: 8 }],
      thicknessLimits: [{ min: 0.5, max: 10 }],
    };
    const codes = codesFor({ ...BASE_BENCHTOP, thicknessMm: 3, bendRadiusMm: 1.2 }, smallRack);
    expect(codes).toContain('no-suitable-die');
  });

  it('warns, rather than blocks, when no die makes the requested radius', () => {
    const result = build(benchtopPart({ ...BASE_BENCHTOP, bendRadiusMm: 4 }), {
      machine: GENERIC_2500_40T,
    });
    const finding = result.report.findings.find((f) => f.code === 'radius-not-achievable');
    expect(finding?.severity).toBe('warning');
    expect(finding?.suggestion).toMatch(/set the bend radius to/);
  });
});

describe('minimum flange', () => {
  it('passes for a 40 mm front edge', () => {
    const result = build(bracketPart({ flange: 40 }), { machine: GENERIC_2500_40T });
    expect(result.report.findings.map((f) => f.code)).not.toContain('flange-below-minimum');
  });

  it('fails for a flange shorter than the die can hold', () => {
    // 1.2 mm material picks an 8 mm V, which needs about 5.6 mm of flange.
    const result = build(bracketPart({ flange: 3 }), { machine: GENERIC_2500_40T });
    const finding = result.report.findings.find((f) => f.code === 'flange-below-minimum');
    expect(finding?.severity).toBe('error');
  });

  it('measures the whole developed leg, not just the adjacent face', () => {
    // The top is only 30 mm deep but carries a 100 mm splashback beyond it, so
    // the leg at the front bend is well over the minimum.
    const params: BenchtopParams = { ...BASE_BENCHTOP, depthMm: 40 };
    expect(codesFor(params)).not.toContain('flange-below-minimum');
  });
});

describe('tonnage', () => {
  it('passes for 1.2 mm stainless over 1.8 m', () => {
    expect(codesFor(BASE_BENCHTOP)).not.toContain('tonnage-exceeded');
  });

  it('fails for thick steel over a long bend', () => {
    const strongEnoughRack: MachineProfile = {
      ...GENERIC_2500_40T,
      thicknessLimits: [{ min: 0.5, max: 10 }],
      maxTonnesPerMetre: 200,
    };
    const result = build(
      bracketPart({ width: 2400, depth: 600, flange: 120, thickness: 6, radius: 8, materialId: 'ms' }),
      { machine: strongEnoughRack },
    );
    expect(result.report.findings.map((f) => f.code)).toContain('tonnage-exceeded');
  });

  it('fails when the die is loaded past its per-metre limit', () => {
    const weakRack: MachineProfile = {
      ...GENERIC_2500_40T,
      thicknessLimits: [{ min: 0.5, max: 10 }],
      maxTonnesPerMetre: 5,
      maxTonnes: 1000,
    };
    const result = build(bracketPart({ thickness: 3, radius: 4, materialId: 'ms' }), {
      machine: weakRack,
    });
    expect(result.report.findings.map((f) => f.code)).toContain('tonnage-per-metre-exceeded');
  });
});

describe('thickness limits', () => {
  it('fails when the material is thicker than the machine takes', () => {
    const result = build(bracketPart({ thickness: 8, radius: 10, materialId: 'ms' }), {
      machine: GENERIC_2500_40T,
    });
    expect(result.report.findings.map((f) => f.code)).toContain('thickness-out-of-range');
  });
});

describe('unfold overlap', () => {
  it('fails when two flanges land on top of each other in the flat', () => {
    // An L-shaped face with flanges off both edges of its inner corner: in the
    // flat they sweep into the same square and interfere.
    const t = 1.2;
    const r = 1.2;
    const lShape = profile({
      verts: [
        { x: 0, y: 0, bulge: 0 },
        { x: 200, y: 0, bulge: 0 },
        { x: 200, y: 100, bulge: 0 },
        { x: 100, y: 100, bulge: 0 },
        { x: 100, y: 200, bulge: 0 },
        { x: 0, y: 200, bulge: 0 },
      ],
    });
    const base = makeFace({ id: faceId('base'), profile: lShape, featureId: 'base' });
    const armA = makeFace({
      id: faceId('armA'),
      profile: profile(rect(0, 0, 100, 150)),
      featureId: 'armA',
    });
    const armB = makeFace({
      id: faceId('armB'),
      profile: profile(rect(0, 0, 100, 150)),
      featureId: 'armB',
    });
    const mk = (id: string, faceB: typeof armA, lineA: Bend['lineA']): Bend => ({
      id: bendId(id),
      faceA: base.id,
      faceB: faceB.id,
      lineA,
      lineB: { p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 } },
      angleDeg: 90,
      direction: 'down',
      insideRadius: r,
    });
    const graph = buildGraph(
      [base, armA, armB],
      [
        mk('bendA', armA, { p0: { x: 200, y: 100 }, p1: { x: 100, y: 100 } }),
        mk('bendB', armB, { p0: { x: 100, y: 100 }, p1: { x: 100, y: 200 } }),
      ],
      base.id,
      t,
    );
    const flat = unfold(graph, { material: STAINLESS_304 });
    expect(flat.overlapAreaMm2).toBeGreaterThan(9000);
    const report = validate({
      graph,
      flat,
      material: STAINLESS_304,
      machine: GENERIC_2500_40T,
    });
    expect(report.findings.map((f) => f.code)).toContain('unfold-overlap');
    expect(report.exportAllowed).toBe(false);
  });

  it('passes for a plain benchtop', () => {
    expect(codesFor(BASE_BENCHTOP)).not.toContain('unfold-overlap');
  });
});

describe('bend relief', () => {
  it('passes when the bend runs the full width of the face', () => {
    const result = build(bracketPart({}), { machine: GENERIC_2500_40T });
    expect(result.report.findings.map((f) => f.code)).not.toContain('missing-bend-relief');
  });

  it('warns when the bend stops inside material', () => {
    const result = build(bracketPart({ insetStart: 50, insetEnd: 50 }), {
      machine: GENERIC_2500_40T,
    });
    const finding = result.report.findings.find((f) => f.code === 'missing-bend-relief');
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toMatch(/both ends/);
    expect(result.report.exportAllowed).toBe(true);
  });
});

describe('cutout clearance', () => {
  it('passes for a sink 90 mm back from the front', () => {
    const params: BenchtopParams = {
      ...BASE_BENCHTOP,
      cutouts: [
        {
          kind: 'sink',
          id: 'sink1',
          fromLeftMm: 400,
          fromFrontMm: 90,
          widthMm: 400,
          depthMm: 350,
          cornerRadiusMm: 10,
        },
      ],
    };
    expect(codesFor(params)).not.toContain('cutout-near-bend');
  });

  it('warns for a sink pushed up against the front bend', () => {
    const params: BenchtopParams = {
      ...BASE_BENCHTOP,
      cutouts: [
        {
          kind: 'sink',
          id: 'sink1',
          fromLeftMm: 400,
          fromFrontMm: 4,
          widthMm: 400,
          depthMm: 350,
          cornerRadiusMm: 10,
        },
      ],
    };
    expect(codesFor(params)).toContain('cutout-near-bend');
  });
});

describe('fold collision heuristic', () => {
  it('stays quiet on an ordinary benchtop', () => {
    expect(codesFor(BASE_BENCHTOP)).not.toContain('fold-collision-risk');
  });

  it('warns when the flange being formed is deeper than the throat', () => {
    const result = build(bracketPart({ depth: 900, flange: 400 }), {
      machine: GENERIC_2500_40T,
    });
    const finding = result.report.findings.find((f) => f.code === 'fold-collision-risk');
    expect(finding?.severity).toBe('warning');
    expect(finding?.suggestion).toMatch(/does not simulate the fold sequence/);
  });
});

describe('stock sheet', () => {
  it('fails when the blank does not fit the stock', () => {
    const result = build(benchtopPart(BASE_BENCHTOP), {
      machine: GENERIC_2500_40T,
      // The blank is 1800 x ~736 mm, so a 1500 x 700 sheet cannot take it
      // either way round.
      validation: { stockSheet: { widthMm: 700, lengthMm: 1500 } },
    });
    expect(result.report.findings.map((f) => f.code)).toContain('blank-exceeds-stock');
  });

  it('passes on a big enough sheet', () => {
    const result = build(benchtopPart(BASE_BENCHTOP), {
      machine: GENERIC_2500_40T,
      validation: { stockSheet: { widthMm: 1500, lengthMm: 3000 } },
    });
    expect(result.report.findings.map((f) => f.code)).not.toContain('blank-exceeds-stock');
  });
});

describe('calibration nagging', () => {
  it('warns about uncalibrated allowances when asked', () => {
    const result = build(benchtopPart(BASE_BENCHTOP), {
      machine: GENERIC_2500_40T,
      validation: { requireCalibratedAllowance: true },
    });
    expect(result.report.findings.map((f) => f.code)).toContain('uncalibrated-allowance');
  });

  it('goes quiet once a bend table row exists', () => {
    const calibrated = withBendRow(STAINLESS_304, {
      thickness: 1.2,
      kFactor: 0.42,
      note: 'test strip 2026-08-01',
    });
    const result = build(benchtopPart(BASE_BENCHTOP), {
      machine: GENERIC_2500_40T,
      materials: [calibrated],
      validation: { requireCalibratedAllowance: true },
    });
    expect(result.report.findings.map((f) => f.code)).not.toContain('uncalibrated-allowance');
  });
});

describe('export gating', () => {
  it('exports a clean part', () => {
    const result = build(benchtopPart(BASE_BENCHTOP), { machine: GENERIC_2500_40T });
    expect(() => exportDxf(result)).not.toThrow();
  });

  it('refuses to export a part with validation errors', () => {
    const result = build(benchtopPart({ ...BASE_BENCHTOP, lengthMm: 3000 }), {
      machine: GENERIC_2500_40T,
    });
    expect(result.report.exportAllowed).toBe(false);
    expect(() => exportDxf(result)).toThrow(ExportBlockedError);
  });
});

describe('material lookup', () => {
  it('knows the built-in stainless grades', () => {
    expect(STAINLESS_304.family).toBe('stainless');
    expect(MILD_STEEL.utsMPa).toBeGreaterThan(0);
  });

  it('regenerates deterministically', () => {
    const part = benchtopPart(BASE_BENCHTOP);
    const a = regenerate(part);
    const b = regenerate(part);
    expect([...a.graph.faces.keys()]).toEqual([...b.graph.faces.keys()]);
    expect([...a.graph.bends.keys()]).toEqual([...b.graph.bends.keys()]);
  });
});
