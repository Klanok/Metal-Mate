/**
 * 2D boolean operations, backed by Clipper2 (WASM).
 *
 * This is the highest robustness risk in the whole system, so it lives behind
 * a deliberately thin interface: linearise arcs at a fine chord tolerance,
 * hand integer coordinates to Clipper, then re-fit the arcs that survived.
 * Nothing outside this module knows Clipper exists, and nothing outside this
 * module ever sees a linearised arc.
 *
 * Arc survival works by tagging: each interior point of a linearised arc
 * carries the arc's key in Clipper's Z channel. Original vertices keep their
 * Z through a boolean; points created at an intersection get Z = 0. So a run
 * of consecutive output points sharing one non-zero key is an unclipped span
 * of that arc, and can be collapsed back to a single bulge. A clipped arc
 * simply loses its tag at the cut and stays as line segments — conservative,
 * never wrong.
 */

import { BOOLEAN_SCALE, CHORD_TOL, TOL } from '../units.js';
import {
  type ArcGeometry,
  type Loop,
  type Vertex,
  arcGeometry,
  arcSubdivisions,
  bulgeForAngle,
  dedupe,
  isCCW,
  segments,
  signedArea,
} from './loop.js';
import { type Profile, allLoops, profile } from './profile.js';
import { type Vec2 } from './vec2.js';
import { containsPoint } from './loop.js';

/** How far an output point may sit off an arc's circle and still be re-fitted. */
const ARC_REFIT_TOL = Math.max(4 * CHORD_TOL, 0.005);

export type BooleanOp = 'union' | 'difference' | 'intersection' | 'xor';

export interface Boolean2D {
  /** Union of every input profile. */
  union(inputs: readonly Profile[]): Profile[];
  /** `subjects` minus `clips`. */
  difference(subjects: readonly Profile[], clips: readonly Profile[]): Profile[];
  /** Region common to `subjects` and `clips`. */
  intersection(subjects: readonly Profile[], clips: readonly Profile[]): Profile[];
  /** Symmetric difference. Used by overlap detection in the unfold engine. */
  xor(subjects: readonly Profile[], clips: readonly Profile[]): Profile[];
  /** Total area of the intersection, in mm^2. Cheap overlap test. */
  intersectionArea(subjects: readonly Profile[], clips: readonly Profile[]): number;
  /**
   * Grow (positive delta) or shrink (negative delta) profiles by `delta` mm.
   * Used for clearance checks, reliefs and hem returns. Corners are rounded,
   * which is both what sheet metal wants and the conservative choice for a
   * clearance test.
   */
  offset(inputs: readonly Profile[], deltaMm: number): Profile[];
}

// Minimal structural typing of the bits of the Clipper2 embind module we use.
// The shipped .d.ts is generated and awkward to consume; this states exactly
// what we depend on, so a version bump breaks loudly at the boundary.
interface ClipperPoint {
  x: bigint;
  y: bigint;
  z: bigint;
}
interface ClipperPath {
  size(): number;
  get(i: number): ClipperPoint;
  push_back(p: ClipperPoint): void;
  delete(): void;
}
interface ClipperPaths {
  size(): number;
  get(i: number): ClipperPath;
  push_back(p: ClipperPath): void;
  delete(): void;
}
interface ClipperModule {
  Point64: new (x: bigint, y: bigint, z: bigint) => ClipperPoint;
  Path64: new () => ClipperPath;
  Paths64: new () => ClipperPaths;
  FillRule: { NonZero: unknown; EvenOdd: unknown; Positive: unknown; Negative: unknown };
  Union64(subjects: ClipperPaths, clips: ClipperPaths, rule: unknown): ClipperPaths;
  Difference64(subjects: ClipperPaths, clips: ClipperPaths, rule: unknown): ClipperPaths;
  Intersect64(subjects: ClipperPaths, clips: ClipperPaths, rule: unknown): ClipperPaths;
  Xor64(subjects: ClipperPaths, clips: ClipperPaths, rule: unknown): ClipperPaths;
  InflatePaths64(
    paths: ClipperPaths,
    delta: number,
    joinType: unknown,
    endType: unknown,
    miterLimit: number,
    arcTolerance: number,
  ): ClipperPaths;
  JoinType: { Square: unknown; Round: unknown; Miter: unknown };
  EndType: { Polygon: unknown; Joined: unknown; Butt: unknown; Square: unknown; Round: unknown };
}

