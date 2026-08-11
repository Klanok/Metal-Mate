/**
 * Ute canopy template — the skeleton.
 *
 * This is the second template pack, and it exists to answer the question the
 * architecture doc set for it: does the template layer actually hold, or does
 * the core turn out to know something about benchtops? So it is deliberately
 * the plainest canopy that is still a canopy — flat panels, square corners, no
 * window apertures, no tapers, no tabs.
 *
 * The one piece of real construction it does carry is the **lip**: each wall
 * turns inward at the top and bottom, and the roof and the floor land on those
 * lips rather than butting edge to edge. That is how a canopy is actually put
 * together — a butt-welded box has nothing to clamp, nothing to bolt through
 * and no stiffness at the seam — and it is what forced the mate to be able to
 * say "one thickness up and a lip's rise past the edge" rather than only
 * "hinged about the edge".
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

import { type Feature, type GrainDirection, type Part } from '../features/types.js';
import { outsideSetback } from '../materials/allowance.js';
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
  /**
   * Outside depth of the lip folded inward around the top and bottom of each
   * wall, mm — measured from the wall's outside surface, the way you would put
   * a rule on it. Zero leaves the plain skeleton with nothing to fix the roof
   * to.
   *
   * CONSTRUCTION: lips on the **walls**, roof and floor lapping over them. The
   * roof lies on the top lips and the bottom lips lie on the floor, so a
   * thickness comes out of the wall at each end and the finished outside height
   * is still the one that was asked for.
   */
  readonly lipMm?: number;
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
  lipMm: 25,
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
  const lip = params.lipMm ?? 0;
  if (lip < 0) throw new CanopyParameterError('lip depth cannot be negative');
  const setback = outsideSetback(90, params.bendRadiusMm, t);
  if (lip > 0 && lip <= setback) {
    throw new CanopyParameterError(
      `a ${lip} mm lip is inside the ${setback.toFixed(2)} mm the bend itself takes, so there is no flat to fold`,
    );
  }
  const withFloor = params.floor !== false;
  const length = lengthMm - t;
  const width = widthMm - t;
  // How far the walls run from the roof's neutral surface. With a floor that is
  // the neutral box, floor to roof. Without one the walls stand on the tray, so
  // their cut bottom edge is the outside bottom and only the roof's own half
  // thickness comes off.
  const height = withFloor ? heightMm - t : heightMm - t / 2;
  if (length <= 0 || width <= 0 || height <= 0) {
    throw new CanopyParameterError(
      `a ${lengthMm} x ${widthMm} x ${heightMm} mm canopy has nothing left once ${t} mm of thickness comes off each dimension`,
    );
  }

  const panels = canopyPanels(params);

  const parts = panels.map((panel) => panelPart(panel, params, { length, width, height }));

  // Mate tree. Everything hangs off one panel: the floor when there is one,
  // otherwise the roof, because a canopy that sits on the tray has no floor to
  // hang off and the roof is what ties the four walls together.
  const root = withFloor ? 'floor' : 'roof';

  const lipRise = lipRiseFor(params);

  const mates: EdgeMate[] = [];
  for (const wall of ['front', 'rear', 'left', 'right'] as const) {
    mates.push({
      id: `${root}-${wall}`,
      part: key(params, wall),
      // With a floor, each wall stands on its own bottom edge; without one it
      // hangs from its top edge off the roof, which is the panel that is there.
      edge: { faceId: panelFaceId(wall), edgeName: withFloor ? 'bottom' : 'top' },
      to: key(params, root),
      // ...along the matching edge of the panel it hangs off. The floor and
      // roof carry the plain rectangle edge names, where the rear of the
      // canopy is the `back` edge.
      toEdge: { faceId: panelFaceId(root), edgeName: DECK_EDGE[wall] },
      angleDeg: 90,
      // The lip lies on the deck, so the wall's plate starts a lip's rise into
      // the box — the far side of the deck from its own outward normal, which
      // faces out of the box.
      standoffMm: -lipRise,
      label: `${PANEL_LABELS[wall]} onto ${PANEL_LABELS[root]}`,
    });
  }
  if (withFloor) {
    // The roof lands on one wall's top lip. It sits on all four, but a
    // placement tree allows exactly one relationship per part — the other three
    // contacts are seams, not placements, the same way a closed corner is not a
    // second bend.
    //
    // `beyondMm` is the lap: the roof does not hinge about the wall's top edge,
    // it lies a lip's rise past it, on top of the lip folded off that edge.
    mates.push({
      id: 'left-roof',
      part: key(params, 'roof'),
      edge: { faceId: panelFaceId('roof'), edgeName: 'left' },
      to: key(params, 'left'),
      toEdge: { faceId: panelFaceId('left'), edgeName: 'top' },
      angleDeg: 90,
      beyondMm: lipRise,
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
  const { length, width } = box;
  // A wall spans the box top to bottom, less what each lip takes. The mates
  // hand that same rise back, so the two always agree: whatever comes off the
  // plate here is exactly how far the lip carries the panel that lands on it.
  const height = box.height - lipEdgesFor(panel, params).length * lipRiseFor(params);
  if (height <= 0) {
    throw new CanopyParameterError(
      `a ${params.heightMm} mm canopy has no wall left once its lips take their setbacks`,
    );
  }
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

  const lip = params.lipMm ?? 0;
  const lipEdges = lipEdgesFor(panel, params);

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
      ...lipEdges.map((edge): Feature => ({
        kind: 'edge-flange',
        id: featureId(lipFeatureId(panel, edge)),
        edge: { faceId: panelFaceId(panel), edgeName: edge },
        lengthMm: lip - outsideSetback(90, params.bendRadiusMm, params.thicknessMm),
        angleDeg: 90,
        // Both lips turn the same way, toward the inside of the box. The fold
        // direction is already measured against each edge's own direction, and
        // the two edges run opposite ways round the wall's boundary, so the
        // same value on both is the same physical side. Using different values
        // sends one lip in and one out.
        direction: 'down',
        insideRadiusMm: params.bendRadiusMm,
        // Two walls' lips meet at each vertical corner as horizontal strips at
        // a right angle — the picture-frame case — so each end is mitred.
        mitreStartDeg: 45,
        mitreEndDeg: 45,
        label: `${PANEL_LABELS[panel]} ${edge} lip`,
      })),
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
/**
 * Which of a panel's edges carry a lip. Walls only, top always, bottom when
 * there is a floor to land on it.
 */
function lipEdgesFor(panel: CanopyPanel, params: CanopyParams): ('top' | 'bottom')[] {
  const isWall = panel !== 'floor' && panel !== 'roof';
  if (!isWall || (params.lipMm ?? 0) <= 0) return [];
  return params.floor === false ? ['top'] : ['top', 'bottom'];
}

/**
 * How far a lip carries the panel that lands on it past the wall's own plate
 * edge, mm.
 *
 * Half a thickness to reach that panel's neutral surface from the face of the
 * lip it lies on, plus the setback the bend takes out of the wall. The same
 * number comes off the wall's plate and goes into the mate, so the box closes
 * on its outside dimensions however deep the lip is.
 *
 * Zero without lips, which leaves the plain butt-jointed skeleton.
 */
function lipRiseFor(params: CanopyParams): number {
  if ((params.lipMm ?? 0) <= 0) return 0;
  return (
    params.thicknessMm / 2 + outsideSetback(90, params.bendRadiusMm, params.thicknessMm)
  );
}

/** A wall's lip along one of its edges. */
function lipFeatureId(panel: CanopyPanel, edge: 'top' | 'bottom'): string {
  return `${panel}-${edge}-lip`;
}

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
