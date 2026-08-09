import { beforeAll, describe, expect, it } from 'vitest';
import { initBooleans } from '../src/geometry/boolean.js';
import { profile, profileArea, profileBounds } from '../src/geometry/profile.js';
import { circle, rect } from '../src/geometry/loop.js';
import { bendId, faceId } from '../src/ids.js';
import { STAINLESS_304 } from '../src/materials/material.js';
import { bendAllowance } from '../src/materials/allowance.js';
import { type Bend, type Face, buildGraph, checkGraph, makeFace } from '../src/model/graph.js';
import { unfold } from '../src/unfold/unfold.js';

const T = 1.2;
const R = 1.0;
const K = 0.44;
const BA90 = bendAllowance(90, R, T, K);

function lBracket(baseDepth = 50, flangeLength = 30, width = 100) {
  const base: Face = makeFace({
    id: faceId('base'),
    profile: profile(rect(0, 0, width, baseDepth)),
    featureId: 'base',
    label: 'Base',
  });
  const flange: Face = makeFace({
    id: faceId('flange'),
    profile: profile(rect(0, 0, width, flangeLength)),
    featureId: 'flange',
    label: 'Flange',
  });
  const bend: Bend = {
    id: bendId('flange', 'bend'),
    faceA: base.id,
    faceB: flange.id,
    lineA: { p0: { x: 0, y: 0 }, p1: { x: width, y: 0 } },
    lineB: { p0: { x: 0, y: 0 }, p1: { x: width, y: 0 } },
    angleDeg: 90,
    direction: 'down',
    insideRadius: R,
  };
  return buildGraph([base, flange], [bend], base.id, T);
}

beforeAll(async () => {
  await initBooleans();
});

describe('graph checks', () => {
  it('accepts a well-formed two-face tree', () => {
    expect(checkGraph(lBracket())).toEqual([]);
  });

  it('rejects a bend line that is not a CCW boundary edge of its face', () => {
    const g = lBracket();
    const bend = [...g.bends.values()][0]!;
    // Reverse lineA: now the material is on the right, which is the wrong side.
    const broken = buildGraph(
      [...g.faces.values()],
      [{ ...bend, lineA: { p0: bend.lineA.p1, p1: bend.lineA.p0 } }],
      g.baseFaceId,
      g.thickness,
    );
    expect(checkGraph(broken).map((p) => p.code)).toContain('bend-line-not-on-face');
  });

  it('rejects a bend whose two bend lines are different lengths', () => {
    const g = lBracket();
    const bend = [...g.bends.values()][0]!;
    const broken = buildGraph(
      [...g.faces.values()],
      [{ ...bend, lineB: { p0: { x: 0, y: 0 }, p1: { x: 80, y: 0 } } }],
      g.baseFaceId,
      g.thickness,
    );
    expect(checkGraph(broken).map((p) => p.code)).toContain('bend-line-length-mismatch');
  });

  it('rejects a graph with a cycle', () => {
    const g = lBracket();
    const [base, flange] = [...g.faces.values()];
    const bend = [...g.bends.values()][0]!;
    const extra: Bend = { ...bend, id: bendId('flange', 'bend2') };
    const broken = buildGraph([base!, flange!], [bend, extra], g.baseFaceId, g.thickness);
    expect(checkGraph(broken).map((p) => p.code)).toContain('not-a-tree');
  });
});

