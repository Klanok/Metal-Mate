/**
 * Where the parts sit relative to each other.
 *
 * The architecture doc lists assemblies as a v1 non-goal, and this is
 * deliberately not one. There is no mate solver with degrees of freedom, no
 * interference checking, no sub-assemblies and no exploded views. There is one
 * question it exists to answer: **given two edges on two different parts that
 * are supposed to meet, do they?** — because that is what a cross-part corner
 * joint needs before it can put a tab on one and a slot in the other.
 *
 * Parts are placed the same way faces are: a root that stays put, and everyone
 * else brought to an already-placed neighbour by one relationship. That makes
 * the placement graph a tree for the same reason the face-bend graph is one —
 * every part reachable by exactly one path, so placement is a sequence of rigid
 * motions with nothing to reconcile, and `checkAssembly` enforces it.
 *
 * A mate brings one edge of the part being placed onto one edge of the part it
 * is placed against. The two run **antiparallel** when they meet, the same
 * convention bend lines and corner joints follow: travelling along one from its
 * start is travelling along the other toward its start.
 *
 * `angleDeg` is the departure from flat, exactly as it is for a bend: 0 leaves
 * the two parts coplanar and unfolded away from each other, 90 stands the
 * placed part square to its neighbour.
 */

import { toRadians } from '../units.js';
import {
  type Vec3,
  add3,
  cross3,
  dot3,
  normalize3,
  rotateAbout,
  scale3,
  sub3,
} from '../geometry/vec3.js';
import { type FaceId, type PartId } from '../ids.js';
import { type Frame3, type FoldedPart, frameFor, toWorld } from '../unfold/fold.js';
import { type Face, type FaceBendGraph, edgeLength, namedEdge } from './graph.js';

/** A named edge of a named face, on a named part. */
export interface AssemblyEdgeRef {
  readonly partId: PartId;
  readonly faceId: FaceId;
  readonly edgeName: string;
}

export interface EdgeMate {
  readonly id: string;
  /** The part this mate places. */
  readonly part: PartId;
  readonly edge: { readonly faceId: FaceId; readonly edgeName: string };
  /** The already-placed part it is brought against. */
  readonly to: PartId;
  readonly toEdge: { readonly faceId: FaceId; readonly edgeName: string };
  /** Departure from flat, degrees. 90 stands the part square to its neighbour. */
  readonly angleDeg: number;
  /** Slide along the shared edge, mm. */
  readonly offsetMm?: number;
  /**
   * Lift the placed part off the host's face by this much, mm — signed, along
   * the host face's outward normal.
   *
   * Zero is a butt joint: the two neutral surfaces meet on the corner line.
   * One thickness is a **lap**: one sheet lies on the other, which is what a
   * panel landing on a folded lip actually does. Without it the two sheets
   * would occupy the same space and nothing downstream would say so. Negative
   * puts the placed part behind the host's face, which is the same lap seen
   * from the other side.
   */
  readonly standoffMm?: number;
  /**
   * Move the placed part past the host's edge by this much, mm — signed, along
   * the host face's own plane, away from its material.
   *
   * Zero is the plain case, the one a bend does: the two parts hinge about the
   * shared line. Positive carries the placed part beyond the edge, which is
   * what a panel lying on a lip does — the lip is folded off that edge, so the
   * panel it carries sits a lip's rise past it. Negative brings the placed part
   * back over the host's own material.
   *
   * Together with `standoffMm` this fixes the placed edge anywhere in the plane
   * across the seam, and with `offsetMm` and `angleDeg` that is the whole rigid
   * placement. Nothing here is solved for: every number is stated.
   */
  readonly beyondMm?: number;
  readonly label?: string;
}

export interface Assembly {
  /** The part that stays where it is; everything else is placed onto it. */
  readonly rootPartId: PartId;
  readonly mates: readonly EdgeMate[];
}

/** A part's own 3D space, positioned in the assembly's. */
export interface Placement {
  readonly partId: PartId;
  readonly frame: Frame3;
}

export interface AssemblyProblem {
  readonly mateId?: string;
  readonly partId?: PartId;
  readonly message: string;
}

