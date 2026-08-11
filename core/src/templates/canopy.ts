/**
 * Ute canopy template.
 *
 * This is the second template pack, and it exists to answer the question the
 * architecture doc set for it: does the template layer actually hold, or does
 * the core turn out to know something about benchtops?
 *
 * The body it builds is six panels around a box that can be tapered — each wall
 * leaning inward by its own angle, the roof falling from the front of the
 * canopy to the rear. None of that is special-cased here. `canopyBody` states
 * the shape as six planes and eight corners, and this file reads every number
 * off it: panel outlines, bend angles, lip mitres, and the offsets that put one
 * panel against another. Square is the case where all the angles are zero.
 *
 * The construction is lipped, not butt-welded. Each wall turns inward at the
 * top and bottom; the roof lands on the top lips and the bottom lips land on
 * the floor. A butt-welded box has nothing to clamp, nothing to rivet through
 * and no stiffness at the seam.
 *
 * Dimensions are **outside** sizes, the way somebody measures a ute tray. The
 * panels are cut to the neutral surfaces half a thickness inside them, so the
 * metal makes up the outside.
 *
 * KNOWN SIMPLIFICATION: the vertical seams between walls carry no joint record.
 * Joints still resolve inside one part's graph and those are between parts, so
 * the four upright corners are drawn meeting and are not yet cut for a weld gap
 * or a rivetted lap.
 */

import { type Feature, type GrainDirection, type Part } from '../features/types.js';
import { outsideSetback } from '../materials/allowance.js';
import { type Vec2, v2 } from '../geometry/vec2.js';
import { polygon } from '../geometry/loop.js';
import { profile } from '../geometry/profile.js';
import {
  type Vec3,
  cross3,
  dot3,
  distance3,
  normalize3,
  sub3,
} from '../geometry/vec3.js';
import { type DirectedEdge } from '../model/graph.js';
import { type FaceId, faceId, featureId, partId } from '../ids.js';
import { type Assembly, type EdgeMate } from '../model/assembly.js';
import { toDegrees, toRadians } from '../units.js';
import {
  type CanopyBody,
  type CanopyPanel,
  type CanopyTaper,
  type CanopyWall,
  type CornerKey,
  CANOPY_WALLS,
  CanopyBodyError,
  PANEL_ORDER,
  canopyBody,
  corner,
  dihedralDeg,
  outwardNormal,
  panelOutline,
} from './canopyBody.js';

export { type CanopyPanel, type CanopyTaper } from './canopyBody.js';

export const CANOPY_TEMPLATE_KIND = 'canopy';

