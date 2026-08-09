/**
 * 2D affine transforms restricted to rigid motions and mirrors.
 *
 * Sheet metal is never scaled: a flat pattern is the same size as the material
 * it is cut from. Restricting the transform group to rotate / translate /
 * mirror means arcs stay arcs and a bulge only ever needs its sign flipped.
 */

import { TOL } from '../units.js';
import { type Loop, type Vertex } from './loop.js';
import { type Vec2, distance, normalize, sub } from './vec2.js';

/** Maps (x, y) to (a*x + c*y + e, b*x + d*y + f). */
export interface Xform2 {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export const IDENTITY: Xform2 = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function translation(dx: number, dy: number): Xform2 {
  return { a: 1, b: 0, c: 0, d: 1, e: dx, f: dy };
}

export function rotation(radians: number): Xform2 {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

/** Mirror about the x axis. Reverses orientation. */
export function mirrorX(): Xform2 {
  return { a: 1, b: 0, c: 0, d: -1, e: 0, f: 0 };
}

export function determinant(t: Xform2): number {
  return t.a * t.d - t.b * t.c;
}

export function isMirrored(t: Xform2): boolean {
  return determinant(t) < 0;
}

/** `second` applied after `first`. */
export function compose(second: Xform2, first: Xform2): Xform2 {
  return {
    a: second.a * first.a + second.c * first.b,
    b: second.b * first.a + second.d * first.b,
    c: second.a * first.c + second.c * first.d,
    d: second.b * first.c + second.d * first.d,
    e: second.a * first.e + second.c * first.f + second.e,
    f: second.b * first.e + second.d * first.f + second.f,
  };
}

export function apply(t: Xform2, p: Vec2): Vec2 {
  return { x: t.a * p.x + t.c * p.y + t.e, y: t.b * p.x + t.d * p.y + t.f };
}

export function applyVertex(t: Xform2, v: Vertex): Vertex {
  const p = apply(t, { x: v.x, y: v.y });
  // A mirror reverses the sense of every arc; a rigid motion leaves it alone.
  return { x: p.x, y: p.y, bulge: isMirrored(t) ? -v.bulge : v.bulge };
}

export function applyLoop(t: Xform2, l: Loop): Loop {
  return { verts: l.verts.map((v) => applyVertex(t, v)) };
}

/**
 * The unique rigid transform (no mirror) taking directed segment p0->p1 onto
 * directed segment q0->q1. The two segments must be the same length.
 *
 * This is how the unfold engine places one face relative to its neighbour:
 * both faces know where their shared bend line is in their own frame, and
 * placement is exactly "put my bend line there".
 */
export function fromSegmentToSegment(p0: Vec2, p1: Vec2, q0: Vec2, q1: Vec2): Xform2 {
  const lp = distance(p0, p1);
  const lq = distance(q0, q1);
  if (lp <= TOL || lq <= TOL) {
    throw new Error('fromSegmentToSegment: degenerate segment');
  }
  if (Math.abs(lp - lq) > 1e-6 * Math.max(1, lp)) {
    throw new Error(
      `fromSegmentToSegment: length mismatch (${lp.toFixed(6)} vs ${lq.toFixed(6)}); a rigid motion cannot map one onto the other`,
    );
  }
  const u = normalize(sub(p1, p0));
  const w = normalize(sub(q1, q0));
  // Rotation taking u onto w.
  const cos = u.x * w.x + u.y * w.y;
  const sin = u.x * w.y - u.y * w.x;
  const rot: Xform2 = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
  const rotated = apply(rot, p0);
  return compose(translation(q0.x - rotated.x, q0.y - rotated.y), rot);
}
