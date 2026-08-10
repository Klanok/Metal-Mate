/**
 * DXF export tests.
 *
 * Everything the writer produces is checked by parsing it back with the
 * independent reader in `io/dxfReader.ts`, so the format is verified by a
 * second reading rather than by the writer agreeing with itself. The golden
 * files in `fixtures/` catch unintended changes to the byte output.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { initBooleans } from '../src/geometry/boolean.js';
import { perimeter, signedArea } from '../src/geometry/loop.js';
import { GENERIC_2500_40T } from '../src/machine/machineProfile.js';
import { build, exportDxf } from '../src/pipeline.js';
import {
  type DxfPolyline,
  entitiesOnLayer,
  loopsFromEntities,
  parseDxf,
  tokenize,
} from '../src/io/dxfReader.js';
import { CUT_ONLY_EXPORT_PROFILE, DEFAULT_EXPORT_PROFILE } from '../src/io/exportProfile.js';
import {
  NO_EDGE,
  type BenchtopParams,
  DEFAULT_BENCHTOP,
  benchtopPart,
} from '../src/templates/benchtop.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
/** Set UPDATE_GOLDEN=1 to re-approve golden files after an intended change. */
const UPDATE_GOLDEN = process.env['UPDATE_GOLDEN'] === '1';

const MVP: BenchtopParams = {
  ...DEFAULT_BENCHTOP,
  name: 'MVP benchtop',
  partId: 'BT-001',
  revision: 'A',
  lengthMm: 1800,
  depthMm: 600,
  thicknessMm: 1.2,
  bendRadiusMm: 1.2,
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
    { kind: 'hole', id: 'tap1', fromLeftMm: 620, fromFrontMm: 500, diameterMm: 35 },
  ],
};

let dxf: string;

beforeAll(async () => {
  await initBooleans();
  const result = build(benchtopPart(MVP), { machine: GENERIC_2500_40T });
  dxf = exportDxf(result, { dateStamp: '2026-08-09' });
});

describe('DXF R12 structure', () => {
  it('is a well-formed tag stream ending in EOF', () => {
    const tags = tokenize(dxf);
    expect(tags.length % 1).toBe(0);
    expect(tags[tags.length - 1]).toEqual({ code: 0, value: 'EOF' });
  });

  it('declares R12 and millimetres', () => {
    const doc = parseDxf(dxf);
    expect(doc.headerVariables.get('$ACADVER')).toBe('AC1009');
    expect(doc.headerVariables.get('$INSUNITS')).toBe('4');
  });

  it('defines every layer the entities use', () => {
    const doc = parseDxf(dxf);
    const declared = new Set(doc.layers.map((l) => l.name));
    for (const e of doc.entities) expect(declared).toContain(e.layer);
    expect(declared).toContain('CUT_OUTER');
    expect(declared).toContain('CUT_INNER');
  });

  it('writes exactly one closed outer profile', () => {
    const doc = parseDxf(dxf);
    const outers = entitiesOnLayer(doc, 'CUT_OUTER').filter(
      (e): e is DxfPolyline => e.type === 'POLYLINE',
    );
    expect(outers).toHaveLength(1);
    expect(outers[0]!.closed).toBe(true);
  });

  it('writes cutouts on the inner layer', () => {
    const doc = parseDxf(dxf);
    const inners = entitiesOnLayer(doc, 'CUT_INNER').filter(
      (e): e is DxfPolyline => e.type === 'POLYLINE',
    );
    expect(inners).toHaveLength(2);
    for (const inner of inners) expect(inner.closed).toBe(true);
  });

  it('puts bend lines on direction-specific layers', () => {
    const doc = parseDxf(dxf);
    expect(entitiesOnLayer(doc, 'BEND_DOWN').filter((e) => e.type === 'LINE')).toHaveLength(1);
    expect(entitiesOnLayer(doc, 'BEND_UP').filter((e) => e.type === 'LINE')).toHaveLength(1);
  });

  it('etches the part id and a grain arrow', () => {
    const doc = parseDxf(dxf);
    const etch = entitiesOnLayer(doc, 'ETCH');
    expect(etch.filter((e) => e.type === 'TEXT').map((e) => (e as { text: string }).text)).toContain(
      'BT-001',
    );
    // Shaft plus two arrowhead strokes.
    expect(etch.filter((e) => e.type === 'LINE')).toHaveLength(3);
  });

  it('notes material, thickness and grain on the INFO layer', () => {
    const doc = parseDxf(dxf);
    const texts = entitiesOnLayer(doc, 'INFO')
      .filter((e) => e.type === 'TEXT')
      .map((e) => (e as { text: string }).text);
    expect(texts.some((t) => t.includes('ss304') && t.includes('1.2'))).toBe(true);
    expect(texts).toContain('GRAIN LENGTH');
    expect(texts).toContain('DATE 2026-08-09');
    expect(texts.filter((t) => t.startsWith('BEND '))).toHaveLength(2);
  });

  it('omits bend lines, etch and notes under the cut-only profile', () => {
    const result = build(benchtopPart(MVP), { machine: GENERIC_2500_40T });
    const doc = parseDxf(exportDxf(result, { exportProfile: CUT_ONLY_EXPORT_PROFILE }));
    expect(doc.entities.every((e) => e.layer === 'CUT_OUTER' || e.layer === 'CUT_INNER')).toBe(true);
  });
});