export interface CanopyParams {
  readonly name: string;
  /** Prefix for each panel's part number, e.g. "CAN" gives CAN-FLOOR. */
  readonly partPrefix?: string;
  readonly revision?: string;
  /** Outside length of the footprint, front to back. */
  readonly lengthMm: number;
  /** Outside width of the footprint, side to side. */
  readonly widthMm: number;
  /** Outside height at the front. */
  readonly heightMm: number;
  readonly thicknessMm: number;
  readonly materialId: string;
  readonly bendRadiusMm: number;
  /** How much lower the roof sits at the rear than at the front, mm. */
  readonly roofDropMm?: number;
  /** How far each wall leans inward at the top, degrees. */
  readonly taperDeg?: CanopyTaper;
  /**
   * Include a floor panel. A canopy that sits on the ute's own tray does not
   * need one, and leaving it out makes the roof the part everything hangs off.
   */
  readonly floor?: boolean;
  /**
   * Depth of the lip folded inward around the top and bottom of each wall, mm.
   *
   * Measured on the outside of the metal from the corner the two outside
   * surfaces would meet at if the bend were sharp — which is what a rule laid
   * along the outside of the canopy reads. Zero leaves a plain butt-jointed
   * skeleton with nothing to rivet through.
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
  roofDropMm: 0,
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
  return PANEL_ORDER.filter((p) => p !== 'floor' || params.floor !== false);
}

const PANEL_LABELS: Record<CanopyPanel, string> = {
  floor: 'Floor',
  roof: 'Roof',
  front: 'Front (bulkhead)',
  rear: 'Rear (door opening)',
  left: 'Left side',
  right: 'Right side',
};

/** Which deck a wall's lip lands against, at each end of the wall. */
const DECK_OF = { bottom: 'floor', top: 'roof' } as const;
type LipEdge = keyof typeof DECK_OF;

/** Generate the canopy's parts and how they sit together. */
export function canopyDocument(params: CanopyParams): TemplateDocument {
  const body = buildBody(params);
  const withFloor = params.floor !== false;
  const root: CanopyPanel = withFloor ? 'floor' : 'roof';

  const shapes = new Map<CanopyPanel, PanelShape>();
  for (const panel of canopyPanels(params)) shapes.set(panel, panelShape(body, params, panel));

  const parts = canopyPanels(params).map((panel) => panelPart(body, params, panel, shapes.get(panel)!));

  // Mate tree. Everything hangs off one panel: the floor when there is one,
  // otherwise the roof, because a canopy that sits on the tray has no floor to
  // hang off and the roof is what ties the four walls together.
  const mates: EdgeMate[] = [];
  const standing: LipEdge = withFloor ? 'bottom' : 'top';
  for (const wall of CANOPY_WALLS) {
    mates.push(
      mateFor(
        `${root}-${wall}`,
        params,
        { panel: root, shape: shapes.get(root)!, edgeName: wall },
        { panel: wall, shape: shapes.get(wall)!, edgeName: standing },
        `${PANEL_LABELS[wall]} onto ${PANEL_LABELS[root]}`,
      ),
    );
  }
  if (withFloor) {
    // The roof lands on one wall's top lip. It sits on all four, but a
    // placement tree allows exactly one relationship per part — the other three
    // contacts are seams, not placements, the same way a closed corner is not a
    // second bend.
    mates.push(
      mateFor(
        'left-roof',
        params,
        { panel: 'left', shape: shapes.get('left')!, edgeName: 'top' },
        { panel: 'roof', shape: shapes.get('roof')!, edgeName: 'left' },
        'Roof onto Left side',
      ),
    );
  }

  return { parts, assembly: { rootPartId: key(params, root), mates } };
}

/**
 * The body a parameter set describes: eight corners and six planes.
 *
 * Exported because the shape is worth asking about on its own — how wide the
 * roof ends up once the sides lean in, how high the rear is once the roof
 * falls — and those are questions about the body, not about any one panel.
 */
export function canopyBodyFor(params: CanopyParams): CanopyBody {
  return buildBody(params);
}

/**
 * The handful of outside dimensions a tapered canopy is not obviously the size
 * of any more.
 *
 * Once the sides lean in and the roof falls, "1800 x 1500 x 900" describes the
 * footprint and the front, and says nothing about the roof or the back of the
 * canopy. These are the numbers somebody would put a tape on to check it, so
 * they are measured on the outside skin rather than the neutral surfaces.
 */
export interface CanopyMeasures {
  readonly roofWidthFrontMm: number;
  readonly roofWidthRearMm: number;
  readonly roofLengthMm: number;
  readonly rearHeightMm: number;
}

export function canopyMeasures(params: CanopyParams): CanopyMeasures {
  const body = buildBody(params);
  const at = (k: CornerKey): Vec3 => {
    const p = body.outside.get(k);
    if (p === undefined) throw new CanopyParameterError(`no corner ${k}`);
    return p;
  };
  return {
    roofWidthFrontMm: distance3(at('front-left-top'), at('front-right-top')),
    roofWidthRearMm: distance3(at('rear-left-top'), at('rear-right-top')),
    roofLengthMm: distance3(at('front-left-top'), at('rear-left-top')),
    rearHeightMm: at('rear-left-top').z - at('rear-left-bottom').z,
  };
}

/** The body this parameter set describes, with the template's own error type. */
function buildBody(params: CanopyParams): CanopyBody {
  const { thicknessMm: t } = params;
  if (!(t > 0)) throw new CanopyParameterError('thickness must be positive');
  if (!(params.bendRadiusMm > 0)) throw new CanopyParameterError('bend radius must be positive');
  const lip = params.lipMm ?? 0;
  if (lip < 0) throw new CanopyParameterError('lip depth cannot be negative');
  try {
    return canopyBody({
      lengthMm: params.lengthMm,
      widthMm: params.widthMm,
      heightMm: params.heightMm,
      thicknessMm: t,
      ...(params.roofDropMm !== undefined ? { roofDropMm: params.roofDropMm } : {}),
      ...(params.taperDeg !== undefined ? { taperDeg: params.taperDeg } : {}),
    });
  } catch (e) {
    if (e instanceof CanopyBodyError) throw new CanopyParameterError(e.message);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

/**
 * One panel's flat outline and where it sits on the body.
 *
 * `at` is the 2D sketch the part is cut from; `in3d` is the same four points in
 * the body's space. Keeping both means a mate can be worked out from the real
 * geometry rather than from a rule about which panel is which.
 */
interface PanelShape {
  readonly panel: CanopyPanel;
  /** Sketch corners, counter-clockwise, translated to the positive quadrant. */
  readonly at: readonly Vec2[];
  /** The same corners in body space. */
  readonly in3d: readonly Vec3[];
  /** Edge name to its index in the loop: the edge runs from i to i+1. */
  readonly edgeIndex: ReadonlyMap<string, number>;
  /** Which body corner each loop vertex came from, before any lip inset. */
  readonly from: readonly CornerKey[];
  readonly normal: Vec3;
}

/**
 * A panel's outline, with the lips taken out of it.
 *
 * A wall does not reach the corner of the body: its plate stops where the bend
 * to the lip starts. That distance is `lipRise`, and taking it off here is the
 * same number the mate hands back, so the box closes on the outside dimensions
 * whatever the taper does.
 */
function panelShape(body: CanopyBody, params: CanopyParams, panel: CanopyPanel): PanelShape {
  const outline = panelOutline(body, panel);
  const loop = outline.loop;
  const edgeIndex = new Map<string, number>();
  for (const [name, [a, b]] of outline.edges) {
    const i = loop.findIndex((c) => c.key === a);
    if (loop[(i + 1) % loop.length]!.key !== b) {
      throw new CanopyParameterError(`the ${panel} panel's ${name} edge is not a boundary edge`);
    }
    edgeIndex.set(name, i);
  }

  // Only walls are cut back, and only along the edges that carry a lip.
  const insets = new Map<number, number>();
  for (const edge of lipEdgesFor(panel, params)) {
    insets.set(edgeIndex.get(edge)!, lipRise(body, params, panel as CanopyWall, edge));
  }
  if (isWall(panel) && params.floor === false) {
    // No floor to land on: the wall runs down to the outside bottom, so its
    // plate reaches half a thickness past the neutral floor plane rather than
    // stopping short of it.
    const phi = dihedralDeg(body, panel, 'floor');
    insets.set(edgeIndex.get('bottom')!, -params.thicknessMm / 2 / Math.sin(toRadians(phi)));
  }

  const inset = insetLoop(
    loop.map((c) => c.at),
    insets,
  );
  const minX = Math.min(...inset.map((p) => p.x));
  const minY = Math.min(...inset.map((p) => p.y));
  const at = inset.map((p) => v2(p.x - minX, p.y - minY));
  const in3d = inset.map((p) => fromFrame(outline.frame, p));

  return {
    panel,
    at,
    in3d,
    edgeIndex,
    from: loop.map((c) => c.key),
    normal: outwardNormal(body, panel),
  };
}

function fromFrame(
  frame: { origin: Vec3; xAxis: Vec3; yAxis: Vec3 },
  p: Vec2,
): Vec3 {
  return {
    x: frame.origin.x + frame.xAxis.x * p.x + frame.yAxis.x * p.y,
    y: frame.origin.y + frame.xAxis.y * p.x + frame.yAxis.y * p.y,
    z: frame.origin.z + frame.xAxis.z * p.x + frame.yAxis.z * p.y,
  };
}

/**
 * Move some edges of a convex loop inward and rebuild the corners.
 *
 * Each edge keeps its own direction and slides along its inward normal; the
 * corners follow to wherever the neighbouring lines now cross. Doing it this way
 * rather than moving the corners means a tapered wall stays a straight-sided
 * trapezium instead of acquiring a kink where the lip starts.
 */
function insetLoop(loop: readonly Vec2[], by: ReadonlyMap<number, number>): Vec2[] {
  const lines = loop.map((a, i) => {
    const b = loop[(i + 1) % loop.length]!;
    const dir = { x: b.x - a.x, y: b.y - a.y };
    const len = Math.hypot(dir.x, dir.y);
    if (len === 0) throw new CanopyParameterError('a panel has a zero-length edge');
    const u = { x: dir.x / len, y: dir.y / len };
    // Counter-clockwise, so the metal is on the left of every edge.
    const inward = { x: -u.y, y: u.x };
    const d = by.get(i) ?? 0;
    return { p: { x: a.x + inward.x * d, y: a.y + inward.y * d }, u };
  });

  // Vertex i is where the edge arriving at it meets the edge leaving it.
  return loop.map((_, i) =>
    crossPoint(lines[(i - 1 + lines.length) % lines.length]!, lines[i]!),
  );
}

/** Where two lines given as point + direction cross. */
function crossPoint(a: { p: Vec2; u: Vec2 }, b: { p: Vec2; u: Vec2 }): Vec2 {
  const denom = a.u.x * b.u.y - a.u.y * b.u.x;
  if (Math.abs(denom) < 1e-12) {
    throw new CanopyParameterError('two edges of a panel run parallel and never meet');
  }
  const dx = b.p.x - a.p.x;
  const dy = b.p.y - a.p.y;
  const s = (dx * b.u.y - dy * b.u.x) / denom;
  return v2(a.p.x + a.u.x * s, a.p.y + a.u.y * s);
}

function isWall(panel: CanopyPanel): panel is CanopyWall {
  return panel !== 'floor' && panel !== 'roof';
}

/**
 * Which of a panel's edges carry a lip. Walls only, top always, bottom when
 * there is a floor to land on it.
 */
function lipEdgesFor(panel: CanopyPanel, params: CanopyParams): LipEdge[] {
  if (!isWall(panel) || (params.lipMm ?? 0) <= 0) return [];
  return params.floor === false ? ['top'] : ['top', 'bottom'];
}

/**
 * How far a wall's plate stops short of the body's corner, mm.
 *
 * Two parts.
 *
 * First, where the sharp outside corner would be. The wall's outside surface
 * and the lip's outside surface are each half a thickness off their own neutral
 * plane, and the lip's neutral plane is a thickness inside the deck's, so the
 * corner those two outside surfaces make sits `T/2 * tan(phi/2)` along the wall
 * from where the two neutral planes cross. The tighter the corner, the further
 * that is — which is why a leaning wall is not the square answer.
 *
 * Then the setback the bend itself takes out of that corner. At a square corner
 * the two come to `T/2 + R + T`, which is what the untapered canopy used.
 *
 * The same number goes into the mate as an offset, so whatever it is, the panel
 * that lands on the lip lands where the body says it should.
 */
function lipRise(
  body: CanopyBody,
  params: CanopyParams,
  wall: CanopyWall,
  edge: LipEdge,
): number {
  const phi = dihedralDeg(body, wall, DECK_OF[edge]);
  const toCorner = (params.thicknessMm / 2) * Math.tan(toRadians(phi) / 2);
  return toCorner + lipSetback(body, params, wall, edge);
}

/** What the bend to the lip takes out of the outside corner, mm. */
function lipSetback(
  body: CanopyBody,
  params: CanopyParams,
  wall: CanopyWall,
  edge: LipEdge,
): number {
  const phi = dihedralDeg(body, wall, DECK_OF[edge]);
  return outsideSetback(180 - phi, params.bendRadiusMm, params.thicknessMm);
}

function panelPart(
  body: CanopyBody,
  params: CanopyParams,
  panel: CanopyPanel,
  shape: PanelShape,
): Part {
  const lip = params.lipMm ?? 0;
  const edges: Record<string, DirectedEdge> = {};
  for (const [name, i] of shape.edgeIndex) {
    edges[name] = { p0: shape.at[i]!, p1: shape.at[(i + 1) % shape.at.length]! };
  }

  const lipFeatures = lipEdgesFor(panel, params).map((edge): Feature => {
    const wall = panel as CanopyWall;
    const phi = dihedralDeg(body, wall, DECK_OF[edge]);
    const plate = lip - lipSetback(body, params, wall, edge);
    if (plate <= 0) {
      throw new CanopyParameterError(
        `a ${lip} mm lip is inside the ${lipSetback(body, params, wall, edge).toFixed(2)} mm the bend itself takes, so there is no flat to fold`,
      );
    }
    const [startCorner, endCorner] = lipCorners(shape, edge);
    return {
      kind: 'edge-flange',
      id: featureId(lipFeatureId(panel, edge)),
      edge: { faceId: panelFaceId(panel), edgeName: edge },
      lengthMm: plate,
      // The lip folds through whatever the body leaves at that seam: 90 on a
      // square canopy, more where a wall leans out from the deck, less where it
      // leans in.
      angleDeg: 180 - phi,
      // Both lips turn the same way, toward the inside of the box. The fold
      // direction is measured against each edge's own direction, and the two
      // edges run opposite ways round the wall's boundary, so the same value on
      // both is the same physical side. Using different values sends one lip in
      // and one out.
      direction: 'down',
      insideRadiusMm: params.bendRadiusMm,
      // Two walls' lips meet at each upright corner as strips in one plane, so
      // each end is cut to half that corner. Square gives the familiar 45.
      mitreStartDeg: mitreAt(body, wall, edge, startCorner),
      mitreEndDeg: mitreAt(body, wall, edge, endCorner),
      label: `${PANEL_LABELS[panel]} ${edge} lip`,
    };
  });

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
        profile: profile(polygon([...shape.at])),
        edges,
        label: PANEL_LABELS[panel],
      },
      ...lipFeatures,
    ],
    template: { kind: CANOPY_TEMPLATE_KIND, params },
  };
}

