/**
 * The canopy skeleton.
 *
 * This template exists to test the architecture as much as to make a canopy:
 * the doc calls the second template pack "the real test that the template
 * architecture holds". So these tests care about two things — that the panels
 * are the right metal, and that the box actually closes up in space.
 *
 * The box test is the one that would catch a wrong rotation: six flat panels
 * mated at right angles either enclose the outside dimensions asked for, or
 * they fold through each other and nothing says so.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { initBooleans } from '../src/geometry/boolean.js';
import { dot3, sub3 } from '../src/geometry/vec3.js';
import { faceId, partId } from '../src/ids.js';
import { regenerate } from '../src/features/regen.js';
import { GENERIC_2500_40T } from '../src/machine/machineProfile.js';
import { type Frame3, fold } from '../src/unfold/fold.js';
import { STAINLESS_304, findMaterial } from '../src/materials/material.js';
import {
  type PlacedPart,
  checkAssembly,
  placeFoldedPart,
  solveAssembly,
  worldEdge,
} from '../src/model/assembly.js';
import { buildDocument, exportDocumentDxf, keyOf } from '../src/pipeline.js';
import {
  type CanopyParams,
  CANOPY_TEMPLATE_KIND,
  CanopyParameterError,
  DEFAULT_CANOPY,
  canopyBodyFor,
  canopyDocument,
  canopyMeasures,
  canopyPanels,
} from '../src/templates/canopy.js';
import { dihedralDeg } from '../src/templates/canopyBody.js';

const T = 1.6;
const L = 1800;
const W = 1500;
const H = 900;

const CANOPY: CanopyParams = {
  ...DEFAULT_CANOPY,
  lengthMm: L,
  widthMm: W,
  heightMm: H,
  thicknessMm: T,
  materialId: 'ss304',
};

const LIP = DEFAULT_CANOPY.lipMm!;
/** What the bend itself takes out of the outside corner, at 90 degrees. */
const SETBACK = DEFAULT_CANOPY.bendRadiusMm + T;
/** ...plus the half thickness that lifts the deck's neutral surface clear. */
const LIP_RISE = T / 2 + SETBACK;

/** The four walls and the box dimension each runs along. */
const WALLS = [
  ['CAN-FRONT', W - T],
  ['CAN-REAR', W - T],
  ['CAN-LEFT', L - T],
  ['CAN-RIGHT', L - T],
] as const;

/** The flat plate one panel is cut from, before any lip is folded off it. */
function plateSize(params: CanopyParams, partIdText: string): [number, number] {
  const part = canopyDocument(params).parts.find((p) => p.parameters.partId === partIdText)!;
  const { graph } = regenerate(part);
  const verts = graph.faces.get(faceId(partIdText.slice('CAN-'.length).toLowerCase()))!.profile
    .outer.verts;
  const xs = verts.map((v) => v.x);
  const ys = verts.map((v) => v.y);
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
}

function expectSize(got: readonly [number, number], want: readonly [number, number]): void {
  expect(got[0]).toBeCloseTo(want[0], 9);
  expect(got[1]).toBeCloseTo(want[1], 9);
}

/** Solve the assembly for a set of parameters. */
function placeAll(params: CanopyParams): {
  parts: Map<ReturnType<typeof partId>, PlacedPart>;
  places: Map<ReturnType<typeof partId>, Frame3>;
} {
  const doc = canopyDocument(params);
  const parts = new Map<ReturnType<typeof partId>, PlacedPart>();
  for (const part of doc.parts) {
    const { graph } = regenerate(part);
    parts.set(keyOf(part), {
      partId: keyOf(part),
      graph,
      folded: fold(graph, { material: STAINLESS_304, fraction: 1 }),
    });
  }
  return { parts, places: solveAssembly(doc.assembly, parts) };
}

/**
 * Every face of every panel, as a plane in assembly space.
 *
 * A seam is only closed if the two panels either side of it end up at the angle
 * the body says, and a lip only carries a deck if it ends up parallel to it one
 * thickness away. Both are questions about planes, and neither depends on
 * knowing where the assembly happens to have put the whole thing.
 */
