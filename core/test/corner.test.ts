/**
 * Corner joints.
 *
 * The load-bearing claim is the one in CLAUDE.md invariant 1: a joint is a
 * record alongside the graph that modifies 2D profiles at unfold time, and
 * never a graph edge. If it were an edge it would close a cycle and the tree
 * property — the thing that makes unfold a sequence of rigid motions — would be
 * gone. So the first test here is that adding a joint leaves the tree alone,
 * and the rest are about the metal.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { initBooleans } from '../src/geometry/boolean.js';
import { profileArea } from '../src/geometry/profile.js';
import { cornerId, faceId, featureId } from '../src/ids.js';
import { regenerate, rectangleEdges, rectangleProfile } from '../src/features/regen.js';
import type { CornerTreatment } from '../src/model/corner.js';
import { applyCorners, checkCorners, defaultSlotInset, tabStations } from '../src/model/corner.js';
import { checkGraph } from '../src/model/graph.js';
import type { Feature, Part } from '../src/features/types.js';
import { unfold } from '../src/unfold/unfold.js';
import { STAINLESS_304 } from '../src/materials/material.js';

const T = 1.2;
const WIDTH = 200;
const DEPTH = 100;
const FLANGE = 30;

/**
 * A plate with a front and a left flange, both folded down. Their two side
 * edges meet at the front-left corner, which is the joint under test.
 *
 * Built by hand rather than through the benchtop template so the test says
 * exactly which edges are meant to meet.
 */
function cornerPart(treatment?: CornerTreatment, over: Partial<{ leftLength: number }> = {}): Part {
  const features: Feature[] = [
    {
      kind: 'base-flange',
      id: featureId('base'),
      profile: rectangleProfile(WIDTH, DEPTH),
      edges: rectangleEdges(WIDTH, DEPTH),
      label: 'Base',
    },
    {
      kind: 'edge-flange',
      id: featureId('frontDrop'),
      edge: { faceId: faceId('base'), edgeName: 'front' },
      lengthMm: FLANGE,
      angleDeg: 90,
      direction: 'down',
      insideRadiusMm: 1.2,
    },
    {
      kind: 'edge-flange',
      id: featureId('leftDrop'),
      edge: { faceId: faceId('base'), edgeName: 'left' },
      lengthMm: over.leftLength ?? FLANGE,
      angleDeg: 90,
      direction: 'down',
      insideRadiusMm: 1.2,
    },
  ];
  if (treatment !== undefined) {
    features.push({
      kind: 'corner-joint',
      id: featureId('frontLeft'),
      // The front flange's `start` end came from the base's front-left corner;
      // the left flange's `end` end came from the same corner.
      a: { faceId: faceId('frontDrop'), edgeName: 'start' },
      b: { faceId: faceId('leftDrop'), edgeName: 'end' },
      treatment,
      label: 'Front-left corner',
    });
  }
  return {
    parameters: { name: 'Corner test', materialId: 'ss304', thicknessMm: T, grain: 'none' },
    features,
  };
}

const WELD: CornerTreatment = { kind: 'weld-gap', gapMm: 2 };
const TABS: CornerTreatment = {
  kind: 'tab-slot',
  tabWidthMm: 8,
  tabCount: 2,
  tabLengthMm: T,
  clearanceMm: 0.15,
};

beforeAll(async () => {
  await initBooleans();
});

describe('a joint is not a graph edge', () => {
  it('leaves the tree exactly as it was', () => {
    const without = regenerate(cornerPart()).graph;
    const with_ = regenerate(cornerPart(WELD)).graph;
    expect(with_.faces.size).toBe(without.faces.size);
    expect(with_.bends.size).toBe(without.bends.size);
    expect(checkGraph(with_)).toEqual([]);
    expect(with_.corners.size).toBe(1);
  });

  it('records the joint under its own id', () => {
    const { graph } = regenerate(cornerPart(WELD));
    const joint = graph.corners.get(cornerId('frontLeft'))!;
    expect(joint).toBeDefined();
    expect(joint.label).toBe('Front-left corner');
    expect(joint.treatment).toEqual(WELD);
  });

  it('applies without mutating the graph it was given', () => {
    const { graph } = regenerate(cornerPart(WELD));
    const before = profileArea(graph.faces.get(faceId('frontDrop'))!.profile);
    applyCorners(graph);
    applyCorners(graph);
    expect(profileArea(graph.faces.get(faceId('frontDrop'))!.profile)).toBe(before);
  });
});

