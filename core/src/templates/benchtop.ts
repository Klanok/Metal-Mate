/**
 * Benchtop template.
 *
 * Owns a parameter set and emits an ordinary feature tree. Nothing below this
 * layer knows what a benchtop is: the core sees a base flange, some edge
 * flanges and some cutouts. That is the whole point — the canopy template in
 * v2 is the same shape of code over the same unchanged core.
 *
 * All plan and edge dimensions are **outside** dimensions, the way a joiner
 * dimensions a benchtop. The template converts them to tangent-to-tangent leg
 * lengths by subtracting the outside setback at every fold, which is what the
 * face-bend graph wants.
 *
 * Any of the four sides can carry an edge. What happens where two of them meet
 * depends on which way they fold:
 *
 *  - **Both the same way** — the corner closes. The two flanges run right up to
 *    it and meet, leaving a seam to weld and grind, which is how a stainless
 *    benchtop corner is actually made. Anything in the chain that ends up
 *    horizontal (the return under a fold-down edge) is mitred at 45 degrees,
 *    because two horizontal strips meeting at a right angle overlap otherwise —
 *    the same cut a picture frame gets.
 *  - **Opposite ways** — one up and one down cannot meet, so the corner is
 *    relieved with a notch instead, and each bend line ends in fresh air.
 */

import { type Loop, circle, polygon, roundedRect } from '../geometry/loop.js';
import { profile, type Profile } from '../geometry/profile.js';
import { type Vec2 } from '../geometry/vec2.js';
import {
  type CutoutFeature,
  type EdgeFlangeFeature,
  type Feature,
  type GrainDirection,
  type Part,
} from '../features/types.js';
import { type DirectedEdge } from '../model/graph.js';
import { faceId, featureId } from '../ids.js';
import { outsideSetback } from '../materials/allowance.js';

/**
 * What a side does with its edge.
 *
 * `upstand` folds up — that is the splashback. Everything else folds down,
 * which is how a finished front or end edge is made.
 */
export type EdgeStyle = 'none' | 'square-drop' | 'drop-and-return' | 'boxed' | 'upstand';

export type Side = 'front' | 'right' | 'back' | 'left';

export const SIDES: readonly Side[] = ['front', 'right', 'back', 'left'];

export interface EdgeParams {
  readonly style: EdgeStyle;
  /** Outside height of the drop, or of the upstand, in mm. */
  readonly heightMm: number;
  /** Outside length of the return that folds back under. */
  readonly returnMm?: number;
  /** Outside height of the upstand that closes a boxed edge. */
  readonly upstandMm?: number;
}

export type BenchtopEdges = Readonly<Record<Side, EdgeParams>>;

export const NO_EDGE: EdgeParams = { style: 'none', heightMm: 0 };

/**
 * What to do where two folded sides meet.
 *
 * `mitre` closes the corner so it can be welded; `relief` notches it open.
 * Two sides folding opposite ways are always relieved — they cannot meet.
 */
export type CornerStyle = 'mitre' | 'relief';

export type CornerName = 'front-left' | 'front-right' | 'back-right' | 'back-left';

export type CornerTreatment = 'mitre' | 'relief' | 'none';

/**
 * The four corners, each named for the two sides that meet there.
 *
 * `startSide` is the side whose edge *starts* at this corner and `endSide` the
 * one whose edge *ends* here, following the counter-clockwise boundary of the
 * top face. That distinction is what tells a flange which of its own two ends
 * is the one at this corner.
 */
export const CORNERS: readonly { name: CornerName; startSide: Side; endSide: Side }[] = [
  { name: 'front-left', startSide: 'front', endSide: 'left' },
  { name: 'front-right', startSide: 'right', endSide: 'front' },
  { name: 'back-right', startSide: 'back', endSide: 'right' },
  { name: 'back-left', startSide: 'left', endSide: 'back' },
];

/* ---------------------------------------------------------------- legacy -- */

/** @deprecated The front is now `edges.front`. Still read for older projects. */
export type FrontEdgeStyle = 'none' | 'square-drop' | 'drop-and-return' | 'boxed';
/** @deprecated The back is now `edges.back` with style `upstand`. */
export type SplashbackStyle = 'none' | 'integral';

/** @deprecated Use `EdgeParams` on `edges.front`. */
export interface FrontEdgeParams {
  readonly style: FrontEdgeStyle;
  readonly dropMm: number;
  readonly returnMm?: number;
  readonly upstandMm?: number;
}

