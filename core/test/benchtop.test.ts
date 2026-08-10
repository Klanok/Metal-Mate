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
  NO_EDGE,
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
  edges: {
    front: { style: 'square-drop', heightMm: 40 },
    back: { style: 'upstand', heightMm: 100 },
    left: NO_EDGE,
    right: NO_EDGE,
  },
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
  const base: BenchtopParams = {
    ...MVP,
    cutouts: [],
    edges: { ...MVP.edges, back: NO_EDGE },
  };

  it('square drop makes one bend', () => {
    const { graph } = regenerate(benchtopPart(base));
    expect(graph.bends.size).toBe(1);
  });

  it('drop and return makes two bends and adds the return to the blank', () => {
    const part = benchtopPart({
      ...base,
      edges: { ...base.edges, front: { style: 'drop-and-return', heightMm: 40, returnMm: 25 } },
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
      edges: {
        ...base.edges,
        front: { style: 'boxed', heightMm: 40, returnMm: 25, upstandMm: 15 },
      },
    });
    const { graph } = regenerate(part);
    expect(graph.bends.size).toBe(3);
    expect(checkGraph(graph)).toEqual([]);
  });

  it('rejects a return style with no return length', () => {
    expect(() =>
      benchtopPart({ ...base, edges: { ...base.edges, front: { style: 'drop-and-return', heightMm: 40 } } }),
    ).toThrow(BenchtopParameterError);
  });

  it('rejects an edge too short to survive its own setbacks', () => {
    expect(() =>
      benchtopPart({ ...base, edges: { ...base.edges, front: { style: 'square-drop', heightMm: 2 } } }),
    ).toThrow(/setback/);
  });

  it('rejects a benchtop too shallow for its folds', () => {
    expect(() => benchtopPart({ ...MVP, depthMm: 4 })).toThrow(BenchtopParameterError);
  });
});