describe('arcs survive as bulges', () => {
  it('never linearises the sink corner radii', () => {
    const doc = parseDxf(dxf);
    const inners = entitiesOnLayer(doc, 'CUT_INNER').filter(
      (e): e is DxfPolyline => e.type === 'POLYLINE',
    );
    const sink = inners.find((p) => p.vertices.length === 8);
    expect(sink).toBeDefined();
    expect(sink!.vertices.filter((v) => Math.abs(v.bulge) > 1e-9)).toHaveLength(4);
  });

  it('writes the tap hole as two semicircular arcs', () => {
    const doc = parseDxf(dxf);
    const inners = entitiesOnLayer(doc, 'CUT_INNER').filter(
      (e): e is DxfPolyline => e.type === 'POLYLINE',
    );
    const hole = inners.find((p) => p.vertices.length === 2);
    expect(hole).toBeDefined();
    for (const v of hole!.vertices) expect(Math.abs(v.bulge)).toBeCloseTo(1, 6);
  });
});

describe('geometry round-trips through the file', () => {
  it('reproduces the blank outline and its cut length', () => {
    const source = build(benchtopPart(MVP), { machine: GENERIC_2500_40T });
    const doc = parseDxf(dxf);
    const { loops, openChains } = loopsFromEntities(
      [...entitiesOnLayer(doc, 'CUT_OUTER'), ...entitiesOnLayer(doc, 'CUT_INNER')],
    );
    expect(openChains).toBe(0);
    expect(loops).toHaveLength(3);

    // Coordinates are written to the export profile's 4 decimal places, so the
    // recovered area differs from the source by about perimeter x 1e-4 mm^2.
    const outer = loops.reduce((a, b) => (Math.abs(signedArea(a)) > Math.abs(signedArea(b)) ? a : b));
    const sourceArea = Math.abs(signedArea(source.flat.profile.outer));
    expect(Math.abs(Math.abs(signedArea(outer)) - sourceArea)).toBeLessThan(1);
    const totalCut = loops.reduce((sum, l) => sum + perimeter(l), 0);
    expect(totalCut).toBeCloseTo(source.flat.cutLengthMm, 2);
  });

  it('keeps outer counter-clockwise and inners clockwise', () => {
    const doc = parseDxf(dxf);
    const outer = entitiesOnLayer(doc, 'CUT_OUTER').filter(
      (e): e is DxfPolyline => e.type === 'POLYLINE',
    )[0]!;
    expect(signedArea({ verts: outer.vertices })).toBeGreaterThan(0);
    for (const inner of entitiesOnLayer(doc, 'CUT_INNER').filter(
      (e): e is DxfPolyline => e.type === 'POLYLINE',
    )) {
      expect(signedArea({ verts: inner.vertices })).toBeLessThan(0);
    }
  });

  it('places the blank with its lower-left corner on the origin', () => {
    const doc = parseDxf(dxf);
    const outer = entitiesOnLayer(doc, 'CUT_OUTER').filter(
      (e): e is DxfPolyline => e.type === 'POLYLINE',
    )[0]!;
    expect(Math.min(...outer.vertices.map((v) => v.x))).toBeCloseTo(0, 3);
    expect(Math.min(...outer.vertices.map((v) => v.y))).toBeCloseTo(0, 3);
  });

  it('has no duplicated or zero-length segments', () => {
    const doc = parseDxf(dxf);
    for (const p of doc.entities.filter((e): e is DxfPolyline => e.type === 'POLYLINE')) {
      for (let i = 0; i < p.vertices.length; i++) {
        const a = p.vertices[i]!;
        const b = p.vertices[(i + 1) % p.vertices.length]!;
        expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(1e-6);
      }
    }
  });
});