/** @deprecated Use `EdgeParams` on `edges.back`. */
export interface SplashbackParams {
  readonly style: SplashbackStyle;
  readonly heightMm: number;
}

/* --------------------------------------------------------------- cutouts -- */

export interface RectangularCutout {
  readonly kind: 'sink' | 'hob';
  readonly id: string;
  /** Left edge of the cutout, measured from the left end of the benchtop. */
  readonly fromLeftMm: number;
  /** Front edge of the cutout, measured from the front of the benchtop. */
  readonly fromFrontMm: number;
  readonly widthMm: number;
  readonly depthMm: number;
  readonly cornerRadiusMm: number;
}

export interface RoundCutout {
  readonly kind: 'hole';
  readonly id: string;
  readonly fromLeftMm: number;
  readonly fromFrontMm: number;
  readonly diameterMm: number;
}

export type BenchtopCutout = RectangularCutout | RoundCutout;

/* ------------------------------------------------------------ parameters -- */

export interface BenchtopParams {
  readonly name: string;
  readonly partId?: string;
  readonly revision?: string;
  /** Overall length, outside to outside. */
  readonly lengthMm: number;
  /** Overall depth, front outside face to the back. */
  readonly depthMm: number;
  readonly thicknessMm: number;
  readonly materialId: string;
  readonly bendRadiusMm: number;
  /** Edge treatment per side. Omitted sides are left open. */
  readonly edges?: Partial<BenchtopEdges>;
  /**
   * What to do where two sides folding the same way meet. Defaults to `mitre`,
   * which closes the corner for welding. Corners where the two sides fold
   * opposite ways are relieved whatever this says.
   */
  readonly cornerStyle?: CornerStyle;
  /**
   * Gap left between the two flanges at a closed corner, mm. Omit for one
   * thickness, which clears the material and leaves something to weld into.
   */
  readonly cornerGapMm?: number;
  /**
   * Size of the notch cut at a relieved corner, mm. Omit for a sensible
   * default; the two bend zones must not run into each other.
   */
  readonly cornerReliefMm?: number;
  /** @deprecated Superseded by `edges.front`; still honoured if present. */
  readonly frontEdge?: FrontEdgeParams;
  /** @deprecated Superseded by `edges.back`; still honoured if present. */
  readonly splashback?: SplashbackParams;
  readonly cutouts: readonly BenchtopCutout[];
  readonly grain?: GrainDirection;
}

export const BENCHTOP_TEMPLATE_KIND = 'benchtop';

export const DEFAULT_BENCHTOP: BenchtopParams = {
  name: 'Benchtop',
  lengthMm: 1800,
  depthMm: 600,
  thicknessMm: 1.2,
  materialId: 'ss304',
  bendRadiusMm: 1.2,
  edges: {
    front: { style: 'square-drop', heightMm: 40 },
    back: { style: 'upstand', heightMm: 100 },
    left: NO_EDGE,
    right: NO_EDGE,
  },
  cutouts: [],
  grain: 'length',
};

export class BenchtopParameterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenchtopParameterError';
  }
}

/**
 * Fill in every side, reading the older `frontEdge` / `splashback` spelling
 * when a project predates per-side edges. `edges` wins where both are given.
 */
export function resolveEdges(params: BenchtopParams): BenchtopEdges {
  // Setting both spellings for one side is always a mistake, and silently
  // preferring one of them hides it. DEFAULT_BENCHTOP uses `edges`, so
  // spreading it and then setting `frontEdge` would otherwise do nothing.
  if (params.edges?.front !== undefined && params.frontEdge !== undefined) {
    throw new BenchtopParameterError('set either edges.front or the older frontEdge, not both');
  }
  if (params.edges?.back !== undefined && params.splashback !== undefined) {
    throw new BenchtopParameterError('set either edges.back or the older splashback, not both');
  }

  const legacyFront: EdgeParams | undefined =
    params.frontEdge === undefined
      ? undefined
      : {
          style: params.frontEdge.style,
          heightMm: params.frontEdge.dropMm,
          ...(params.frontEdge.returnMm !== undefined ? { returnMm: params.frontEdge.returnMm } : {}),
          ...(params.frontEdge.upstandMm !== undefined
            ? { upstandMm: params.frontEdge.upstandMm }
            : {}),
        };
  const legacyBack: EdgeParams | undefined =
    params.splashback === undefined
      ? undefined
      : {
          style: params.splashback.style === 'integral' ? 'upstand' : 'none',
          heightMm: params.splashback.heightMm,
        };

  return {
    front: params.edges?.front ?? legacyFront ?? NO_EDGE,
    back: params.edges?.back ?? legacyBack ?? NO_EDGE,
    left: params.edges?.left ?? NO_EDGE,
    right: params.edges?.right ?? NO_EDGE,
  };
}

