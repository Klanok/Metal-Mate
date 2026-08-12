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
import { type Feature } from '../src/features/types.js';
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

  it('puts a rivet line down every lip, evenly divided', () => {
    const doc = canopyDocument(CANOPY);
    const left = doc.parts.find((p) => p.parameters.partId === 'CAN-LEFT')!;
    const holes = left.features.filter((f) => f.kind === 'cutout');
    // Two lips, each with its own run of rivets.
    const top = holes.filter((h) => h.faceId === faceId('left-top-lip'));
    const bottom = holes.filter((h) => h.faceId === faceId('left-bottom-lip'));
    expect(top.length).toBeGreaterThan(2);
    expect(top.length).toEqual(bottom.length);

    const plate = LIP - SETBACK;
    const clear = CANOPY.rivet!.diameterMm * 2;
    // A circle is two vertices a diameter apart, so the centre is their mean.
    const xs = top.map((h) => (h.loop.verts[0]!.x + h.loop.verts[1]!.x) / 2);
    const ys = top.map((h) => h.loop.verts[0]!.y);

    // Down the middle of the flat: the only line with the same clearance to the
    // bend as to the free edge.
    for (const y of ys) expect(y).toBeCloseTo(plate / 2, 6);
    // Evenly spaced, at the target pitch or a little under — never over.
    const gaps = xs.slice(1).map((x, i) => x - xs[i]!);
    for (const gap of gaps) {
      expect(gap).toBeCloseTo(gaps[0]!, 6);
      expect(gap).toBeLessThanOrEqual(CANOPY.rivet!.pitchMm + 1e-9);
    }
    expect(gaps[0]).toBeGreaterThan(CANOPY.rivet!.pitchMm * 0.8);
    // Clear of the mitred ends, measured square to the rake rather than along
    // the lip — a 45 degree cut is further away than its x offset suggests.
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(plate / 2 + clear * Math.SQRT2 - 1e-9);
  });

  it('refuses a lip too shallow for the rivet going through it', () => {
    // 12 mm of lip leaves 8.4 mm of flat, and a 4.8 mm rivet wants 9.6 mm each
    // side of centre. Better to say so than to put holes in the radius.
    expect(() => canopyDocument({ ...CANOPY, lipMm: 12 })).toThrow(CanopyParameterError);
    expect(() => canopyDocument({ ...CANOPY, lipMm: 12 })).toThrow(
      /deepen the lip or use a smaller rivet/,
    );
    // A smaller rivet wants less lip: 3.2 mm needs 12.8 mm of flat where 4.8
    // needs 19.2, so an 18 mm lip carries one and not the other.
    expect(() =>
      canopyDocument({ ...CANOPY, lipMm: 18, rivet: { diameterMm: 3.2, pitchMm: 80 } }),
    ).not.toThrow();
    expect(() => canopyDocument({ ...CANOPY, lipMm: 18 })).toThrow(/deepen the lip/);
    // ...and no rivets at all is a plain folded lip.
    const { rivet: _rivet, ...noRivets } = CANOPY;
    const plain = canopyDocument({ ...noRivets, lipMm: 12 });
    expect(plain.parts.flatMap((p) => p.features).filter((f) => f.kind === 'cutout')).toEqual([]);
  });

  it('carries the rivet holes through to the flat pattern', () => {
    // The holes are on a folded face, not the base one, so they have to survive
    // the unfold to reach the laser at all.
    const built = buildDocument(canopyDocument(CANOPY).parts, {
      machine: { ...GENERIC_2500_40T, bedLengthMm: 3000 },
    });
    const wall = built.parts.find((p) => p.part.parameters.partId === 'CAN-LEFT')!;
    if (!wall.ok) throw new Error('the left wall did not build');
    const doc = canopyDocument(CANOPY);
    const wanted = doc.parts
      .find((p) => p.parameters.partId === 'CAN-LEFT')!
      .features.filter((f) => f.kind === 'cutout').length;
    expect(wall.result.flat.profile.inners).toHaveLength(wanted);
    // Round holes stay round: arcs out to the DXF, never a polygon.
    for (const inner of wall.result.flat.profile.inners) {
      expect(inner.verts.some((v) => v.bulge !== 0)).toBe(true);
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

describe('the seam inverted onto the roof', () => {
  const INVERTED: CanopyParams = { ...CANOPY, lipOn: 'roof' };
  const SIDES = ['front', 'rear', 'left', 'right'] as const;

  /** Every flange label a panel carries, by part number. */
  function flangesBy(params: CanopyParams): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const part of canopyDocument(params).parts) {
      out.set(
        part.parameters.partId!,
        part.features.filter((f) => f.kind === 'edge-flange').map((f) => f.label!),
      );
    }
    return out;
  }

  it('takes the lip off the walls and turns it down off the roof', () => {
    const walls = flangesBy({ ...CANOPY, floor: false });
    expect(walls.get('CAN-LEFT')).toEqual(['Left side top lip']);
    expect(walls.get('CAN-ROOF')).toEqual([]);

    const roof = flangesBy({ ...INVERTED, floor: false });
    // Nothing left on the wall to fold: the top corner is a bend on the roof.
    expect(roof.get('CAN-LEFT')).toEqual([]);
    expect(roof.get('CAN-ROOF')).toEqual([
      'Roof front return',
      'Roof rear return',
      'Roof left return',
      'Roof right return',
    ]);
  });

  it('keeps the wall lip that lands on the floor', () => {
    // Only the roof seam inverts. A canopy with a floor still stands its walls
    // on their own bottom lips, and inverting the top must not disturb that.
    const flanges = flangesBy(INVERTED);
    expect(flanges.get('CAN-LEFT')).toEqual(['Left side bottom lip']);
  });

  it('wraps each return down the outside of the wall it meets', () => {
    // The return lies against the wall's outer face, so the two sheets are face
    // to face: the return's neutral plane sits one full thickness *outboard* of
    // the wall's. Signed, not absolute — a sign error here would put the return
    // inside the box, which is a different canopy that still measures right.
    const params: CanopyParams = {
      ...INVERTED,
      roofDropMm: 150,
      taperDeg: { leftDeg: 7, rightDeg: 7 },
    };
    const planes = assembledPlanes(params);
    for (const wall of SIDES) {
      const ret = planes.get(`can-roof/roof-${wall}-lip`)!;
      const on = planes.get(`can-${wall}/${wall}`)!;
      // Parallel to the wall and facing the same way out of the box.
      expect(betweenDeg(ret, on), `${wall} return`).toBeCloseTo(0, 4);
      // ...one thickness proud of it. Same T*(0.5 - K) slack as the wall lips:
      // the arcs are drawn at R + K*T so the picture is optimistic by a tenth.
      const out = dot3(sub3(ret.origin, on.origin), on.normal);
      expect(out, `${wall} return standoff`).toBeGreaterThan(T - 0.25);
      expect(out, `${wall} return standoff`).toBeLessThan(T + 0.25);
    }
  });

  it('closes to exactly the same box as the seam it replaces', () => {
    // The inversion moves metal about at every top corner. If the reach past the
    // body corner is wrong the box closes to a different size, and this is what
    // says so — measured against the canopy it replaces rather than against a
    // second derivation of the same numbers.
    const spansOf = (params: CanopyParams): number[] => {
      const { parts, places } = placeAll(params);
      const points = [...parts.entries()].flatMap(([id, placed]) => {
        const name = [...placed.graph.faces.keys()][0]!;
        const face = placed.graph.faces.get(name)!;
        const edge = worldEdge(placed, places.get(id)!, name, [...face.edges.keys()][0]!);
        return [edge.p0, edge.p1];
      });
      const span = (pick: (p: { x: number; y: number; z: number }) => number): number => {
        const vs = points.map(pick);
        return Math.max(...vs) - Math.min(...vs);
      };
      return [span((p) => p.x), span((p) => p.y), span((p) => p.z)].sort((a, b) => a - b);
    };

    for (const floor of [true, false]) {
      const plain = spansOf({ ...CANOPY, floor });
      const inverted = spansOf({ ...INVERTED, floor });
      for (const [i, want] of plain.entries()) {
        expect(inverted[i], `floor=${floor}`).toBeCloseTo(want, 6);
      }
    }
    // ...and with a floor under it, that box is the outside box asked for, one
    // thickness down to the neutral surfaces. (Without a floor the walls run on
    // to the outside bottom instead, which is a different and already-tested
    // number — hence comparing like with like above.)
    const expected = [H - T, W - T, L - T].sort((a, b) => a - b);
    const got = spansOf(INVERTED);
    for (const [i, want] of expected.entries()) expect(got[i]).toBeCloseTo(want, 6);
  });

  it('moves the rivets off the top corner and onto the roof', () => {
    const holesOn = (params: CanopyParams, part: string): number =>
      canopyDocument(params)
        .parts.find((p) => p.parameters.partId === part)!
        .features.filter((f) => f.kind === 'cutout').length;

    const plain = { ...CANOPY, floor: false };
    const inverted = { ...INVERTED, floor: false };
    // Same seams, same rivet, same count — they have simply changed panel.
    expect(holesOn(plain, 'CAN-ROOF')).toBe(0);
    expect(holesOn(inverted, 'CAN-LEFT')).toBe(0);
    expect(holesOn(inverted, 'CAN-ROOF')).toBe(
      (['CAN-FRONT', 'CAN-REAR', 'CAN-LEFT', 'CAN-RIGHT'] as const).reduce(
        (n, p) => n + holesOn(plain, p),
        0,
      ),
    );
  });

  it('mitres the four returns into a closed frame', () => {
    // Two returns meet at every corner of one plate, so each is cut to half that
    // corner. On a square roof that is the familiar 45 at all eight ends.
    const roof = canopyDocument({ ...INVERTED, floor: false })
      .parts.find((p) => p.parameters.partId === 'CAN-ROOF')!;
    for (const f of roof.features) {
      if (f.kind !== 'edge-flange') continue;
      expect(f.mitreStartDeg, `${f.label!} start`).toBeCloseTo(45, 9);
      expect(f.mitreEndDeg, `${f.label!} end`).toBeCloseTo(45, 9);
    }
  });

  it('refuses a return too shallow for the bend that makes it', () => {
    // The same rule as a wall lip, and it has to survive the inversion: a lip
    // inside the setback has no flat left to fold.
    expect(() => canopyDocument({ ...INVERTED, lipMm: 2 })).toThrow(CanopyParameterError);
    expect(() => canopyDocument({ ...INVERTED, lipMm: 25 })).not.toThrow();
  });

  it('goes through the pipeline and out to DXF like any other canopy', () => {
    const built = buildDocument(canopyDocument({ ...INVERTED, floor: false }).parts, {
      machine: { ...GENERIC_2500_40T, bedLengthMm: 3000 },
    });
    expect(built.problems).toEqual([]);
    expect(built.exportAllowed).toBe(true);
    // Four bends on the roof now, none on the walls — the mirror of the default.
    const bends = built.parts.map((p) => (p.ok ? p.result.flat.bendLines.length : -1));
    expect(bends).toEqual([0, 0, 0, 0, 4]);
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

/**
 * Door openings and the doors that close them.
 *
 * The opening is a hole in the wall and the door is its own blank lapping over
 * it. What these tests care about is that the two agree: that the hole lands
 * inside the metal, that the door is big enough to cover it, and that the door
 * ends up in front of the hole rather than somewhere else on the wall.
 *
 * The placement test is the one that would catch a sign error in the mate. A
 * flipped `beyondMm` hangs the door under the canopy instead of over the
 * opening, and every other check here would still pass.
 *
 * Note that rivet holes are cutouts too, so anything counting openings has to
 * say which cutouts it means rather than counting them all.
 */
describe('canopy doors', () => {
  const WITH_DOOR: CanopyParams = { ...CANOPY, doors: [{ wall: 'left' }] };

  /** The door opening in a part, as distinct from its rivet holes. */
  const openingIn = (part: (typeof CANOPY_DOC.parts)[number]) =>
    part.features.filter(
      (f): f is Extract<Feature, { kind: 'cutout' }> =>
        f.kind === 'cutout' && (f.label?.endsWith('door opening') ?? false),
    );

  const partNamed = (doc: ReturnType<typeof canopyDocument>, id: string) =>
    doc.parts.find((p) => p.parameters.partId === id)!;

  const outerOf = (part: ReturnType<typeof partNamed>) =>
    part.features.find((f) => f.kind === 'base-flange')!.profile.outer.verts;

  const span = (vs: readonly { x: number; y: number }[]) => ({
    width: Math.max(...vs.map((v) => v.x)) - Math.min(...vs.map((v) => v.x)),
    height: Math.max(...vs.map((v) => v.y)) - Math.min(...vs.map((v) => v.y)),
  });

  it('makes no openings unless asked', () => {
    const doc = canopyDocument(CANOPY);
    expect(doc.parts.flatMap(openingIn)).toHaveLength(0);
    expect(doc.parts).toHaveLength(canopyPanels(CANOPY).length);
  });

  it('cuts an opening in the wall and adds the door as its own part', () => {
    const doc = canopyDocument(WITH_DOOR);
    expect(doc.parts).toHaveLength(canopyPanels(WITH_DOOR).length + 1);
    expect(openingIn(partNamed(doc, 'CAN-LEFT'))).toHaveLength(1);
    // The other three walls stay shut.
    expect(openingIn(partNamed(doc, 'CAN-RIGHT'))).toHaveLength(0);
    expect(openingIn(partNamed(doc, 'CAN-REAR'))).toHaveLength(0);

    const door = partNamed(doc, 'CAN-LEFT-DOOR');
    expect(door.features.filter((f) => f.kind === 'edge-flange')).toHaveLength(4);
  });

  it('sizes the opening by its margins and the door to lap over it', () => {
    const doc = canopyDocument(WITH_DOOR);
    const wall = span(outerOf(partNamed(doc, 'CAN-LEFT')));
    const opening = span(openingIn(partNamed(doc, 'CAN-LEFT'))[0]!.loop.verts);

    // Defaults: 70 mm jambs, 70 mm head and sill — the frame around a
    // full-width door, not a border with a window in it.
    expect(opening.width).toBeCloseTo(wall.width - 140, 5);
    expect(opening.height).toBeCloseTo(wall.height - 140, 5);

    // 20 mm lap all round, so the blank is 40 mm bigger than the hole each way.
    const door = span(outerOf(partNamed(doc, 'CAN-LEFT-DOOR')));
    expect(door.width).toBeCloseTo(opening.width + 40, 5);
    expect(door.height).toBeCloseTo(opening.height + 40, 5);
  });

  it('puts the door over its opening, one thickness proud of the wall', () => {
    const { parts, places } = placeAll(WITH_DOOR);
    const wallKey = partId('CAN-LEFT');
    const doorKey = partId('CAN-LEFT-DOOR');
    const wall = worldEdge(parts.get(wallKey)!, places.get(wallKey)!, faceId('left'), 'bottom');
    const door = worldEdge(parts.get(doorKey)!, places.get(doorKey)!, faceId('left-door'), 'bottom');

    const doorWidth = span(outerOf(partNamed(canopyDocument(WITH_DOOR), 'CAN-LEFT-DOOR'))).width;

    // One thickness out along the wall's own outward normal: the door lies on
    // the outside skin, not through it and not inside the canopy.
    for (const p of [door.p0, door.p1]) {
      expect(dot3(sub3(p, wall.p0), wall.normal)).toBeCloseTo(T, 4);
    }

    // Up the wall by the sill less the lap: the door's bottom edge sits 20 mm
    // below the top of the 70 mm sill. A flipped sign hangs it under the ute.
    for (const p of [door.p0, door.p1]) {
      expect(dot3(sub3(p, wall.p0), wall.inward)).toBeCloseTo(50, 4);
    }

    // Which way round the door's own edge runs is the mate's business. What
    // matters is that the blank spans its full width across the opening, and
    // that both ends land inside the wall rather than off the end of it.
    const along = [door.p0, door.p1].map((p) => dot3(sub3(p, wall.p0), wall.dir));
    expect(Math.abs(along[0]! - along[1]!)).toBeCloseTo(doorWidth, 3);
    const wallLength = Math.hypot(
      wall.p1.x - wall.p0.x,
      wall.p1.y - wall.p0.y,
      wall.p1.z - wall.p0.z,
    );
    for (const a of along) {
      expect(Math.abs(a)).toBeGreaterThan(0);
      expect(Math.abs(a)).toBeLessThanOrEqual(wallLength + 1e-6);
    }
  });

  it('follows a leaning wall instead of forcing a rectangle into it', () => {
    // This is the case that shipped broken. With the sides leaned in, the rear
    // wall is a trapezium; a rectangle inset from its bounding box pokes out
    // through the sloping edge, and the whole canopy failed to build.
    const leaning: CanopyParams = {
      ...CANOPY,
      taperDeg: { leftDeg: 5, rightDeg: 5 },
      doors: [{ wall: 'left' }, { wall: 'right' }, { wall: 'rear' }],
    };
    expect(() => canopyDocument(leaning)).not.toThrow();

    const rear = partNamed(canopyDocument(leaning), 'CAN-REAR');
    const wall = outerOf(rear);
    const opening = openingIn(rear)[0]!.loop.verts;

    // The wall narrows toward the top, and so does its opening: the margins are
    // true all the way round rather than true at the bottom and wrong at the top.
    const widthAt = (vs: readonly { x: number; y: number }[], high: boolean) => {
      const ys = vs.map((v) => v.y);
      const cut = (Math.min(...ys) + Math.max(...ys)) / 2;
      const half = vs.filter((v) => (high ? v.y > cut : v.y < cut));
      return Math.max(...half.map((v) => v.x)) - Math.min(...half.map((v) => v.x));
    };
    // Which end of the panel's own y axis is the top is the frame's business,
    // not this test's; what matters is that the opening tapers the same way the
    // wall does rather than staying square inside it.
    const wallTaper = widthAt(wall, true) - widthAt(wall, false);
    const openingTaper = widthAt(opening, true) - widthAt(opening, false);
    expect(Math.abs(wallTaper)).toBeGreaterThan(1);
    expect(Math.sign(openingTaper)).toBe(Math.sign(wallTaper));

    // And the opening stays inside the metal.
    const xs = wall.map((v) => v.x);
    const ys = wall.map((v) => v.y);
    for (const v of opening) {
      expect(v.x).toBeGreaterThan(Math.min(...xs));
      expect(v.x).toBeLessThan(Math.max(...xs));
      expect(v.y).toBeGreaterThan(Math.min(...ys));
      expect(v.y).toBeLessThan(Math.max(...ys));
    }
  });

  it('hangs a door on every leaning wall, still one thickness proud', () => {
    const leaning: CanopyParams = {
      ...CANOPY,
      taperDeg: { leftDeg: 5, rightDeg: 5 },
      doors: [{ wall: 'left' }, { wall: 'right' }, { wall: 'rear' }],
    };
    const { parts, places } = placeAll(leaning);
    for (const wall of ['left', 'right', 'rear'] as const) {
      const wk = partId(`CAN-${wall.toUpperCase()}`);
      const dk = partId(`CAN-${wall.toUpperCase()}-DOOR`);
      const w = worldEdge(parts.get(wk)!, places.get(wk)!, faceId(wall), 'bottom');
      const d = worldEdge(parts.get(dk)!, places.get(dk)!, faceId(`${wall}-door`), 'bottom');
      const gap = sub3(d.p0, w.p0);
      expect(dot3(gap, w.normal)).toBeCloseTo(T, 4);
      expect(dot3(gap, w.inward)).toBeCloseTo(50, 4);
    }
  });

  it('hinges on its top edge and swings up and out', () => {
    /** The middle of the door's free edge, relative to its wall's top edge. */
    const freeEdge = (openDeg: number) => {
      const params: CanopyParams = { ...CANOPY, doors: [{ wall: 'left', openDeg }] };
      const { parts, places } = placeAll(params);
      const wk = partId('CAN-LEFT');
      const dk = partId('CAN-LEFT-DOOR');
      const top = worldEdge(parts.get(wk)!, places.get(wk)!, faceId('left'), 'top');
      const free = worldEdge(parts.get(dk)!, places.get(dk)!, faceId('left-door'), 'bottom');
      const mid = {
        x: (free.p0.x + free.p1.x) / 2,
        y: (free.p0.y + free.p1.y) / 2,
        z: (free.p0.z + free.p1.z) / 2,
      };
      const g = sub3(mid, top.p0);
      return { out: dot3(g, top.normal), down: dot3(g, top.inward) };
    };

    // Shut: lying on the wall one thickness proud, hanging below the top edge.
    const shut = freeEdge(0);
    expect(shut.out).toBeCloseTo(T, 3);
    expect(shut.down).toBeGreaterThan(0);

    // Opening lifts the free edge and carries it outward, away from the load
    // space. A door that swings the other way opens into its own cargo.
    const part = freeEdge(30);
    const wide = freeEdge(70);
    expect(part.out).toBeGreaterThan(shut.out);
    expect(wide.out).toBeGreaterThan(part.out);
    expect(part.down).toBeLessThan(shut.down);
    expect(wide.down).toBeLessThan(part.down);
  });

  it('opening a door changes nothing that gets cut or folded', () => {
    // How far open the door is drawn is a view, not a dimension. If it reached
    // the blank or the bend table, the flat pattern would depend on how somebody
    // happened to leave a slider.
    const shut = canopyDocument({ ...CANOPY, doors: [{ wall: 'left', openDeg: 0 }] });
    const open = canopyDocument({ ...CANOPY, doors: [{ wall: 'left', openDeg: 62 }] });
    const blank = (d: ReturnType<typeof canopyDocument>) =>
      JSON.stringify(
        partNamed(d, 'CAN-LEFT-DOOR').features.map((f) =>
          f.kind === 'edge-flange' ? { ...f, id: String(f.id) } : f,
        ),
      );
    expect(blank(open)).toEqual(blank(shut));
    expect(JSON.stringify(outerOf(partNamed(open, 'CAN-LEFT')))).toEqual(
      JSON.stringify(outerOf(partNamed(shut, 'CAN-LEFT'))),
    );
  });

  it('sits centred along its wall, not slid off the end of it', () => {
    // The axis the other checks are blind to. How far the door stands off its
    // wall and how far up it sits are both unchanged by sliding it along the
    // wall, so a door displaced by the whole length of the canopy passed every
    // test in this file while being visibly adrift in the 3D view.
    const leaning: CanopyParams = {
      ...CANOPY,
      taperDeg: { leftDeg: 5, rightDeg: 5 },
      doors: [{ wall: 'left' }, { wall: 'right' }, { wall: 'rear' }],
    };
    const { parts, places } = placeAll(leaning);
    for (const wall of ['left', 'right', 'rear'] as const) {
      const wk = partId(`CAN-${wall.toUpperCase()}`);
      const dk = partId(`CAN-${wall.toUpperCase()}-DOOR`);
      const bottom = worldEdge(parts.get(wk)!, places.get(wk)!, faceId(wall), 'bottom');
      const hinge = worldEdge(parts.get(dk)!, places.get(dk)!, faceId(`${wall}-door`), 'top');
      const length = Math.hypot(
        bottom.p1.x - bottom.p0.x,
        bottom.p1.y - bottom.p0.y,
        bottom.p1.z - bottom.p0.z,
      );
      const [near, far] = [hinge.p0, hinge.p1]
        .map((p) => dot3(sub3(p, bottom.p0), bottom.dir))
        .sort((a, b) => a - b) as [number, number];

      // Inside the wall at both ends, and the same distance in at each — equal
      // jambs mean a centred door, whatever shape the wall is.
      expect(near).toBeGreaterThan(0);
      expect(far).toBeLessThan(length);
      expect(near).toBeCloseTo(length - far, 0);
    }
  });

  it('refuses margins that leave no opening', () => {
    expect(() => canopyDocument({ ...CANOPY, doors: [{ wall: 'rear', jambMm: 2000 }] })).toThrow(
      CanopyParameterError,
    );
  });

  it('refuses two doors in one wall', () => {
    expect(() =>
      canopyDocument({ ...CANOPY, doors: [{ wall: 'left' }, { wall: 'left', headMm: 80 }] }),
    ).toThrow(CanopyParameterError);
  });

  it('refuses a return that is inside its own bend', () => {
    expect(() => canopyDocument({ ...CANOPY, doors: [{ wall: 'left', returnMm: 1 }] })).toThrow(
      CanopyParameterError,
    );
  });

  it('builds and exports a canopy with doors on both sides and the rear', () => {
    const params: CanopyParams = {
      ...CANOPY,
      doors: [{ wall: 'left' }, { wall: 'right' }, { wall: 'rear' }],
    };
    const doc = canopyDocument(params);
    expect(doc.parts).toHaveLength(canopyPanels(params).length + 3);

    const built = buildDocument(doc.parts, { machine: GENERIC_2500_40T });
    expect(built.exportAllowed).toBe(true);
    expect(() => exportDocumentDxf(built)).not.toThrow();
  });
});

const CANOPY_DOC = canopyDocument(CANOPY);
