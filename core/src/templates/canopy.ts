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
 * The construction is lipped, not butt-welded. A butt-welded box has nothing to
 * clamp, nothing to rivet through and no stiffness at the seam.
 *
 * Which panel carries the lip at the roof seam is a choice, `lipOn`. By default
 * each wall turns inward at the top and the roof lands on those four lips.
 * Inverted, the roof turns a return down outside each wall and the wall laps up
 * inside it, which puts a bend on the top corner instead of a joint and moves
 * the rivets out of sight. Either way the bottom lips land on the floor.
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
import { circle, containsPoint, polygon, roundedRect } from '../geometry/loop.js';
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
  /**
   * Which panel carries the lip at the roof seam.
   *
   * `walls` is the plain box: each wall turns a lip inward at the top and the
   * roof lands on those four lips. The seam, and every rivet in it, comes out
   * on the top corner where you look at it.
   *
   * `roof` inverts that. The roof turns a return down outside each wall and the
   * wall laps up inside it, so the top corner is a bend rather than a joint and
   * the rivets move onto the wall face below it. That is the construction the
   * Utemaster-style canopies read as: an unbroken top edge and no fastener in
   * view.
   *
   * How smooth that corner comes out is `bendRadiusMm`, and it is formed as one
   * bend. What radius the brake can actually hold is not known — the die rack is
   * still one of the open questions, and the placeholder machine's numbers are
   * nobody's measurement. Do not read a limit into this either way.
   *
   * The bottom seam is unaffected: a wall still turns a lip onto the floor.
   */
  readonly lipOn?: 'walls' | 'roof';
  /**
   * Rivets down every lip, or none.
   *
   * The seams are riveted, not welded, so the lip is not just a stiffener — it
   * is what the fastener goes through, and its depth has to answer to the rivet
   * rather than to taste.
   */
  readonly rivet?: RivetSpec;
  /**
   * Door openings, at most one per wall.
   *
   * A canopy with none is a sealed box, which is what this template made before
   * doors existed and is still what you want if the thing is a toolbox rather
   * than something you climb into.
   */
  readonly doors?: readonly CanopyDoor[];
  readonly grain?: GrainDirection;
}

/**
 * What is going through the seam.
 *
 * Lives on the template for now rather than in shop settings, because two
 * designs may well be riveted differently and nothing yet says a shop has one
 * rivet. If it turns out there is only ever one, it belongs next to the press
 * brake.
 */
export interface RivetSpec {
  /** Shank diameter, mm — the size the rivet is called. */
  readonly diameterMm: number;
  /** Hole diameter, mm. Defaults to the shank plus 0.2 for clearance. */
  readonly holeMm?: number;
  /**
   * Target pitch along the seam, mm.
   *
   * A target, not a promise: the holes divide each seam evenly, so the pitch
   * that comes out is this or a little less. Nobody wants one short space at
   * the end of a 1.8 m run.
   */
  readonly pitchMm: number;
  /**
   * Minimum from a hole centre to any edge or bend, mm. Defaults to 2 x the
   * shank, which is the usual rule for blind rivets in sheet.
   */
  readonly edgeDistanceMm?: number;
}

export function riveted(spec: RivetSpec): {
  hole: number;
  edge: number;
  pitch: number;
} {
  return {
    hole: spec.holeMm ?? spec.diameterMm + 0.2,
    edge: spec.edgeDistanceMm ?? spec.diameterMm * 2,
    pitch: spec.pitchMm,
  };
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
  rivet: { diameterMm: 4.8, pitchMm: 100 },
  grain: 'length',
};

/**
 * The walls a door can go in.
 *
 * Not the front: it faces the back of the cab, where there is neither room to
 * swing a door nor anything to reach it from.
 */
export const DOOR_WALLS = ['left', 'right', 'rear'] as const;
export type DoorWall = (typeof DOOR_WALLS)[number];

/**
 * A door opening in one wall, and the door that closes it.
 *
 * The opening is a hole in the wall panel and nothing more. A lip cannot be
 * folded around it: a brake folds along a line that runs off both ends of the
 * blank, so a return around a hole is a pressing operation and needs tooling a
 * brake shop has not got. The production canopies this is modelled on get their
 * apertures pressed; the equivalent here is a frame of folded sections riveted
 * around the opening, which is a separate job from this one.
 *
 * What the door itself does have is a return folded back on all four edges —
 * four straight bends off the edge of a rectangular blank, mitred at the
 * corners exactly as the body lips are. That much a brake will do.
 */
