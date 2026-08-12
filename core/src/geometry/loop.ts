/**
 * Closed loops of lines and arcs.
 *
 * A loop is a cyclic list of vertices. Each vertex carries a `bulge` that
 * describes the segment leaving it and arriving at the next vertex (wrapping
 * from the last back to the first). This is the DXF bulge convention:
 *
 *     bulge = tan(theta / 4)
 *
 * where `theta` is the arc's signed included angle, positive counter-clockwise.
 * A bulge of 0 is a straight line.
 *
 * Using bulges rather than an explicit segment union is deliberate: it is the
 * representation DXF R12 polylines want, so arcs survive all the way to the
 * laser without ever being linearised (INVARIANT, see CLAUDE.md).
 *
 * Orientation convention: outer loops counter-clockwise (positive signed area),
 * inner loops (holes) clockwise.
 */

import { ANGLE_TOL, CHORD_TOL, TOL } from '../units.js';
import {
  type Box2,
  type Vec2,
  add,
  boxOf,
  distance,
  leftNormal,
  lerp,
  normalize,
  scale,
  sub,
} from './vec2.js';

export interface Vertex {
  readonly x: number;
  readonly y: number;
  /** Bulge of the segment from this vertex to the next. 0 = straight line. */
  readonly bulge: number;
}

export interface Loop {
  readonly verts: readonly Vertex[];
}

export function vertex(x: number, y: number, bulge = 0): Vertex {
  return { x, y, bulge };
}

export function point(v: Vertex): Vec2 {
  return { x: v.x, y: v.y };
}

export function loop(verts: readonly Vertex[]): Loop {
  if (verts.length < 2) throw new Error(`loop needs at least 2 vertices, got ${verts.length}`);
  return { verts };
}

/** Build a loop from bare points (all straight segments). */
export function polygon(points: readonly Vec2[]): Loop {
  return loop(points.map((p) => vertex(p.x, p.y, 0)));
}

/** Axis-aligned rectangle, counter-clockwise, from its lower-left corner. */
export function rect(x: number, y: number, w: number, h: number): Loop {
  return polygon([
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ]);
}

/**
 * Axis-aligned rectangle with equal corner radii, counter-clockwise.
 * Used for sink and hob cutouts.
 */
export function roundedRect(x: number, y: number, w: number, h: number, r: number): Loop {
  if (r <= TOL) return rect(x, y, w, h);
  const rr = Math.min(r, w / 2, h / 2);
  // Quarter-turn CCW arcs: theta = +pi/2, bulge = tan(pi/8).
  const b = Math.tan(Math.PI / 8);
  return loop([
    vertex(x + rr, y, 0),
    vertex(x + w - rr, y, b),
    vertex(x + w, y + rr, 0),
    vertex(x + w, y + h - rr, b),
    vertex(x + w - rr, y + h, 0),
    vertex(x + rr, y + h, b),
    vertex(x, y + h - rr, 0),
    vertex(x, y + rr, b),
  ]);
}

/** Full circle as a two-vertex loop of semicircular arcs, counter-clockwise. */
export function circle(cx: number, cy: number, r: number): Loop {
  if (r <= TOL) throw new Error(`circle radius must be positive, got ${r}`);
  // theta = pi per half, bulge = tan(pi/4) = 1.
  return loop([vertex(cx - r, cy, 1), vertex(cx + r, cy, 1)]);
}

/** Number of segments in a loop (equal to the vertex count, since it closes). */
export function segmentCount(l: Loop): number {
  return l.verts.length;
}

export function vertexAt(l: Loop, i: number): Vertex {
  const n = l.verts.length;
  const v = l.verts[((i % n) + n) % n];
  if (v === undefined) throw new Error('empty loop');
  return v;
}

/** Resolved geometry of one arc segment. */
export interface ArcGeometry {
  readonly start: Vec2;
  readonly end: Vec2;
  readonly center: Vec2;
  readonly radius: number;
  /** Signed included angle in radians; positive is counter-clockwise. */
  readonly theta: number;
  /** Angle of `start` about `center`, radians. */
  readonly startAngle: number;
}

/**
 * Resolve the arc between `p0` and `p1` for a given bulge.
 * Returns null for a straight segment.
 */
export function arcGeometry(p0: Vec2, p1: Vec2, bulge: number): ArcGeometry | null {
  if (Math.abs(bulge) <= ANGLE_TOL) return null;
  const chord = distance(p0, p1);
  if (chord <= TOL) throw new Error('arc segment has zero-length chord');
  const theta = 4 * Math.atan(bulge);
  const half = theta / 2;
  const signedRadius = chord / (2 * Math.sin(half));
  const mid = lerp(p0, p1, 0.5);
  const n = leftNormal(normalize(sub(p1, p0)));
  const center = add(mid, scale(n, signedRadius * Math.cos(half)));
  const radius = Math.abs(signedRadius);
  const startAngle = Math.atan2(p0.y - center.y, p0.x - center.x);
  return { start: p0, end: p1, center, radius, theta, startAngle };
}

