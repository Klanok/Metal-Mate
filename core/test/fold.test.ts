/**
 * The folded (3D) view.
 *
 * These tests pin down the bend direction convention. Direction has no effect
 * on the flat pattern, so without them an inverted sign would sail through
 * every other test and only show up as a benchtop with its splashback pointing
 * at the floor.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { initBooleans } from '../src/geometry/boolean.js';
import { length3, sub3 } from '../src/geometry/vec3.js';
import { faceId } from '../src/ids.js';
import { STAINLESS_304 } from '../src/materials/material.js';
import { bendAllowance } from '../src/materials/allowance.js';
import { regenerate } from '../src/features/regen.js';
import { angleBetween, fold, frameFor, toWorld } from '../src/unfold/fold.js';
import { unfold } from '../src/unfold/unfold.js';
import { type BenchtopParams, DEFAULT_BENCHTOP, benchtopPart } from '../src/templates/benchtop.js';

const PARAMS: BenchtopParams = {
  ...DEFAULT_BENCHTOP,
  lengthMm: 1800,
  depthMm: 600,
  thicknessMm: 1.2,
  bendRadiusMm: 1.2,
  frontEdge: { style: 'square-drop', dropMm: 40 },
  splashback: { style: 'integral', heightMm: 100 },
  cutouts: [],
};

beforeAll(async () => {
  await initBooleans();
});

function foldBenchtop(params: BenchtopParams = PARAMS, fraction = 1) {
  const { graph } = regenerate(benchtopPart(params));
  return { graph, folded: fold(graph, { material: STAINLESS_304, fraction }) };
}

/** Farthest point of a face in world z. */
function extremeZ(
  graph: ReturnType<typeof regenerate>['graph'],
  folded: ReturnType<typeof fold>,
  id: ReturnType<typeof faceId>,
): { min: number; max: number } {
  const frame = frameFor(folded, id);
  const zs = graph.faces
    .get(id)!
    .profile.outer.verts.map((v) => toWorld(frame, { x: v.x, y: v.y }).z);
  return { min: Math.min(...zs), max: Math.max(...zs) };
}

describe('bend direction', () => {
  it('sends a "down" front edge below the top face', () => {
    const { graph, folded } = foldBenchtop();
    const drop = extremeZ(graph, folded, faceId('frontDrop'));
    expect(drop.min).toBeLessThan(-30);
    expect(drop.max).toBeLessThanOrEqual(0.001);
  });

  it('sends an "up" splashback above the top face', () => {
    const { graph, folded } = foldBenchtop();
    const splash = extremeZ(graph, folded, faceId('splashback'));
    expect(splash.max).toBeGreaterThan(90);
    expect(splash.min).toBeGreaterThanOrEqual(-0.001);
  });

  it('leaves the base face in the z = 0 plane', () => {
    const { graph, folded } = foldBenchtop();
    const top = extremeZ(graph, folded, faceId('top'));
    expect(top.min).toBeCloseTo(0, 9);
    expect(top.max).toBeCloseTo(0, 9);
  });

  it('turns each face 90 degrees out of its neighbour', () => {
    const { folded } = foldBenchtop();
    const top = frameFor(folded, faceId('top')).normal;
    expect(angleBetween(top, frameFor(folded, faceId('frontDrop')).normal)).toBeCloseTo(90, 6);
    expect(angleBetween(top, frameFor(folded, faceId('splashback')).normal)).toBeCloseTo(90, 6);
  });

  it('curls a boxed front edge back under the top, not away from it', () => {
    const boxed: BenchtopParams = {
      ...PARAMS,
      splashback: { style: 'none', heightMm: 0 },
      frontEdge: { style: 'boxed', dropMm: 40, returnMm: 25, upstandMm: 15 },
    };
    const { graph, folded } = foldBenchtop(boxed);
    const topFrame = frameFor(folded, faceId('top'));
    // The top face's own front edge, in world coordinates.
    const frontEdgeY = toWorld(topFrame, { x: 0, y: 0 }).y;
    const returnFrame = frameFor(folded, faceId('frontReturn'));
    const returnPoints = graph.faces
      .get(faceId('frontReturn'))!
      .profile.outer.verts.map((v) => toWorld(returnFrame, { x: v.x, y: v.y }));
    // The return runs back underneath the benchtop, so it sits behind the
    // front edge, not in front of it.
    expect(Math.max(...returnPoints.map((p) => p.y))).toBeGreaterThan(frontEdgeY + 20);
    expect(Math.min(...returnPoints.map((p) => p.z))).toBeLessThan(-30);
  });
});

describe('fold fraction', () => {
  it('reproduces the flat pattern at fraction 0', () => {
    const { graph, folded } = foldBenchtop(PARAMS, 0);
    const flat = unfold(graph, { material: STAINLESS_304, keepOrigin: true });
    for (const face of folded.faces) {
      const frame = face.frame;
      expect(Math.abs(frame.origin.z)).toBeLessThan(1e-9);
      const placed = flat.faces.find((f) => f.faceId === face.faceId)!;
      const flatOrigin = { x: placed.xform.e, y: placed.xform.f };
      expect(frame.origin.x).toBeCloseTo(flatOrigin.x, 6);
      expect(frame.origin.y).toBeCloseTo(flatOrigin.y, 6);
    }
  });

  it('keeps the bend zone one bend allowance long at every fraction', () => {
    const ba = bendAllowance(90, 1.2, 1.2, 0.44);
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      const { folded } = foldBenchtop(PARAMS, fraction);
      for (const bend of folded.bends) {
        // Arc length from one tangent line to the other.
        const developed =
          fraction === 0
            ? length3(sub3(bend.tangentB[1], bend.tangentA[0]))
            : Math.abs(bend.sweepRad) * bend.currentRadius;
        expect(developed).toBeCloseTo(ba, 6);
      }
    }
  });

  it('reaches the neutral radius R + K T when fully folded', () => {
    const { folded } = foldBenchtop(PARAMS, 1);
    for (const bend of folded.bends) {
      expect(bend.neutralRadius).toBeCloseTo(1.2 + 0.44 * 1.2, 9);
    }
  });
});
