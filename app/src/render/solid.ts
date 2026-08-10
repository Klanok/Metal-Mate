/**
 * Folded part -> renderable geometry.
 *
 * Kept free of Three.js so it can be tested in Node: this module produces
 * plain numbers (2D outlines plus a placement matrix per face, and a triangle
 * soup per bend), and the viewport component turns them into meshes.
 *
 * Both faces and bend zones are drawn as slabs half a thickness either side of
 * the surface the core models. The core places profiles on the neutral
 * surface, which sits at K*T from the inside rather than exactly halfway, so
 * this is about 0.07 mm out on 1.2 mm stock. It is a display approximation and
 * nothing measures it — but faces and bends use the *same* approximation, so
 * they still meet exactly at the tangent lines and the shell has no seams.
 */

import type { FaceBendGraph, FoldedBend, FoldedPart, Vec2, Vec3 } from '@metal-mate/core';
import { add3, cross3, linearise, normalize3, rotateAbout, scale3, sub3 } from '@metal-mate/core';

export interface FacePiece {
  readonly faceId: string;
  readonly label: string;
  /** Outer boundary in face-local 2D, linearised for triangulation. */
  readonly outer: readonly Vec2[];
  readonly holes: readonly (readonly Vec2[])[];
  /** Column-major 4x4, as Three.js `Matrix4.fromArray` wants it. */
  readonly matrix: readonly number[];
  readonly thickness: number;
}

export interface BendPiece {
  readonly bendId: string;
  readonly direction: 'up' | 'down';
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

/** How finely a bend arc is tessellated, in degrees per segment. */
const BEND_STEP_DEG = 5;

export function facePieces(graph: FaceBendGraph, folded: FoldedPart): FacePiece[] {
  const out: FacePiece[] = [];
  const half = folded.thickness / 2;
  for (const { faceId, frame } of folded.faces) {
    const face = graph.faces.get(faceId);
    if (face === undefined) continue;
    const normal = normalize3(frame.normal);
    // Drop the frame back half a thickness so extruding by T straddles the
    // surface the core placed rather than sitting on one side of it.
    const origin = sub3(frame.origin, scale3(normal, half));
    out.push({
      faceId: String(faceId),
      label: face.label ?? String(faceId),
      outer: linearise(face.profile.outer),
      holes: face.profile.inners.map((l) => linearise(l)),
      matrix: matrixFrom(frame.xAxis, frame.yAxis, normal, origin),
      thickness: folded.thickness,
    });
  }
  return out;
}

/**
 * Column-major 4x4 placing a face's local (x, y, extrusion) frame in world.
 * The face's own axes are already unit and perpendicular, so this is a pure
 * rotation plus translation — no normalisation games needed.
 */
function matrixFrom(x: Vec3, y: Vec3, z: Vec3, origin: Vec3): number[] {
  return [
    x.x, x.y, x.z, 0,
    y.x, y.y, y.z, 0,
    z.x, z.y, z.z, 0,
    origin.x, origin.y, origin.z, 1,
  ];
}

/**
 * The curved slab through a bend.
 *
 * The bend zone is a cylinder patch: sweep the (straight) bend line about the
 * bend axis. Two surfaces half a thickness either side of the neutral one,
 * plus the two end caps, gives a closed shell that meets the flat faces
 * exactly at the tangent lines.
 */
export function bendPiece(bend: FoldedBend, thickness: number): BendPiece | null {
  // At fraction 0 the "arc" is a flat strip; the adjoining faces already cover
  // that ground, so there is nothing to draw.
  if (!Number.isFinite(bend.currentRadius) || Math.abs(bend.sweepRad) < 1e-9) return null;

  const steps = Math.max(
    2,
    Math.ceil(Math.abs((bend.sweepRad * 180) / Math.PI) / BEND_STEP_DEG),
  );
  const half = thickness / 2;
  const axis = normalize3(bend.axisDir);
  const start = [bend.tangentA[0], bend.tangentA[1]] as const;

  const positions: number[] = [];
  // Rings of 4 points: [outer@end0, outer@end1, inner@end1, inner@end0].
  for (let i = 0; i <= steps; i++) {
    const angle = (bend.sweepRad * i) / steps;
    for (const offset of [half, -half]) {
      for (const end of offset > 0 ? [0, 1] : [1, 0]) {
        const p = start[end]!;
        const spun = add3(bend.axisOrigin, rotateAbout(sub3(p, bend.axisOrigin), axis, angle));
        // Radial direction, from the axis out through this point.
        const radial = radialAt(spun, bend.axisOrigin, axis);
        const shifted = add3(spun, scale3(radial, offset));
        positions.push(shifted.x, shifted.y, shifted.z);
      }
    }
  }

  const indices: number[] = [];
  const ring = 4;
  for (let i = 0; i < steps; i++) {
    const a = i * ring;
    const b = (i + 1) * ring;
    for (let k = 0; k < ring; k++) {
      const k2 = (k + 1) % ring;
      indices.push(a + k, b + k, a + k2);
      indices.push(a + k2, b + k, b + k2);
    }
  }
  // Caps at each end of the bend line, so the slab reads as solid when the
  // camera looks along the bend.
  const last = steps * ring;
  indices.push(0, 2, 1, 0, 3, 2);
  indices.push(last + 0, last + 1, last + 2, last + 0, last + 2, last + 3);

  return {
    bendId: String(bend.bendId),
    direction: bend.direction,
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  };
}

/** Unit vector from the bend axis out to `p`, perpendicular to the axis. */
function radialAt(p: Vec3, axisOrigin: Vec3, axis: Vec3): Vec3 {
  const rel = sub3(p, axisOrigin);
  const along = rel.x * axis.x + rel.y * axis.y + rel.z * axis.z;
  const perpendicular = sub3(rel, scale3(axis, along));
  const len = Math.hypot(perpendicular.x, perpendicular.y, perpendicular.z);
  if (len < 1e-9) return normalize3(cross3(axis, { x: 0, y: 0, z: 1 }));
  return scale3(perpendicular, 1 / len);
}

export function bendPieces(folded: FoldedPart): BendPiece[] {
  const out: BendPiece[] = [];
  for (const bend of folded.bends) {
    const piece = bendPiece(bend, folded.thickness);
    if (piece !== null) out.push(piece);
  }
  return out;
}

/** Bounding sphere of everything, so the camera can frame the part. */
export function partExtent(
  graph: FaceBendGraph,
  folded: FoldedPart,
): { centre: Vec3; radius: number } {
  let min: Vec3 = { x: Infinity, y: Infinity, z: Infinity };
  let max: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const { faceId, frame } of folded.faces) {
    const face = graph.faces.get(faceId);
    if (face === undefined) continue;
    for (const v of face.profile.outer.verts) {
      const world = add3(frame.origin, add3(scale3(frame.xAxis, v.x), scale3(frame.yAxis, v.y)));
      min = { x: Math.min(min.x, world.x), y: Math.min(min.y, world.y), z: Math.min(min.z, world.z) };
      max = { x: Math.max(max.x, world.x), y: Math.max(max.y, world.y), z: Math.max(max.z, world.z) };
    }
  }
  if (!Number.isFinite(min.x)) return { centre: { x: 0, y: 0, z: 0 }, radius: 100 };
  const centre = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
  const radius = Math.max(1, Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z) / 2);
  return { centre, radius };
}