/** Bulge for an arc of the given signed included angle. */
export function bulgeForAngle(theta: number): number {
  return Math.tan(theta / 4);
}

/** Signed included angle for a bulge. */
export function angleForBulge(bulge: number): number {
  return 4 * Math.atan(bulge);
}

/** Iterate the loop's segments as (start, end, bulge) triples. */
export function* segments(l: Loop): Generator<{ p0: Vec2; p1: Vec2; bulge: number; index: number }> {
  const n = l.verts.length;
  for (let i = 0; i < n; i++) {
    const a = vertexAt(l, i);
    const b = vertexAt(l, i + 1);
    yield { p0: point(a), p1: point(b), bulge: a.bulge, index: i };
  }
}

/**
 * Signed area in mm^2. Positive means counter-clockwise.
 * Straight-segment shoelace plus the signed circular-segment area of each arc.
 */
export function signedArea(l: Loop): number {
  let shoelace = 0;
  let arcs = 0;
  for (const { p0, p1, bulge } of segments(l)) {
    shoelace += p0.x * p1.y - p1.x * p0.y;
    if (Math.abs(bulge) > ANGLE_TOL) {
      const theta = 4 * Math.atan(bulge);
      const c = distance(p0, p1);
      const sinHalf = Math.sin(theta / 2);
      const r2 = (c * c) / (4 * sinHalf * sinHalf);
      arcs += (r2 / 2) * (theta - Math.sin(theta));
    }
  }
  return shoelace / 2 + arcs;
}

export function area(l: Loop): number {
  return Math.abs(signedArea(l));
}

export function isCCW(l: Loop): boolean {
  return signedArea(l) > 0;
}

/** Reverse the traversal direction, preserving the same geometry. */
export function reverse(l: Loop): Loop {
  const n = l.verts.length;
  const out: Vertex[] = [];
  for (let j = 0; j < n; j++) {
    const src = vertexAt(l, n - 1 - j);
    // The segment leaving w_j is the reverse of the original segment that
    // arrived at it, i.e. the one leaving v_{n-2-j}.
    const bulgeSrc = vertexAt(l, n - 2 - j);
    out.push({ x: src.x, y: src.y, bulge: -bulgeSrc.bulge });
  }
  return { verts: out };
}

/** Force counter-clockwise (outer loop) orientation. */
export function asCCW(l: Loop): Loop {
  return isCCW(l) ? l : reverse(l);
}

/** Force clockwise (inner loop / hole) orientation. */
export function asCW(l: Loop): Loop {
  return isCCW(l) ? reverse(l) : l;
}

/** Total developed length of the loop's boundary, in mm. */
export function perimeter(l: Loop): number {
  let total = 0;
  for (const { p0, p1, bulge } of segments(l)) {
    const arc = arcGeometry(p0, p1, bulge);
    total += arc === null ? distance(p0, p1) : Math.abs(arc.theta) * arc.radius;
  }
  return total;
}

/** Bounding box, accounting for arc bulge beyond the chord endpoints. */
export function bounds(l: Loop): Box2 {
  const pts: Vec2[] = l.verts.map(point);
  for (const { p0, p1, bulge } of segments(l)) {
    const arc = arcGeometry(p0, p1, bulge);
    if (arc === null) continue;
    for (const extreme of arcAxisExtremes(arc)) pts.push(extreme);
  }
  return boxOf(pts);
}

/** The points where an arc reaches its extreme x or y, if the arc covers them. */
function arcAxisExtremes(arc: ArcGeometry): Vec2[] {
  const out: Vec2[] = [];
  for (let k = 0; k < 4; k++) {
    const angle = (k * Math.PI) / 2;
    if (arcCoversAngle(arc, angle)) {
      out.push({
        x: arc.center.x + arc.radius * Math.cos(angle),
        y: arc.center.y + arc.radius * Math.sin(angle),
      });
    }
  }
  return out;
}

function arcCoversAngle(arc: ArcGeometry, angle: number): boolean {
  const TWO_PI = Math.PI * 2;
  // Sweep measured in the arc's own direction, normalised to [0, 2pi).
  let delta = (angle - arc.startAngle) * Math.sign(arc.theta);
  delta = ((delta % TWO_PI) + TWO_PI) % TWO_PI;
  return delta <= Math.abs(arc.theta);
}

/**
 * Approximate the loop as a list of points with the given chord tolerance.
 * Only for boolean input and rendering — never for DXF output.
 */
export function linearise(l: Loop, chordTol: number = CHORD_TOL): Vec2[] {
  const out: Vec2[] = [];
  for (const { p0, p1, bulge } of segments(l)) {
    out.push(p0);
    const arc = arcGeometry(p0, p1, bulge);
    if (arc === null) continue;
    const steps = arcSubdivisions(arc.radius, arc.theta, chordTol);
    for (let i = 1; i < steps; i++) {
      const a = arc.startAngle + (arc.theta * i) / steps;
      out.push({
        x: arc.center.x + arc.radius * Math.cos(a),
        y: arc.center.y + arc.radius * Math.sin(a),
      });
    }
  }
  return out;
}

