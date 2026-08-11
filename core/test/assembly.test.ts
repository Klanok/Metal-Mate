/**
 * Placing parts relative to each other.
 *
 * This is not general assembly CAD — the architecture doc rules that out for
 * v1 — it is the narrow thing a cross-part corner joint needs: given two edges
 * on two different parts that are supposed to meet, where are they, and do they
 * actually meet?
 *
 * So the tests that matter are the geometric ones: after a mate, the two edges
 * are the same segment in space, and the dihedral between the two faces is the
 * angle that was asked for.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { initBooleans } from '../src/geometry/boolean.js';
import { distance3, normalize3, sub3, dot3 } from '../src/geometry/vec3.js';
import { faceId, featureId, partId } from '../src/ids.js';
import { regenerate, rectangleEdges, rectangleProfile } from '../src/features/regen.js';
import {
  type Assembly,
  type EdgeMate,
  type PlacedPart,
  AT_ORIGIN,
  AssemblyError,
  checkAssembly,
  solveAssembly,
  worldEdge,
} from '../src/model/assembly.js';
import { fold } from '../src/unfold/fold.js';
import { STAINLESS_304 } from '../src/materials/material.js';
import type { Part } from '../src/features/types.js';

const T = 1.2;

/** A flat rectangular panel with named boundary edges and no folds. */
function panel(name: string, width: number, depth: number): Part {
  return {
    parameters: { name, materialId: 'ss304', thicknessMm: T, grain: 'none' },
    features: [
      {
        kind: 'base-flange',
        id: featureId('plate'),
        profile: rectangleProfile(width, depth),
        edges: rectangleEdges(width, depth),
        label: name,
      },
    ],
  };
}

function placed(name: string, width: number, depth: number): PlacedPart {
  const part = panel(name, width, depth);
  const { graph } = regenerate(part);
  return {
    partId: partId(name),
    graph,
    folded: fold(graph, { material: STAINLESS_304, fraction: 1 }),
  };
}

const FLOOR = 'Floor';
const SIDE = 'Side';

/** A 1200 x 600 floor with a 1200 x 400 side stood up along its back edge. */
function twoPanels(angleDeg = 90, offsetMm?: number): {
  assembly: Assembly;
  parts: Map<ReturnType<typeof partId>, PlacedPart>;
} {
  const floor = placed(FLOOR, 1200, 600);
  const side = placed(SIDE, 1200, 400);
  const mate: EdgeMate = {
    id: 'floor-to-side',
    part: partId(SIDE),
    edge: { faceId: faceId('plate'), edgeName: 'front' },
    to: partId(FLOOR),
    toEdge: { faceId: faceId('plate'), edgeName: 'back' },
    angleDeg,
    ...(offsetMm !== undefined ? { offsetMm } : {}),
  };
  return {
    assembly: { rootPartId: partId(FLOOR), mates: [mate] },
    parts: new Map([
      [partId(FLOOR), floor],
      [partId(SIDE), side],
    ]),
  };
}

beforeAll(async () => {
  await initBooleans();
});

