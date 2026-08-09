import { describe, expect, it } from 'vitest';
import {
  angleForBulge,
  arcGeometry,
  bounds,
  bulgeForAngle,
  circle,
  isCCW,
  linearise,
  perimeter,
  polygon,
  rect,
  reverse,
  roundedRect,
  signedArea,
} from '../src/geometry/loop.js';
import { profile, profileArea, profileCutLength } from '../src/geometry/profile.js';
import {
  IDENTITY,
  applyLoop,
  compose,
  fromSegmentToSegment,
  isMirrored,
  mirrorX,
  rotation,
  translation,
} from '../src/geometry/transform.js';
import { isDirectedEdgeOfLoop } from '../src/model/graph.js';

describe('loops', () => {
  it('gives a counter-clockwise rectangle a positive area', () => {
    const r = rect(0, 0, 30, 20);
    expect(signedArea(r)).toBeCloseTo(600, 12);
    expect(isCCW(r)).toBe(true);
  });

  it('reverses a loop without changing the shape it encloses', () => {
    const r = roundedRect(0, 0, 40, 30, 5);
    const back = reverse(r);
    expect(signedArea(back)).toBeCloseTo(-signedArea(r), 9);
    expect(perimeter(back)).toBeCloseTo(perimeter(r), 9);
    expect(signedArea(reverse(back))).toBeCloseTo(signedArea(r), 9);
  });

  it('measures a circle built from two semicircular arcs', () => {
    const c = circle(10, -5, 4);
    expect(signedArea(c)).toBeCloseTo(Math.PI * 16, 9);
    expect(perimeter(c)).toBeCloseTo(2 * Math.PI * 4, 9);
    const box = bounds(c);
    expect(box.min).toEqual({ x: 6, y: -9 });
    expect(box.max).toEqual({ x: 14, y: -1 });
  });

  it('measures a rounded rectangle exactly', () => {
    const w = 400;
    const h = 300;
    const r = 12;
    const l = roundedRect(0, 0, w, h, r);
    // A rounded rectangle is the rectangle minus the four corner offcuts.
    const expected = w * h - (4 - Math.PI) * r * r;
    expect(signedArea(l)).toBeCloseTo(expected, 9);
    expect(perimeter(l)).toBeCloseTo(2 * (w - 2 * r) + 2 * (h - 2 * r) + 2 * Math.PI * r, 9);
  });

  it('includes arc bulge in the bounding box, not just the vertices', () => {
    // A single 180 degree arc bowing well past both of its endpoints.
    const l = { verts: [{ x: 0, y: 0, bulge: 1 }, { x: 10, y: 0, bulge: 0 }] };
    const box = bounds(l);
    expect(box.min.y).toBeCloseTo(-5, 9);
    expect(box.max.y).toBeCloseTo(0, 9);
  });

  it('round-trips bulge and included angle', () => {
    for (const deg of [10, 45, 90, 179]) {
      const theta = (deg * Math.PI) / 180;
      expect(angleForBulge(bulgeForAngle(theta))).toBeCloseTo(theta, 12);
    }
  });

  it('resolves arc geometry with the DXF sign convention', () => {
    // Positive bulge = counter-clockwise, so this arc bows below the chord.
    const arc = arcGeometry({ x: 0, y: 0 }, { x: 1, y: 0 }, Math.tan(Math.PI / 8));
    expect(arc).not.toBeNull();
    expect(arc!.center.x).toBeCloseTo(0.5, 12);
    expect(arc!.center.y).toBeCloseTo(0.5, 12);
    expect(arc!.theta).toBeCloseTo(Math.PI / 2, 12);
  });

  it('linearises within the chord tolerance', () => {
    const c = circle(0, 0, 50);
    const pts = linearise(c, 0.002);
    for (const p of pts) {
      expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(50 + 1e-9);
      expect(Math.hypot(p.x, p.y)).toBeGreaterThan(50 - 0.002 - 1e-9);
    }
  });
});

describe('profiles', () => {
  it('normalises orientation: outer CCW, inner CW', () => {
    const p = profile(reverse(rect(0, 0, 100, 100)), [rect(10, 10, 20, 20)]);
    expect(isCCW(p.outer)).toBe(true);
    expect(isCCW(p.inners[0]!)).toBe(false);
  });

  it('subtracts holes from the material area but adds their cut length', () => {
    const p = profile(rect(0, 0, 100, 100), [circle(50, 50, 10)]);
    expect(profileArea(p)).toBeCloseTo(10_000 - Math.PI * 100, 9);
    expect(profileCutLength(p)).toBeCloseTo(400 + 2 * Math.PI * 10, 9);
  });
});

describe('transforms', () => {
  it('maps one directed segment onto another as a rigid motion', () => {
    const t = fromSegmentToSegment(
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 5 },
      { x: 5, y: 15 },
    );
    expect(isMirrored(t)).toBe(false);
    const moved = applyLoop(t, rect(0, 0, 10, 4));
    expect(signedArea(moved)).toBeCloseTo(40, 9);
  });

  it('refuses to map segments of different lengths', () => {
    expect(() =>
      fromSegmentToSegment({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, { x: 20, y: 0 }),
    ).toThrow(/length mismatch/);
  });

  it('flips arc sense under a mirror and leaves it alone otherwise', () => {
    const c = circle(0, 0, 5);
    expect(applyLoop(mirrorX(), c).verts[0]!.bulge).toBeCloseTo(-1, 12);
    expect(applyLoop(rotation(0.7), c).verts[0]!.bulge).toBeCloseTo(1, 12);
  });

  it('composes second-after-first', () => {
    const t = compose(translation(10, 0), rotation(Math.PI / 2));
    const moved = applyLoop(t, polygon([{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }]));
    expect(moved.verts[0]!.x).toBeCloseTo(10, 9);
    expect(moved.verts[0]!.y).toBeCloseTo(1, 9);
    expect(compose(IDENTITY, t)).toEqual(t);
  });
});

describe('directed boundary edges', () => {
  const r = rect(0, 0, 100, 50);

  it('accepts an edge running the same way as the loop', () => {
    expect(isDirectedEdgeOfLoop(r, { p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 } })).toBe(true);
  });

  it('accepts a sub-segment of a boundary edge, which is how insets work', () => {
    expect(isDirectedEdgeOfLoop(r, { p0: { x: 20, y: 0 }, p1: { x: 80, y: 0 } })).toBe(true);
  });

  it('rejects the same edge running backwards', () => {
    expect(isDirectedEdgeOfLoop(r, { p0: { x: 100, y: 0 }, p1: { x: 0, y: 0 } })).toBe(false);
  });

  it('rejects an edge that is not on the boundary', () => {
    expect(isDirectedEdgeOfLoop(r, { p0: { x: 0, y: 10 }, p1: { x: 100, y: 10 } })).toBe(false);
  });
});
