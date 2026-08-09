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
 */

import { roundedRect, circle } from '../geometry/loop.js';
import { rectangleEdges, rectangleProfile } from '../features/regen.js';
import {
  type CutoutFeature,
  type EdgeFlangeFeature,
  type Feature,
  type GrainDirection,
  type Part,
} from '../features/types.js';
import { faceId, featureId } from '../ids.js';
import { outsideSetback } from '../materials/allowance.js';

export type FrontEdgeStyle = 'none' | 'square-drop' | 'drop-and-return' | 'boxed';
export type SplashbackStyle = 'none' | 'integral';

export interface FrontEdgeParams {
  readonly style: FrontEdgeStyle;
  /** Outside height of the front drop, top surface to the bottom of the edge. */
  readonly dropMm: number;
  /** Outside length of the return that folds back under. */
  readonly returnMm?: number;
  /** Outside height of the upstand that closes a boxed edge. */
  readonly upstandMm?: number;
}

export interface SplashbackParams {
  readonly style: SplashbackStyle;
  /** Outside height above the benchtop surface. */
  readonly heightMm: number;
}

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
  /** Centre, measured from the left end and the front of the benchtop. */
  readonly fromLeftMm: number;
  readonly fromFrontMm: number;
  readonly diameterMm: number;
}

export type BenchtopCutout = RectangularCutout | RoundCutout;

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
  readonly frontEdge: FrontEdgeParams;
  readonly splashback: SplashbackParams;
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
  frontEdge: { style: 'square-drop', dropMm: 40 },
  splashback: { style: 'integral', heightMm: 100 },
  cutouts: [],
  grain: 'length',
};

export class BenchtopParameterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenchtopParameterError';
  }
}

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

  const hasFront = params.frontEdge.style !== 'none';
  const hasSplashback = params.splashback.style !== 'none';

  const topDepth = params.depthMm - (hasFront ? setback : 0) - (hasSplashback ? setback : 0);
  if (topDepth <= 0) {
    throw new BenchtopParameterError(
      `a ${params.depthMm} mm deep benchtop has no top left once the folds take ${(2 * setback).toFixed(1)} mm; increase the depth or the bend radius`,
    );
  }

  const topId = featureId('top');
  const features: Feature[] = [
    {
      kind: 'base-flange',
      id: topId,
      profile: rectangleProfile(params.lengthMm, topDepth),
      edges: rectangleEdges(params.lengthMm, topDepth),
      label: 'Top',
    },
  ];

  features.push(...frontEdgeFeatures(params, setback));
  if (hasSplashback) features.push(splashbackFeature(params, setback));
  features.push(...cutoutFeatures(params, setback));

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
 * The front edge chain. Each style is a run of edge flanges folding the same
 * way, so a square drop, a drop with a return under it, and a full boxed edge
 * differ only in how many links the chain has.
 */
function frontEdgeFeatures(params: BenchtopParams, setback: number): EdgeFlangeFeature[] {
  const { style, dropMm } = params.frontEdge;
  if (style === 'none') return [];

  const r = params.bendRadiusMm;
  const common = {
    angleDeg: 90,
    direction: 'down' as const,
    insideRadiusMm: r,
  };
  const out: EdgeFlangeFeature[] = [];

  // The drop loses a setback at its top fold, plus another at its bottom fold
  // when something folds back off it.
  const foldsAtBottom = style === 'drop-and-return' || style === 'boxed' ? 1 : 0;
  const dropLeg = dropMm - setback - foldsAtBottom * setback;
  requirePositive(dropLeg, `front edge drop of ${dropMm} mm`, setback);
  out.push({
    kind: 'edge-flange',
    id: featureId('frontDrop'),
    edge: { faceId: faceId('top'), edgeName: 'front' },
    lengthMm: dropLeg,
    ...common,
    label: 'Front edge',
  });

  if (style === 'drop-and-return' || style === 'boxed') {
    const returnMm = params.frontEdge.returnMm;
    if (returnMm === undefined || returnMm <= 0) {
      throw new BenchtopParameterError(`front edge style "${style}" needs a return length`);
    }
    const foldsAtEnd = style === 'boxed' ? 1 : 0;
    const returnLeg = returnMm - setback - foldsAtEnd * setback;
    requirePositive(returnLeg, `front edge return of ${returnMm} mm`, setback);
    out.push({
      kind: 'edge-flange',
      id: featureId('frontReturn'),
      edge: { faceId: faceId('frontDrop'), edgeName: 'tip' },
      lengthMm: returnLeg,
      ...common,
      label: 'Front return',
    });
  }

  if (style === 'boxed') {
    const upstandMm = params.frontEdge.upstandMm;
    if (upstandMm === undefined || upstandMm <= 0) {
      throw new BenchtopParameterError('front edge style "boxed" needs an upstand height');
    }
    const upstandLeg = upstandMm - setback;
    requirePositive(upstandLeg, `front edge upstand of ${upstandMm} mm`, setback);
    out.push({
      kind: 'edge-flange',
      id: featureId('frontUpstand'),
      edge: { faceId: faceId('frontReturn'), edgeName: 'tip' },
      lengthMm: upstandLeg,
      ...common,
      label: 'Front upstand',
    });
  }

  return out;
}

function splashbackFeature(params: BenchtopParams, setback: number): EdgeFlangeFeature {
  const leg = params.splashback.heightMm - setback;
  requirePositive(leg, `splashback of ${params.splashback.heightMm} mm`, setback);
  return {
    kind: 'edge-flange',
    id: featureId('splashback'),
    edge: { faceId: faceId('top'), edgeName: 'back' },
    lengthMm: leg,
    angleDeg: 90,
    direction: 'up',
    insideRadiusMm: params.bendRadiusMm,
    label: 'Splashback',
  };
}

/**
 * Cutouts are positioned from the front-left corner of the finished benchtop,
 * which is where a joiner measures from. The top face's own origin sits one
 * setback back from the front, so that offset is applied here.
 */
function cutoutFeatures(params: BenchtopParams, setback: number): CutoutFeature[] {
  const frontOffset = params.frontEdge.style === 'none' ? 0 : setback;
  return params.cutouts.map((c) => {
    const y = c.fromFrontMm - frontOffset;
    if (c.kind === 'hole') {
      if (c.diameterMm <= 0) {
        throw new BenchtopParameterError(`cutout ${c.id}: diameter must be positive`);
      }
      return {
        kind: 'cutout',
        id: featureId(c.id),
        faceId: faceId('top'),
        loop: circle(c.fromLeftMm, y, c.diameterMm / 2),
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
      loop: roundedRect(c.fromLeftMm, y, c.widthMm, c.depthMm, c.cornerRadiusMm),
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
