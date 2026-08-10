/**
 * The feature model.
 *
 * The feature list is the source of truth for a part. Geometry — the
 * face-bend graph, the flat pattern, the 3D solid — is always regenerated from
 * it and never edited directly or persisted. Editing a parameter and
 * regenerating is the only way a part changes shape.
 *
 * Features refer to geometry through stable topological names
 * (`face:top` / `edge:front`), never through array positions.
 */

import { type Loop } from '../geometry/loop.js';
import { type Profile } from '../geometry/profile.js';
import { type DirectedEdge, type BendDirection } from '../model/graph.js';
import { type CornerTreatment } from '../model/corner.js';
import { type FaceId, type FeatureId } from '../ids.js';

/** Points at one named edge of one face. */
export interface EdgeRef {
  readonly faceId: FaceId;
  readonly edgeName: string;
}

export interface BaseFlangeFeature {
  readonly kind: 'base-flange';
  readonly id: FeatureId;
  /** Sketch profile, in the part's own plan coordinates. */
  readonly profile: Profile;
  /** Names for the sketch's boundary edges, so later features can find them. */
  readonly edges: Readonly<Record<string, DirectedEdge>>;
  readonly label?: string;
}

export interface EdgeFlangeFeature {
  readonly kind: 'edge-flange';
  readonly id: FeatureId;
  readonly edge: EdgeRef;
  /** Leg length measured tangent line to tangent line, mm. */
  readonly lengthMm: number;
  readonly angleDeg: number;
  readonly direction: BendDirection;
  readonly insideRadiusMm: number;
  /** Pull the flange back from the start of the edge, mm. */
  readonly insetStartMm?: number;
  /** Pull the flange back from the end of the edge, mm. */
  readonly insetEndMm?: number;
  /**
   * Cut the start end of the flange at an angle instead of square, degrees.
   *
   * 0 is a square end. A positive angle rakes the cut back toward the middle of
   * the flange, so the tip is shorter than the root — 45 is the mitre that lets
   * two flanges meeting at a right-angled corner close against each other
   * instead of overlapping. Negative flares the end outward.
   *
   * "Start" is the end of the flange that came from the start of its parent
   * edge, matching `insetStartMm` and the `start` named edge.
   */
  readonly mitreStartDeg?: number;
  /** Cut the end end of the flange at an angle instead of square, degrees. */
  readonly mitreEndDeg?: number;
  /** Pin a V-die instead of letting the machine profile choose. */
  readonly dieWidthMm?: number;
  /** Force a bend allowance, bypassing the material and bend table. */
  readonly allowanceOverrideMm?: number;
  readonly label?: string;
}

export interface CutoutFeature {
  readonly kind: 'cutout';
  readonly id: FeatureId;
  readonly faceId: FaceId;
  /** Cutout boundary in the target face's local coordinates. */
  readonly loop: Loop;
  readonly label?: string;
}

/**
 * Two flanges that meet in the folded part, and what to do where they meet.
 *
 * Not a graph edge: see `model/corner.ts` and CLAUDE.md invariant 1. The
 * treatment modifies the two faces' 2D profiles at unfold time.
 */
export interface CornerJointFeature {
  readonly kind: 'corner-joint';
  readonly id: FeatureId;
  readonly a: EdgeRef;
  readonly b: EdgeRef;
  readonly treatment: CornerTreatment;
  readonly label?: string;
}

export type Feature =
  | BaseFlangeFeature
  | EdgeFlangeFeature
  | CutoutFeature
  | CornerJointFeature;

export type GrainDirection = 'length' | 'width' | 'none';

export interface PartParameters {
  readonly name: string;
  readonly materialId: string;
  readonly thicknessMm: number;
  /**
   * Polish grain direction, carried through to the DXF and the drawing.
   * Polished stainless has to be nested with the grain aligned, and the laser
   * operator needs to see which way that is.
   */
  readonly grain: GrainDirection;
  /** Part number / label etched on the blank. */
  readonly partId?: string;
  readonly revision?: string;
  /**
   * How many of this part the document wants. Absent means one.
   *
   * An assembly asks for two of a side panel and one of a floor; the cut list
   * and the mass rollup need to know, and the DXF does not — the same file is
   * cut N times.
   */
  readonly quantity?: number;
}

export interface Part {
  readonly parameters: PartParameters;
  readonly features: readonly Feature[];
  /**
   * Parameters of the template that generated these features, when the part
   * came from one. Kept so the wizard stays live and can regenerate.
   */
  readonly template?: { readonly kind: string; readonly params: unknown };
}
