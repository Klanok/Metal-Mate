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
  solveAssembly,
  worldEdge,
} from '../src/model/assembly.js';
import { buildDocument, exportDocumentDxf, keyOf } from '../src/pipeline.js';
import {
  type CanopyParams,
  CANOPY_TEMPLATE_KIND,
  CanopyParameterError,
  DEFAULT_CANOPY,
  canopyDocument,
  canopyPanels,
} from '../src/templates/canopy.js';

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
    const doc = canopyDocument(CANOPY);
    const size = (partIdText: string): [number, number] => {
      const part = doc.parts.find((p) => p.parameters.partId === partIdText)!;
      const { graph } = regenerate(part);
      const verts = [...graph.faces.values()][0]!.profile.outer.verts;
      const xs = verts.map((v) => v.x);
      const ys = verts.map((v) => v.y);
      return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
    };
    // Butt-welded corners meet on the neutral surface, so each dimension loses
    // exactly one thickness — half from the panel at each end.
    expect(size('CAN-FLOOR')).toEqual([W - T, L - T]);
    expect(size('CAN-ROOF')).toEqual([W - T, L - T]);
    expect(size('CAN-FRONT')).toEqual([W - T, H - T]);
    expect(size('CAN-REAR')).toEqual([W - T, H - T]);
    expect(size('CAN-LEFT')).toEqual([L - T, H - T]);
    expect(size('CAN-RIGHT')).toEqual([L - T, H - T]);
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
    const doc = canopyDocument(CANOPY);
    const built = buildDocument(doc.parts, {
      machine: { ...GENERIC_2500_40T, bedLengthMm: 3000 },
    });
    const area =
      2 * (W - T) * (L - T) + 2 * (W - T) * (H - T) + 2 * (L - T) * (H - T);
    const expected = ((area * T) / 1e9) * findMaterial('ss304')!.densityKgM3;
    expect(built.totalMassKg).toBeCloseTo(expected, 6);
  });

  it('blocks export when a panel is longer than the brake bed', () => {
    // The 1800 mm floor will not fit a 1500 mm bed, and that has to stop the
    // whole document rather than just that panel.
    const doc = canopyDocument(CANOPY);
    const built = buildDocument(doc.parts, {
      machine: { ...GENERIC_2500_40T, bedLengthMm: 1500 },
    });
    expect(built.exportAllowed).toBe(true);
    // ...except a flat panel has no bends, so the bed length never applies.
    // That is worth knowing: a skeleton canopy asks nothing of the press brake.
    expect(built.parts.every((p) => p.ok && p.result.flat.bendLines.length === 0)).toBe(true);
  });
});
