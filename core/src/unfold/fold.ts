/**
 * The folded (3D) view.
 *
 * Exactly the same traversal as the unfold, with rotations instead of
 * in-plane offsets — which is why the fold/unfold animation is nearly free:
 * call `fold` with a fraction between 0 and 1.
 *
 * Face profiles lie on the **neutral surface**, so the bend arc radius is
 * BA / theta = R + K*T and the developed length across a bend is exactly the
 * bend allowance the flat pattern used. At fraction 0 the faces lie flat, one
 * bend allowance apart, matching the flat pattern; at fraction 1 they sit at
 * the finished angle. Nothing has to be reconciled between the two views.
 *
 * Sign convention, fixed here and depended on by the templates: with `u` the
 * bend line direction on face A and `n` face A's normal, a rotation of +theta
 * about `u` carries the far-side material toward -n. So a 'down' bend rotates
 * by +theta and an 'up' bend by -theta.
 */

import { type Vec2 } from '../geometry/vec2.js';
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
import { type BendId, type FaceId } from '../ids.js';
import { type Material } from '../materials/material.js';
import { resolveAllowance } from '../materials/allowance.js';
import { toRadians } from '../units.js';
import { type BendDirection, type FaceBendGraph, assertGraphOk, incidentBends } from '../model/graph.js';

/** Placement of a face's local 2D frame in 3D. */
export interface Frame3 {
  readonly origin: Vec3;
  /** Image of the face-local +x direction. */
  readonly xAxis: Vec3;
  /** Image of the face-local +y direction. */
  readonly yAxis: Vec3;
  /** xAxis x yAxis. Points out of the "front" of the face. */
  readonly normal: Vec3;
}

export interface FoldedFace {
  readonly faceId: FaceId;
  readonly frame: Frame3;
}

export interface FoldedBend {
  readonly bendId: BendId;
  /** A point on the bend axis. */
  readonly axisOrigin: Vec3;
  /** Unit direction of the bend axis. */
  readonly axisDir: Vec3;
  /**
   * Radius of the neutral surface in the finished bend, mm — that is
   * BA / theta = R + K*T. A property of the bend, not of the animation, so
   * this is what the bend table reports.
   */
  readonly neutralRadius: number;
  /**
   * Radius to actually draw at this fraction, mm. The bend zone keeps its
   * developed length as the fold closes, so this runs from Infinity at
   * fraction 0 down to `neutralRadius` at fraction 1. This is what the
   * viewport needs.
   */
  readonly currentRadius: number;
  /** Signed rotation applied, radians. */
  readonly sweepRad: number;
  readonly direction: BendDirection;
  /** Tangent line on face A's side, in world coordinates. */
  readonly tangentA: readonly [Vec3, Vec3];
  /** Tangent line on face B's side, in world coordinates. */
  readonly tangentB: readonly [Vec3, Vec3];
}

export interface FoldedPart {
  readonly faces: readonly FoldedFace[];
  readonly bends: readonly FoldedBend[];
  readonly thickness: number;
  /** 0 = flat, 1 = fully folded. */
  readonly fraction: number;
}

export interface FoldOptions {
  readonly material: Material;
  /** 0 flat .. 1 folded. Drives the animation slider. */
  readonly fraction?: number;
  readonly baseFaceId?: FaceId;
}

