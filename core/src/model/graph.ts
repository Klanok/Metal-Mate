/**
 * The face-bend graph: the canonical description of a folded part.
 *
 * Nodes are planar faces, edges are bends. Both the 3D solid and the flat
 * pattern are *derived* from this graph by the same traversal, which is why no
 * B-rep kernel is needed anywhere in the system.
 *
 * INVARIANT: the graph is a tree. Every face is reachable from the base face
 * by exactly one path of bends. Closed corners are NOT graph edges — they are
 * `CornerJoint` records that modify 2D profiles at unfold time (see
 * `model/corner.ts`), precisely so that the tree property survives them.
 *
 * Conventions that the whole system depends on:
 *
 *  - A face's `profile` lies on the **neutral surface**, in the face's own 2D
 *    frame. Tangent points sit at the same station on every surface parallel
 *    to it, so this costs nothing when working in outside dimensions, and it
 *    makes the folded view use radius BA/theta = R + K*T — the same number the
 *    flat pattern is built from. Flat and folded never need reconciling.
 *  - A bend stores its bend line twice, once in each face's local frame, each
 *    directed so that **its own face's material lies to the left**. Since the
 *    two faces are on opposite sides of the shared line, the two directed
 *    lines run antiparallel — which is exactly what makes the flat placement a
 *    pure rigid motion with no mirroring.
 *  - `angleDeg` is the bend angle, i.e. the departure from flat: a right-angle
 *    fold is 90, not 180.
 */

import { type BendId, type FaceId } from '../ids.js';
import { type Profile } from '../geometry/profile.js';
import { type Loop, segments } from '../geometry/loop.js';
import { type Vec2, cross, distance, dot, normalize, sub } from '../geometry/vec2.js';
import { TOL } from '../units.js';

/** A directed segment in a face's local 2D frame. */
export interface DirectedEdge {
  readonly p0: Vec2;
  readonly p1: Vec2;
}

export interface Face {
  readonly id: FaceId;
  /** Neutral-surface profile in this face's local 2D frame, mm. */
  readonly profile: Profile;
  /** Feature that produced this face, for selection and error reporting. */
  readonly featureId: string;
  /**
   * Stable names for boundary edges, in face-local coordinates and directed
   * with the material on the left. This is the topological-naming hook: a
   * feature says "flange off `top.front`", never "flange off edge 2", so
   * adding a cutout or reordering the tree cannot silently move it.
   */
  readonly edges: ReadonlyMap<string, DirectedEdge>;
  /** Human label used in drawings and validation messages. */
  readonly label?: string;
}

/** Look up a named edge, with a message that lists what was available. */
export function namedEdge(face: Face, edgeName: string): DirectedEdge {
  const e = face.edges.get(edgeName);
  if (e === undefined) {
    throw new Error(
      `face ${face.id} has no edge named ${JSON.stringify(edgeName)}; ` +
        `known edges: ${[...face.edges.keys()].join(', ') || '(none)'}`,
    );
  }
  return e;
}

export type BendDirection = 'up' | 'down';

export interface Bend {
  readonly id: BendId;
  readonly faceA: FaceId;
  readonly faceB: FaceId;
  /** Bend line in faceA's frame, faceA's material on the left. */
  readonly lineA: DirectedEdge;
  /** Bend line in faceB's frame, faceB's material on the left. */
  readonly lineB: DirectedEdge;
  /** Bend angle (departure from flat) in degrees, 0 < angle < 180. */
  readonly angleDeg: number;
  /** Which way faceB rotates out of faceA's plane. */
  readonly direction: BendDirection;
  /** Inside radius in mm. */
  readonly insideRadius: number;
  /** Explicit bend allowance in mm, overriding the material/table lookup. */
  readonly allowanceOverride?: number;
  /** V-die width in mm, when the user has pinned one. */
  readonly dieWidth?: number;
  readonly label?: string;
}

export interface FaceBendGraph {
  readonly faces: ReadonlyMap<FaceId, Face>;
  readonly bends: ReadonlyMap<BendId, Bend>;
  /** The face that stays put when unfolding and folding. */
  readonly baseFaceId: FaceId;
  /** Sheet thickness in mm. Single-thickness parts only (v1). */
  readonly thickness: number;
}