/** The body corners at the start and end of a wall's lipped edge. */
function lipCorners(shape: PanelShape, edge: LipEdge): [CornerKey, CornerKey] {
  const i = shape.edgeIndex.get(edge)!;
  return [shape.from[i]!, shape.from[(i + 1) % shape.from.length]!];
}

/**
 * Half the corner two lips meet at, as a rake off square.
 *
 * The lips of two neighbouring walls lie in one plane and meet at an upright
 * corner of the body. Whatever angle they meet at, cutting each of them to half
 * of it closes the frame — a mitre. 45 is the square case, and the rake the
 * flange machinery wants is the departure from a square cut, `90 - corner/2`.
 */
function mitreAt(
  body: CanopyBody,
  wall: CanopyWall,
  edge: LipEdge,
  at: CornerKey,
): number {
  const neighbour = CANOPY_WALLS.find((w) => w !== wall && at.split('-').includes(w));
  if (neighbour === undefined) {
    throw new CanopyParameterError(`no wall meets the ${wall} wall at ${at}`);
  }
  const psi = toDegrees(
    Math.acos(
      Math.max(
        -1,
        Math.min(1, dot3(lipRunFrom(body, wall, edge, at), lipRunFrom(body, neighbour, edge, at))),
      ),
    ),
  );
  const mitre = 90 - psi / 2;
  if (Math.abs(mitre) > 75) {
    throw new CanopyParameterError(
      `the lips meet at ${psi.toFixed(1)} degrees at the ${at.replace(/-/g, ' ')} corner, which no mitre closes`,
    );
  }
  return mitre;
}