function assembledPlanes(params: CanopyParams): Map<string, Frame3> {
  const { parts, places } = placeAll(params);
  const out = new Map<string, Frame3>();
  for (const [id, placed] of parts) {
    const at = places.get(id)!;
    for (const face of placeFoldedPart(placed.folded, at).faces) {
      out.set(`${String(id)}/${String(face.faceId)}`, face.frame);
    }
  }
  return out;
}

/** Angle between two planes' outward normals, degrees. */
function betweenDeg(a: Frame3, b: Frame3): number {
  const c = Math.max(-1, Math.min(1, dot3(a.normal, b.normal)));
  return (Math.acos(c) * 180) / Math.PI;
}

beforeAll(async () => {
  await initBooleans();
});

describe('the parts it makes', () => {
  it('makes six panels, each its own part with its own number', () => {
    const doc = canopyDocument(CANOPY);
    expect(doc.parts).toHaveLength(6);
    expect(doc.parts.map((p) => p.parameters.partId)).toEqual([
      'CAN-FLOOR',
      'CAN-FRONT',
      'CAN-REAR',
      'CAN-LEFT',
      'CAN-RIGHT',
      'CAN-ROOF',
    ]);
    expect(canopyPanels(CANOPY)).toHaveLength(6);
  });

  it('leaves the floor out when the canopy sits on the tray', () => {
    const doc = canopyDocument({ ...CANOPY, floor: false });
    expect(doc.parts).toHaveLength(5);
    expect(doc.parts.map((p) => p.parameters.partId)).not.toContain('CAN-FLOOR');
    // With no floor, the roof is what everything hangs off.
    expect(doc.assembly.rootPartId).toBe(partId('CAN-ROOF'));
  });

  it('cuts every panel to the neutral-surface box, not the outside box', () => {
    // Corners meet on the neutral surface, so each plan dimension loses exactly
    // one thickness — half from the panel at each end.
    expectSize(plateSize(CANOPY, 'CAN-FLOOR'), [W - T, L - T]);
    expectSize(plateSize(CANOPY, 'CAN-ROOF'), [W - T, L - T]);
    // A wall with no lips spans the box the same way.
    const plain = { ...CANOPY, lipMm: 0 };
    for (const [id, across] of WALLS) {
      expectSize(plateSize(plain, id), [across, H - T]);
    }
  });

  it('takes a lip rise out of the wall at each end that carries one', () => {
    // What the lips take off the wall is exactly what the mates hand back, so
    // the box still closes on the outside height it was asked for — that is
    // checked below. Here: the plate really is shorter, by the setback the bend
    // takes plus the half thickness that lifts the deck clear of the lip.
    for (const [id, across] of WALLS) {
      expectSize(plateSize(CANOPY, id), [across, H - T - 2 * LIP_RISE]);
      // No floor means no bottom lip, and a wall that runs to the tray: only
      // the roof's own half thickness comes off the top.
      expectSize(plateSize({ ...CANOPY, floor: false }, id), [across, H - T / 2 - LIP_RISE]);
    }
  });

  it('folds each lip inward and mitres both its ends', () => {
    const doc = canopyDocument(CANOPY);
    const left = doc.parts.find((p) => p.parameters.partId === 'CAN-LEFT')!;
    const lips = left.features.filter((f) => f.kind === 'edge-flange');
    expect(lips.map((f) => f.id)).toEqual([faceId('left-top-lip'), faceId('left-bottom-lip')]);
    for (const lip of lips) {
      if (lip.kind !== 'edge-flange') throw new Error('not a flange');
      // Outside depth, so the bend's own setback comes out of the flat.
      expect(lip.lengthMm).toBeCloseTo(LIP - SETBACK, 9);
      expect(lip.angleDeg).toBe(90);
      // Two walls' lips meet at each vertical corner at a right angle, so each
      // end is raked back 45 degrees and the picture frame closes.
      expect(lip.mitreStartDeg).toBe(45);
      expect(lip.mitreEndDeg).toBe(45);
    }
  });

  it('records the template on every panel, so the wizard stays live', () => {
    for (const part of canopyDocument(CANOPY).parts) {
      expect(part.template?.kind).toBe(CANOPY_TEMPLATE_KIND);
      expect(part.template?.params).toEqual(CANOPY);
    }
  });

  it('rejects a canopy too small to survive its own thickness', () => {
    expect(() => canopyDocument({ ...CANOPY, widthMm: 1 })).toThrow(CanopyParameterError);
    expect(() => canopyDocument({ ...CANOPY, thicknessMm: 0 })).toThrow(/thickness/);
  });
});