export interface CanopyDoor {
  readonly wall: DoorWall;
  /** Metal left above the opening, mm. */
  readonly headMm?: number;
  /** Metal left below the opening, mm. */
  readonly sillMm?: number;
  /** Metal left at each end of the opening, mm. */
  readonly jambMm?: number;
  /**
   * Corner radius of the opening, mm.
   *
   * Not decoration. A square internal corner in a wall panel is where a crack
   * starts, and this one spends its life being shaken on a ute.
   */
  readonly cornerRadiusMm?: number;
  /** How far the door laps over the frame all round, mm. */
  readonly lapMm?: number;
  /** Depth of the return folded back around the door, mm. */
  readonly returnMm?: number;
}

const DOOR_DEFAULTS = {
  headMm: 60,
  sillMm: 60,
  jambMm: 60,
  cornerRadiusMm: 20,
  lapMm: 20,
  returnMm: 20,
} as const;

/** One door's numbers with the defaults filled in. */
interface DoorSpec {
  readonly wall: DoorWall;
  readonly headMm: number;
  readonly sillMm: number;
  readonly jambMm: number;
  readonly cornerRadiusMm: number;
  readonly lapMm: number;
  readonly returnMm: number;
}

function doorSpec(door: CanopyDoor): DoorSpec {
  return { ...DOOR_DEFAULTS, ...strip(door), wall: door.wall };
}

/** Drop keys whose value is undefined, so a spread does not bury a default. */
function strip<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** The door in one wall, if this parameter set puts one there. */
function doorFor(params: CanopyParams, panel: CanopyPanel): DoorSpec | undefined {
  const found = (params.doors ?? []).filter((d) => d.wall === panel);
  if (found.length > 1) {
    throw new CanopyParameterError(`the ${panel} wall has ${found.length} doors; it can have one`);
  }
  return found[0] === undefined ? undefined : doorSpec(found[0]);
}

/** An opening in a wall, in that wall's own flat coordinates. */
interface Aperture {
  readonly x: number;
  readonly y: number;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly cornerRadiusMm: number;
}

/**
 * Where one door's opening sits in its wall.
 *
 * The margins are measured from the wall's bounding box rather than from its
 * sloping edges, so on a tapered wall the head margin is the tightest point
 * rather than the average. Whether that leaves the opening inside the metal is
 * not assumed — every corner is checked against the actual outline below.
 */
function apertureFor(shape: PanelShape, door: DoorSpec): Aperture {
  const width = Math.max(...shape.at.map((p) => p.x));
  const height = Math.max(...shape.at.map((p) => p.y));
  const w = width - 2 * door.jambMm;
  const h = height - door.headMm - door.sillMm;
  if (w <= 0 || h <= 0) {
    throw new CanopyParameterError(
      `the ${door.wall} door's margins leave no opening: a ${width.toFixed(0)} x ${height.toFixed(0)} mm wall ` +
        `less ${door.jambMm} mm jambs and ${door.headMm}/${door.sillMm} mm head and sill`,
    );
  }
  const r = Math.min(door.cornerRadiusMm, w / 2, h / 2);
  const at: Aperture = {
    x: door.jambMm,
    y: door.sillMm,
    widthMm: w,
    heightMm: h,
    cornerRadiusMm: r,
  };

  // A tapered wall is a trapezium, so a rectangle inset from its bounding box
  // can still poke out through a sloping edge. Say so rather than exporting a
  // wall with a hole in its outline.
  const outline = polygon([...shape.at]);
  const corners = [
    v2(at.x, at.y),
    v2(at.x + w, at.y),
    v2(at.x + w, at.y + h),
    v2(at.x, at.y + h),
  ];
  for (const p of corners) {
    if (!containsPoint(outline, p)) {
      throw new CanopyParameterError(
        `the ${door.wall} door's opening reaches outside the wall — the wall leans in and the margins are ` +
          'measured from its widest point, so the head or a jamb needs to grow',
      );
    }
  }
  return at;
}

function apertureLoop(a: Aperture): ReturnType<typeof roundedRect> {
  return roundedRect(a.x, a.y, a.widthMm, a.heightMm, a.cornerRadiusMm);
}

/** The four edges of a door blank, counter-clockwise from the bottom left. */
const DOOR_EDGES = ['bottom', 'hinge', 'top', 'latch'] as const;