describe('checks', () => {
  const check = (part: Part): string[] =>
    checkCorners(regenerate(part).graph).map((p) => p.message);

  it('passes a joint whose two edges really do meet', () => {
    expect(check(cornerPart(WELD))).toEqual([]);
  });

  it('refuses two edges of different lengths', () => {
    // A 30 mm flange cannot butt against a 45 mm one along its whole length.
    const problems = check(cornerPart(WELD, { leftLength: 45 }));
    expect(problems.join()).toMatch(/do not meet along their whole length/);
  });

  it('stops the unfold rather than developing a part that cannot be made', () => {
    const { graph } = regenerate(cornerPart(WELD, { leftLength: 45 }));
    expect(() => unfold(graph, { material: STAINLESS_304 })).toThrow();
  });

  it('names a face or edge that does not exist', () => {
    const part = cornerPart(WELD);
    const joint = part.features.find((f) => f.kind === 'corner-joint')!;
    const bad: Part = {
      ...part,
      features: [
        ...part.features.filter((f) => f.kind !== 'corner-joint'),
        { ...joint, a: { faceId: faceId('nosuch'), edgeName: 'start' } },
      ],
    };
    expect(check(bad).join()).toMatch(/no face called nosuch/);

    const badEdge: Part = {
      ...part,
      features: [
        ...part.features.filter((f) => f.kind !== 'corner-joint'),
        { ...joint, a: { faceId: faceId('frontDrop'), edgeName: 'nosuch' } },
      ],
    };
    expect(check(badEdge).join()).toMatch(/no edge named/);
  });

  it('refuses a joint from an edge to itself', () => {
    const part = cornerPart(WELD);
    const joint = part.features.find((f) => f.kind === 'corner-joint')!;
    const bad: Part = {
      ...part,
      features: [
        ...part.features.filter((f) => f.kind !== 'corner-joint'),
        { ...joint, b: joint.a },
      ],
    };
    expect(check(bad).join()).toMatch(/same edge/);
  });

  it('refuses tabs that do not fit on the edge', () => {
    const tooMany: CornerTreatment = { ...TABS, kind: 'tab-slot', tabCount: 5, tabWidthMm: 8 };
    expect(check(cornerPart(tooMany)).join()).toMatch(/do not fit on a 30.0 mm edge/);
  });

  it('refuses nonsense tab dimensions', () => {
    expect(check(cornerPart({ ...TABS, tabWidthMm: 0 })).join()).toMatch(/tab width/);
    expect(check(cornerPart({ ...TABS, tabCount: 0 })).join()).toMatch(/whole number/);
    expect(check(cornerPart({ ...TABS, tabLengthMm: -1 })).join()).toMatch(/tab length/);
    expect(check(cornerPart({ ...TABS, clearanceMm: -1 })).join()).toMatch(/clearance/);
  });

  it('refuses a negative weld gap', () => {
    expect(check(cornerPart({ kind: 'weld-gap', gapMm: -1 })).join()).toMatch(/negative/);
  });

  it('refuses a slot set so close to the edge that it breaks out', () => {
    // Half a thickness in was the first thing I tried, and it is wrong: the
    // slot straddles the edge and becomes an open notch, which is a different
    // joint and would have been cut without complaint.
    expect(check(cornerPart({ ...TABS, slotInsetMm: T / 2 })).join()).toMatch(/break out/);
  });
});

describe('weld gap', () => {
  it('takes half the gap off each flange', () => {
    const plain = applyCorners(regenerate(cornerPart()).graph);
    const welded = applyCorners(regenerate(cornerPart(WELD)).graph);
    for (const id of ['frontDrop', 'leftDrop']) {
      const before = profileArea(plain.faces.get(faceId(id))!.profile);
      const after = profileArea(welded.faces.get(faceId(id))!.profile);
      // A strip half the gap deep along the whole 30 mm side edge.
      expect(before - after).toBeCloseTo((2 / 2) * FLANGE, 5);
    }
  });

  it('leaves the base face alone', () => {
    const plain = applyCorners(regenerate(cornerPart()).graph);
    const welded = applyCorners(regenerate(cornerPart(WELD)).graph);
    expect(profileArea(welded.faces.get(faceId('base'))!.profile)).toBeCloseTo(
      profileArea(plain.faces.get(faceId('base'))!.profile),
      9,
    );
  });

  it('does nothing at all with a gap of zero', () => {
    const zero = applyCorners(regenerate(cornerPart({ kind: 'weld-gap', gapMm: 0 })).graph);
    const plain = applyCorners(regenerate(cornerPart()).graph);
    expect(profileArea(zero.faces.get(faceId('frontDrop'))!.profile)).toBeCloseTo(
      profileArea(plain.faces.get(faceId('frontDrop'))!.profile),
      9,
    );
  });

  it('reaches the blank, which is the point of doing it at unfold time', () => {
    const plain = unfold(regenerate(cornerPart()).graph, { material: STAINLESS_304 });
    const welded = unfold(regenerate(cornerPart(WELD)).graph, { material: STAINLESS_304 });
    expect(plain.areaMm2 - welded.areaMm2).toBeCloseTo(2 * ((2 / 2) * FLANGE), 4);
    expect(welded.islandCount).toBe(1);
    expect(welded.overlapAreaMm2).toBe(0);
  });
});