describe('the box it makes', () => {
  it('hangs together as a placement tree', () => {
    const doc = canopyDocument(CANOPY);
    const { parts } = placeAll(CANOPY);
    expect(checkAssembly(doc.assembly, parts)).toEqual([]);
    // Six panels, five mates: a tree, exactly like the face-bend graph.
    expect(doc.assembly.mates).toHaveLength(5);
  });

  it('stands all four walls square to the floor', () => {
    const { parts, places } = placeAll(CANOPY);
    const floor = parts.get(partId('CAN-FLOOR'))!;
    const floorUp = worldEdge(floor, places.get(partId('CAN-FLOOR'))!, faceId('floor'), 'front')
      .normal;
    for (const [name, panel] of [
      ['CAN-FRONT', 'front'],
      ['CAN-REAR', 'rear'],
      ['CAN-LEFT', 'left'],
      ['CAN-RIGHT', 'right'],
    ] as const) {
      const wall = parts.get(partId(name))!;
      const wallNormal = worldEdge(wall, places.get(partId(name))!, faceId(panel), 'bottom').normal;
      // A wall standing on the floor is perpendicular to it.
      expect(Math.abs(dot3(floorUp, wallNormal))).toBeCloseTo(0, 6);
    }
  });

  it('puts the roof parallel to the floor and the right height above it', () => {
    const { parts, places } = placeAll(CANOPY);
    const floorEdge = worldEdge(
      parts.get(partId('CAN-FLOOR'))!,
      places.get(partId('CAN-FLOOR'))!,
      faceId('floor'),
      'front',
    );
    const roofEdge = worldEdge(
      parts.get(partId('CAN-ROOF'))!,
      places.get(partId('CAN-ROOF'))!,
      faceId('roof'),
      'front',
    );
    expect(Math.abs(dot3(floorEdge.normal, roofEdge.normal))).toBeCloseTo(1, 6);
    // Neutral surface to neutral surface, so one thickness under the outside.
    const rise = Math.abs(dot3(sub3(roofEdge.p0, floorEdge.p0), floorEdge.normal));
    expect(rise).toBeCloseTo(H - T, 6);
  });

  it('lays the roof on the lip rather than butting it against the wall', () => {
    const { parts, places } = placeAll(CANOPY);
    const wall = worldEdge(
      parts.get(partId('CAN-LEFT'))!,
      places.get(partId('CAN-LEFT'))!,
      faceId('left'),
      'top',
    );
    const roof = worldEdge(
      parts.get(partId('CAN-ROOF'))!,
      places.get(partId('CAN-ROOF'))!,
      faceId('roof'),
      'left',
    );
    const offset = sub3(roof.p0, wall.p1);
    // Up the wall, past the edge the lip is folded off, by exactly the rise the
    // wall's own plate gave up for it. A butt joint would put this at zero.
    expect(dot3(offset, wall.inward)).toBeCloseTo(-LIP_RISE, 6);
    // ...and squarely, with no drift off the wall's plane.
    expect(dot3(offset, wall.normal)).toBeCloseTo(0, 6);
    expect(Math.abs(dot3(wall.normal, roof.normal))).toBeCloseTo(0, 6);
  });

  it('stands every wall at the angle the tapered body asks for', () => {
    // The one test that would catch a wrong mate angle on a tapered body. Six
    // flat panels either meet at the angles the body states, or they fold
    // through each other and nothing else says so.
    const params: CanopyParams = {
      ...CANOPY,
      roofDropMm: 200,
      taperDeg: { leftDeg: 8, rightDeg: 5, frontDeg: 3, rearDeg: 2 },
    };
    const body = canopyBodyFor(params);
    const planes = assembledPlanes(params);
    const face = (panel: string): Frame3 => planes.get(`can-${panel}/${panel}`)!;

    for (const wall of ['front', 'rear', 'left', 'right'] as const) {
      for (const deck of ['floor', 'roof'] as const) {
        // Both normals face out of the body, so the angle between them is the
        // supplement of the interior angle the body carries.
        expect(betweenDeg(face(wall), face(deck)), `${wall} to ${deck}`).toBeCloseTo(
          180 - dihedralDeg(body, wall, deck),
          5,
        );
      }
    }
    // Opposite walls leaning by different amounts are not parallel, and that
    // has to survive the assembly rather than being averaged away.
    expect(betweenDeg(face('left'), face('right'))).toBeCloseTo(180 - 8 - 5, 5);
  });

  it('lands each deck on its lips, one thickness off the metal', () => {
    const params: CanopyParams = {
      ...CANOPY,
      roofDropMm: 150,
      taperDeg: { leftDeg: 7, rightDeg: 7 },
    };
    const planes = assembledPlanes(params);
    for (const wall of ['front', 'rear', 'left', 'right'] as const) {
      for (const [edge, deck] of [
        ['top', 'roof'],
        ['bottom', 'floor'],
      ] as const) {
        const lip = planes.get(`can-${wall}/${wall}-${edge}-lip`)!;
        const on = planes.get(`can-${deck}/${deck}`)!;
        // A lip that carries a deck is parallel to it, and facing the same way:
        // the lip's outer face is the one the deck lands on, so its normal
        // points at the deck exactly as the deck's own points away from the box.
        expect(betweenDeg(lip, on), `${wall} ${edge} lip`).toBeCloseTo(0, 4);
        // ...and one thickness away, which is the two sheets in contact.
        //
        // Not exactly: bend arcs are drawn at R + K*T so that flat and folded
        // never need reconciling, and that puts the lip T*(0.5 - K) shy of
        // where the metal really lands — about a tenth of a millimetre here,
        // more as the corner opens. The cut part is right; the picture is
        // optimistic by that much, and the tolerance says so rather than
        // pretending the model is exact.
        const gap = Math.abs(dot3(sub3(lip.origin, on.origin), on.normal));
        expect(gap, `${wall} ${edge} lip standoff`).toBeGreaterThan(T - 0.25);
        expect(gap, `${wall} ${edge} lip standoff`).toBeLessThan(T + 0.25);
      }
    }
  });

  it('says what a tapered canopy actually measures', () => {
    // "1800 x 1500 x 900" stops describing the whole canopy the moment it
    // tapers: it is the footprint and the front. These are the numbers somebody
    // would put a tape on to check the thing that turns up.
    const square = canopyMeasures(CANOPY);
    expect(square.roofWidthFrontMm).toBeCloseTo(W, 6);
    expect(square.roofWidthRearMm).toBeCloseTo(W, 6);
    expect(square.rearHeightMm).toBeCloseTo(H, 6);

    const tapered = canopyMeasures({
      ...CANOPY,
      roofDropMm: 150,
      taperDeg: { leftDeg: 10, rightDeg: 10 },
    });
    // Both sides in 10 degrees over the rise takes twice that off the roof.
    expect(tapered.roofWidthFrontMm).toBeCloseTo(W - 2 * H * Math.tan((10 * Math.PI) / 180), 0);
    // The rear roof is lower, so its walls have leaned in for less of a rise
    // and it is wider than the front.
    expect(tapered.roofWidthRearMm).toBeGreaterThan(tapered.roofWidthFrontMm);
    expect(tapered.rearHeightMm).toBeCloseTo(H - 150, 6);
  });

  it('encloses the outside dimensions it was asked for', () => {
    // Every panel corner, in assembly space. Six panels mated at right angles
    // either bound a box of the size asked for or they fold through each other,
    // and nothing else in the pipeline would say which.
    const { parts, places } = placeAll(CANOPY);
    const points = [...parts.entries()].flatMap(([id, placed]) => {
      const face = [...placed.graph.faces.values()][0]!;
      const name = [...placed.graph.faces.keys()][0]!;
      const edge = worldEdge(placed, places.get(id)!, name, [...face.edges.keys()][0]!);
      return [edge.p0, edge.p1];
    });
    const span = (pick: (p: { x: number; y: number; z: number }) => number): number => {
      const vs = points.map(pick);
      return Math.max(...vs) - Math.min(...vs);
    };
    // The neutral-surface box is one thickness smaller than the outside in
    // every direction; the three spans are its three dimensions in some order.
    const spans = [span((p) => p.x), span((p) => p.y), span((p) => p.z)].sort((a, b) => a - b);
    const expected = [H - T, W - T, L - T].sort((a, b) => a - b);
    for (const [i, want] of expected.entries()) expect(spans[i]).toBeCloseTo(want, 6);
  });
});