/**
 * One door: a rectangular blank with a return folded back on all four edges.
 *
 * The blank laps the opening by `lapMm` all round, so it covers the aperture
 * and lands on the frame rather than dropping through it. Every bend runs the
 * full width of the blank and off both ends, which is the only kind a brake can
 * make, and the ends are mitred 45 so the four returns close on each other at
 * the corners instead of overlapping.
 */
function doorPart(params: CanopyParams, door: DoorSpec, aperture: Aperture): Part {
  const w = aperture.widthMm + 2 * door.lapMm;
  const h = aperture.heightMm + 2 * door.lapMm;
  const at = [v2(0, 0), v2(w, 0), v2(w, h), v2(0, h)];
  const edges: Record<string, DirectedEdge> = {};
  DOOR_EDGES.forEach((name, i) => {
    edges[name] = { p0: at[i]!, p1: at[(i + 1) % at.length]! };
  });

  const setback = outsideSetback(90, params.bendRadiusMm, params.thicknessMm);
  const plate = door.returnMm - setback;
  if (plate <= 0) {
    throw new CanopyParameterError(
      `a ${door.returnMm} mm return on the ${door.wall} door is inside the ${setback.toFixed(2)} mm the bend ` +
        'itself takes, so there is no flat to fold',
    );
  }

  const returns = DOOR_EDGES.map((name): Feature => ({
    kind: 'edge-flange',
    id: featureId(`${door.wall}-door-${name}-return`),
    edge: { faceId: faceId(`${door.wall}-door`), edgeName: name },
    lengthMm: plate,
    angleDeg: 90,
    // Away from the outward face, so the return points back at the canopy and
    // the door presents a clean skin. Same convention as the body lips.
    direction: 'down',
    insideRadiusMm: params.bendRadiusMm,
    mitreStartDeg: 45,
    mitreEndDeg: 45,
    label: `${PANEL_LABELS[door.wall]} door ${name} return`,
  }));

  return {
    parameters: {
      name: `${params.name} ${PANEL_LABELS[door.wall].toLowerCase()} door`,
      materialId: params.materialId,
      thicknessMm: params.thicknessMm,
      grain: params.grain ?? 'length',
      partId: doorPartNumber(params, door.wall),
      ...(params.revision !== undefined ? { revision: params.revision } : {}),
    },
    features: [
      {
        kind: 'base-flange',
        id: featureId(`${door.wall}-door`),
        profile: profile(polygon(at)),
        edges,
        label: `${PANEL_LABELS[door.wall]} door`,
      },
      ...returns,
    ],
    template: { kind: CANOPY_TEMPLATE_KIND, params },
  };
}

function doorPartNumber(params: CanopyParams, wall: DoorWall): string {
  return `${params.partPrefix ?? 'CAN'}-${wall.toUpperCase()}-DOOR`;
}

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

/**
 * An edge that can carry a lip.
 *
 * A wall names its horizontal edges by the deck they meet; the roof names each
 * of its four edges for the wall it meets. So an edge name plus the panel it
 * belongs to is enough to say which seam it is.
 */
type LipEdge = 'top' | 'bottom' | CanopyWall;

/** The panel on the other side of a lipped seam. */
function across(panel: CanopyPanel, edge: LipEdge): CanopyPanel {
  if (isWall(panel)) return edge === 'top' ? 'roof' : 'floor';
  return edge as CanopyWall;
}

/** True when the roof carries the return at the top seam rather than the walls. */
function lipsOnRoof(params: CanopyParams): boolean {
  return params.lipOn === 'roof';
}

