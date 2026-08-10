/**
 * The unfold engine.
 *
 * Traverse the face-bend graph from the base face. Each face is placed in the
 * flat plane by a rigid transform; each bend contributes a rectangular bend
 * zone whose width is the bend allowance, separating the two faces' tangent
 * lines. Union the faces and bend zones for the outer boundary, subtract the
 * transformed cutouts, and record where every bend line ended up.
 *
 * Placement rule (the whole thing in one paragraph): a bend stores its bend
 * line in both faces' frames, each directed with its own face's material on the
 * left. Because the faces sit on opposite sides of the shared line, those two
 * directed lines are antiparallel. So placing face B is exactly "map B's bend
 * line onto A's bend line, offset by the bend allowance, running the other
 * way" — a rigid motion, never a mirror. Getting this convention right at the
 * model level is what keeps the engine itself free of special cases.
 */

import { booleans } from '../geometry/boolean.js';
import { type Loop, polygon } from '../geometry/loop.js';
import {
  type Profile,
  profile,
  profileArea,
  profileBounds,
  profileCutLength,
  transformProfile,
} from '../geometry/profile.js';
import { IDENTITY, type Xform2, apply, compose, fromSegmentToSegment, translation } from '../geometry/transform.js';
import { type Box2, type Vec2, add, lerp, normalize, rightNormal, scale, sub } from '../geometry/vec2.js';
import { type BendId, type FaceId } from '../ids.js';
import { applyCorners } from '../model/corner.js';
import { type AllowanceResult, resolveAllowance } from '../materials/allowance.js';
import { type Material } from '../materials/material.js';
import {
  type Bend,
  type BendDirection,
  type FaceBendGraph,
  assertGraphOk,
  getFace,
  incidentBends,
} from '../model/graph.js';

/**
 * Overlap area below which we call it numerical noise rather than
 * interference, in mm^2.
 *
 * The union comes back off the boolean kernel's integer grid while the input
 * areas are exact, so the difference carries a rounding error proportional to
 * the boundary length — a few tenths of a square micron on a benchtop-sized
 * blank. The floor therefore has to scale with the part: a fixed epsilon that
 * suits a 100 mm bracket reports a 1.8 m benchtop as self-overlapping.
 *
 * Real interference in sheet metal is square millimetres at least, so this
 * sits orders of magnitude below anything that could matter.
 */
function overlapNoiseFloor(totalAreaMm2: number): number {
  return Math.max(1e-4, totalAreaMm2 * 1e-8);
}

export interface PlacedFace {
  readonly faceId: FaceId;
  /** Face-local frame to flat-pattern frame. */
  readonly xform: Xform2;
  /** The face's profile, already in flat-pattern coordinates. */
  readonly profile: Profile;
}

export interface FlatBendLine {
  readonly bendId: BendId;
  readonly faceA: FaceId;
  readonly faceB: FaceId;
  /** Tangent line on face A's side of the bend zone, in flat coordinates. */
  readonly tangentA: readonly [Vec2, Vec2];
  /** Tangent line on face B's side. */
  readonly tangentB: readonly [Vec2, Vec2];
  /** Centreline of the bend zone — what gets drawn on the BEND_* layer. */
  readonly centreline: readonly [Vec2, Vec2];
  readonly angleDeg: number;
  readonly direction: BendDirection;
  readonly insideRadius: number;
  readonly lengthMm: number;
  readonly allowance: AllowanceResult;
  readonly dieWidth: number | undefined;
}

export interface FlatPattern {
  /** Outer boundary and cutouts of the developed blank. */
  readonly profile: Profile;
  readonly bendLines: readonly FlatBendLine[];
  readonly faces: readonly PlacedFace[];
  readonly bendZones: readonly Profile[];
  readonly bounds: Box2;
  /** Material area in mm^2 (holes removed). */
  readonly areaMm2: number;
  /** Total cut length in mm, outer plus every hole. */
  readonly cutLengthMm: number;
  /**
   * Area where placed faces or bend zones landed on top of each other, mm^2.
   * Anything above zero means the part cannot be made from one blank; the
   * validation layer turns this into a hard error.
   */
  readonly overlapAreaMm2: number;
  /** Number of disconnected pieces the blank came out in. 1 for a sane part. */
  readonly islandCount: number;
}

export interface UnfoldOptions {
  readonly material: Material;
  /** Override the graph's base face. */
  readonly baseFaceId?: FaceId;
  /** Skip the lower-left origin normalisation (used by tests). */
  readonly keepOrigin?: boolean;
}

