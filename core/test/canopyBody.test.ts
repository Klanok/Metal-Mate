/**
 * The canopy body: eight corners, six planes, and every angle read off them.
 *
 * The square case is checked against the arithmetic the old rectangle template
 * did by hand, because that is the only independent answer available — if the
 * general code cannot reproduce "one thickness off each dimension" it is wrong
 * before any taper is considered.
 */

import { describe, expect, it } from 'vitest';
import { distance3 } from '../src/geometry/vec3.js';
import {
  type CanopyBodyParams,
  MAX_TAPER_DEG,
  canopyBody,
  corner,
  cornerKey,
  dihedralDeg,
  panelOutline,
  toPanel,
} from '../src/templates/canopyBody.js';

const T = 1.6;
const SQUARE: CanopyBodyParams = {
  lengthMm: 1800,
  widthMm: 1500,
  heightMm: 900,
  thicknessMm: T,
};

/** Edge length between two named corners, on the neutral surface. */
function span(params: CanopyBodyParams, a: Parameters<typeof corner>[1], b: Parameters<typeof corner>[1]): number {
  const body = canopyBody(params);
  return distance3(corner(body, a), corner(body, b));
}

describe('a square body', () => {
  it('is the neutral box: one thickness off every outside dimension', () => {
    // What the rectangle template computed as W - T, L - T, H - T, now falling
    // out of six planes rather than three subtractions.
    expect(span(SQUARE, 'front-left-bottom', 'front-right-bottom')).toBeCloseTo(1500 - T, 9);
    expect(span(SQUARE, 'front-left-bottom', 'rear-left-bottom')).toBeCloseTo(1800 - T, 9);
    expect(span(SQUARE, 'front-left-bottom', 'front-left-top')).toBeCloseTo(900 - T, 9);
  });

  it('keeps the outside skin on the dimensions that were asked for', () => {
    const body = canopyBody(SQUARE);
    const at = (k: Parameters<typeof corner>[1]) => body.outside.get(k)!;
    expect(distance3(at('front-left-bottom'), at('front-right-bottom'))).toBeCloseTo(1500, 9);
    expect(distance3(at('front-left-bottom'), at('rear-left-bottom'))).toBeCloseTo(1800, 9);
    expect(distance3(at('front-left-bottom'), at('front-left-top'))).toBeCloseTo(900, 9);
  });

  it('meets itself at right angles everywhere', () => {
    const body = canopyBody(SQUARE);
    for (const wall of ['front', 'rear', 'left', 'right'] as const) {
      expect(dihedralDeg(body, wall, 'floor')).toBeCloseTo(90, 9);
      expect(dihedralDeg(body, wall, 'roof')).toBeCloseTo(90, 9);
    }
    expect(dihedralDeg(body, 'left', 'front')).toBeCloseTo(90, 9);
  });
});

describe('a tapered body', () => {
  it('narrows the roof by the lean, and leaves the footprint alone', () => {
    // A wall leaning in 10 degrees over an 898.4 mm neutral rise pulls the top
    // in by that rise times tan(10).
    const body = canopyBody({ ...SQUARE, taperDeg: { leftDeg: 10 } });
    const bottom = corner(body, 'front-left-bottom');
    const top = corner(body, 'front-left-top');
    const rise = top.z - bottom.z;
    expect(top.x - bottom.x).toBeCloseTo(rise * Math.tan((10 * Math.PI) / 180), 6);
    // The other side has not moved, so the floor is still the footprint.
    expect(corner(body, 'front-right-bottom').x).toBeCloseTo(1500 - T / 2, 9);
  });

  it('turns the lean into the angle the metal actually folds through', () => {
    const body = canopyBody({ ...SQUARE, taperDeg: { leftDeg: 10 } });
    // Leaning the top inward closes the corner at the floor and opens the one
    // at the roof, the way a bucket does. That is the angle the press brake
    // folds, so getting the sense of it wrong would fold every lip backwards.
    expect(dihedralDeg(body, 'left', 'floor')).toBeCloseTo(80, 9);
    expect(dihedralDeg(body, 'left', 'roof')).toBeCloseTo(100, 9);
    // ...and leaves every seam it does not touch alone.
    expect(dihedralDeg(body, 'front', 'floor')).toBeCloseTo(90, 9);
  });

  it('drops the roof toward the rear without moving the front', () => {
    const body = canopyBody({ ...SQUARE, roofDropMm: 150 });
    const front = corner(body, 'front-left-top');
    const rear = corner(body, 'rear-left-top');
    // Measured on the outside skin, the front is the height asked for and the
    // rear is that less the drop.
    const outFront = body.outside.get('front-left-top')!;
    const outRear = body.outside.get('rear-left-top')!;
    expect(outFront.z).toBeCloseTo(900, 6);
    expect(outRear.z).toBeCloseTo(750, 6);
    expect(front.z).toBeGreaterThan(rear.z);
    // A sloping roof is no longer square to the walls.
    const slope = (Math.atan2(150, 1800) * 180) / Math.PI;
    expect(dihedralDeg(body, 'front', 'roof')).toBeCloseTo(90 - slope, 6);
    expect(dihedralDeg(body, 'rear', 'roof')).toBeCloseTo(90 + slope, 6);
  });

  it('refuses a taper that folds the body over', () => {
    expect(() => canopyBody({ ...SQUARE, taperDeg: { leftDeg: 80 } })).toThrow(/stops being a wall/);
    expect(() => canopyBody({ ...SQUARE, taperDeg: { leftDeg: MAX_TAPER_DEG + 0.1 } })).toThrow();
    // 45 degrees of lean over a 900 mm wall closes the roof to nothing.
    expect(() =>
      canopyBody({ ...SQUARE, widthMm: 400, taperDeg: { leftDeg: 40, rightDeg: 40 } }),
    ).toThrow(/closed the body over|does not stand up/);
  });

  it('refuses a roof drop that reaches the floor', () => {
    expect(() => canopyBody({ ...SQUARE, roofDropMm: 900 })).toThrow(/nothing standing at the rear/);
    expect(() => canopyBody({ ...SQUARE, roofDropMm: -1 })).toThrow(/cannot be negative/);
  });
});