/** Unit direction a wall's lipped edge runs, leaving the given corner. */
function lipRunFrom(body: CanopyBody, wall: CanopyWall, edge: LipEdge, at: CornerKey): Vec3 {
  const [a, b] = panelOutline(body, wall).edges.get(edge)!;
  const other = a === at ? b : a;
  return normalize3(sub3(corner(body, other), corner(body, at)));
}

// ---------------------------------------------------------------------------
// Mates
// ---------------------------------------------------------------------------

interface MateSide {
  readonly panel: CanopyPanel;
  readonly shape: PanelShape;
  readonly edgeName: string;
}

/**
 * The mate that reproduces where the body already says the panel goes.
 *
 * Rather than case out an angle and two offsets for every combination of taper,
 * this measures them: the two edges are known in body space, the mate's four
 * numbers are defined against the host edge's own frame, and all four are rigid
 * invariants. So the mate is *solved*, once, from the geometry — and if the
 * body changes shape the numbers follow with no rule to update.
 */
function mateFor(
  id: string,
  params: CanopyParams,
  host: MateSide,
  guest: MateSide,
  label: string,
): EdgeMate {
  const h = edgeInSpace(host);
  const g = edgeInSpace(guest);

  // The two edges must run against each other, which is what makes the meeting
  // a rigid motion with no mirroring. Every seam on the body does, because both
  // panels wind counter-clockwise round their own outside.
  if (dot3(h.dir, g.dir) > -0.999) {
    throw new CanopyParameterError(
      `the ${host.panel} ${host.edgeName} and ${guest.panel} ${guest.edgeName} edges do not run against each other`,
    );
  }

  const delta = sub3(g.p0, h.p1);
  const angleDeg = signedAngle(h.normal, g.normal, h.dir);
  return {
    id,
    part: key(params, guest.panel),
    edge: { faceId: panelFaceId(guest.panel), edgeName: guest.edgeName },
    to: key(params, host.panel),
    toEdge: { faceId: panelFaceId(host.panel), edgeName: host.edgeName },
    angleDeg,
    offsetMm: -dot3(delta, h.dir),
    standoffMm: dot3(delta, h.normal),
    beyondMm: -dot3(delta, h.inward),
    label,
  };
}

