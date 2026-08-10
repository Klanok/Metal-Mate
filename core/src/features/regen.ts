/**
 * Regeneration: feature list -> face-bend graph.
 *
 * Runs on every parameter change. Deterministic and side-effect free: the same
 * feature list always produces the same graph, with the same ids, which is
 * what makes golden-file testing meaningful.
 */

import { type Loop, polygon } from '../geometry/loop.js';
import { type Profile, profile } from '../geometry/profile.js';
import { type Vec2, add, normalize, scale, sub } from '../geometry/vec2.js';
import { toRadians } from '../units.js';
import { bendId as makeBendId, faceId as makeFaceId, type FaceId } from '../ids.js';
import {
  type Bend,
  type DirectedEdge,
  type Face,
  type FaceBendGraph,
  buildGraph,
  edgeLength,
  namedEdge,
} from '../model/graph.js';
import { type EdgeFlangeFeature, type Feature, type Part } from './types.js';

export interface RegenResult {
  readonly graph: FaceBendGraph;
  /** Which feature produced which faces, for selection and the feature tree. */
  readonly facesByFeature: ReadonlyMap<string, readonly FaceId[]>;
}

export function regenerate(part: Part): RegenResult {
  const faces = new Map<FaceId, Face>();
  const bends: Bend[] = [];
  const facesByFeature = new Map<string, FaceId[]>();
  let baseFaceId: FaceId | null = null;

  const recordFace = (featureId: string, face: Face): void => {
    faces.set(face.id, face);
    const list = facesByFeature.get(featureId) ?? [];
    list.push(face.id);
    facesByFeature.set(featureId, list);
  };

  for (const feature of part.features) {
    switch (feature.kind) {
      case 'base-flange': {
        if (baseFaceId !== null) {
          throw new Error('a part may only have one base flange');
        }
        const id = makeFaceId(feature.id);
        recordFace(feature.id, {
          id,
          profile: feature.profile,
          featureId: feature.id,
          edges: new Map(Object.entries(feature.edges)),
          ...(feature.label !== undefined ? { label: feature.label } : {}),
        });
        baseFaceId = id;
        break;
      }
      case 'edge-flange': {
        const parent = faces.get(feature.edge.faceId);
        if (parent === undefined) {
          throw new Error(
            `feature ${feature.id} targets face ${feature.edge.faceId}, which does not exist yet`,
          );
        }
        const { face, bend } = buildEdgeFlange(feature, parent);
        recordFace(feature.id, face);
        bends.push(bend);
        break;
      }
      case 'cutout': {
        const target = faces.get(feature.faceId);
        if (target === undefined) {
          throw new Error(
            `cutout ${feature.id} targets face ${feature.faceId}, which does not exist yet`,
          );
        }
        faces.set(target.id, {
          ...target,
          profile: profile(target.profile.outer, [...target.profile.inners, feature.loop]),
        });
        break;
      }
    }
  }

  if (baseFaceId === null) throw new Error('a part must start with a base flange feature');
  return {
    graph: buildGraph([...faces.values()], bends, baseFaceId, part.parameters.thicknessMm),
    facesByFeature,
  };
}

/**
 * Build the flange face and the bend that attaches it.
 *
 * The flange's own frame puts its bend edge along the local x axis from the
 * origin, so its material sits above the axis and therefore to the left of
 * (0,0)->(L,0) — the direction convention the unfold engine relies on.
 *
 * The insets trim the flange back from each end of the parent edge, which is
 * how a flange stops short of a corner. The mitres rake the ends instead of
 * cutting them square, which is how two flanges meeting at a corner close
 * against each other. Both leave the bend line itself alone except for the
 * insets, so the flange is still a rigid body hinged on a straight line.
 */