/** Generate the canopy's parts and how they sit together. */
export function canopyDocument(params: CanopyParams): TemplateDocument {
  const body = buildBody(params);
  const withFloor = params.floor !== false;
  const root: CanopyPanel = withFloor ? 'floor' : 'roof';

  const shapes = new Map<CanopyPanel, PanelShape>();
  for (const panel of canopyPanels(params)) shapes.set(panel, panelShape(body, params, panel));

  const parts = canopyPanels(params).map((panel) => panelPart(body, params, panel, shapes.get(panel)!));

  // Doors are parts in their own right, made from their own blanks. They are
  // added after the panels so the body still reads floor-first down the parts
  // list, which is the order it gets built in.
  const doors = DOOR_WALLS.flatMap((wall) => {
    const door = doorFor(params, wall);
    if (door === undefined) return [];
    return [{ door, aperture: apertureFor(shapes.get(wall)!, door) }];
  });
  parts.push(...doors.map(({ door, aperture }) => doorPart(params, door, aperture)));

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

  // Each door hangs on its own wall: same plane, lifted one thickness so it
  // lies on the outside skin rather than through it, slid up off the wall's
  // bottom edge to sit over the opening. Every number here is stated rather
  // than solved for, the same as every other mate.
  for (const { door, aperture } of doors) {
    mates.push({
      id: `${door.wall}-door`,
      part: partId(doorPartNumber(params, door.wall)),
      edge: { faceId: faceId(`${door.wall}-door`), edgeName: 'bottom' },
      to: key(params, door.wall),
      toEdge: { faceId: panelFaceId(door.wall), edgeName: 'bottom' },
      angleDeg: 0,
      offsetMm: aperture.x - door.lapMm,
      standoffMm: params.thicknessMm,
      beyondMm: -(aperture.y - door.lapMm),
      label: `${PANEL_LABELS[door.wall]} door onto ${PANEL_LABELS[door.wall]}`,
    });
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

  // A panel is cut back along the edges it carries a lip on.
  const insets = new Map<number, number>();
  for (const edge of lipEdgesFor(panel, params)) {
    insets.set(edgeIndex.get(edge)!, lipRise(body, params, panel, edge));
  }
  if (isWall(panel) && lipsOnRoof(params)) {
    // The wall laps up inside the roof's return, so its plate stops against the
    // roof's inner surface rather than running on to the neutral corner. Half a
    // thickness, taken along the wall rather than square to the roof.
    const phi = dihedralDeg(body, panel, 'roof');
    insets.set(edgeIndex.get('top')!, params.thicknessMm / 2 / Math.sin(toRadians(phi)));
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
 * Which of a panel's edges carry a lip.
 *
 * With the lip on the walls: top always, bottom when there is a floor to land
 * on it. With it on the roof: the roof carries all four returns, and a wall
 * keeps only the bottom lip that lands on the floor.
 */
function lipEdgesFor(panel: CanopyPanel, params: CanopyParams): LipEdge[] {
  if ((params.lipMm ?? 0) <= 0) return [];
  if (lipsOnRoof(params)) {
    if (panel === 'roof') return [...CANOPY_WALLS];
    return isWall(panel) && params.floor !== false ? ['bottom'] : [];
  }
  if (!isWall(panel)) return [];
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
  panel: CanopyPanel,
  edge: LipEdge,
): number {
  const phi = dihedralDeg(body, panel, across(panel, edge));
  const setback = lipSetback(body, params, panel, edge);
  if (isWall(panel)) {
    const toCorner = (params.thicknessMm / 2) * Math.tan(toRadians(phi) / 2);
    return toCorner + setback;
  }
  return setback - returnReach(params.thicknessMm, phi);
}

/**
 * How far past the body's corner a roof return's outside corner sits, mm.
 *
 * The return lies *outside* the wall, so its neutral plane is a full thickness
 * outboard of the wall's — the two sheets are face to face, and each contributes
 * half a thickness. Its outside surface is another half beyond that, so the
 * corner the roof's and the return's outside surfaces make is 1.5 thicknesses
 * out from the wall's neutral plane.
 *
 * Measured along the roof, a plane that far outboard is met at
 * `T(1.5 + 0.5 cos phi) / sin phi`: the `sin` is the obliquity of the roof to
 * the wall, and the `cos` term is the shift from the roof's own outside surface
 * sitting half a thickness above its neutral plane. At a square corner that is
 * `1.5T`, and the lip rise comes out `R + T - 1.5T`, so a canopy with a bend
 * radius bigger than half a thickness has its roof plate stopping *short* of
 * the corner even though the return finishes outboard of the wall.
 */
function returnReach(thicknessMm: number, phi: number): number {
  const rad = toRadians(phi);
  return (thicknessMm * (1.5 + 0.5 * Math.cos(rad))) / Math.sin(rad);
}

/** What the bend to the lip takes out of the outside corner, mm. */
function lipSetback(
  body: CanopyBody,
  params: CanopyParams,
  panel: CanopyPanel,
  edge: LipEdge,
): number {
  const phi = dihedralDeg(body, panel, across(panel, edge));
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

  const lipFeatures = lipEdgesFor(panel, params).flatMap((edge): Feature[] => {
    const phi = dihedralDeg(body, panel, across(panel, edge));
    const plate = lip - lipSetback(body, params, panel, edge);
    if (plate <= 0) {
      throw new CanopyParameterError(
        `a ${lip} mm lip is inside the ${lipSetback(body, params, panel, edge).toFixed(2)} mm the bend itself takes, so there is no flat to fold`,
      );
    }
    const [startCorner, endCorner] = lipCorners(shape, edge);
    const mitreStartDeg = mitreAt(body, panel, edge, startCorner);
    const mitreEndDeg = mitreAt(body, panel, edge, endCorner);
    const parent = edges[edge]!;
    const width = Math.hypot(parent.p1.x - parent.p0.x, parent.p1.y - parent.p0.y);
    const flange: Feature = {
      kind: 'edge-flange',
      id: featureId(lipFeatureId(panel, edge)),
      edge: { faceId: panelFaceId(panel), edgeName: edge },
      lengthMm: plate,
      // The lip folds through whatever the body leaves at that seam: 90 on a
      // square canopy, more where a wall leans out from the deck, less where it
      // leans in.
      angleDeg: 180 - phi,
      // Every lip turns the same way, away from the panel's outward normal: a
      // wall's lip inward across the box, the roof's return down outside the
      // wall. The fold direction is measured against each edge's own direction,
      // and the edges run opposite ways round the panel's boundary, so the same
      // value on all of them is the same physical side. Using different values
      // sends one lip in and one out.
      direction: 'down',
      insideRadiusMm: params.bendRadiusMm,
      // Two lips meet at each corner as strips in one plane, so each end is cut
      // to half that corner. Square gives the familiar 45.
      mitreStartDeg,
      mitreEndDeg,
      label: lipLabel(panel, edge),
    };
    return [
      flange,
      ...rivetHoles(params, panel, edge, { width, length: plate, mitreStartDeg, mitreEndDeg }),
    ];
  });

  const door = doorFor(params, panel);
  const aperture: Feature[] =
    door === undefined
      ? []
      : [
          {
            kind: 'cutout',
            id: featureId(`${panel}-door-opening`),
            faceId: panelFaceId(panel),
            loop: apertureLoop(apertureFor(shape, door)),
            label: `${PANEL_LABELS[panel]} door opening`,
          },
        ];

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
      ...aperture,
      ...lipFeatures,
    ],
    template: { kind: CANOPY_TEMPLATE_KIND, params },
  };
}

/**
 * The rivet holes down one lip, in that lip's own flat coordinates.
 *
 * A flange's local space runs x along its bend line from the start of the
 * parent edge, and y from the bend tangent (y = 0) out to the free edge
 * (y = length). So the holes sit at y = length/2 — down the middle of the flat,
 * which is the only line that gives the same clearance to the bend as to the
 * free edge, and therefore the one that lets the lip be as narrow as possible.
 *
 * Across the seam the run is bounded by the mitres, which slope. A hole's
 * clearance from a raked end is measured square to that end, so the usable span
 * is inset by `edge / cos(mitre)` rather than by `edge`.
 *
 * ONE SIDE ONLY: the holes go in the lip and not in the panel that lands on it.
 * Their spacing along the seam would match on both parts, but their distance
 * from the seam depends on the bend allowance being right, and K is one of the
 * numbers this shop has not measured yet. A 0.2 mm clearance hole does not
 * forgive that. Clamp the deck to the lip and drill through.
 */
function rivetHoles(
  params: CanopyParams,
  panel: CanopyPanel,
  edge: LipEdge,
  flange: { width: number; length: number; mitreStartDeg: number; mitreEndDeg: number },
): Feature[] {
  if (params.rivet === undefined) return [];
  const { hole, edge: clear, pitch } = riveted(params.rivet);
  const where = lipLabel(panel, edge);
  if (!(hole > 0) || !(pitch > 0) || !(clear > 0)) {
    throw new CanopyParameterError('rivet diameter, pitch and edge distance must all be positive');
  }
  if (flange.length < 2 * clear) {
    throw new CanopyParameterError(
      `the ${where} is ${flange.length.toFixed(1)} mm of flat, and a ${params.rivet.diameterMm} mm rivet needs ${(2 * clear).toFixed(1)} mm to keep ${clear} mm off both the bend and the free edge — deepen the lip or use a smaller rivet`,
    );
  }

  const y = flange.length / 2;
  // At mid-height each mitre has already eaten half its rake.
  const rake = (deg: number): number =>
    Math.tan(toRadians(deg)) * y + clear / Math.cos(toRadians(deg));
  const from = rake(flange.mitreStartDeg);
  const to = flange.width - rake(flange.mitreEndDeg);
  const run = to - from;
  if (run < 0) {
    throw new CanopyParameterError(
      `the ${where} has no room for a rivet between its mitred ends`,
    );
  }

  const gaps = Math.max(1, Math.ceil(run / pitch));
  const count = gaps + 1;
  return Array.from({ length: count }, (_, i): Feature => {
    const x = from + (run * i) / gaps;
    return {
      kind: 'cutout',
      id: featureId(`${panel}-${edge}-rivet-${i + 1}`),
      faceId: faceId(lipFeatureId(panel, edge)),
      loop: circle(x, y, hole / 2),
      label: `${where} rivet ${i + 1} of ${count}`,
    };
  });
}

/** The body corners at the start and end of a wall's lipped edge. */
function lipCorners(shape: PanelShape, edge: LipEdge): [CornerKey, CornerKey] {
  const i = shape.edgeIndex.get(edge)!;
  return [shape.from[i]!, shape.from[(i + 1) % shape.from.length]!];
}

/**
 * Half the corner two lips meet at, as a rake off square.
 *
 * Two lips lie in one plane and meet at a corner of the body — either two walls'
 * lips at an upright corner, or two of the roof's returns at a roof corner.
 * Whatever angle they meet at, cutting each of them to half of it closes the
 * frame: a mitre. 45 is the square case, and the rake the flange machinery wants
 * is the departure from a square cut, `90 - corner/2`.
 */
function mitreAt(
  body: CanopyBody,
  panel: CanopyPanel,
  edge: LipEdge,
  at: CornerKey,
): number {
  const [mine, theirs] = lipsMeetingAt(body, panel, edge, at);
  const psi = toDegrees(Math.acos(Math.max(-1, Math.min(1, dot3(mine, theirs)))));
  const mitre = 90 - psi / 2;
  if (Math.abs(mitre) > 75) {
    throw new CanopyParameterError(
      `the lips meet at ${psi.toFixed(1)} degrees at the ${at.replace(/-/g, ' ')} corner, which no mitre closes`,
    );
  }
  return mitre;
}

/**
 * The two lip runs that meet at one corner.
 *
 * On the walls they belong to two different panels meeting at an upright corner
 * of the body, each along its own top or bottom edge. On the roof both belong to
 * the roof itself: its four returns turn down off four edges of one plate, and
 * two of them meet at every corner. Either way the mitre is half the angle
 * between the runs, so all this has to do is find the other one.
 */
function lipsMeetingAt(
  body: CanopyBody,
  panel: CanopyPanel,
  edge: LipEdge,
  at: CornerKey,
): [Vec3, Vec3] {
  const mine = lipRunFrom(body, panel, edge, at);
  if (isWall(panel)) {
    const neighbour = CANOPY_WALLS.find((w) => w !== panel && at.split('-').includes(w));
    if (neighbour === undefined) {
      throw new CanopyParameterError(`no wall meets the ${panel} wall at ${at}`);
    }
    return [mine, lipRunFrom(body, neighbour, edge, at)];
  }
  const other = CANOPY_WALLS.find((w) => w !== edge && at.split('-').includes(w));
  if (other === undefined) {
    throw new CanopyParameterError(`no second ${panel} edge meets the ${edge} edge at ${at}`);
  }
  return [mine, lipRunFrom(body, panel, other, at)];
}

/** Unit direction a panel's lipped edge runs, leaving the given corner. */
function lipRunFrom(body: CanopyBody, panel: CanopyPanel, edge: LipEdge, at: CornerKey): Vec3 {
  const [a, b] = panelOutline(body, panel).edges.get(edge)!;
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

/** A panel's lip along one of its edges. */
function lipFeatureId(panel: CanopyPanel, edge: LipEdge): string {
  return `${panel}-${edge}-lip`;
}

/**
 * What to call a lip on the drawing.
 *
 * A wall turns a lip inward; the roof turns a return down outside the wall. They
 * are the same feature and the shop calls them different things, so the label
 * follows the shop rather than the code.
 */
function lipLabel(panel: CanopyPanel, edge: LipEdge): string {
  const what = panel === 'roof' ? 'return' : 'lip';
  return `${PANEL_LABELS[panel]} ${edge} ${what}`;
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