let modulePromise: Promise<ClipperModule> | null = null;

async function loadClipper(): Promise<ClipperModule> {
  if (modulePromise === null) {
    modulePromise = (async () => {
      const factory = (await import('clipper2-wasm/dist/es/clipper2z.js')) as unknown as {
        default: () => Promise<ClipperModule>;
      };
      return factory.default();
    })();
  }
  return modulePromise;
}

let cached: Boolean2D | null = null;

/**
 * Initialise the boolean kernel. Must be awaited once before any unfold or
 * export; everything downstream of it is synchronous and pure.
 */
export async function initBooleans(): Promise<Boolean2D> {
  if (cached !== null) return cached;
  const mod = await loadClipper();
  cached = new Clipper2Boolean(mod);
  return cached;
}

/** The initialised kernel, or throw. For synchronous call sites. */
export function booleans(): Boolean2D {
  if (cached === null) {
    throw new Error('boolean kernel not initialised — await initBooleans() first');
  }
  return cached;
}

/** Test seam: drop the cached kernel. */
export function resetBooleansForTest(): void {
  cached = null;
}

interface TaggedArc {
  readonly arc: ArcGeometry;
}

class Clipper2Boolean implements Boolean2D {
  constructor(private readonly mod: ClipperModule) {}

  union(inputs: readonly Profile[]): Profile[] {
    return this.run('union', inputs, []);
  }

  difference(subjects: readonly Profile[], clips: readonly Profile[]): Profile[] {
    return this.run('difference', subjects, clips);
  }

  intersection(subjects: readonly Profile[], clips: readonly Profile[]): Profile[] {
    return this.run('intersection', subjects, clips);
  }

  xor(subjects: readonly Profile[], clips: readonly Profile[]): Profile[] {
    return this.run('xor', subjects, clips);
  }

  offset(inputs: readonly Profile[], deltaMm: number): Profile[] {
    if (inputs.length === 0) return [];
    // An offset re-cuts every arc, so nothing here can carry an arc tag
    // through; the result comes back as fine polylines by design.
    const arcs = new Map<string, TaggedArc>();
    const paths = this.buildPaths(inputs, arcs);
    const inflated = this.mod.InflatePaths64(
      paths,
      deltaMm * BOOLEAN_SCALE,
      this.mod.JoinType.Round,
      this.mod.EndType.Polygon,
      2,
      CHORD_TOL * BOOLEAN_SCALE,
    );
    const loops = this.readPaths(inflated, new Map());
    inflated.delete();
    paths.delete();
    return groupIntoProfiles(loops);
  }

  intersectionArea(subjects: readonly Profile[], clips: readonly Profile[]): number {
    let total = 0;
    for (const p of this.intersection(subjects, clips)) {
      total += Math.abs(signedArea(p.outer));
      for (const inner of p.inners) total -= Math.abs(signedArea(inner));
    }
    return total;
  }

  private run(op: BooleanOp, subjects: readonly Profile[], clips: readonly Profile[]): Profile[] {
    const arcs = new Map<string, TaggedArc>();
    const subjectPaths = this.buildPaths(subjects, arcs);
    const clipPaths = this.buildPaths(clips, arcs);
    let result: ClipperPaths;
    const rule = this.mod.FillRule.NonZero;
    switch (op) {
      case 'union':
        result = this.mod.Union64(subjectPaths, clipPaths, rule);
        break;
      case 'difference':
        result = this.mod.Difference64(subjectPaths, clipPaths, rule);
        break;
      case 'intersection':
        result = this.mod.Intersect64(subjectPaths, clipPaths, rule);
        break;
      case 'xor':
        result = this.mod.Xor64(subjectPaths, clipPaths, rule);
        break;
    }
    const loops = this.readPaths(result, arcs);
    result.delete();
    subjectPaths.delete();
    clipPaths.delete();
    return groupIntoProfiles(loops);
  }

