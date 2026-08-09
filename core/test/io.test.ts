import { describe, expect, it } from 'vitest';
import { perimeter, signedArea } from '../src/geometry/loop.js';
import {
  DxfParseError,
  loopsFromEntities,
  parseDxf,
} from '../src/io/dxfReader.js';
import {
  ProjectFormatError,
  SCHEMA_VERSION,
  deserializeProject,
  serializeProject,
} from '../src/io/projectFile.js';
import { DEFAULT_BENCHTOP, benchtopPart } from '../src/templates/benchtop.js';

describe('DXF import healing', () => {
  /** A 100 x 50 rectangle drawn as four separate LINE entities, out of order. */
  const looseLines = `0
SECTION
2
ENTITIES
0
LINE
8
0
10
0.0
20
50.0
30
0.0
11
0.0
21
0.0
31
0.0
0
LINE
8
0
10
100.0
20
0.0
30
0.0
11
100.0
21
50.0
31
0.0
0
LINE
8
0
10
0.0
20
0.0
30
0.0
11
100.0
21
0.0
31
0.0
0
LINE
8
0
10
100.0
20
50.0
30
0.0
11
0.0
21
50.0
31
0.0
0
ENDSEC
0
EOF
`;

  it('chains loose lines into one closed loop', () => {
    const doc = parseDxf(looseLines);
    expect(doc.entities).toHaveLength(4);
    const { loops, openChains } = loopsFromEntities(doc.entities);
    expect(openChains).toBe(0);
    expect(loops).toHaveLength(1);
    expect(Math.abs(signedArea(loops[0]!))).toBeCloseTo(5000, 6);
    expect(perimeter(loops[0]!)).toBeCloseTo(300, 6);
  });

  it('joins endpoints that are close but not coincident', () => {
    // Nudge one corner by 5 microns, as a hand-drawn detail would be.
    const sloppy = looseLines.replace('10\n100.0\n20\n0.0\n30\n0.0\n11\n100.0', '10\n100.005\n20\n0.0\n30\n0.0\n11\n100.0');
    const { loops, openChains } = loopsFromEntities(parseDxf(sloppy).entities, 0.01);
    expect(openChains).toBe(0);
    expect(loops).toHaveLength(1);
  });

  it('reports a chain that does not close rather than inventing an edge', () => {
    const gapped = looseLines.replace(
      '0\nLINE\n8\n0\n10\n100.0\n20\n50.0\n30\n0.0\n11\n0.0\n21\n50.0\n31\n0.0\n',
      '',
    );
    const { loops, openChains } = loopsFromEntities(parseDxf(gapped).entities);
    expect(loops).toHaveLength(0);
    expect(openChains).toBe(1);
  });

  it('converts a CIRCLE into a two-arc loop', () => {
    const dxf = `0
SECTION
2
ENTITIES
0
CIRCLE
8
0
10
10.0
20
20.0
30
0.0
40
5.0
0
ENDSEC
0
EOF
`;
    const { loops } = loopsFromEntities(parseDxf(dxf).entities);
    expect(loops).toHaveLength(1);
    expect(Math.abs(signedArea(loops[0]!))).toBeCloseTo(Math.PI * 25, 9);
  });

  it('rejects a file whose tags do not pair up', () => {
    expect(() => parseDxf('0\nSECTION\n2\n')).toThrow(DxfParseError);
  });
});

describe('project files', () => {
  it('round-trips a part through JSON', () => {
    const part = benchtopPart(DEFAULT_BENCHTOP);
    const text = serializeProject({ parts: [part] });
    const doc = deserializeProject(text);
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(doc.parts).toHaveLength(1);
    expect(doc.parts[0]).toEqual(part);
  });

  it('keeps template parameters so the wizard can regenerate', () => {
    const doc = deserializeProject(serializeProject({ parts: [benchtopPart(DEFAULT_BENCHTOP)] }));
    expect(doc.parts[0]!.template).toEqual({ kind: 'benchtop', params: DEFAULT_BENCHTOP });
  });

  it('refuses a file written by a newer schema', () => {
    const text = JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, parts: [] });
    expect(() => deserializeProject(text)).toThrow(/newer version/);
  });

  it('rejects malformed input', () => {
    expect(() => deserializeProject('not json')).toThrow(ProjectFormatError);
    expect(() => deserializeProject('{}')).toThrow(/schemaVersion/);
    expect(() => deserializeProject(JSON.stringify({ schemaVersion: 1 }))).toThrow(/parts/);
  });
});