export function unfold(inputGraph: FaceBendGraph, options: UnfoldOptions): FlatPattern {
  assertGraphOk(inputGraph);
  // Corner joints do their work here, by modifying the two faces' profiles
  // before anything is placed. They are never graph edges, so the tree the
  // placement walks is the same tree either way.
  const graph = applyCorners(inputGraph);
  const ops = booleans();
  const thickness = graph.thickness;
  const baseFaceId = options.baseFaceId ?? graph.baseFaceId;
  if (!graph.faces.has(baseFaceId)) throw new Error(`base face ${baseFaceId} is not in the graph`);

  const placements = new Map<FaceId, Xform2>([[baseFaceId, IDENTITY]]);
  const bendLines: FlatBendLine[] = [];
  const bendZones: Profile[] = [];

  // Breadth-first so that placement errors surface near the base face, where
  // they are easiest to interpret.
  const queue: FaceId[] = [baseFaceId];
  const visitedBends = new Set<BendId>();
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const currentXform = placements.get(currentId)!;
    for (const { bend, other, fromA } of incidentBends(graph, currentId)) {
      if (visitedBends.has(bend.id)) continue;
      visitedBends.add(bend.id);
      const allowance = resolveAllowance(bend, options.material, thickness);

      // Near side = the face we are standing on; far side = the one to place.
      const nearLine = fromA ? bend.lineA : bend.lineB;
      const farLine = fromA ? bend.lineB : bend.lineA;

      const n0 = apply(currentXform, nearLine.p0);
      const n1 = apply(currentXform, nearLine.p1);
      const u = normalize(sub(n1, n0));
      // The far face lies beyond the bend zone, on the right of the near
      // face's bend line (its material is on the left, by convention).
      const offset = scale(rightNormal(u), allowance.bendAllowance);
      const f0 = add(n1, offset);
      const f1 = add(n0, offset);

      const farXform = fromSegmentToSegment(farLine.p0, farLine.p1, f0, f1);
      const existing = placements.get(other);
      if (existing === undefined) {
        placements.set(other, farXform);
        queue.push(other);
      }

      bendZones.push(profile(polygon([n0, n1, f0, f1])));
      bendLines.push({
        bendId: bend.id,
        faceA: bend.faceA,
        faceB: bend.faceB,
        tangentA: fromA ? [n0, n1] : [f1, f0],
        tangentB: fromA ? [f1, f0] : [n0, n1],
        centreline: [lerp(n0, f1, 0.5), lerp(n1, f0, 0.5)],
        angleDeg: bend.angleDeg,
        direction: bend.direction,
        insideRadius: bend.insideRadius,
        lengthMm: Math.hypot(n1.x - n0.x, n1.y - n0.y),
        allowance,
        dieWidth: bend.dieWidth,
      });
    }
  }

  const placedFaces: PlacedFace[] = [...placements.entries()].map(([faceId, xform]) => ({
    faceId,
    xform,
    profile: transformProfile(xform, getFace(graph, faceId).profile),
  }));

  // Outer boundary: union of every face and bend zone, ignoring holes.
  const solidPieces: Profile[] = [
    ...placedFaces.map((p) => profile(p.profile.outer)),
    ...bendZones,
  ];
  const unioned = ops.union(solidPieces);
  const sumOfParts = solidPieces.reduce((acc, p) => acc + profileArea(p), 0);
  const unionArea = unioned.reduce((acc, p) => acc + profileArea(p), 0);
  const overlapAreaMm2 = Math.max(0, sumOfParts - unionArea);

  // Cutouts: every face's inner loops, in flat coordinates.
  const holes: Profile[] = [];
  for (const placed of placedFaces) {
    for (const inner of placed.profile.inners) holes.push(profile(inner));
  }
  const withHoles = holes.length > 0 ? ops.difference(unioned, holes) : unioned;

  const merged = mergeProfiles(withHoles);
  const normalised = options.keepOrigin === true ? merged : moveToOrigin(merged);
  const shift = options.keepOrigin === true ? IDENTITY : originShift(merged);

  return {
    profile: normalised,
    bendLines: bendLines.map((b) => shiftBendLine(b, shift)),
    faces: placedFaces.map((p) => ({
      faceId: p.faceId,
      xform: compose(shift, p.xform),
      profile: transformProfile(shift, p.profile),
    })),
    bendZones: bendZones.map((z) => transformProfile(shift, z)),
    bounds: profileBounds(normalised),
    areaMm2: profileArea(normalised),
    cutLengthMm: profileCutLength(normalised),
    overlapAreaMm2: overlapAreaMm2 > overlapNoiseFloor(sumOfParts) ? overlapAreaMm2 : 0,
    islandCount: withHoles.length,
  };
}

/**
 * Reduce the boolean result to a single profile. A tree graph always develops
 * into one connected blank, so more than one piece means something has gone
 * wrong upstream; we keep the largest so the caller still has geometry to show
 * alongside the error that `islandCount` triggers.
 */
function mergeProfiles(profiles: readonly Profile[]): Profile {
  if (profiles.length === 0) throw new Error('unfold produced no geometry');
  let best = profiles[0]!;
  let bestArea = profileArea(best);
  for (const p of profiles.slice(1)) {
    const a = profileArea(p);
    if (a > bestArea) {
      best = p;
      bestArea = a;
    }
  }
  return best;
}

function originShift(p: Profile): Xform2 {
  const box = profileBounds(p);
  return translation(-box.min.x, -box.min.y);
}

function moveToOrigin(p: Profile): Profile {
  return transformProfile(originShift(p), p);
}

function shiftBendLine(b: FlatBendLine, t: Xform2): FlatBendLine {
  const map = (pair: readonly [Vec2, Vec2]): readonly [Vec2, Vec2] => [
    apply(t, pair[0]),
    apply(t, pair[1]),
  ];
  return {
    ...b,
    tangentA: map(b.tangentA),
    tangentB: map(b.tangentB),
    centreline: map(b.centreline),
  };
}

/** Developed length across a chain of legs joined by bends: sum(legs) + sum(BA). */
export function developedLength(legs: readonly number[], allowances: readonly number[]): number {
  return legs.reduce((a, b) => a + b, 0) + allowances.reduce((a, b) => a + b, 0);
}

/** Convenience for building a rectangular face profile in a face-local frame. */
export function rectFace(width: number, height: number): Loop {
  return polygon([
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ]);
}
