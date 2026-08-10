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
  type BenchtopEdges,
  type BenchtopParams,
  type EdgeParams,
  BenchtopParameterError,
  DEFAULT_BENCHTOP,
  benchtopPart,
  cornerTreatments,
  resolveEdges,
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
  const GAP = T; // default weld gap at a closed corner: one thickness

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

  it('runs the end flanges the depth of the top, less the notch and the weld gap', () => {
    const { graph } = regenerate(benchtopPart(ALL_ROUND));
    const topDepth = 600 - 2 * SETBACK;
    for (const id of ['leftDrop', 'rightDrop']) {
      const face = graph.faces.get(faceId(id))!;
      const xs = face.profile.outer.verts.map((v) => v.x);
      // One end meets the front drop (mitred, so half a gap comes off), the
      // other meets the splashback folding the other way (relieved, notched).
      expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(topDepth - RELIEF - GAP / 2, 9);
      const ys = face.profile.outer.verts.map((v) => v.y);
      expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(40 - SETBACK, 9);
    }
  });

  it('notches only the corners where the two sides fold opposite ways', () => {
    const { graph } = regenerate(benchtopPart(ALL_ROUND));
    const top = graph.faces.get(faceId('top'))!;
    // Front/left and front/right both fold down, so those two corners close and
    // stay square. Both back corners meet the splashback folding up, which
    // cannot close, so they are notched: two extra vertices each.
    expect(top.profile.outer.verts).toHaveLength(8);
    const w = 1800 - 2 * SETBACK;
    const d = 600 - 2 * SETBACK;
    const has = (x: number, y: number): boolean =>
      top.profile.outer.verts.some((v) => Math.abs(v.x - x) < 1e-9 && Math.abs(v.y - y) < 1e-9);
    expect(has(0, 0)).toBe(true); // front-left, mitred, still a sharp corner
    expect(has(w, 0)).toBe(true); // front-right, ditto
    expect(has(0, d)).toBe(false); // back-left, notched away
    expect(has(w, d)).toBe(false); // back-right, notched away
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
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(600 - 2 * SETBACK - 8 - GAP / 2, 9);
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

/** The same edge on all four sides, typed so every side is present. */
function everySide(edge: EdgeParams): BenchtopEdges {
  return { front: edge, right: edge, back: edge, left: edge };
}

describe('mitred corners', () => {
  const GAP = T;
  const ALL_DOWN: BenchtopParams = {
    ...MVP,
    cutouts: [],
    edges: {
      front: { style: 'square-drop', heightMm: 40 },
      back: { style: 'square-drop', heightMm: 40 },
      left: { style: 'square-drop', heightMm: 40 },
      right: { style: 'square-drop', heightMm: 40 },
    },
  };
  const W = 1800 - 2 * SETBACK; // top face width
  const D = 600 - 2 * SETBACK; // top face depth

  it('classifies each corner by whether the two sides can meet', () => {
    expect(cornerTreatments(resolveEdges(ALL_DOWN))).toEqual({
      'front-left': 'mitre',
      'front-right': 'mitre',
      'back-right': 'mitre',
      'back-left': 'mitre',
    });
    // The splashback folds up, so neither back corner can close.
    expect(cornerTreatments(resolveEdges(MVP))['back-left']).toBe('none');
    expect(
      cornerTreatments(
        resolveEdges({ ...ALL_DOWN, edges: { ...ALL_DOWN.edges, back: { style: 'upstand', heightMm: 100 } } }),
      ),
    ).toMatchObject({ 'back-left': 'relief', 'back-right': 'relief', 'front-left': 'mitre' });
  });

  it('leaves the top square — a closed corner needs the metal, not a notch', () => {
    const { graph } = regenerate(benchtopPart(ALL_DOWN));
    const top = graph.faces.get(faceId('top'))!;
    expect(top.profile.outer.verts).toHaveLength(4);
    for (const [x, y] of [[0, 0], [W, 0], [W, D], [0, D]] as const) {
      expect(
        top.profile.outer.verts.some((v) => Math.abs(v.x - x) < 1e-9 && Math.abs(v.y - y) < 1e-9),
      ).toBe(true);
    }
  });

  it('runs each drop to the corner, less half a weld gap at each end', () => {
    const { graph } = regenerate(benchtopPart(ALL_DOWN));
    const widthOf = (id: string): number => {
      const xs = graph.faces.get(faceId(id))!.profile.outer.verts.map((v) => v.x);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(widthOf('frontDrop')).toBeCloseTo(W - GAP, 9);
    expect(widthOf('backDrop')).toBeCloseTo(W - GAP, 9);
    expect(widthOf('leftDrop')).toBeCloseTo(D - GAP, 9);
    expect(widthOf('rightDrop')).toBeCloseTo(D - GAP, 9);
  });

  it('closes the corner exactly when the weld gap is zero', () => {
    const { graph } = regenerate(benchtopPart({ ...ALL_DOWN, cornerGapMm: 0 }));
    const xs = graph.faces.get(faceId('frontDrop'))!.profile.outer.verts.map((v) => v.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(W, 9);
  });

  it('keeps the drops rectangular — two vertical flanges butt without a mitre', () => {
    const { graph } = regenerate(benchtopPart(ALL_DOWN));
    const drop = graph.faces.get(faceId('frontDrop'))!;
    const ys = drop.profile.outer.verts.map((v) => v.y);
    const atRoot = drop.profile.outer.verts.filter((v) => Math.abs(v.y - Math.min(...ys)) < 1e-9);
    const atTip = drop.profile.outer.verts.filter((v) => Math.abs(v.y - Math.max(...ys)) < 1e-9);
    const span = (vs: typeof atRoot): number =>
      Math.max(...vs.map((v) => v.x)) - Math.min(...vs.map((v) => v.x));
    expect(span(atTip)).toBeCloseTo(span(atRoot), 9);
  });

  it('mitres the returns at 45 degrees, which is where two horizontals collide', () => {
    const returnMm = 25;
    const returnLeg = returnMm - SETBACK;
    const part = benchtopPart({
      ...ALL_DOWN,
      edges: everySide({ style: 'drop-and-return', heightMm: 40, returnMm }),
    });
    const { graph } = regenerate(part);
    expect(checkGraph(graph)).toEqual([]);

    const face = graph.faces.get(faceId('frontReturn'))!;
    const ys = face.profile.outer.verts.map((v) => v.y);
    const root = face.profile.outer.verts.filter((v) => Math.abs(v.y - Math.min(...ys)) < 1e-9);
    const tip = face.profile.outer.verts.filter((v) => Math.abs(v.y - Math.max(...ys)) < 1e-9);
    const span = (vs: typeof root): number =>
      Math.max(...vs.map((v) => v.x)) - Math.min(...vs.map((v) => v.x));
    // A 45 degree cut takes back exactly the flange's own length at each end.
    // That is the condition for the two returns to meet along the corner
    // diagonal instead of overlapping in a square.
    expect(span(root) - span(tip)).toBeCloseTo(2 * returnLeg, 9);
    expect(span(root)).toBeCloseTo(W - GAP, 9);
  });

  it('hands the mitre on to the upstand of a boxed edge', () => {
    const returnMm = 25;
    const returnLeg = returnMm - 2 * SETBACK; // boxed: a fold at each end
    const { graph } = regenerate(
      benchtopPart({
        ...ALL_DOWN,
        edges: everySide({ style: 'boxed', heightMm: 40, returnMm, upstandMm: 15 }),
      }),
    );
    const xs = graph.faces.get(faceId('frontUpstand'))!.profile.outer.verts.map((v) => v.x);
    // The upstand sits on the return's tip, so it is already the mitred length
    // without knowing anything about corners.
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(W - GAP - 2 * returnLeg, 9);
  });

  it('develops to a blank with no overlap and passes validation', () => {
    const result = build(benchtopPart(ALL_DOWN), { machine: GENERIC_2500_40T });
    expect(result.flat.overlapAreaMm2).toBe(0);
    expect(result.flat.islandCount).toBe(1);
    expect(result.report.errorCount).toBe(0);
    expect(result.report.exportAllowed).toBe(true);
  });

  it('can be forced back to relief notches', () => {
    const { graph } = regenerate(benchtopPart({ ...ALL_DOWN, cornerStyle: 'relief' }));
    // Four notched corners, three vertices each.
    expect(graph.faces.get(faceId('top'))!.profile.outer.verts).toHaveLength(12);
  });

  it('rejects a mitre that would consume the whole flange', () => {
    // A 400 mm return on a 700 mm bench: the two 45 degree cuts cross before
    // they reach the tip. The mitre is applied when the flange face is built,
    // so this surfaces from regeneration rather than from the template.
    expect(() =>
      regenerate(
        benchtopPart({
          ...ALL_DOWN,
          lengthMm: 700,
          edges: {
            ...ALL_DOWN.edges,
            front: { style: 'drop-and-return', heightMm: 40, returnMm: 400 },
          },
        }),
      ),
    ).toThrow(/mitre/);
  });

  it('rejects a negative weld gap', () => {
    expect(() => benchtopPart({ ...ALL_DOWN, cornerGapMm: -1 })).toThrow(BenchtopParameterError);
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