export function fold(graph: FaceBendGraph, options: FoldOptions): FoldedPart {
  assertGraphOk(graph);
  const fraction = clamp01(options.fraction ?? 1);
  const baseFaceId = options.baseFaceId ?? graph.baseFaceId;

  const frames = new Map<FaceId, Frame3>([
    [
      baseFaceId,
      {
        origin: { x: 0, y: 0, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
      },
    ],
  ]);
  const bends: FoldedBend[] = [];
  const queue: FaceId[] = [baseFaceId];
  const done = new Set<BendId>();

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const frameA = frames.get(currentId)!;
    for (const { bend, other, fromA } of incidentBends(graph, currentId)) {
      if (done.has(bend.id)) continue;
      done.add(bend.id);

      const nearLine = fromA ? bend.lineA : bend.lineB;
      const farLine = fromA ? bend.lineB : bend.lineA;
      const allowance = resolveAllowance(bend, options.material, graph.thickness);
      const theta = toRadians(bend.angleDeg);
      const neutralRadius = allowance.bendAllowance / theta;

      const p0 = toWorld(frameA, nearLine.p0);
      const p1 = toWorld(frameA, nearLine.p1);
      const u = normalize3(sub3(p1, p0));
      const n = frameA.normal;
      // In-plane direction pointing away from face A's material across the
      // bend line. Material is on the left of `u`, i.e. toward n x u.
      const w = cross3(u, n);

      // 'down' sends the far material to -n, which is +theta about u.
      // Traversing the same bend from face B sees it the other way round.
      const sign = (bend.direction === 'down' ? 1 : -1) * (fromA ? 1 : -1);
      const sweep = sign * theta * fraction;

      // The bend zone keeps its developed length (the bend allowance) at every
      // fraction, so the arc radius shrinks from infinity down to BA/theta as
      // the fold closes. At fraction 0 this is exactly the flat pattern: the
      // two tangent lines one bend allowance apart, in the plane.
      let q0: Vec3;
      let q1: Vec3;
      let wFar: Vec3;
      let axisOrigin: Vec3;
      let currentRadius: number;
      if (fraction === 0) {
        const step = scale3(w, allowance.bendAllowance);
        q0 = add3(p0, step);
        q1 = add3(p1, step);
        wFar = w;
        axisOrigin = p0;
        currentRadius = Infinity;
      } else {
        const rho = allowance.bendAllowance / (theta * fraction);
        currentRadius = rho;
        const centreOffset = scale3(n, -sign * rho);
        const c0 = add3(p0, centreOffset);
        const c1 = add3(p1, centreOffset);
        q0 = add3(c0, rotateAbout(sub3(p0, c0), u, sweep));
        q1 = add3(c1, rotateAbout(sub3(p1, c1), u, sweep));
        wFar = rotateAbout(w, u, sweep);
        axisOrigin = c0;
      }

      if (!frames.has(other)) {
        frames.set(other, frameFromBendLine(farLine, q1, q0, wFar));
        queue.push(other);
      }

      bends.push({
        bendId: bend.id,
        axisOrigin,
        axisDir: u,
        neutralRadius,
        currentRadius,
        sweepRad: sweep,
        direction: bend.direction,
        tangentA: fromA ? [p0, p1] : [q1, q0],
        tangentB: fromA ? [q1, q0] : [p0, p1],
      });
    }
  }

  return {
    faces: [...frames.entries()].map(([faceId, frame]) => ({ faceId, frame })),
    bends,
    thickness: graph.thickness,
    fraction,
  };
}

export function toWorld(frame: Frame3, p: Vec2): Vec3 {
  return add3(frame.origin, add3(scale3(frame.xAxis, p.x), scale3(frame.yAxis, p.y)));
}

export function frameFor(part: FoldedPart, faceId: FaceId): Frame3 {
  const f = part.faces.find((x) => x.faceId === faceId);
  if (f === undefined) throw new Error(`face ${faceId} is not in the folded part`);
  return f.frame;
}

/**
 * Build a face's 3D frame from where its bend line landed.
 *
 * `line` is the face's own bend line in its local 2D frame (material on the
 * left); `worldP0`/`worldP1` are where its two ends go; `materialDir` is the
 * world direction its material extends in.
 */
function frameFromBendLine(
  line: { p0: Vec2; p1: Vec2 },
  worldP0: Vec3,
  worldP1: Vec3,
  materialDir: Vec3,
): Frame3 {
  const localDir = unit2(sub2(line.p1, line.p0));
  const localLeft = { x: -localDir.y, y: localDir.x };
  const worldDir = normalize3(sub3(worldP1, worldP0));
  const worldLeft = normalize3(materialDir);

  // Image of local (1,0) and (0,1), expressed in the (dir, left) basis.
  const xAxis = add3(scale3(worldDir, localDir.x), scale3(worldLeft, localLeft.x));
  const yAxis = add3(scale3(worldDir, localDir.y), scale3(worldLeft, localLeft.y));
  const originOffset = add3(scale3(xAxis, -line.p0.x), scale3(yAxis, -line.p0.y));
  return {
    origin: add3(worldP0, originOffset),
    xAxis,
    yAxis,
    normal: cross3(xAxis, yAxis),
  };
}

function sub2(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

function unit2(a: Vec2): Vec2 {
  const l = Math.hypot(a.x, a.y);
  return { x: a.x / l, y: a.y / l };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Angle between two face normals, degrees. Used by tests and the drawing view. */
export function angleBetween(a: Vec3, b: Vec3): number {
  const d = Math.max(-1, Math.min(1, dot3(normalize3(a), normalize3(b))));
  return (Math.acos(d) * 180) / Math.PI;
}