export function hasFlange(edge: EdgeParams): boolean {
  return edge.style !== 'none' && edge.heightMm > 0;
}

/** Which way a side folds. An upstand goes up; every other style goes down. */
export function foldDirection(edge: EdgeParams): 'up' | 'down' {
  return edge.style === 'upstand' ? 'up' : 'down';
}

/**
 * What happens at each corner.
 *
 * Two sides folding the same way can close against each other. Two folding
 * opposite ways cannot — the flanges go in different directions from the same
 * point — so that corner is relieved regardless of what was asked for.
 */
export function cornerTreatments(
  edges: BenchtopEdges,
  style: CornerStyle = 'mitre',
): Readonly<Record<CornerName, CornerTreatment>> {
  const out = {} as Record<CornerName, CornerTreatment>;
  for (const { name, startSide, endSide } of CORNERS) {
    const a = edges[startSide];
    const b = edges[endSide];
    if (!hasFlange(a) || !hasFlange(b)) out[name] = 'none';
    else if (foldDirection(a) !== foldDirection(b)) out[name] = 'relief';
    else out[name] = style;
  }
  return out;
}

/* ------------------------------------------------------------------ build -- */

/** Generate the feature tree for a benchtop. */
export function benchtopPart(params: BenchtopParams): Part {
  const { thicknessMm: t, bendRadiusMm: r } = params;
  if (t <= 0) throw new BenchtopParameterError('thickness must be positive');
  if (r <= 0) throw new BenchtopParameterError('bend radius must be positive');
  if (params.lengthMm <= 0 || params.depthMm <= 0) {
    throw new BenchtopParameterError('length and depth must be positive');
  }

  // Every 90 degree fold eats one outside setback out of the dimension it runs
  // along. Legs are stored tangent-to-tangent, so subtract one setback per fold
  // at each end of the leg.
  const setback = outsideSetback(90, r, t);
  const edges = resolveEdges(params);
  const flanged = (side: Side): boolean => hasFlange(edges[side]);

  const topWidth =
    params.lengthMm - (flanged('left') ? setback : 0) - (flanged('right') ? setback : 0);
  const topDepth =
    params.depthMm - (flanged('front') ? setback : 0) - (flanged('back') ? setback : 0);
  if (topWidth <= 0 || topDepth <= 0) {
    throw new BenchtopParameterError(
      `a ${params.lengthMm} x ${params.depthMm} mm benchtop has no top left once its folds take ${setback.toFixed(1)} mm of setback each; increase the size or reduce the bend radius`,
    );
  }

  const relief = params.cornerReliefMm ?? defaultCornerRelief(t, r);
  const gap = params.cornerGapMm ?? defaultCornerGap(t);
  if (gap < 0) throw new BenchtopParameterError('corner gap cannot be negative');
  const corners = cornerTreatments(edges, params.cornerStyle ?? 'mitre');
  const top = topFace(topWidth, topDepth, corners, relief);

  const topId = featureId('top');
  const features: Feature[] = [
    {
      kind: 'base-flange',
      id: topId,
      profile: top.profile,
      edges: top.edges,
      label: 'Top',
    },
  ];

  for (const side of SIDES) {
    const at = {
      // A side's own start is the corner its edge leaves from, its end the
      // corner its edge arrives at.
      start: corners[CORNERS.find((c) => c.startSide === side)!.name],
      end: corners[CORNERS.find((c) => c.endSide === side)!.name],
    };
    features.push(...edgeFeatures(side, edges[side], params, setback, at, gap));
  }
  features.push(...cutoutFeatures(params, edges, setback, top.origin));

  return {
    parameters: {
      name: params.name,
      materialId: params.materialId,
      thicknessMm: t,
      grain: params.grain ?? 'length',
      ...(params.partId !== undefined ? { partId: params.partId } : {}),
      ...(params.revision !== undefined ? { revision: params.revision } : {}),
    },
    features,
    template: { kind: BENCHTOP_TEMPLATE_KIND, params },
  };
}

/**
 * A notch big enough that the probe used by the bend-relief check clears it,
 * and at least a thickness of metal is removed from the corner.
 */
function defaultCornerRelief(thickness: number, radius: number): number {
  return Math.max(2 * thickness, radius + thickness);
}

