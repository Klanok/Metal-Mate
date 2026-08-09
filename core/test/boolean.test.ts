import { beforeAll, describe, expect, it } from 'vitest';
import { type Boolean2D, initBooleans } from '../src/geometry/boolean.js';
import { circle, rect, roundedRect, signedArea, isCCW, perimeter } from '../src/geometry/loop.js';
import { profile, profileArea, profileBounds } from '../src/geometry/profile.js';

let ops: Boolean2D;

beforeAll(async () => {
  ops = await initBooleans();
});

describe('boolean kernel', () => {
  it('unions two abutting rectangles into one', () => {
    const a = profile(rect(0, 0, 100, 100));
    const b = profile(rect(100, 0, 100, 100));
    const result = ops.union([a, b]);
    expect(result).toHaveLength(1);
    expect(profileArea(result[0]!)).toBeCloseTo(20_000, 6);
    const box = profileBounds(result[0]!);
    expect(box.min).toEqual({ x: 0, y: 0 });
    expect(box.max).toEqual({ x: 200, y: 100 });
  });

  it('unions overlapping rectangles', () => {
    const a = profile(rect(0, 0, 100, 100));
    const b = profile(rect(50, 50, 100, 100));
    const result = ops.union([a, b]);
    expect(result).toHaveLength(1);
    expect(profileArea(result[0]!)).toBeCloseTo(17_500, 4);
  });

  it('keeps a rectangle disjoint from a far-away rectangle', () => {
    const result = ops.union([profile(rect(0, 0, 10, 10)), profile(rect(100, 0, 10, 10))]);
    expect(result).toHaveLength(2);
  });

  it('subtracts a hole and reports it as an inner loop', () => {
    const plate = profile(rect(0, 0, 100, 100));
    const hole = profile(rect(40, 40, 20, 20));
    const result = ops.difference([plate], [hole]);
    expect(result).toHaveLength(1);
    expect(result[0]!.inners).toHaveLength(1);
    expect(isCCW(result[0]!.outer)).toBe(true);
    expect(isCCW(result[0]!.inners[0]!)).toBe(false);
    expect(profileArea(result[0]!)).toBeCloseTo(10_000 - 400, 4);
  });

  it('preserves a full circle through a difference (arc re-fitting)', () => {
    const plate = profile(rect(0, 0, 100, 100));
    const hole = profile(circle(50, 50, 10));
    const result = ops.difference([plate], [hole]);
    expect(result).toHaveLength(1);
    const inner = result[0]!.inners[0]!;
    // Two semicircular arcs survive as two bulge vertices, not a polyline.
    expect(inner.verts.length).toBeLessThanOrEqual(4);
    expect(inner.verts.some((v) => Math.abs(v.bulge) > 0.1)).toBe(true);
    expect(Math.abs(signedArea(inner))).toBeCloseTo(Math.PI * 100, 2);
    expect(perimeter(inner)).toBeCloseTo(2 * Math.PI * 10, 2);
  });

  it('preserves rounded-rectangle corners through a union', () => {
    const sink = profile(roundedRect(0, 0, 400, 300, 12));
    const strip = profile(rect(0, 300, 400, 50));
    const result = ops.union([sink, strip]);
    expect(result).toHaveLength(1);
    const arcs = result[0]!.outer.verts.filter((v) => Math.abs(v.bulge) > 1e-9);
    // The two bottom corners are untouched by the union and must stay arcs.
    expect(arcs.length).toBeGreaterThanOrEqual(2);
  });

  it('reports the intersection area of overlapping regions', () => {
    const a = profile(rect(0, 0, 100, 100));
    const b = profile(rect(90, 0, 100, 100));
    expect(ops.intersectionArea([a], [b])).toBeCloseTo(1000, 4);
    expect(ops.intersectionArea([a], [profile(rect(200, 0, 10, 10))])).toBeCloseTo(0, 6);
  });

  it('nests an island inside a hole as a separate profile', () => {
    const outerPlate = profile(rect(0, 0, 100, 100));
    const bigHole = profile(rect(20, 20, 60, 60));
    const island = profile(rect(40, 40, 20, 20));
    const withHole = ops.difference([outerPlate], [bigHole]);
    const result = ops.union([...withHole, island]);
    expect(result).toHaveLength(2);
    expect(profileArea(result[0]!)).toBeCloseTo(10_000 - 3600, 4);
    expect(profileArea(result[1]!)).toBeCloseTo(400, 4);
  });
});
