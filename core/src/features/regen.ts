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
 * how a flange stops short of a corner.
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

  const id = makeFaceId(feature.id);
  const outer = rectangleFace(width, feature.lengthMm);
  const face: Face = {
    id,
    profile: profile(outer),
    featureId: feature.id,
    edges: new Map<string, DirectedEdge>([
      // `root` is the bend edge itself; `tip` the free edge; `start` and `end`
      // the two sides, named for the ends of the parent edge they came from.
      ['root', { p0: { x: 0, y: 0 }, p1: { x: width, y: 0 } }],
      ['tip', { p0: { x: width, y: feature.lengthMm }, p1: { x: 0, y: feature.lengthMm } }],
      ['start', { p0: { x: width, y: 0 }, p1: { x: width, y: feature.lengthMm } }],
      ['end', { p0: { x: 0, y: feature.lengthMm }, p1: { x: 0, y: 0 } }],
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

function rectangleFace(width: number, height: number): Loop {
  const pts: Vec2[] = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
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