interface SpaceEdge {
  readonly p0: Vec3;
  readonly p1: Vec3;
  readonly dir: Vec3;
  readonly normal: Vec3;
  readonly inward: Vec3;
}

/** One named edge of one panel, in the body's space. */
function edgeInSpace(side: MateSide): SpaceEdge {
  const i = side.shape.edgeIndex.get(side.edgeName);
  if (i === undefined) {
    throw new CanopyParameterError(`the ${side.panel} panel has no ${side.edgeName} edge`);
  }
  const p0 = side.shape.in3d[i]!;
  const p1 = side.shape.in3d[(i + 1) % side.shape.in3d.length]!;
  if (distance3(p0, p1) < 1e-9) {
    throw new CanopyParameterError(`the ${side.panel} panel's ${side.edgeName} edge has no length`);
  }
  const dir = normalize3(sub3(p1, p0));
  const normal = side.shape.normal;
  return { p0, p1, dir, normal, inward: cross3(normal, dir) };
}

/**
 * The rotation about `axis` that carries `from` onto `to`, degrees.
 *
 * Right-handed, matching `rotateAbout`, because that is what the mate solver
 * applies. The result is the departure from flat the mate has to ask for.
 */
function signedAngle(from: Vec3, to: Vec3, axis: Vec3): number {
  const c = dot3(from, to);
  const s = dot3(cross3(from, to), axis);
  return toDegrees(Math.atan2(s, c));
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** A wall's lip along one of its edges. */
function lipFeatureId(panel: CanopyPanel, edge: LipEdge): string {
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