describe('placing parts', () => {
  it('leaves the root part where it is', () => {
    const { assembly, parts } = twoPanels();
    expect(solveAssembly(assembly, parts).get(partId(FLOOR))).toEqual(AT_ORIGIN);
  });

  it('brings the two mated edges onto the same segment in space', () => {
    const { assembly, parts } = twoPanels();
    const places = solveAssembly(assembly, parts);

    const host = worldEdge(parts.get(partId(FLOOR))!, places.get(partId(FLOOR))!, faceId('plate'), 'back');
    const guest = worldEdge(parts.get(partId(SIDE))!, places.get(partId(SIDE))!, faceId('plate'), 'front');

    // They run opposite ways when they meet, so one's start is the other's end.
    expect(distance3(guest.p0, host.p1)).toBeCloseTo(0, 6);
    expect(distance3(guest.p1, host.p0)).toBeCloseTo(0, 6);
    expect(dot3(guest.dir, host.dir)).toBeCloseTo(-1, 9);
  });

  it('opens the dihedral to the angle asked for', () => {
    for (const angleDeg of [30, 60, 90, 120]) {
      const { assembly, parts } = twoPanels(angleDeg);
      const places = solveAssembly(assembly, parts);
      const host = worldEdge(parts.get(partId(FLOOR))!, places.get(partId(FLOOR))!, faceId('plate'), 'back');
      const guest = worldEdge(parts.get(partId(SIDE))!, places.get(partId(SIDE))!, faceId('plate'), 'front');

      // Measured between the two faces' inward directions, from flat. Flat is
      // the two panels laid out away from each other, so the departure from
      // flat is 180 minus the angle between the inward directions.
      const between = (Math.acos(clamp(dot3(host.inward, guest.inward))) * 180) / Math.PI;
      expect(180 - between).toBeCloseTo(angleDeg, 6);
    }
  });

  it('leaves the two parts coplanar at zero, which is what flat means', () => {
    const { assembly, parts } = twoPanels(0);
    const places = solveAssembly(assembly, parts);
    const host = worldEdge(parts.get(partId(FLOOR))!, places.get(partId(FLOOR))!, faceId('plate'), 'back');
    const guest = worldEdge(parts.get(partId(SIDE))!, places.get(partId(SIDE))!, faceId('plate'), 'front');
    expect(Math.abs(dot3(host.normal, guest.normal))).toBeCloseTo(1, 6);
    // ...and lying away from each other rather than on top of each other.
    expect(dot3(host.inward, guest.inward)).toBeCloseTo(-1, 6);
  });

  it('slides the part along the shared edge when asked', () => {
    const { assembly, parts } = twoPanels(90, 50);
    const places = solveAssembly(assembly, parts);
    const host = worldEdge(parts.get(partId(FLOOR))!, places.get(partId(FLOOR))!, faceId('plate'), 'back');
    const guest = worldEdge(parts.get(partId(SIDE))!, places.get(partId(SIDE))!, faceId('plate'), 'front');
    // 50 mm back along the shared line from where it would otherwise sit.
    expect(distance3(guest.p0, host.p1)).toBeCloseTo(50, 6);
    expect(dot3(normalize3(sub3(guest.p0, host.p1)), host.dir)).toBeCloseTo(-1, 6);
  });

  it('lifts a lapped part off the face it lands on', () => {
    // A butt joint puts the two neutral surfaces on the same line. A lap puts
    // one sheet on the other, which is what a panel landing on a folded lip
    // does — and without the standoff both would occupy the same space and
    // nothing downstream would say so.
    const { assembly, parts } = twoPanels(0);
    const lapped: Assembly = {
      ...assembly,
      mates: [{ ...assembly.mates[0]!, standoffMm: 1.6 }],
    };
    const places = solveAssembly(lapped, parts);
    const host = worldEdge(parts.get(partId(FLOOR))!, places.get(partId(FLOOR))!, faceId('plate'), 'back');
    const guest = worldEdge(parts.get(partId(SIDE))!, places.get(partId(SIDE))!, faceId('plate'), 'front');

    // Still coplanar and still lined up along the seam, but a thickness proud
    // of the host's face rather than on it.
    expect(Math.abs(dot3(host.normal, guest.normal))).toBeCloseTo(1, 6);
    expect(dot3(sub3(guest.p0, host.p1), host.normal)).toBeCloseTo(1.6, 6);
    // ...and no sideways drift while doing it.
    const along = sub3(guest.p0, host.p1);
    expect(dot3(along, host.dir)).toBeCloseTo(0, 6);
    expect(dot3(along, host.inward)).toBeCloseTo(0, 6);
  });

  it('places a chain of parts, each onto the one before', () => {
    const floor = placed('Floor', 1200, 600);
    const side = placed('Side', 1200, 400);
    const roof = placed('Roof', 1200, 600);
    const assembly: Assembly = {
      rootPartId: partId('Floor'),
      mates: [
        {
          id: 'm1',
          part: partId('Side'),
          edge: { faceId: faceId('plate'), edgeName: 'front' },
          to: partId('Floor'),
          toEdge: { faceId: faceId('plate'), edgeName: 'back' },
          angleDeg: 90,
        },
        {
          id: 'm2',
          part: partId('Roof'),
          edge: { faceId: faceId('plate'), edgeName: 'front' },
          to: partId('Side'),
          toEdge: { faceId: faceId('plate'), edgeName: 'back' },
          angleDeg: 90,
        },
      ],
    };
    const parts = new Map([
      [partId('Floor'), floor],
      [partId('Side'), side],
      [partId('Roof'), roof],
    ]);
    const places = solveAssembly(assembly, parts);
    expect(places.size).toBe(3);

    // Two right angles from the floor puts the roof's plane parallel to it.
    const floorEdge = worldEdge(floor, places.get(partId('Floor'))!, faceId('plate'), 'back');
    const roofEdge = worldEdge(roof, places.get(partId('Roof'))!, faceId('plate'), 'front');
    expect(Math.abs(dot3(floorEdge.normal, roofEdge.normal))).toBeCloseTo(1, 6);
    // ...and 400 mm above it, which is the side's depth.
    const rise = Math.abs(dot3(sub3(roofEdge.p0, floorEdge.p0), floorEdge.normal));
    expect(rise).toBeCloseTo(400, 6);
  });
});

