/**
 * A planar region: one outer loop plus zero or more inner loops (holes).
 *
 * Every face of the face-bend graph is a profile, and so is the finished flat
 * pattern. Orientation is normalised on construction: outer counter-clockwise,
 * inners clockwise, matching both the DXF export rule and Clipper's non-zero
 * fill expectations.
 */

import {
  type Loop,
  area as loopArea,
  asCCW,
  asCW,
  bounds as loopBounds,
  containsPoint,
  perimeter as loopPerimeter,
} from './loop.js';
import { type Xform2, applyLoop } from './transform.js';
import { type Box2, type Vec2, boxUnion } from './vec2.js';

export interface Profile {
  readonly outer: Loop;
  readonly inners: readonly Loop[];
}

export function profile(outer: Loop, inners: readonly Loop[] = []): Profile {
  return { outer: asCCW(outer), inners: inners.map(asCW) };
}

/** Material area: outer area minus the holes. */
export function profileArea(p: Profile): number {
  let a = loopArea(p.outer);
  for (const inner of p.inners) a -= loopArea(inner);
  return a;
}

/** Total cut length: outer boundary plus every hole boundary. */
export function profileCutLength(p: Profile): number {
  let total = loopPerimeter(p.outer);
  for (const inner of p.inners) total += loopPerimeter(inner);
  return total;
}

export function profileBounds(p: Profile): Box2 {
  let b = loopBounds(p.outer);
  for (const inner of p.inners) b = boxUnion(b, loopBounds(inner));
  return b;
}

export function transformProfile(t: Xform2, p: Profile): Profile {
  return profile(
    applyLoop(t, p.outer),
    p.inners.map((l) => applyLoop(t, l)),
  );
}

/** True when the point is inside the outer loop and outside every hole. */
export function profileContains(p: Profile, pt: Vec2): boolean {
  if (!containsPoint(p.outer, pt)) return false;
  for (const inner of p.inners) {
    if (containsPoint(inner, pt)) return false;
  }
  return true;
}

export function allLoops(p: Profile): Loop[] {
  return [p.outer, ...p.inners];
}