describe('tab and slot', () => {
  it('spreads the tabs evenly, and never against either end', () => {
    expect(tabStations(30, 2)).toEqual([7.5, 22.5]);
    expect(tabStations(30, 1)).toEqual([15]);
    expect(tabStations(40, 4)).toEqual([5, 15, 25, 35]);
  });

  it('grows tabs out of one flange and cuts slots in the other', () => {
    const plain = applyCorners(regenerate(cornerPart()).graph);
    const tabbed = applyCorners(regenerate(cornerPart(TABS)).graph);

    const tabsFace = tabbed.faces.get(faceId('frontDrop'))!;
    const added = profileArea(tabsFace.profile) - profileArea(plain.faces.get(faceId('frontDrop'))!.profile);
    expect(added).toBeCloseTo(2 * 8 * T, 4);

    const slotFace = tabbed.faces.get(faceId('leftDrop'))!;
    const removed = profileArea(plain.faces.get(faceId('leftDrop'))!.profile) - profileArea(slotFace.profile);
    // Two slots, each the tab plus clearance all round.
    expect(removed).toBeCloseTo(2 * (8 + 0.3) * (T + 0.3), 4);
  });

  it('cuts the slots as holes, so the blank stays one piece', () => {
    const flat = unfold(regenerate(cornerPart(TABS)).graph, { material: STAINLESS_304 });
    expect(flat.islandCount).toBe(1);
    expect(flat.profile.inners).toHaveLength(2);
    expect(flat.overlapAreaMm2).toBe(0);
  });

  it('lines each slot up with its tab, which is the antiparallel convention', () => {
    const { graph } = regenerate(cornerPart(TABS));
    const applied = applyCorners(graph);
    const slots = applied.faces.get(faceId('leftDrop'))!.profile.inners;
    expect(slots).toHaveLength(2);

    // The left flange's `end` edge runs from (tipEndX, length) to (0, 0), so a
    // station s from the *front* flange's start meets (30 - s) along it. With
    // tabs at 7.5 and 22.5, the slots sit at 22.5 and 7.5 from that edge's
    // start — which is the same two points measured from the other direction.
    const centres = slots
      .map((loop) => {
        const ys = loop.verts.map((v) => v.y);
        return (Math.min(...ys) + Math.max(...ys)) / 2;
      })
      .sort((x, y) => x - y);
    expect(centres[0]).toBeCloseTo(7.5, 4);
    expect(centres[1]).toBeCloseTo(22.5, 4);
  });

  it('leaves one thickness of land in front of the slot unless told otherwise', () => {
    const applied = applyCorners(regenerate(cornerPart(TABS)).graph);
    const slot = applied.faces.get(faceId('leftDrop'))!.profile.inners[0]!;
    // The `end` edge of the left flange lies on x = 0, and "into the face" is
    // +x, so the slot centre sits at the inset.
    const xs = slot.verts.map((v) => v.x);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(defaultSlotInset(T, 0.15), 6);
    // A full thickness of metal between the edge and the slot.
    expect(Math.min(...xs)).toBeCloseTo(T, 6);

    const further = applyCorners(regenerate(cornerPart({ ...TABS, slotInsetMm: 5 })).graph);
    const moved = further.faces.get(faceId('leftDrop'))!.profile.inners[0]!;
    const movedXs = moved.verts.map((v) => v.x);
    expect((Math.min(...movedXs) + Math.max(...movedXs)) / 2).toBeCloseTo(5, 6);
  });
});