export function arcSubdivisions(radius: number, theta: number, chordTol: number): number {
  const sweep = Math.abs(theta);
  if (radius <= chordTol) return Math.max(2, Math.ceil(sweep / (Math.PI / 8)));
  // Max angular step that keeps sagitta under the chord tolerance.
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - chordTol / radius)));
  return Math.max(2, Math.ceil(sweep / step));
}

/**
 * Drop vertices that coincide with their neighbour (only when both incident
 * segments are straight — collapsing an arc would change the geometry).
 */
export function dedupe(l: Loop, tol: number = TOL): Loop {
  const verts = [...l.verts];
  const out: Vertex[] = [];
  for (let i = 0; i < verts.length; i++) {
    const cur = vertexAt({ verts }, i);
    const next = vertexAt({ verts }, i + 1);
    const coincident = Math.abs(cur.x - next.x) <= tol && Math.abs(cur.y - next.y) <= tol;
    if (coincident && Math.abs(cur.bulge) <= ANGLE_TOL) continue;
    out.push(cur);
  }
  return out.length >= 2 ? { verts: out } : { verts };
}

/**
 * Point-in-loop by ray casting over the linearised boundary. Points within
 * `tol` of the boundary are reported as inside, which is what containment
 * tests for cutouts and reliefs want.
 */
export function containsPoint(l: Loop, p: Vec2, tol: number = TOL): boolean {
  const pts = linearise(l, Math.min(CHORD_TOL, tol > 0 ? tol * 10 : CHORD_TOL));
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (pointOnSegment(a, b, p, tol)) return true;
    const straddles = a.y > p.y !== b.y > p.y;
    if (!straddles) continue;
    const t = (p.y - a.y) / (b.y - a.y);
    if (p.x < a.x + t * (b.x - a.x)) inside = !inside;
  }
  return inside;
}

function pointOnSegment(a: Vec2, b: Vec2, p: Vec2, tol: number): boolean {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 <= tol * tol) return distance(a, p) <= tol;
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return distance({ x: a.x + t * abx, y: a.y + t * aby }, p) <= tol;
}

/**
 * Round every corner of a convex polygon to the same radius.
 *
 * `roundedRect` does this for an axis-aligned box, which is all a sink cutout
 * ever needs. A door opening in a wall that leans in is a trapezium, so its
 * corners are not right angles and the radius has to be fitted to whatever
 * angle each corner actually turns through.
 *
 * At a corner turning through `theta`, an arc of radius `r` tangent to both
 * edges meets them a distance `r / tan((pi - theta) / 2)` back from the corner.
 * The radius is reduced if two corners would otherwise eat past each other on a
 * short edge, so a big radius on a small opening degrades rather than
 * self-intersects.
 *
 * Points must be counter-clockwise and convex, which every panel outline in
 * this codebase is — a canopy wall is a rectangle or a trapezium.
 */
export function filletPolygon(pts: readonly Vec2[], r: number): Loop {
  if (r <= TOL || pts.length < 3) return polygon(pts);

  const n = pts.length;
  const dirs = pts.map((p, i) => normalize(sub(pts[(i + 1) % n]!, p)));
  const lengths = pts.map((p, i) => distance(p, pts[(i + 1) % n]!));

  // How far back from each corner the tangent point sits, before any trimming.
  const turn = pts.map((_, i) => {
    const into = dirs[(i - 1 + n) % n]!;
    const out = dirs[i]!;
    const cross = into.x * out.y - into.y * out.x;
    const dot = into.x * out.x + into.y * out.y;
    return Math.atan2(cross, dot);
  });
  // Tangent distance back from a corner turning through theta is r*tan(theta/2).
  // A corner that barely turns gets none: it is a straight edge in two pieces.
  const scaled = turn.map((t) => (Math.abs(t) <= ANGLE_TOL ? 0 : r * Math.tan(Math.abs(t) / 2)));
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const room = lengths[i]!;
    const want = scaled[i]! + scaled[j]!;
    if (want > room && want > TOL) {
      const k = room / want;
      scaled[i] = scaled[i]! * k;
      scaled[j] = scaled[j]! * k;
    }
  }

  const verts: Vertex[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = turn[i]!;
    const d = scaled[i]!;
    if (d <= TOL) {
      verts.push(vertex(pts[i]!.x, pts[i]!.y, 0));
      continue;
    }
    const into = dirs[(i - 1 + n) % n]!;
    const out = dirs[i]!;
    const start = sub(pts[i]!, scale(into, d));
    const end = add(pts[i]!, scale(out, d));
    // The arc turns through the same angle the corner did.
    verts.push(vertex(start.x, start.y, Math.tan(t / 4)));
    verts.push(vertex(end.x, end.y, 0));
  }
  return loop(verts);
}