/**
 * Weld gap at a closed corner, mm.
 *
 * Face profiles lie on the neutral surface, so two flanges whose profiles just
 * touch would have their real material interlocking by roughly half a
 * thickness at the corner. One thickness of gap clears that and leaves a seam
 * of about half a thickness to weld into — for 1.2 mm stainless, a 0.6 mm gap,
 * which is what a TIG weld wants. The shop may prefer another number; that is
 * what `cornerGapMm` is for.
 */
function defaultCornerGap(thickness: number): number {
  return thickness;
}

interface TopFace {
  readonly profile: Profile;
  readonly edges: Record<string, DirectedEdge>;
  /** Where the top face's own origin sits relative to the front-left corner. */
  readonly origin: Vec2;
}

/**
 * The top face, notched only at the corners that are being relieved.
 *
 * A relieved corner has its two bend lines ending in fresh air, which is what
 * the bend-relief check looks for and what stops the metal tearing when the
 * second bend forms. A mitred corner is left square: the flanges close against
 * each other there, so the top must run all the way out to meet them.
 */
function topFace(
  width: number,
  depth: number,
  corners: Readonly<Record<CornerName, CornerTreatment>>,
  relief: number,
): TopFace {
  const notch = (corner: CornerName): number => (corners[corner] === 'relief' ? relief : 0);
  const bl = notch('front-left');
  const br = notch('front-right');
  const tr = notch('back-right');
  const tl = notch('back-left');

  if (Math.max(bl, br, tr, tl) > 0 && relief * 2 >= Math.min(width, depth)) {
    throw new BenchtopParameterError(
      `corner relief of ${relief.toFixed(1)} mm does not fit a ${width.toFixed(0)} x ${depth.toFixed(0)} mm top`,
    );
  }

  const points: Vec2[] = [];
  const push = (x: number, y: number): void => {
    points.push({ x, y });
  };

  push(bl, 0);
  push(width - br, 0);
  if (br > 0) {
    push(width - br, br);
    push(width, br);
  }
  push(width, depth - tr);
  if (tr > 0) {
    push(width - tr, depth - tr);
    push(width - tr, depth);
  }
  push(tl, depth);
  if (tl > 0) {
    push(tl, depth - tl);
    push(0, depth - tl);
  }
  // Without a notch here the left edge runs straight back into the first point,
  // so emitting it again would leave a zero-length segment in the profile.
  if (bl > 0) {
    push(0, bl);
    push(bl, bl);
  }

  const outer: Loop = polygon(points);
  return {
    profile: profile(outer),
    // Each edge is directed so the top face's material lies to its left, which
    // is the convention the unfold engine places faces by.
    edges: {
      front: { p0: { x: bl, y: 0 }, p1: { x: width - br, y: 0 } },
      right: { p0: { x: width, y: br }, p1: { x: width, y: depth - tr } },
      back: { p0: { x: width - tr, y: depth }, p1: { x: tl, y: depth } },
      left: { p0: { x: 0, y: depth - tl }, p1: { x: 0, y: bl } },
    },
    origin: { x: 0, y: 0 },
  };
}

/**
 * The flange chain for one side. A square drop is one link; a return adds a
 * second; a boxed edge adds a third. An upstand is the splashback: one link,
 * folded the other way.
 */