  private buildPaths(profiles: readonly Profile[], arcs: Map<string, TaggedArc>): ClipperPaths {
    const paths = new this.mod.Paths64();
    for (const p of profiles) {
      for (const l of allLoops(p)) {
        const path = this.buildPath(l, arcs);
        paths.push_back(path);
        path.delete();
      }
    }
    return paths;
  }

  private buildPath(l: Loop, arcs: Map<string, TaggedArc>): ClipperPath {
    const path = new this.mod.Path64();
    for (const { p0, p1, bulge, index } of segments(l)) {
      // Segment endpoints are untagged; only the arc's interior carries a key,
      // so a cut anywhere along the arc simply drops the run.
      path.push_back(this.point(p0, 0n));
      const arc = arcGeometry(p0, p1, bulge);
      if (arc === null) continue;
      const key = arcs.size + 1;
      arcs.set(String(key), { arc });
      void index;
      const steps = arcSubdivisions(arc.radius, arc.theta, CHORD_TOL);
      for (let i = 1; i < steps; i++) {
        const a = arc.startAngle + (arc.theta * i) / steps;
        path.push_back(
          this.point(
            {
              x: arc.center.x + arc.radius * Math.cos(a),
              y: arc.center.y + arc.radius * Math.sin(a),
            },
            BigInt(key),
          ),
        );
      }
    }
    return path;
  }

  private point(p: Vec2, z: bigint): ClipperPoint {
    return new this.mod.Point64(
      BigInt(Math.round(p.x * BOOLEAN_SCALE)),
      BigInt(Math.round(p.y * BOOLEAN_SCALE)),
      z,
    );
  }

  private readPaths(paths: ClipperPaths, arcs: Map<string, TaggedArc>): Loop[] {
    const out: Loop[] = [];
    for (let i = 0; i < paths.size(); i++) {
      const path = paths.get(i);
      const pts: { p: Vec2; tag: string }[] = [];
      for (let j = 0; j < path.size(); j++) {
        const pt = path.get(j);
        pts.push({
          p: { x: Number(pt.x) / BOOLEAN_SCALE, y: Number(pt.y) / BOOLEAN_SCALE },
          tag: pt.z === 0n ? '' : String(pt.z),
        });
      }
      if (pts.length < 3) continue;
      const l = dedupe(refitArcs(pts, arcs));
      if (Math.abs(signedArea(l)) <= TOL) continue;
      out.push(l);
    }
    return out;
  }
}

/**
 * Collapse tagged runs of points back into arc segments.
 * Exported for direct testing — this is the subtle half of the module.
 */
export function refitArcs(
  pts: readonly { p: Vec2; tag: string }[],
  arcs: ReadonlyMap<string, TaggedArc>,
): Loop {
  const n = pts.length;
  const untaggedIndex = pts.findIndex((q) => q.tag === '');
  if (untaggedIndex < 0 || arcs.size === 0) {
    return { verts: pts.map((q) => ({ x: q.p.x, y: q.p.y, bulge: 0 })) };
  }
  // Rotate so the path starts on an untagged point: every tagged run is then
  // strictly interior and needs no wrap-around handling.
  const ordered = [...pts.slice(untaggedIndex), ...pts.slice(0, untaggedIndex)];
  const verts: Vertex[] = [];
  let i = 0;
  while (i < n) {
    const cur = ordered[i]!;
    if (cur.tag !== '') {
      // Should not happen given the rotation, but stay safe.
      verts.push({ x: cur.p.x, y: cur.p.y, bulge: 0 });
      i += 1;
      continue;
    }
    let j = i + 1;
    let runTag = '';
    while (j < n && ordered[j]!.tag !== '') {
      if (runTag === '') runTag = ordered[j]!.tag;
      else if (ordered[j]!.tag !== runTag) break;
      j += 1;
    }
    const runLength = j - i - 1;
    const tagged = arcs.get(runTag);
    const endPoint = ordered[j % n]!;
    if (runLength > 0 && tagged !== undefined) {
      const bulge = fitBulge(tagged.arc, cur.p, endPoint.p, ordered.slice(i + 1, j).map((q) => q.p));
      if (bulge !== null) {
        verts.push({ x: cur.p.x, y: cur.p.y, bulge });
        i = j;
        continue;
      }
    }
    verts.push({ x: cur.p.x, y: cur.p.y, bulge: 0 });
    i += 1;
  }
  return { verts };
}

