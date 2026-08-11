/**
 * Ute canopy template — the skeleton.
 *
 * This is the second template pack, and it exists to answer the question the
 * architecture doc set for it: does the template layer actually hold, or does
 * the core turn out to know something about benchtops? So it is deliberately
 * the plainest canopy that is still a canopy — flat panels, square butt-welded
 * corners, no window apertures, no tapers, no tabs, no lips.
 *
 * What it does exercise, and what the benchtop never did:
 *
 *  - a template emitting **several parts and how they sit together**, rather
 *    than one part. `benchtopPart` returns a `Part`; a canopy is a set, so this
 *    returns a document. That difference is the finding.
 *  - the assembly tree: a root panel that stays put and every other panel
 *    brought to an already-placed one by a single edge mate.
 *
 * Dimensions are **outside** sizes, the way somebody measures a ute tray.
 * Panels lie on the neutral surface, so the six neutral planes form a box one
 * thickness smaller in each direction, and every panel is cut to that box. A
 * butt-welded corner is exactly that: the two neutral surfaces meet on the
 * corner line and the metal either side of them makes up the outside.
 *
 * KNOWN SIMPLIFICATION: the seams are butt joints with no weld gap and no
 * `CornerJoint` records, because joints still resolve inside one part's graph
 * and these are between parts. Once a joint can be carried across a mate, the
 * twelve seams here become twelve joints and the gap stops being zero.
 */

import { type GrainDirection, type Part } from '../features/types.js';
import { rectangleEdges, rectangleProfile } from '../features/regen.js';
import { type FaceId, faceId, featureId, partId } from '../ids.js';
import { type Assembly, type EdgeMate } from '../model/assembly.js';

export const CANOPY_TEMPLATE_KIND = 'canopy';

/** Which panel of the box a part is. */
export type CanopyPanel = 'floor' | 'roof' | 'front' | 'rear' | 'left' | 'right';

export interface CanopyParams {
  readonly name: string;
  /** Prefix for each panel's part number, e.g. "CAN" gives CAN-FLOOR. */
  readonly partPrefix?: string;
  readonly revision?: string;
  /** Outside length, front to back. */
  readonly lengthMm: number;
  /** Outside width, side to side. */
  readonly widthMm: number;
  /** Outside height, floor to roof. */
  readonly heightMm: number;
  readonly thicknessMm: number;
  readonly materialId: string;
  readonly bendRadiusMm: number;
  /**
   * Include a floor panel. A canopy that sits on the ute's own tray does not
   * need one, and leaving it out makes the roof the part everything hangs off.
   */
  readonly floor?: boolean;
  readonly grain?: GrainDirection;
}

export const DEFAULT_CANOPY: CanopyParams = {
  name: 'Canopy',
  partPrefix: 'CAN',
  lengthMm: 1800,
  widthMm: 1500,
  heightMm: 900,
  thicknessMm: 1.6,
  materialId: 'al5005',
  bendRadiusMm: 2,
  floor: true,
  grain: 'length',
};

export class CanopyParameterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanopyParameterError';
  }
}

/**
 * A template's whole output when it makes more than one part.
 *
 * The benchtop returns a `Part`; anything with an assembly has to return this.
 */
export interface TemplateDocument {
  readonly parts: readonly Part[];
  readonly assembly: Assembly;
}

/** Every panel this parameter set produces, in build order. */
export function canopyPanels(params: CanopyParams): CanopyPanel[] {
  const walls: CanopyPanel[] = ['front', 'rear', 'left', 'right'];
  return params.floor === false ? [...walls, 'roof'] : ['floor', ...walls, 'roof'];
}

const PANEL_LABELS: Record<CanopyPanel, string> = {
  floor: 'Floor',
  roof: 'Roof',
  front: 'Front (bulkhead)',
  rear: 'Rear (door opening)',
  left: 'Left side',
  right: 'Right side',
};