/**
 * Face constructor that defaults the edge-name map. Hand-built graphs (tests,
 * one-off parts) rarely need named edges; features always supply them.
 */
export function makeFace(
  init: Omit<Face, 'edges'> & { edges?: ReadonlyMap<string, DirectedEdge> },
): Face {
  const { edges, ...rest } = init;
  return { ...rest, edges: edges ?? new Map() };
}

export function buildGraph(
  faces: readonly Face[],
  bends: readonly Bend[],
  baseFaceId: FaceId,
  thickness: number,
): FaceBendGraph {
  const faceMap = new Map<FaceId, Face>();
  for (const f of faces) {
    if (faceMap.has(f.id)) throw new Error(`duplicate face id ${f.id}`);
    faceMap.set(f.id, f);
  }
  const bendMap = new Map<BendId, Bend>();
  for (const b of bends) {
    if (bendMap.has(b.id)) throw new Error(`duplicate bend id ${b.id}`);
    bendMap.set(b.id, b);
  }
  return { faces: faceMap, bends: bendMap, baseFaceId, thickness };
}

export function getFace(g: FaceBendGraph, id: FaceId): Face {
  const f = g.faces.get(id);
  if (f === undefined) throw new Error(`no such face: ${id}`);
  return f;
}

export function getBend(g: FaceBendGraph, id: BendId): Bend {
  const b = g.bends.get(id);
  if (b === undefined) throw new Error(`no such bend: ${id}`);
  return b;
}

/** Bends incident to a face, with the far face resolved. */
export function incidentBends(
  g: FaceBendGraph,
  faceId: FaceId,
): { bend: Bend; other: FaceId; fromA: boolean }[] {
  const out: { bend: Bend; other: FaceId; fromA: boolean }[] = [];
  for (const bend of g.bends.values()) {
    if (bend.faceA === faceId) out.push({ bend, other: bend.faceB, fromA: true });
    else if (bend.faceB === faceId) out.push({ bend, other: bend.faceA, fromA: false });
  }
  return out;
}

export interface GraphProblem {
  readonly code:
    | 'unknown-face'
    | 'not-a-tree'
    | 'disconnected'
    | 'self-loop'
    | 'bad-angle'
    | 'bad-radius'
    | 'bend-line-length-mismatch'
    | 'bend-line-not-on-face'
    | 'bad-thickness'
    | 'no-base-face';
  readonly message: string;
  readonly bendId?: BendId;
  readonly faceId?: FaceId;
}

/**
 * Structural check of the graph. Runs before every unfold; a graph that fails
 * here cannot be unfolded at all, so these are hard errors rather than
 * validation warnings.
 */
