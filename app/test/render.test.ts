/**
 * The pure half of the UI: turning core output into things a renderer can draw.
 * Both modules are deliberately free of React and Three.js so they can be
 * tested here rather than only by looking at the screen.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_BENCHTOP,
  GENERIC_2500_40T,
  NO_EDGE,
  benchtopPart,
  build,
  circle,
  initBooleans,
  roundedRect,
  faceId,
} from '@metal-mate/core';
import type { BenchtopParams, BuildResult } from '@metal-mate/core';
import { flatPatternView, loopToPath } from '../src/render/flatSvg.js';
import { bendPieces, facePieces, partExtent } from '../src/render/solid.js';

const PARAMS: BenchtopParams = {
  ...DEFAULT_BENCHTOP,
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
  ],
};

let result: BuildResult;

beforeAll(async () => {
  await initBooleans();
  result = build(benchtopPart(PARAMS), { machine: GENERIC_2500_40T, foldFraction: 1 });
});

describe('flat pattern SVG', () => {
  it('writes straight segments as line commands', () => {
    const d = loopToPath({
      verts: [
        { x: 0, y: 0, bulge: 0 },
        { x: 10, y: 0, bulge: 0 },
        { x: 10, y: 5, bulge: 0 },
        { x: 0, y: 5, bulge: 0 },
      ],
    });
    expect(d).toBe('M 0 0 L 10 0 L 10 5 L 0 5 Z');
  });

  it('writes arcs as arc commands, never as polylines', () => {
    const d = loopToPath(roundedRect(0, 0, 100, 60, 8));
    const arcs = d.match(/A /g) ?? [];
    expect(arcs).toHaveLength(4);
    expect(d).toContain('A 8 8 0 0 1');
  });

  it('marks a semicircle as a positive sweep and not a large arc', () => {
    const d = loopToPath(circle(0, 0, 5));
    // Two 180 degree arcs: sweep 1 (counter-clockwise), large-arc 0.
    expect(d.match(/A 5 5 0 0 1/g)).toHaveLength(2);
  });

  it('flips the arc sweep flag for a clockwise loop', () => {
    // Inner loops come back clockwise, so their arcs must sweep the other way.
    const sink = result.flat.profile.inners[0]!;
    const d = loopToPath(sink);
    expect(d).toContain('A ');
    expect(d).toContain(' 0 0 ');
  });

  it('derives a view box that contains the blank plus a margin', () => {
    const view = flatPatternView(result.flat);
    expect(view.widthMm).toBeCloseTo(1800, 3);
    expect(view.box.x).toBeCloseTo(0, 6);
    expect(view.innerPaths).toHaveLength(1);
  });

  it('labels every bend with its angle, direction and radius', () => {
    const view = flatPatternView(result.flat);
    expect(view.bendLines).toHaveLength(2);
    expect(view.bendLines.map((b) => b.direction).sort()).toEqual(['down', 'up']);
    for (const line of view.bendLines) {
      expect(line.label).toMatch(/^90° (up|down) R1\.2$/);
      expect(Math.hypot(line.x2 - line.x1, line.y2 - line.y1)).toBeCloseTo(1800, 3);
    }
  });
});

describe('folded solid', () => {
  it('emits one piece per face, carrying its cutouts', () => {
    const pieces = facePieces(result.graph, result.folded!);
    expect(pieces.map((p) => p.faceId).sort()).toEqual(['frontDrop', 'splashback', 'top']);
    const top = pieces.find((p) => p.faceId === 'top')!;
    expect(top.holes).toHaveLength(1);
    // The sink corners are linearised for triangulation only.
    expect(top.holes[0]!.length).toBeGreaterThan(8);
  });

  it('places the base face at the origin with an unrotated frame', () => {
    const top = facePieces(result.graph, result.folded!).find((p) => p.faceId === 'top')!;
    const m = top.matrix;
    expect(m.slice(0, 3)).toEqual([1, 0, 0]);
    expect(m.slice(4, 7)).toEqual([0, 1, 0]);
    // Pushed back half a thickness so the extrusion straddles the surface.
    expect(m[14]).toBeCloseTo(-0.6, 9);
  });

  it('produces a closed slab for each bend', () => {
    const pieces = bendPieces(result.folded!);
    expect(pieces).toHaveLength(2);
    for (const piece of pieces) {
      expect(piece.positions.length % 3).toBe(0);
      expect(piece.indices.length % 3).toBe(0);
      // Every index must address a real vertex.
      const vertexCount = piece.positions.length / 3;
      for (const i of piece.indices) expect(i).toBeLessThan(vertexCount);
    }
  });

  it('gives the bend slab the material thickness across its section', () => {
    const bend = result.folded!.bends[0]!;
    const piece = bendPieces(result.folded!).find((p) => p.bendId === String(bend.bendId))!;
    // Ring 0 is [outer@end0, outer@end1, inner@end1, inner@end0]; the first and
    // last are the same station on opposite faces of the sheet.
    const p = (i: number): [number, number, number] => [
      piece.positions[i * 3]!,
      piece.positions[i * 3 + 1]!,
      piece.positions[i * 3 + 2]!,
    ];
    const [ax, ay, az] = p(0);
    const [dx, dy, dz] = p(3);
    expect(Math.hypot(ax - dx, ay - dy, az - dz)).toBeCloseTo(1.2, 6);
  });

  it('draws nothing for a bend that is not yet folded', () => {
    const flatResult = build(benchtopPart(PARAMS), {
      machine: GENERIC_2500_40T,
      foldFraction: 0,
    });
    expect(bendPieces(flatResult.folded!)).toHaveLength(0);
  });

  it('measures an extent big enough to frame the whole part', () => {
    const extent = partExtent(result.graph, result.folded!);
    // The part is 1800 long, so the bounding sphere is at least half that.
    expect(extent.radius).toBeGreaterThan(900);
    expect(extent.centre.x).toBeCloseTo(900, 0);
  });

  it('keeps the folded splashback above the top face', () => {
    const pieces = facePieces(result.graph, result.folded!);
    const splash = pieces.find((p) => p.faceId === faceId('splashback'))!;
    // Column 3 of the matrix is the frame origin.
    expect(splash.matrix[14]!).toBeGreaterThan(0);
  });
});