describe('through the rest of the pipeline', () => {
  it('builds, validates and exports as an ordinary document', () => {
    const doc = canopyDocument(CANOPY);
    const built = buildDocument(doc.parts, {
      machine: { ...GENERIC_2500_40T, bedLengthMm: 3000 },
    });
    expect(built.parts.every((p) => p.ok)).toBe(true);
    expect(built.problems).toEqual([]);
    expect(built.exportAllowed).toBe(true);

    const files = exportDocumentDxf(built, { dateStamp: '2026-08-10' });
    expect(files.map((f) => f.fileName)).toEqual([
      'can-floor.dxf',
      'can-front.dxf',
      'can-rear.dxf',
      'can-left.dxf',
      'can-right.dxf',
      'can-roof.dxf',
    ]);
  });

  it('reports a mass that matches the metal in six flat panels', () => {
    // Arithmetic worth checking has to be arithmetic done independently, so
    // this is the lipless canopy: six rectangles and nothing else. The lipped
    // one is checked against it below rather than against a second derivation
    // of the same bend allowances.
    const plain = { ...CANOPY, lipMm: 0 };
    const built = buildDocument(canopyDocument(plain).parts, {
      machine: { ...GENERIC_2500_40T, bedLengthMm: 3000 },
    });
    const area =
      2 * (W - T) * (L - T) + 2 * (W - T) * (H - T) + 2 * (L - T) * (H - T);
    const expected = ((area * T) / 1e9) * findMaterial('ss304')!.densityKgM3;
    expect(built.totalMassKg).toBeCloseTo(expected, 6);
  });

  it('costs metal for the lips, and bends to put them there', () => {
    const machine = { ...GENERIC_2500_40T, bedLengthMm: 3000 };
    const plain = buildDocument(canopyDocument({ ...CANOPY, lipMm: 0 }).parts, { machine });
    const lipped = buildDocument(canopyDocument(CANOPY).parts, { machine });
    expect(lipped.totalMassKg).toBeGreaterThan(plain.totalMassKg);
    // Four walls, two lips each, and the decks stay flat.
    const bends = lipped.parts.map((p) => (p.ok ? p.result.flat.bendLines.length : -1));
    expect(bends).toEqual([0, 2, 2, 2, 2, 0]);
  });

  it('blocks export when a lip is longer than the brake bed', () => {
    // The side walls' lips run the full 1800 mm length and will not go in a
    // 1500 mm brake. One panel that cannot be made stops the whole document —
    // there is no use cutting five of the six.
    const doc = canopyDocument(CANOPY);
    const built = buildDocument(doc.parts, {
      machine: { ...GENERIC_2500_40T, bedLengthMm: 1500 },
    });
    expect(built.exportAllowed).toBe(false);
    // The floor and roof are still flat, so it is the walls that are stopping
    // it, and only the ones long enough to.
    const blocked = built.parts.filter((p) => !p.ok || !p.result.report.exportAllowed);
    expect(blocked.map((p) => p.part.parameters.partId)).toEqual(['CAN-LEFT', 'CAN-RIGHT']);
    // ...and with a bed that fits them, the same canopy goes out.
    const wide = buildDocument(doc.parts, {
      machine: { ...GENERIC_2500_40T, bedLengthMm: 3000 },
    });
    expect(wide.exportAllowed).toBe(true);
  });
});