describe('edges on all four sides', () => {
  const ALL_ROUND: BenchtopParams = {
    ...MVP,
    cutouts: [],
    edges: {
      front: { style: 'square-drop', heightMm: 40 },
      back: { style: 'upstand', heightMm: 100 },
      left: { style: 'square-drop', heightMm: 40 },
      right: { style: 'square-drop', heightMm: 40 },
    },
  };
  const RELIEF = Math.max(2 * T, R + T); // the default: 2.4 mm here

  it('gives every side its own flange, and the graph is still a tree', () => {
    const part = benchtopPart(ALL_ROUND);
    expect(part.features.map((f) => f.id)).toEqual([
      'top',
      'frontDrop',
      'rightDrop',
      'splashback',
      'leftDrop',
    ]);
    const { graph } = regenerate(part);
    expect(checkGraph(graph)).toEqual([]);
    expect(graph.faces.size).toBe(5);
    expect(graph.bends.size).toBe(4);
    expect(graph.baseFaceId).toBe(faceId('top'));
  });

  it('takes a setback off the length for the two end folds', () => {
    const { graph } = regenerate(benchtopPart(ALL_ROUND));
    const top = graph.faces.get(faceId('top'))!;
    const xs = top.profile.outer.verts.map((v) => v.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(1800 - 2 * SETBACK, 9);
  });

  it('runs the end flanges the full depth of the top, less its notches', () => {
    const { graph } = regenerate(benchtopPart(ALL_ROUND));
    const topDepth = 600 - 2 * SETBACK;
    for (const id of ['leftDrop', 'rightDrop']) {
      const face = graph.faces.get(faceId(id))!;
      const xs = face.profile.outer.verts.map((v) => v.x);
      expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(topDepth - 2 * RELIEF, 9);
      const ys = face.profile.outer.verts.map((v) => v.y);
      expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(40 - SETBACK, 9);
    }
  });

  it('notches the top wherever two folded sides meet', () => {
    const { graph } = regenerate(benchtopPart(ALL_ROUND));
    const top = graph.faces.get(faceId('top'))!;
    // Four corners, each replacing one vertex with three.
    expect(top.profile.outer.verts).toHaveLength(12);
    const w = 1800 - 2 * SETBACK;
    const d = 600 - 2 * SETBACK;
    // No material survives inside any corner square of side RELIEF.
    for (const [cx, cy] of [
      [0, 0],
      [w, 0],
      [w, d],
      [0, d],
    ] as const) {
      const inCorner = top.profile.outer.verts.filter(
        (v) => Math.abs(v.x - cx) < RELIEF - 1e-9 && Math.abs(v.y - cy) < RELIEF - 1e-9,
      );
      expect(inCorner).toHaveLength(0);
    }
  });

  it('leaves the corner square when only one of the two sides is folded', () => {
    const { graph } = regenerate(
      benchtopPart({ ...ALL_ROUND, edges: { ...ALL_ROUND.edges, left: NO_EDGE, right: NO_EDGE } }),
    );
    expect(graph.faces.get(faceId('top'))!.profile.outer.verts).toHaveLength(4);
  });

  it('honours an explicit relief size', () => {
    const { graph } = regenerate(benchtopPart({ ...ALL_ROUND, cornerReliefMm: 8 }));
    const face = graph.faces.get(faceId('leftDrop'))!;
    const xs = face.profile.outer.verts.map((v) => v.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(600 - 2 * SETBACK - 16, 9);
  });

  it('rejects a relief that eats the whole top', () => {
    expect(() => benchtopPart({ ...ALL_ROUND, cornerReliefMm: 400 })).toThrow(
      BenchtopParameterError,
    );
  });

  it('develops to a cross-shaped blank with no overlap', () => {
    const result = build(benchtopPart(ALL_ROUND), { machine: GENERIC_2500_40T });
    const w = result.flat.bounds.max.x - result.flat.bounds.min.x;
    const h = result.flat.bounds.max.y - result.flat.bounds.min.y;
    // end drop + BA + top + BA + end drop, across the length.
    expect(w).toBeCloseTo(40 - SETBACK + BA + (1800 - 2 * SETBACK) + BA + (40 - SETBACK), 4);
    expect(h).toBeCloseTo(40 - SETBACK + BA + (600 - 2 * SETBACK) + BA + (100 - SETBACK), 4);
    expect(result.flat.overlapAreaMm2).toBe(0);
    expect(result.flat.islandCount).toBe(1);
  });

  it('folds the ends up or down as asked, without touching the flat', () => {
    const down = build(benchtopPart(ALL_ROUND), { machine: GENERIC_2500_40T });
    const up = build(
      benchtopPart({
        ...ALL_ROUND,
        edges: {
          ...ALL_ROUND.edges,
          left: { style: 'upstand', heightMm: 40 },
          right: { style: 'upstand', heightMm: 40 },
        },
      }),
      { machine: GENERIC_2500_40T },
    );
    expect(down.flat.bendLines.filter((b) => b.direction === 'up')).toHaveLength(1);
    expect(up.flat.bendLines.filter((b) => b.direction === 'up')).toHaveLength(3);
    // Direction is a press-brake instruction, not a change of blank.
    expect(up.flat.bounds).toEqual(down.flat.bounds);
    expect(up.flat.cutLengthMm).toBeCloseTo(down.flat.cutLengthMm, 6);
  });

  it('positions cutouts from the front-left corner of the finished top', () => {
    const withSink: BenchtopParams = {
      ...ALL_ROUND,
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
    const result = build(benchtopPart(withSink), { machine: GENERIC_2500_40T });
    const sink = result.flat.profile.inners[0]!;
    // The left fold moves the top face's own origin in by one setback, so a
    // sink measured 400 mm from the outside of the left end has to land
    // (400 - setback) from the left bend's tangent line.
    const sinkLeftX = Math.min(...sink.verts.map((v) => v.x));
    const leftBend = result.flat.bendLines
      .map((b) => Math.min(b.tangentA[0].x, b.tangentA[1].x))
      .reduce((a, b) => Math.min(a, b));
    expect(sinkLeftX - leftBend).toBeCloseTo(400 - SETBACK, 3);
  });

  it('passes validation on the placeholder machine', () => {
    const result = build(benchtopPart(ALL_ROUND), { machine: GENERIC_2500_40T });
    expect(result.report.errorCount).toBe(0);
    expect(result.report.exportAllowed).toBe(true);
  });
});

describe('older projects', () => {
  it('reads frontEdge and splashback into the same part as edges', () => {
    const { edges: _drop, ...rest } = MVP;
    const legacy: BenchtopParams = {
      ...rest,
      frontEdge: { style: 'square-drop', dropMm: 40 },
      splashback: { style: 'integral', heightMm: 100 },
    };
    const fromLegacy = regenerate(benchtopPart(legacy)).graph;
    const fromEdges = regenerate(benchtopPart(MVP)).graph;
    expect([...fromLegacy.faces.keys()]).toEqual([...fromEdges.faces.keys()]);
    for (const [id, face] of fromLegacy.faces) {
      expect(face.profile).toEqual(fromEdges.faces.get(id)!.profile);
    }
  });

  it('reads a splashback of style none as an open back', () => {
    const { edges: _drop, ...rest } = MVP;
    const { graph } = regenerate(
      benchtopPart({
        ...rest,
        frontEdge: { style: 'square-drop', dropMm: 40 },
        splashback: { style: 'none', heightMm: 0 },
      }),
    );
    expect(graph.bends.size).toBe(1);
  });

  it('refuses to guess when a side is set both ways', () => {
    expect(() => benchtopPart({ ...MVP, frontEdge: { style: 'square-drop', dropMm: 40 } })).toThrow(
      BenchtopParameterError,
    );
    expect(() =>
      benchtopPart({ ...MVP, splashback: { style: 'integral', heightMm: 100 } }),
    ).toThrow(/edges.back/);
  });
});