describe('unfold', () => {
  it('develops an L bracket to legs + bend allowance', () => {
    const flat = unfold(lBracket(50, 30, 100), { material: STAINLESS_304 });
    const box = flat.bounds;
    // Tolerances are set by the 1 nm boolean grid, not by the unfold maths.
    expect(box.max.x - box.min.x).toBeCloseTo(100, 5);
    expect(box.max.y - box.min.y).toBeCloseTo(50 + 30 + BA90, 5);
    expect(flat.overlapAreaMm2).toBe(0);
    expect(flat.islandCount).toBe(1);
    expect(flat.profile.inners).toHaveLength(0);
  });

  it('puts the flat pattern origin at the lower left', () => {
    const flat = unfold(lBracket(), { material: STAINLESS_304 });
    expect(flat.bounds.min.x).toBeCloseTo(0, 9);
    expect(flat.bounds.min.y).toBeCloseTo(0, 9);
  });

  it('records one bend line, of the right length and direction', () => {
    const flat = unfold(lBracket(50, 30, 100), { material: STAINLESS_304 });
    expect(flat.bendLines).toHaveLength(1);
    const bl = flat.bendLines[0]!;
    expect(bl.lengthMm).toBeCloseTo(100, 9);
    expect(bl.direction).toBe('down');
    expect(bl.allowance.bendAllowance).toBeCloseTo(BA90, 9);
    expect(bl.allowance.source).toBe('material-default');
    // Tangent lines sit one bend allowance apart.
    const gap = Math.abs(bl.tangentA[0].y - bl.tangentB[0].y);
    expect(gap).toBeCloseTo(BA90, 9);
  });

  it('flat area equals the sum of face areas plus the bend zone', () => {
    const flat = unfold(lBracket(50, 30, 100), { material: STAINLESS_304 });
    expect(flat.areaMm2).toBeCloseTo(100 * 50 + 100 * 30 + 100 * BA90, 3);
  });

  it('carries cutouts through to the flat pattern', () => {
    const g = lBracket(200, 40, 300);
    const base = g.faces.get(faceId('base'))!;
    const withHole = {
      ...base,
      profile: profile(base.profile.outer, [circle(150, 100, 25)]),
    };
    const holed = buildGraph(
      [withHole, g.faces.get(faceId('flange'))!],
      [...g.bends.values()],
      g.baseFaceId,
      g.thickness,
    );
    const flat = unfold(holed, { material: STAINLESS_304 });
    expect(flat.profile.inners).toHaveLength(1);
    expect(profileArea(flat.profile)).toBeCloseTo(
      300 * 200 + 300 * 40 + 300 * BA90 - Math.PI * 625,
      2,
    );
  });

  it('is unaffected by which of the two faces is the base', () => {
    const g = lBracket(50, 30, 100);
    const fromBase = unfold(g, { material: STAINLESS_304 });
    const fromFlange = unfold(g, { material: STAINLESS_304, baseFaceId: faceId('flange') });
    expect(fromFlange.areaMm2).toBeCloseTo(fromBase.areaMm2, 3);
    const a = profileBounds(fromBase.profile);
    const b = profileBounds(fromFlange.profile);
    expect(b.max.x - b.min.x).toBeCloseTo(a.max.x - a.min.x, 5);
    expect(b.max.y - b.min.y).toBeCloseTo(a.max.y - a.min.y, 5);
  });

  it('lays a chain of faces end to end without overlap', () => {
    // A 300 mm flange folded down off a 50 mm base, then a second 300 mm
    // flange folded back off that. The folded part doubles back on itself,
    // but the flat pattern is a plain strip — which is the point: overlap is a
    // property of the development, not of the finished shape.
    const width = 100;
    const base: Face = makeFace({
      id: faceId('base'),
      profile: profile(rect(0, 0, width, 50)),
      featureId: 'base',
    });
    const down: Face = makeFace({
      id: faceId('down'),
      profile: profile(rect(0, 0, width, 300)),
      featureId: 'down',
    });
    const back: Face = makeFace({
      id: faceId('back'),
      profile: profile(rect(0, 0, width, 300)),
      featureId: 'back',
    });
    const g = buildGraph(
      [base, down, back],
      [
        {
          id: bendId('down', 'bend'),
          faceA: base.id,
          faceB: down.id,
          lineA: { p0: { x: 0, y: 0 }, p1: { x: width, y: 0 } },
          lineB: { p0: { x: 0, y: 0 }, p1: { x: width, y: 0 } },
          angleDeg: 90,
          direction: 'down',
          insideRadius: R,
        },
        {
          // Fold the far edge of `down` back the way it came.
          id: bendId('back', 'bend'),
          faceA: down.id,
          faceB: back.id,
          lineA: { p0: { x: width, y: 300 }, p1: { x: 0, y: 300 } },
          lineB: { p0: { x: 0, y: 0 }, p1: { x: width, y: 0 } },
          angleDeg: 90,
          direction: 'down',
          insideRadius: R,
        },
      ],
      base.id,
      T,
    );
    expect(checkGraph(g)).toEqual([]);
    const flat = unfold(g, { material: STAINLESS_304 });
    // Three faces laid end to end never overlap in the flat, whatever they do
    // when folded — the flat is a strip 50 + 300 + 300 long.
    expect(flat.overlapAreaMm2).toBe(0);
    expect(flat.bounds.max.y - flat.bounds.min.y).toBeCloseTo(50 + 300 + 300 + 2 * BA90, 5);
  });
});