export function checkGraph(g: FaceBendGraph): GraphProblem[] {
  const problems: GraphProblem[] = [];

  if (!(g.thickness > 0)) {
    problems.push({ code: 'bad-thickness', message: `thickness must be positive, got ${g.thickness}` });
  }
  if (!g.faces.has(g.baseFaceId)) {
    problems.push({ code: 'no-base-face', message: `base face ${g.baseFaceId} is not in the graph` });
    return problems;
  }

  for (const bend of g.bends.values()) {
    if (!g.faces.has(bend.faceA)) {
      problems.push({
        code: 'unknown-face',
        message: `bend ${bend.id} references unknown face ${bend.faceA}`,
        bendId: bend.id,
      });
      continue;
    }
    if (!g.faces.has(bend.faceB)) {
      problems.push({
        code: 'unknown-face',
        message: `bend ${bend.id} references unknown face ${bend.faceB}`,
        bendId: bend.id,
      });
      continue;
    }
    if (bend.faceA === bend.faceB) {
      problems.push({
        code: 'self-loop',
        message: `bend ${bend.id} joins face ${bend.faceA} to itself`,
        bendId: bend.id,
      });
    }
    if (!(bend.angleDeg > 0) || !(bend.angleDeg < 180)) {
      problems.push({
        code: 'bad-angle',
        message: `bend ${bend.id} angle must be in (0, 180) degrees, got ${bend.angleDeg}`,
        bendId: bend.id,
      });
    }
    if (!(bend.insideRadius > 0)) {
      problems.push({
        code: 'bad-radius',
        message: `bend ${bend.id} inside radius must be positive, got ${bend.insideRadius}`,
        bendId: bend.id,
      });
    }
    const la = edgeLength(bend.lineA);
    const lb = edgeLength(bend.lineB);
    if (Math.abs(la - lb) > 1e-6 * Math.max(1, la)) {
      problems.push({
        code: 'bend-line-length-mismatch',
        message: `bend ${bend.id} bend line is ${la.toFixed(4)} mm on ${bend.faceA} but ${lb.toFixed(4)} mm on ${bend.faceB}`,
        bendId: bend.id,
      });
    }
    for (const [faceIdRef, line] of [
      [bend.faceA, bend.lineA] as const,
      [bend.faceB, bend.lineB] as const,
    ]) {
      const face = g.faces.get(faceIdRef);
      if (face === undefined) continue;
      if (!isDirectedEdgeOfLoop(face.profile.outer, line)) {
        problems.push({
          code: 'bend-line-not-on-face',
          message:
            `bend ${bend.id} bend line is not a counter-clockwise boundary edge of face ${faceIdRef}; ` +
            'the material must lie to the left of the stored direction',
          bendId: bend.id,
          faceId: faceIdRef,
        });
      }
    }
  }

  // Tree check: connected and edge count exactly faces - 1.
  const faceCount = g.faces.size;
  const bendCount = g.bends.size;
  const seen = new Set<FaceId>([g.baseFaceId]);
  const queue: FaceId[] = [g.baseFaceId];
  let visitedEdges = 0;
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const { other } of incidentBends(g, current)) {
      visitedEdges += 1;
      if (seen.has(other)) continue;
      seen.add(other);
      queue.push(other);
    }
  }
  if (bendCount !== faceCount - 1) {
    problems.push({
      code: 'not-a-tree',
      message: `graph must be a tree: ${faceCount} faces need exactly ${faceCount - 1} bends, found ${bendCount}`,
    });
  }
  if (seen.size !== faceCount) {
    const orphans = [...g.faces.keys()].filter((id) => !seen.has(id));
    problems.push({
      code: 'disconnected',
      message: `faces not reachable from the base face: ${orphans.join(', ')}`,
      ...(orphans[0] !== undefined ? { faceId: orphans[0] } : {}),
    });
  }
  return problems;
}

export function assertGraphOk(g: FaceBendGraph): void {
  const problems = checkGraph(g);
  if (problems.length > 0) {
    throw new Error(`invalid face-bend graph:\n  ${problems.map((p) => p.message).join('\n  ')}`);
  }
}

export function edgeLength(e: DirectedEdge): number {
  return distance(e.p0, e.p1);
}

export function edgeDirection(e: DirectedEdge): Vec2 {
  return normalize(sub(e.p1, e.p0));
}

/**
 * True when the directed edge lies along a straight boundary segment of the
 * loop, pointing the same way as the loop's own traversal. Given a
 * counter-clockwise loop, that is exactly "material on the left".
 */
export function isDirectedEdgeOfLoop(l: Loop, e: DirectedEdge, tol: number = 1e-6): boolean {
  const target = sub(e.p1, e.p0);
  if (distance(e.p0, e.p1) <= TOL) return false;
  const targetDir = normalize(target);
  for (const { p0, p1, bulge } of segments(l)) {
    if (Math.abs(bulge) > 1e-12) continue;
    const seg = sub(p1, p0);
    const segLen = Math.hypot(seg.x, seg.y);
    if (segLen <= TOL) continue;
    const segDir = { x: seg.x / segLen, y: seg.y / segLen };
    // Same direction (not merely collinear).
    if (dot(segDir, targetDir) < 1 - 1e-9) continue;
    // Both endpoints on the segment's infinite line, within its extent.
    const t0 = dot(sub(e.p0, p0), segDir);
    const t1 = dot(sub(e.p1, p0), segDir);
    const off0 = Math.abs(cross(segDir, sub(e.p0, p0)));
    const off1 = Math.abs(cross(segDir, sub(e.p1, p0)));
    if (off0 > tol || off1 > tol) continue;
    if (t0 < -tol || t1 > segLen + tol) continue;
    return true;
  }
  return false;
}