describe('golden files', () => {
  const cases: { name: string; params: BenchtopParams }[] = [
    { name: 'benchtop-plain', params: { ...MVP, cutouts: [] } },
    { name: 'benchtop-sink-splashback', params: MVP },
    {
      name: 'benchtop-boxed-edge',
      params: {
        ...MVP,
        cutouts: [],
        edges: {
          ...MVP.edges,
          front: { style: 'boxed', heightMm: 40, returnMm: 25, upstandMm: 15 },
        },
      },
    },
    {
      // All four sides folded, so the outer profile carries the corner relief
      // notches. Those are what stop the two bends at a corner tearing the
      // metal, and they have to reach the laser exactly as cut.
      name: 'benchtop-all-round',
      params: {
        ...MVP,
        cutouts: [],
        edges: {
          front: { style: 'square-drop', heightMm: 40 },
          back: { style: 'upstand', heightMm: 100 },
          left: { style: 'square-drop', heightMm: 40 },
          right: { style: 'square-drop', heightMm: 40 },
        },
      },
    },
    {
      // Four fold-down edges with a return under each, so every corner closes
      // and every return carries a 45 degree mitre. This is the case where a
      // wrong cut shows up as metal that will not fold together on the bench.
      name: 'benchtop-mitred-returns',
      params: {
        ...MVP,
        cutouts: [],
        edges: {
          front: { style: 'drop-and-return', heightMm: 40, returnMm: 25 },
          back: { style: 'drop-and-return', heightMm: 40, returnMm: 25 },
          left: { style: 'drop-and-return', heightMm: 40, returnMm: 25 },
          right: { style: 'drop-and-return', heightMm: 40, returnMm: 25 },
        },
      },
    },
  ];

  for (const { name, params } of cases) {
    it(`matches ${name}.dxf`, () => {
      const result = build(benchtopPart(params), { machine: GENERIC_2500_40T });
      const actual = exportDxf(result, {
        dateStamp: '2026-08-09',
        exportProfile: DEFAULT_EXPORT_PROFILE,
      });
      const path = join(FIXTURES, `${name}.dxf`);
      if (UPDATE_GOLDEN || !existsSync(path)) {
        mkdirSync(FIXTURES, { recursive: true });
        writeFileSync(path, actual);
      }
      const expected = readFileSync(path, 'utf8');
      if (actual !== expected) {
        writeFileSync(join(FIXTURES, `${name}.actual.dxf`), actual);
      }
      expect(actual).toBe(expected);
    });
  }

  it('keeps golden files free of carriage returns', () => {
    // The writer emits LF. If git ever rewrites a golden file to CRLF — which
    // is what a Windows checkout does by default without the .gitattributes
    // rule — every byte comparison above fails for a reason that has nothing
    // to do with the geometry. Checking here says so directly.
    for (const { name } of cases) {
      const path = join(FIXTURES, `${name}.dxf`);
      if (!existsSync(path)) continue;
      expect(readFileSync(path, 'utf8')).not.toContain('\r');
    }
  });
});