/** Generate the canopy's parts and how they sit together. */
export function canopyDocument(params: CanopyParams): TemplateDocument {
  const { thicknessMm: t, lengthMm, widthMm, heightMm } = params;
  if (t <= 0) throw new CanopyParameterError('thickness must be positive');
  if (params.bendRadiusMm <= 0) throw new CanopyParameterError('bend radius must be positive');

  // The neutral-surface box: one thickness smaller than the outside in each
  // direction, because every panel sits half a thickness inside its own face.
  const length = lengthMm - t;
  const width = widthMm - t;
  const height = heightMm - t;
  if (length <= 0 || width <= 0 || height <= 0) {
    throw new CanopyParameterError(
      `a ${lengthMm} x ${widthMm} x ${heightMm} mm canopy has nothing left once ${t} mm of thickness comes off each dimension`,
    );
  }

  const withFloor = params.floor !== false;
  const panels = canopyPanels(params);

  const parts = panels.map((panel) => panelPart(panel, params, { length, width, height }));

  // Mate tree. Everything hangs off one panel: the floor when there is one,
  // otherwise the roof, because a canopy that sits on the tray has no floor to
  // hang off and the roof is what ties the four walls together.
  const root = withFloor ? 'floor' : 'roof';
  const mates: EdgeMate[] = [];
  for (const wall of ['front', 'rear', 'left', 'right'] as const) {
    mates.push({
      id: `${root}-${wall}`,
      part: key(params, wall),
      // Each wall stands on its own bottom edge...
      edge: { faceId: panelFaceId(wall), edgeName: 'bottom' },
      to: key(params, root),
      // ...along the matching edge of the panel it hangs off. The floor and
      // roof carry the plain rectangle edge names, where the rear of the
      // canopy is the `back` edge.
      toEdge: { faceId: panelFaceId(root), edgeName: DECK_EDGE[wall] },
      angleDeg: 90,
      label: `${PANEL_LABELS[wall]} onto ${PANEL_LABELS[root]}`,
    });
  }
  if (withFloor) {
    // The roof lands on one wall's top edge. It touches all four, but a
    // placement tree allows exactly one relationship per part — the other three
    // contacts are seams, not placements, the same way a closed corner is not a
    // second bend.
    mates.push({
      id: 'left-roof',
      part: key(params, 'roof'),
      edge: { faceId: panelFaceId('roof'), edgeName: 'left' },
      to: key(params, 'left'),
      toEdge: { faceId: panelFaceId('left'), edgeName: 'top' },
      angleDeg: 90,
      label: 'Roof onto Left side',
    });
  }

  return { parts, assembly: { rootPartId: key(params, root), mates } };
}

interface Box {
  readonly length: number;
  readonly width: number;
  readonly height: number;
}

/**
 * One panel, as a flat plate with named boundary edges.
 *
 * Local x and y are chosen per panel so the edge names mean what they say:
 * a wall's `bottom` really is the edge that stands on the floor, and the
 * floor's `left` really is the edge the left wall stands on. That naming is
 * what the mates address, so getting it right here is what keeps the assembly
 * readable rather than a puzzle of rotations.
 */
function panelPart(panel: CanopyPanel, params: CanopyParams, box: Box): Part {
  const { length, width, height } = box;
  const plan: Record<CanopyPanel, { w: number; h: number; names?: EdgeNames }> = {
    // Floor and roof are seen from above: x across the width, y along the
    // length, so the default front/right/back/left already name the sides.
    floor: { w: width, h: length },
    roof: { w: width, h: length },
    // Walls are seen from outside: x along the wall, y up it.
    front: { w: width, h: height, names: WALL_EDGES },
    rear: { w: width, h: height, names: WALL_EDGES },
    left: { w: length, h: height, names: WALL_EDGES },
    right: { w: length, h: height, names: WALL_EDGES },
  };
  const { w, h, names } = plan[panel];

  return {
    parameters: {
      name: `${params.name} ${PANEL_LABELS[panel].toLowerCase()}`,
      materialId: params.materialId,
      thicknessMm: params.thicknessMm,
      grain: params.grain ?? 'length',
      partId: partNumber(params, panel),
      ...(params.revision !== undefined ? { revision: params.revision } : {}),
    },
    features: [
      {
        kind: 'base-flange',
        id: featureId(panel),
        profile: rectangleProfile(w, h),
        edges: names === undefined ? rectangleEdges(w, h) : rectangleEdges(w, h, names),
        label: PANEL_LABELS[panel],
      },
    ],
    template: { kind: CANOPY_TEMPLATE_KIND, params },
  };
}

/**
 * Which edge of the floor or roof each wall stands on.
 *
 * The walls are named for the ends of the canopy; a plain rectangle names its
 * sides front/right/back/left. Only the rear differs, and mapping it here beats
 * renaming the rectangle's edges, which every other template relies on.
 */
const DECK_EDGE: Record<'front' | 'rear' | 'left' | 'right', string> = {
  front: 'front',
  rear: 'back',
  left: 'left',
  right: 'right',
};

/** A wall's own edges, named for what they do rather than which way they face. */
const WALL_EDGES: EdgeNames = { front: 'bottom', right: 'right', back: 'top', left: 'left' };

type EdgeNames = { front: string; right: string; back: string; left: string };

/** Each panel part has exactly one face, named for the panel. */
function panelFaceId(panel: CanopyPanel): FaceId {
  return faceId(panel);
}

function partNumber(params: CanopyParams, panel: CanopyPanel): string {
  const prefix = params.partPrefix ?? 'CAN';
  return `${prefix}-${panel.toUpperCase()}`;
}

function key(params: CanopyParams, panel: CanopyPanel): ReturnType<typeof partId> {
  return partId(partNumber(params, panel));
}