/** The identity placement: a part's own space is the assembly's. */
export const AT_ORIGIN: Frame3 = {
  origin: { x: 0, y: 0, z: 0 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 1, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
};

/** Carry a point out of a part's own space into the assembly's. */
export function placePoint(frame: Frame3, p: Vec3): Vec3 {
  return add3(
    frame.origin,
    add3(scale3(frame.xAxis, p.x), add3(scale3(frame.yAxis, p.y), scale3(frame.normal, p.z))),
  );
}

/** Carry a direction across; unlike a point, translation does not apply. */
export function placeDirection(frame: Frame3, d: Vec3): Vec3 {
  return add3(
    scale3(frame.xAxis, d.x),
    add3(scale3(frame.yAxis, d.y), scale3(frame.normal, d.z)),
  );
}

/** Put one frame inside another, so a part's face frame lands in the assembly. */
export function placeFrame(outer: Frame3, inner: Frame3): Frame3 {
  return {
    origin: placePoint(outer, inner.origin),
    xAxis: placeDirection(outer, inner.xAxis),
    yAxis: placeDirection(outer, inner.yAxis),
    normal: placeDirection(outer, inner.normal),
  };
}

/**
 * Carry a whole folded part into assembly space.
 *
 * Everything in a `FoldedPart` is already world geometry in that part's own
 * space, so placing it is one rigid transform applied to every frame, axis and
 * tangent. Doing it here rather than in the renderer means the assembly view
 * and any geometric check see exactly the same numbers.
 */
export function placeFoldedPart(folded: FoldedPart, at: Frame3): FoldedPart {
  return {
    ...folded,
    faces: folded.faces.map((f) => ({ ...f, frame: placeFrame(at, f.frame) })),
    bends: folded.bends.map((b) => ({
      ...b,
      axisOrigin: placePoint(at, b.axisOrigin),
      axisDir: placeDirection(at, b.axisDir),
      tangentA: [placePoint(at, b.tangentA[0]), placePoint(at, b.tangentA[1])] as const,
      tangentB: [placePoint(at, b.tangentB[0]), placePoint(at, b.tangentB[1])] as const,
    })),
  };
}

/** What a part looks like once it is placed: its folded form and where it sits. */
export interface PlacedPart {
  readonly partId: PartId;
  readonly graph: FaceBendGraph;
  readonly folded: FoldedPart;
}

export interface WorldEdge {
  readonly p0: Vec3;
  readonly p1: Vec3;
  /** Unit direction from p0 to p1. */
  readonly dir: Vec3;
  /** The face's outward normal, in assembly space. */
  readonly normal: Vec3;
  /** In-plane direction from the edge into the face's own material. */
  readonly inward: Vec3;
}

/**
 * One named edge of one face, in assembly space.
 *
 * `inward` is the direction the face's material lies in, measured from the
 * edge. Edges are directed with their material on the left, so in 3D that is
 * the face normal crossed into the edge direction — and it is what the mate
 * angle is measured between.
 */
export function worldEdge(
  placed: PlacedPart,
  placement: Frame3,
  faceId: FaceId,
  edgeName: string,
): WorldEdge {
  const face: Face | undefined = placed.graph.faces.get(faceId);
  if (face === undefined) throw new Error(`part ${placed.partId} has no face ${faceId}`);
  const edge = namedEdge(face, edgeName);
  const faceFrame = placeFrame(placement, frameFor(placed.folded, faceId));
  const p0 = toWorld(faceFrame, edge.p0);
  const p1 = toWorld(faceFrame, edge.p1);
  const dir = normalize3(sub3(p1, p0));
  const normal = faceFrame.normal;
  return { p0, p1, dir, normal, inward: cross3(normal, dir) };
}

/**
 * Structural checks on an assembly.
 *
 * The tree property is the one that matters: a part placed twice has two
 * answers for where it is, and a cycle has none that agree. Both are reported
 * rather than resolved, because either is a modelling mistake.
 */
export function checkAssembly(
  assembly: Assembly,
  parts: ReadonlyMap<PartId, PlacedPart>,
): AssemblyProblem[] {
  const problems: AssemblyProblem[] = [];

  if (!parts.has(assembly.rootPartId)) {
    problems.push({
      partId: assembly.rootPartId,
      message: `the root part ${assembly.rootPartId} is not in the document`,
    });
  }

  const placedBy = new Map<PartId, string>();
  for (const mate of assembly.mates) {
    const already = placedBy.get(mate.part);
    if (mate.part === assembly.rootPartId) {
      problems.push({
        mateId: mate.id,
        message: `${mate.part} is the root, so it cannot also be placed by a mate`,
      });
      continue;
    }
    if (already !== undefined) {
      problems.push({
        mateId: mate.id,
        message: `${mate.part} is placed twice, by ${already} and by ${mate.id}`,
      });
      continue;
    }
    placedBy.set(mate.part, mate.id);
  }

  for (const mate of assembly.mates) {
    const a = parts.get(mate.part);
    const b = parts.get(mate.to);
    if (a === undefined) {
      problems.push({ mateId: mate.id, message: `no part called ${mate.part}` });
      continue;
    }
    if (b === undefined) {
      problems.push({ mateId: mate.id, message: `no part called ${mate.to}` });
      continue;
    }
    const lengthA = edgeOf(a, mate.edge.faceId, mate.edge.edgeName);
    const lengthB = edgeOf(b, mate.toEdge.faceId, mate.toEdge.edgeName);
    if (typeof lengthA === 'string') {
      problems.push({ mateId: mate.id, message: `on ${mate.part}: ${lengthA}` });
      continue;
    }
    if (typeof lengthB === 'string') {
      problems.push({ mateId: mate.id, message: `on ${mate.to}: ${lengthB}` });
      continue;
    }
    if (Math.abs(lengthA - lengthB) > 1e-6) {
      problems.push({
        mateId: mate.id,
        message: `the two edges are ${lengthA.toFixed(3)} and ${lengthB.toFixed(3)} mm long, so they do not meet along their whole length`,
      });
    }
    if (!Number.isFinite(mate.standoffMm ?? 0) || !Number.isFinite(mate.beyondMm ?? 0)) {
      problems.push({ mateId: mate.id, message: 'standoff and beyond must be finite numbers of mm' });
    }
    if (!(mate.angleDeg > -180 && mate.angleDeg < 180)) {
      problems.push({ mateId: mate.id, message: 'mate angle is a departure from flat, so it sits between -180 and 180' });
    }
  }

  // Everything must hang off the root by some chain of mates.
  const reachable = new Set<PartId>([assembly.rootPartId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const mate of assembly.mates) {
      if (reachable.has(mate.to) && !reachable.has(mate.part)) {
        reachable.add(mate.part);
        grew = true;
      }
    }
  }
  for (const mate of assembly.mates) {
    if (!reachable.has(mate.part)) {
      problems.push({
        mateId: mate.id,
        message: `${mate.part} is not reachable from the root part; its mate chain loops or hangs off nothing`,
      });
    }
  }
  for (const partId of parts.keys()) {
    if (!reachable.has(partId)) {
      problems.push({ partId, message: `${partId} is never placed, so the assembly does not say where it goes` });
    }
  }

  return problems;
}

function edgeOf(part: PlacedPart, faceId: FaceId, edgeName: string): number | string {
  const face = part.graph.faces.get(faceId);
  if (face === undefined) return `no face called ${faceId}`;
  try {
    return edgeLength(namedEdge(face, edgeName));
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export class AssemblyError extends Error {
  constructor(public readonly problems: readonly AssemblyProblem[]) {
    super(`the assembly cannot be placed:\n  ${problems.map((p) => p.message).join('\n  ')}`);
    this.name = 'AssemblyError';
  }
}

/**
 * Work out where every part goes.
 *
 * Breadth-first from the root, exactly as the unfold walks the face tree, so a
 * placement error surfaces near the root where it is easiest to read.
 */
export function solveAssembly(
  assembly: Assembly,
  parts: ReadonlyMap<PartId, PlacedPart>,
): Map<PartId, Frame3> {
  const problems = checkAssembly(assembly, parts);
  if (problems.length > 0) throw new AssemblyError(problems);

  const placements = new Map<PartId, Frame3>([[assembly.rootPartId, AT_ORIGIN]]);
  const byTarget = new Map<PartId, EdgeMate[]>();
  for (const mate of assembly.mates) {
    const list = byTarget.get(mate.to) ?? [];
    list.push(mate);
    byTarget.set(mate.to, list);
  }

  const queue: PartId[] = [assembly.rootPartId];
  while (queue.length > 0) {
    const hostId = queue.shift()!;
    for (const mate of byTarget.get(hostId) ?? []) {
      if (placements.has(mate.part)) continue;
      const host = parts.get(mate.to)!;
      const guest = parts.get(mate.part)!;
      const target = worldEdge(host, placements.get(hostId)!, mate.toEdge.faceId, mate.toEdge.edgeName);
      placements.set(mate.part, solveMate(guest, mate, target));
      queue.push(mate.part);
    }
  }

  return placements;
}

/**
 * The placement that satisfies one mate.
 *
 * Three steps, and they are the same three the unfold uses to place a face off
 * a bend: line the two edges up antiparallel, bring them together, then open
 * the dihedral to the angle asked for.
 */
function solveMate(guest: PlacedPart, mate: EdgeMate, target: WorldEdge): Frame3 {
  // The guest's mate edge, in the guest's own space.
  const local = worldEdge(guest, AT_ORIGIN, mate.edge.faceId, mate.edge.edgeName);

  // 1. Rotate the guest so its edge runs *against* the target's, and its
  //    material starts out folded flat away from the host's.
  const axis = target.dir;
  let frame = alignTo(local, { dir: scale3(axis, -1), inward: scale3(target.inward, -1) });

  // 2. Open the dihedral. Positive carries the guest's material toward the
  //    back of the host face, matching the bend convention where +theta about
  //    the line carries the far material toward -n.
  const theta = toRadians(mate.angleDeg);
  if (theta !== 0) frame = rotateFrame(frame, axis, theta);

  // 3. Slide the guest's edge start onto the target's edge end — they run
  //    opposite ways, so those are the ends that coincide — plus the three
  //    offsets, each along one axis of the target edge's own frame: along the
  //    seam, off the host's face, and past the host's edge.
  const guestStart = placePoint(frame, local.p0);
  const anchor = add3(
    target.p1,
    add3(
      scale3(axis, -(mate.offsetMm ?? 0)),
      add3(
        scale3(target.normal, mate.standoffMm ?? 0),
        scale3(target.inward, -(mate.beyondMm ?? 0)),
      ),
    ),
  );
  return { ...frame, origin: add3(frame.origin, sub3(anchor, guestStart)) };
}

/**
 * A rotation-only frame carrying one edge's (direction, inward) pair onto
 * another's. Both pairs are orthonormal by construction, so this is the change
 * of basis between two right-handed triples.
 */
function alignTo(
  from: { dir: Vec3; inward: Vec3 },
  to: { dir: Vec3; inward: Vec3 },
): Frame3 {
  const f = orthonormal(from.dir, from.inward);
  const t = orthonormal(to.dir, to.inward);
  // Rows of `from` dotted into columns of `to`: the matrix taking f to t.
  const image = (v: Vec3): Vec3 =>
    add3(
      scale3(t[0], dot3(v, f[0])),
      add3(scale3(t[1], dot3(v, f[1])), scale3(t[2], dot3(v, f[2]))),
    );
  return {
    origin: { x: 0, y: 0, z: 0 },
    xAxis: image({ x: 1, y: 0, z: 0 }),
    yAxis: image({ x: 0, y: 1, z: 0 }),
    normal: image({ x: 0, y: 0, z: 1 }),
  };
}

function orthonormal(dir: Vec3, inward: Vec3): [Vec3, Vec3, Vec3] {
  const a = normalize3(dir);
  const b = normalize3(sub3(inward, scale3(a, dot3(inward, a))));
  return [a, b, cross3(a, b)];
}

function rotateFrame(frame: Frame3, axis: Vec3, radians: number): Frame3 {
  return {
    origin: rotateAbout(frame.origin, axis, radians),
    xAxis: rotateAbout(frame.xAxis, axis, radians),
    yAxis: rotateAbout(frame.yAxis, axis, radians),
    normal: rotateAbout(frame.normal, axis, radians),
  };
}