/**
 * Bulge for the span start->end following `arc`, or null when the span does
 * not actually lie on that arc's circle (in which case we keep the polyline).
 *
 * The traversal direction is taken from the output points, not from the source
 * arc: a difference or an orientation fix-up can hand the arc back reversed,
 * and re-using the source arc's sign would then produce the complementary arc.
 */
function fitBulge(
  arc: ArcGeometry,
  start: Vec2,
  end: Vec2,
  interior: readonly Vec2[],
): number | null {
  const onCircle = (p: Vec2): boolean =>
    Math.abs(Math.hypot(p.x - arc.center.x, p.y - arc.center.y) - arc.radius) <= ARC_REFIT_TOL;
  if (!onCircle(start) || !onCircle(end)) return null;
  for (const p of interior) {
    if (!onCircle(p)) return null;
  }
  const angleOf = (p: Vec2): number => Math.atan2(p.y - arc.center.y, p.x - arc.center.x);
  const first = interior[0];
  if (first === undefined) return null;
  const step = wrapToPi(angleOf(first) - angleOf(start));
  if (Math.abs(step) <= ANGLE_EPS) return null;
  const dir = Math.sign(step);

  const TWO_PI = Math.PI * 2;
  let sweep = (angleOf(end) - angleOf(start)) * dir;
  sweep = ((sweep % TWO_PI) + TWO_PI) % TWO_PI;
  if (sweep <= ANGLE_EPS || sweep > Math.abs(arc.theta) + 1e-6) return null;
  return bulgeForAngle(sweep * dir);
}

const ANGLE_EPS = 1e-9;

/** Normalise an angle difference into (-pi, pi]. */
function wrapToPi(a: number): number {
  const TWO_PI = Math.PI * 2;
  let r = ((a % TWO_PI) + TWO_PI) % TWO_PI;
  if (r > Math.PI) r -= TWO_PI;
  return r;
}

/**
 * Turn a flat list of oriented loops into profiles: counter-clockwise loops
 * are outers, clockwise loops are holes, and each hole belongs to the smallest
 * outer that contains it.
 */
export function groupIntoProfiles(loops: readonly Loop[]): Profile[] {
  const outers = loops.filter(isCCW);
  const holes = loops.filter((l) => !isCCW(l));
  const assigned = outers.map((outer) => ({ outer, inners: [] as Loop[] }));
  for (const hole of holes) {
    const probe = hole.verts[0];
    if (probe === undefined) continue;
    let best = -1;
    let bestArea = Infinity;
    for (let i = 0; i < assigned.length; i++) {
      const candidate = assigned[i]!.outer;
      if (!containsPoint(candidate, { x: probe.x, y: probe.y })) continue;
      const a = Math.abs(signedArea(candidate));
      if (a < bestArea) {
        bestArea = a;
        best = i;
      }
    }
    if (best >= 0) assigned[best]!.inners.push(hole);
  }
  return assigned
    .map((g) => profile(g.outer, g.inners))
    .sort((a, b) => Math.abs(signedArea(b.outer)) - Math.abs(signedArea(a.outer)));
}