function edgeFeatures(
  side: Side,
  edge: EdgeParams,
  params: BenchtopParams,
  setback: number,
  at: { start: CornerTreatment; end: CornerTreatment },
  gap: number,
): EdgeFlangeFeature[] {
  if (!hasFlange(edge)) return [];

  const r = params.bendRadiusMm;
  const direction = foldDirection(edge);
  const common = { angleDeg: 90, direction, insideRadiusMm: r };
  const out: EdgeFlangeFeature[] = [];

  // At a mitred corner the two flanges close against each other. Half the weld
  // gap comes off each of them, so the seam is centred on the corner. A relieved
  // corner needs nothing here: the top face is already notched, which shortens
  // the bend line and the flange with it.
  const halfGap = gap / 2;
  const insets = {
    ...(at.start === 'mitre' && halfGap > 0 ? { insetStartMm: halfGap } : {}),
    ...(at.end === 'mitre' && halfGap > 0 ? { insetEndMm: halfGap } : {}),
  };
  // Only the links that end up horizontal need a mitre — two vertical flanges
  // meeting at a right angle already butt along the corner line, but two
  // horizontal ones overlap in a square unless each is cut back at 45.
  const mitres = {
    ...(at.start === 'mitre' ? { mitreStartDeg: 45 } : {}),
    ...(at.end === 'mitre' ? { mitreEndDeg: 45 } : {}),
  };

  // The splashback keeps its own name: it is what the people using this call
  // it, and the feature tree is meant to read like the part.
  const rootId = side === 'back' && edge.style === 'upstand' ? 'splashback' : `${side}Drop`;
  const rootLabel =
    side === 'back' && edge.style === 'upstand' ? 'Splashback' : `${sideLabel(side)} edge`;

  const foldsAtBottom = edge.style === 'drop-and-return' || edge.style === 'boxed' ? 1 : 0;
  const rootLeg = edge.heightMm - setback - foldsAtBottom * setback;
  requirePositive(rootLeg, `${sideLabel(side).toLowerCase()} edge of ${edge.heightMm} mm`, setback);
  out.push({
    kind: 'edge-flange',
    id: featureId(rootId),
    edge: { faceId: faceId('top'), edgeName: side },
    lengthMm: rootLeg,
    ...common,
    ...insets,
    label: rootLabel,
  });

  if (edge.style === 'drop-and-return' || edge.style === 'boxed') {
    const returnMm = edge.returnMm;
    if (returnMm === undefined || returnMm <= 0) {
      throw new BenchtopParameterError(`${sideLabel(side).toLowerCase()} edge style "${edge.style}" needs a return length`);
    }
    const foldsAtEnd = edge.style === 'boxed' ? 1 : 0;
    const returnLeg = returnMm - setback - foldsAtEnd * setback;
    requirePositive(returnLeg, `${sideLabel(side).toLowerCase()} return of ${returnMm} mm`, setback);
    out.push({
      kind: 'edge-flange',
      id: featureId(`${side}Return`),
      edge: { faceId: faceId(rootId), edgeName: 'tip' },
      lengthMm: returnLeg,
      ...common,
      ...mitres,
      label: `${sideLabel(side)} return`,
    });
  }

  if (edge.style === 'boxed') {
    const upstandMm = edge.upstandMm;
    if (upstandMm === undefined || upstandMm <= 0) {
      throw new BenchtopParameterError(`${sideLabel(side).toLowerCase()} edge style "boxed" needs an upstand height`);
    }
    const upstandLeg = upstandMm - setback;
    requirePositive(upstandLeg, `${sideLabel(side).toLowerCase()} upstand of ${upstandMm} mm`, setback);
    out.push({
      kind: 'edge-flange',
      id: featureId(`${side}Upstand`),
      edge: { faceId: faceId(`${side}Return`), edgeName: 'tip' },
      lengthMm: upstandLeg,
      ...common,
      label: `${sideLabel(side)} upstand`,
    });
  }

  return out;
}

function sideLabel(side: Side): string {
  return side.charAt(0).toUpperCase() + side.slice(1);
}

/**
 * Cutouts are positioned from the front-left corner of the finished benchtop,
 * which is where a joiner measures from. The top face's own origin sits one
 * setback in from any flanged side, so that offset is applied here.
 */
function cutoutFeatures(
  params: BenchtopParams,
  edges: BenchtopEdges,
  setback: number,
  origin: Vec2,
): CutoutFeature[] {
  const xOffset = (hasFlange(edges.left) ? setback : 0) + origin.x;
  const yOffset = (hasFlange(edges.front) ? setback : 0) + origin.y;
  return params.cutouts.map((c) => {
    const x = c.fromLeftMm - xOffset;
    const y = c.fromFrontMm - yOffset;
    if (c.kind === 'hole') {
      if (c.diameterMm <= 0) {
        throw new BenchtopParameterError(`cutout ${c.id}: diameter must be positive`);
      }
      return {
        kind: 'cutout',
        id: featureId(c.id),
        faceId: faceId('top'),
        loop: circle(x, y, c.diameterMm / 2),
        label: `Hole ${c.id}`,
      };
    }
    if (c.widthMm <= 0 || c.depthMm <= 0) {
      throw new BenchtopParameterError(`cutout ${c.id}: width and depth must be positive`);
    }
    return {
      kind: 'cutout',
      id: featureId(c.id),
      faceId: faceId('top'),
      loop: roundedRect(x, y, c.widthMm, c.depthMm, c.cornerRadiusMm),
      label: `${c.kind === 'sink' ? 'Sink' : 'Hob'} cutout ${c.id}`,
    };
  });
}

function requirePositive(leg: number, what: string, setback: number): void {
  if (leg <= 0) {
    throw new BenchtopParameterError(
      `${what} is too short: the folds take ${setback.toFixed(2)} mm of setback each, leaving ${leg.toFixed(2)} mm of flat`,
    );
  }
}