function buildEdgeFlange(
  feature: EdgeFlangeFeature,
  parent: Face,
): { face: Face; bend: Bend } {
  const parentEdge = namedEdge(parent, feature.edge.edgeName);
  const insetStart = feature.insetStartMm ?? 0;
  const insetEnd = feature.insetEndMm ?? 0;
  const full = edgeLength(parentEdge);
  const width = full - insetStart - insetEnd;
  if (width <= 0) {
    throw new Error(
      `feature ${feature.id}: insets (${insetStart} + ${insetEnd} mm) leave no bend line on a ${full.toFixed(1)} mm edge`,
    );
  }
  if (feature.lengthMm <= 0) {
    throw new Error(`feature ${feature.id}: flange length must be positive`);
  }

  const dir = normalize(sub(parentEdge.p1, parentEdge.p0));
  const lineA: DirectedEdge = {
    p0: add(parentEdge.p0, scale(dir, insetStart)),
    p1: sub(parentEdge.p1, scale(dir, insetEnd)),
  };

  const length = feature.lengthMm;
  // How far each mitre cuts across the tip. The start end is at local x =
  // width, so its rake moves the tip corner inward (negative x); the end end is
  // at local x = 0, so its rake moves that corner outward (positive x).
  const rakeStart = mitreRake(feature.mitreStartDeg, length, feature.id, 'start');
  const rakeEnd = mitreRake(feature.mitreEndDeg, length, feature.id, 'end');
  const tipStartX = width - rakeStart;
  const tipEndX = rakeEnd;
  if (tipStartX - tipEndX <= 0) {
    throw new Error(
      `feature ${feature.id}: the mitres meet before the tip — a ${length.toFixed(1)} mm flange on a ${width.toFixed(1)} mm edge cannot carry them`,
    );
  }

  const id = makeFaceId(feature.id);
  const outer = flangeFace(width, length, tipStartX, tipEndX);
  const face: Face = {
    id,
    profile: profile(outer),
    featureId: feature.id,
    edges: new Map<string, DirectedEdge>([
      // `root` is the bend edge itself; `tip` the free edge; `start` and `end`
      // the two sides, named for the ends of the parent edge they came from.
      // A mitre shortens `tip`, so anything flanged off it — the upstand of a
      // boxed edge — inherits the mitre without having to know about it.
      ['root', { p0: { x: 0, y: 0 }, p1: { x: width, y: 0 } }],
      ['tip', { p0: { x: tipStartX, y: length }, p1: { x: tipEndX, y: length } }],
      ['start', { p0: { x: width, y: 0 }, p1: { x: tipStartX, y: length } }],
      ['end', { p0: { x: tipEndX, y: length }, p1: { x: 0, y: 0 } }],
    ]),
    ...(feature.label !== undefined ? { label: feature.label } : {}),
  };

  const bend: Bend = {
    id: makeBendId(feature.id, 'bend'),
    faceA: parent.id,
    faceB: id,
    lineA,
    lineB: { p0: { x: 0, y: 0 }, p1: { x: width, y: 0 } },
    angleDeg: feature.angleDeg,
    direction: feature.direction,
    insideRadius: feature.insideRadiusMm,
    ...(feature.dieWidthMm !== undefined ? { dieWidth: feature.dieWidthMm } : {}),
    ...(feature.allowanceOverrideMm !== undefined
      ? { allowanceOverride: feature.allowanceOverrideMm }
      : {}),
    ...(feature.label !== undefined ? { label: feature.label } : {}),
  };

  return { face, bend };
}

/**
 * How far a mitre cuts across the tip of a flange, mm.
 *
 * The angle is measured from a square cut, so 0 rakes nothing and 45 rakes back
 * by exactly the flange's own length — the mitre that closes a right-angled
 * corner. Past 85 degrees the tangent runs away, and an angle that steep is a
 * modelling mistake rather than something a brake could form.
 */
function mitreRake(
  angleDeg: number | undefined,
  length: number,
  featureId: string,
  which: 'start' | 'end',
): number {
  if (angleDeg === undefined || angleDeg === 0) return 0;
  if (Math.abs(angleDeg) >= 85) {
    throw new Error(
      `feature ${featureId}: ${which} mitre of ${angleDeg} degrees is too steep to cut; keep it under 85`,
    );
  }
  return Math.tan(toRadians(angleDeg)) * length;
}

/**
 * The flange outline: a rectangle when both ends are square, a trapezoid once
 * either end is mitred. Written as one polygon rather than a rectangle plus a
 * trim so the vertex count never depends on whether a mitre happens to be zero.
 */
function flangeFace(width: number, length: number, tipStartX: number, tipEndX: number): Loop {
  const pts: Vec2[] = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: tipStartX, y: length },
    { x: tipEndX, y: length },
  ];
  return polygon(pts);
}

/** Named edges for an axis-aligned rectangular sketch, counter-clockwise. */
export function rectangleEdges(
  width: number,
  depth: number,
  names: { front: string; right: string; back: string; left: string } = {
    front: 'front',
    right: 'right',
    back: 'back',
    left: 'left',
  },
): Record<string, DirectedEdge> {
  return {
    [names.front]: { p0: { x: 0, y: 0 }, p1: { x: width, y: 0 } },
    [names.right]: { p0: { x: width, y: 0 }, p1: { x: width, y: depth } },
    [names.back]: { p0: { x: width, y: depth }, p1: { x: 0, y: depth } },
    [names.left]: { p0: { x: 0, y: depth }, p1: { x: 0, y: 0 } },
  };
}

/** A rectangular base-flange profile matching `rectangleEdges`. */
export function rectangleProfile(width: number, depth: number): Profile {
  return profile(polygon([
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: depth },
    { x: 0, y: depth },
  ]));
}
