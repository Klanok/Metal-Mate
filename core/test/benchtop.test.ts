/**
 * End-to-end tests for the MVP path:
 *   benchtop parameters -> features -> graph -> flat -> validation -> DXF.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { initBooleans } from '../src/geometry/boolean.js';
import { faceId } from '../src/ids.js';
import { GENERIC_2500_40T } from '../src/machine/machineProfile.js';
import { bendAllowance, outsideSetback } from '../src/materials/allowance.js';
import { build } from '../src/pipeline.js';
import {
  type BenchtopParams,
  BenchtopParameterError,
  DEFAULT_BENCHTOP,
  benchtopPart,
} from '../src/templates/benchtop.js';
import { regenerate } from '../src/features/regen.js';
import { checkGraph } from '../src/model/graph.js';

const T = 1.2;
const R = 1.2;
const SETBACK = outsideSetback(90, R, T); // 2.4 mm at 90 degrees
const BA = bendAllowance(90, R, T, 0.44);

const MVP: BenchtopParams = {
  ...DEFAULT_BENCHTOP,
  name: 'MVP benchtop',
  partId: 'BT-001',
  lengthMm: 1800,
  depthMm: 600,
  thicknessMm: T,
  bendRadiusMm: R,
  frontEdge: { style: 'square-drop', dropMm: 40 },
  splashback: { style: 'integral', heightMm: 100 },
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

beforeAll(async () => {
  await initBooleans();
});

describe('benchtop template', () => {
  it('emits a feature tree that regenerates into a valid graph', () => {
    const part = benchtopPart(MVP);
    expect(part.features.map((f) => f.id)).toEqual(['top', 'frontDrop', 'splashback', 'sink1']);
    const { graph } = regenerate(part);
    expect(checkGraph(graph)).toEqual([]);
    expect(graph.faces.size).toBe(3);
    expect(graph.bends.size).toBe(2);
    expect(graph.baseFaceId).toBe(faceId('top'));
  });

  it('converts outside dimensions to tangent-to-tangent legs', () => {
    const part = benchtopPart(MVP);
    const { graph } = regenerate(part);
    const top = graph.faces.get(faceId('top'))!;
    // Depth loses one setback at the front fold and one at the splashback.
    const topBounds = top.profile.outer.verts.map((v) => v.y);
    expect(Math.max(...topBounds)).toBeCloseTo(600 - 2 * SETBACK, 9);
    const drop = graph.faces.get(faceId('frontDrop'))!;
    expect(Math.max(...drop.profile.outer.verts.map((v) => v.y))).toBeCloseTo(40 - SETBACK, 9);
    const splash = graph.faces.get(faceId('splashback'))!;
    expect(Math.max(...splash.profile.outer.verts.map((v) => v.y))).toBeCloseTo(100 - SETBACK, 9);
  });

  it('develops to a blank of the expected size', () => {
    const result = build(benchtopPart(MVP), { machine: GENERIC_2500_40T });
    const w = result.flat.bounds.max.x - result.flat.bounds.min.x;
    const h = result.flat.bounds.max.y - result.flat.bounds.min.y;
    expect(w).toBeCloseTo(1800, 4);
    // drop + BA + top + BA + splashback
    expect(h).toBeCloseTo(40 - SETBACK + BA + (600 - 2 * SETBACK) + BA + (100 - SETBACK), 4);
    expect(result.flat.overlapAreaMm2).toBe(0);
    expect(result.flat.islandCount).toBe(1);
  });

  it('carries the sink cutout through as an inner loop with its arcs intact', () => {
    const result = build(benchtopPart(MVP), { machine: GENERIC_2500_40T });
    expect(result.flat.profile.inners).toHaveLength(1);
    const sink = result.flat.profile.inners[0]!;
    // Eight vertices: four straight sides and four corner arcs, not a polyline.
    expect(sink.verts).toHaveLength(8);
    expect(sink.verts.filter((v) => Math.abs(v.bulge) > 1e-9)).toHaveLength(4);
  });

  it('positions the sink from the front of the finished benchtop', () => {
    const result = build(benchtopPart(MVP), { machine: GENERIC_2500_40T });
    const sink = result.flat.profile.inners[0]!;
    const frontBend = result.flat.bendLines.find((b) => b.direction === 'down')!;
    const sinkFrontY = Math.min(...sink.verts.map((v) => v.y));
    // The sink's front edge sits (90 - setback) from the top face's front
    // tangent line, which is the face-A side of the front bend.
    expect(sinkFrontY - frontBend.tangentA[0].y).toBeCloseTo(90 - SETBACK, 3);
  });

  it('passes validation on the placeholder machine', () => {
    const result = build(benchtopPart(MVP), { machine: GENERIC_2500_40T });
    expect(result.report.exportAllowed).toBe(true);
    expect(result.report.errorCount).toBe(0);
    expect(result.report.findings).toEqual([]);
  });

  it('reports a sensible part mass', () => {
    const result = build(benchtopPart(MVP), { machine: GENERIC_2500_40T });
    // ~1.32 m^2 of 1.2 mm stainless, less the sink cutout.
    expect(result.massKg).toBeGreaterThan(10);
    expect(result.massKg).toBeLessThan(15);
  });

  it('records the template parameters so the wizard stays live', () => {
    const part = benchtopPart(MVP);
    expect(part.template?.kind).toBe('benchtop');
    expect(part.template?.params).toEqual(MVP);
  });
});

describe('front edge styles', () => {
  const base: BenchtopParams = { ...MVP, cutouts: [], splashback: { style: 'none', heightMm: 0 } };

  it('square drop makes one bend', () => {
    const { graph } = regenerate(benchtopPart(base));
    expect(graph.bends.size).toBe(1);
  });

  it('drop and return makes two bends and adds the return to the blank', () => {
    const part = benchtopPart({
      ...base,
      frontEdge: { style: 'drop-and-return', dropMm: 40, returnMm: 25 },
    });
    const { graph } = regenerate(part);
    expect(graph.bends.size).toBe(2);
    const result = build(part, { machine: GENERIC_2500_40T });
    const h = result.flat.bounds.max.y - result.flat.bounds.min.y;
    // top + BA + drop(2 folds) + BA + return(1 fold)
    expect(h).toBeCloseTo(
      600 - SETBACK + BA + (40 - 2 * SETBACK) + BA + (25 - SETBACK),
      4,
    );
  });

  it('boxed edge makes three bends', () => {
    const part = benchtopPart({
      ...base,
      frontEdge: { style: 'boxed', dropMm: 40, returnMm: 25, upstandMm: 15 },
    });
    const { graph } = regenerate(part);
    expect(graph.bends.size).toBe(3);
    expect(checkGraph(graph)).toEqual([]);
  });

  it('rejects a return style with no return length', () => {
    expect(() =>
      benchtopPart({ ...base, frontEdge: { style: 'drop-and-return', dropMm: 40 } }),
    ).toThrow(BenchtopParameterError);
  });

  it('rejects an edge too short to survive its own setbacks', () => {
    expect(() =>
      benchtopPart({ ...base, frontEdge: { style: 'square-drop', dropMm: 2 } }),
    ).toThrow(/setback/);
  });

  it('rejects a benchtop too shallow for its folds', () => {
    expect(() => benchtopPart({ ...MVP, depthMm: 4 })).toThrow(BenchtopParameterError);
  });
});