describe('panel outlines', () => {
  it('names each edge for the corner pair it joins', () => {
    const body = canopyBody(SQUARE);
    expect([...panelOutline(body, 'floor').edges.keys()].sort()).toEqual([
      'front',
      'left',
      'rear',
      'right',
    ]);
    // A side wall runs front to rear, so its ends are named for the ends of the
    // canopy rather than for some local left and right.
    expect([...panelOutline(body, 'left').edges.keys()].sort()).toEqual([
      'bottom',
      'front',
      'rear',
      'top',
    ]);
    expect([...panelOutline(body, 'front').edges.keys()].sort()).toEqual([
      'bottom',
      'left',
      'right',
      'top',
    ]);
  });

  it('winds counter-clockwise seen from outside, however the body leans', () => {
    for (const params of [
      SQUARE,
      { ...SQUARE, roofDropMm: 200, taperDeg: { leftDeg: 8, rightDeg: 12, frontDeg: 5 } },
    ]) {
      const body = canopyBody(params);
      for (const panel of ['floor', 'roof', 'front', 'rear', 'left', 'right'] as const) {
        const { loop } = panelOutline(body, panel);
        let twice = 0;
        for (let i = 0; i < loop.length; i += 1) {
          const a = loop[i]!.at;
          const b = loop[(i + 1) % loop.length]!.at;
          twice += a.x * b.y - b.x * a.y;
        }
        // Positive signed area is counter-clockwise, which is what every
        // downstream profile and flange assumes.
        expect(twice, `${panel} winds the wrong way`).toBeGreaterThan(0);
      }
    }
  });

  it('agrees with itself across a seam: one edge, one length', () => {
    // The floor's left edge and the left wall's bottom edge are the same two
    // corners. If they ever disagreed, the mate would be placing a panel
    // against an edge of a different length and the box would not close.
    const body = canopyBody({ ...SQUARE, roofDropMm: 120, taperDeg: { leftDeg: 7 } });
    const floor = panelOutline(body, 'floor');
    const wall = panelOutline(body, 'left');
    expect(new Set(floor.edges.get('left')!)).toEqual(new Set(wall.edges.get('bottom')!));

    const lengthOf = (o: typeof floor, name: string): number => {
      const [a, b] = o.edges.get(name)!;
      return distance3(corner(body, a), corner(body, b));
    };
    expect(lengthOf(floor, 'left')).toBeCloseTo(lengthOf(wall, 'bottom'), 9);
  });

  it('lays every panel flat on its own plane', () => {
    // Projecting into the panel frame must lose nothing: if a corner did not
    // lie on the plane, the panel would not be a flat sheet.
    const body = canopyBody({ ...SQUARE, roofDropMm: 200, taperDeg: { leftDeg: 9, rearDeg: 6 } });
    for (const panel of ['floor', 'roof', 'front', 'rear', 'left', 'right'] as const) {
      const { frame, loop } = panelOutline(body, panel);
      for (const { key } of loop) {
        const p = corner(body, key);
        const flat = toPanel(frame, p);
        const back = {
          x: frame.origin.x + frame.xAxis.x * flat.x + frame.yAxis.x * flat.y,
          y: frame.origin.y + frame.xAxis.y * flat.x + frame.yAxis.y * flat.y,
          z: frame.origin.z + frame.xAxis.z * flat.x + frame.yAxis.z * flat.y,
        };
        expect(distance3(p, back), `${panel} corner ${key} is off its own plane`).toBeCloseTo(0, 9);
      }
    }
  });
});