describe('checks', () => {
  const problems = (assembly: Assembly, parts: Map<ReturnType<typeof partId>, PlacedPart>): string[] =>
    checkAssembly(assembly, parts).map((p) => p.message);

  it('passes an assembly that hangs together', () => {
    const { assembly, parts } = twoPanels();
    expect(problems(assembly, parts)).toEqual([]);
  });

  it('refuses two edges of different lengths', () => {
    const floor = placed(FLOOR, 1200, 600);
    const side = placed(SIDE, 900, 400);
    const { assembly } = twoPanels();
    const parts = new Map([
      [partId(FLOOR), floor],
      [partId(SIDE), side],
    ]);
    expect(problems(assembly, parts).join()).toMatch(/do not meet along their whole length/);
  });

  it('refuses a part placed twice, because it has two answers for where it is', () => {
    const { assembly, parts } = twoPanels();
    const twice: Assembly = {
      ...assembly,
      mates: [assembly.mates[0]!, { ...assembly.mates[0]!, id: 'again' }],
    };
    expect(problems(twice, parts).join()).toMatch(/placed twice/);
  });

  it('refuses to place the root part', () => {
    const { assembly, parts } = twoPanels();
    const rooted: Assembly = {
      ...assembly,
      mates: [{ ...assembly.mates[0]!, part: partId(FLOOR), to: partId(SIDE) }],
    };
    expect(problems(rooted, parts).join()).toMatch(/is the root/);
  });

  it('refuses a negative standoff rather than burying one panel in another', () => {
    const { assembly, parts } = twoPanels();
    const bad: Assembly = {
      ...assembly,
      mates: [{ ...assembly.mates[0]!, standoffMm: -1 }],
    };
    expect(problems(bad, parts).join()).toMatch(/standoff cannot be negative/);
  });

  it('refuses a chain that loops instead of reaching the root', () => {
    const a = placed('A', 100, 100);
    const b = placed('B', 100, 100);
    const c = placed('C', 100, 100);
    const mate = (id: string, part: string, to: string): EdgeMate => ({
      id,
      part: partId(part),
      edge: { faceId: faceId('plate'), edgeName: 'front' },
      to: partId(to),
      toEdge: { faceId: faceId('plate'), edgeName: 'back' },
      angleDeg: 90,
    });
    const assembly: Assembly = {
      rootPartId: partId('A'),
      // B and C hold each other up and neither touches A.
      mates: [mate('m1', 'B', 'C'), mate('m2', 'C', 'B')],
    };
    const parts = new Map([
      [partId('A'), a],
      [partId('B'), b],
      [partId('C'), c],
    ]);
    expect(problems(assembly, parts).join()).toMatch(/not reachable from the root/);
  });

  it('says which part was never placed at all', () => {
    const { assembly, parts } = twoPanels();
    parts.set(partId('Orphan'), placed('Orphan', 100, 100));
    expect(problems(assembly, parts).join()).toMatch(/orphan is never placed/);
  });

  it('names a face or edge that does not exist', () => {
    const { assembly, parts } = twoPanels();
    const bad: Assembly = {
      ...assembly,
      mates: [{ ...assembly.mates[0]!, edge: { faceId: faceId('nosuch'), edgeName: 'front' } }],
    };
    expect(problems(bad, parts).join()).toMatch(/no face called nosuch/);
  });

  it('refuses to solve rather than placing a part somewhere wrong', () => {
    const { assembly, parts } = twoPanels();
    const bad: Assembly = { ...assembly, rootPartId: partId('Missing') };
    expect(() => solveAssembly(bad, parts)).toThrow(AssemblyError);
  });
});

function clamp(x: number): number {
  return Math.max(-1, Math.min(1, x));
}
