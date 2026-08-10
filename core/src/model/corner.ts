/**
 * Corner joints: two flanges that meet in the folded part.
 *
 * A joint is **not** a graph edge. The face-bend graph is a tree — every face
 * reachable from the base by exactly one path — and that is what makes unfold a
 * sequence of rigid motions with nothing to reconcile. A corner where two
 * flanges meet is a second relationship between faces that are already related
 * through the tree, so recording it as an edge would close a cycle and take the
 * property away.
 *
 * Instead a joint lives alongside the graph and does its work by **modifying
 * the two faces' 2D profiles** before they are placed:
 *
 *  - `weld-gap` pulls both edges back by half the gap, leaving a seam to weld.
 *  - `tab-slot` grows tabs out of one edge and cuts matching slots in the other
 *    face, so the panels locate each other and hold themselves square while
 *    they are welded or riveted.
 *
 * Both are ordinary boolean operations on a face profile, which is why the
 * blank that reaches the laser carries them and nothing downstream has to know
 * a corner was involved.
 *
 * The two edges of a joint mate **antiparallel**, the same convention bend
 * lines follow: travelling along edge A from its start is travelling along
 * edge B toward its start. A station `s` from A's start therefore meets the
 * station `s` from B's *end*, and that is what lines a tab up with its slot.
 */

import { type Loop, polygon } from '../geometry/loop.js';
import { profile, type Profile } from '../geometry/profile.js';
import { add, leftNormal, normalize, rightNormal, scale, sub, type Vec2 } from '../geometry/vec2.js';
import { booleans } from '../geometry/boolean.js';
import { type CornerId, type FaceId } from '../ids.js';
import {
  type DirectedEdge,
  type Face,
  type FaceBendGraph,
  edgeLength,
  namedEdge,
} from './graph.js';

/** One side of a joint: a named edge on a named face. */
export interface CornerEdgeRef {
  readonly faceId: FaceId;
  readonly edgeName: string;
}

/**
 * Cut both flanges back so there is a gap to weld into.
 *
 * Profiles lie on the neutral surface, so two edges that just touched would
 * have their real material interlocking by around half a thickness. The gap is
 * shared: half comes off each side, so the seam sits where the corner is.
 */
export interface WeldGapTreatment {
  readonly kind: 'weld-gap';
  readonly gapMm: number;
}

/**
 * Grow tabs on one edge and cut matching slots in the other face.
 *
 * Self-fixturing: the panels hold themselves in place and square while they are
 * joined, instead of needing a jig.
 *
 * `slotInsetMm` is the distance from edge B to the centre of its slots. It is
 * the one number here that depends on how the two panels actually sit against
 * each other, so there is no correct default — only a safe one. It defaults to
 * leaving **one thickness of land** between the edge and the near side of the
 * slot, which is about the least metal that will not tear out. **Confirm it
 * against how the shop builds these** before cutting a set.
 *
 * Too small an inset makes the slot straddle the edge, which is an open notch
 * and a different joint entirely; `checkCorners` refuses that rather than
 * quietly cutting it.
 */
export interface TabSlotTreatment {
  readonly kind: 'tab-slot';
  /** Width of each tab along the edge, mm. */
  readonly tabWidthMm: number;
  /** How many tabs, spread evenly along the edge. */
  readonly tabCount: number;
  /** How far the tab stands out of edge A, mm. Usually one thickness. */
  readonly tabLengthMm: number;
  /** Slop added to every slot dimension so the tab goes in, mm. */
  readonly clearanceMm: number;
  /** Distance from edge B to its slots' centreline, mm. */
  readonly slotInsetMm?: number;
}

export type CornerTreatment = WeldGapTreatment | TabSlotTreatment;

export interface CornerJoint {
  readonly id: CornerId;
  readonly a: CornerEdgeRef;
  readonly b: CornerEdgeRef;
  readonly treatment: CornerTreatment;
  readonly label?: string;
}

export interface CornerProblem {
  readonly cornerId: CornerId;
  readonly message: string;
}

/** Edge lengths this far apart still count as meeting. */
const MATE_TOLERANCE_MM = 1e-6;

/**
 * Structural checks on the joints in a graph.
 *
 * Everything here is "could these two edges meet at all", not "should they" —
 * that is the template's business. The one that carries real risk is the
 * length check: two edges of different lengths do not butt, and a joint that
 * quietly treats them as if they did puts tabs where there is no slot.
 */
export function checkCorners(g: FaceBendGraph): CornerProblem[] {
  const problems: CornerProblem[] = [];
  const say = (cornerId: CornerId, message: string): void => {
    problems.push({ cornerId, message });
  };

  for (const joint of g.corners.values()) {
    const a = resolve(g, joint.a);
    const b = resolve(g, joint.b);
    if (typeof a === 'string') {
      say(joint.id, `side A: ${a}`);
      continue;
    }
    if (typeof b === 'string') {
      say(joint.id, `side B: ${b}`);
      continue;
    }
    if (joint.a.faceId === joint.b.faceId && joint.a.edgeName === joint.b.edgeName) {
      say(joint.id, 'both sides name the same edge, so there is no corner here');
      continue;
    }

    const lengthA = edgeLength(a.edge);
    const lengthB = edgeLength(b.edge);
    if (Math.abs(lengthA - lengthB) > MATE_TOLERANCE_MM) {
      say(
        joint.id,
        `the two edges are ${lengthA.toFixed(3)} and ${lengthB.toFixed(3)} mm long, so they do not meet along their whole length`,
      );
      continue;
    }

    const t = joint.treatment;
    if (t.kind === 'weld-gap') {
      if (!(t.gapMm >= 0)) say(joint.id, 'weld gap cannot be negative');
    } else {
      if (!(t.tabWidthMm > 0)) say(joint.id, 'tab width must be positive');
      if (!Number.isInteger(t.tabCount) || t.tabCount < 1) {
        say(joint.id, 'tab count must be a whole number of one or more');
      }
      if (!(t.tabLengthMm > 0)) say(joint.id, 'tab length must be positive');
      if (!(t.clearanceMm >= 0)) say(joint.id, 'tab clearance cannot be negative');
      if (t.tabWidthMm * t.tabCount >= lengthA) {
        say(
          joint.id,
          `${t.tabCount} tabs of ${t.tabWidthMm} mm do not fit on a ${lengthA.toFixed(1)} mm edge`,
        );
      }
      const depth = g.thickness + 2 * t.clearanceMm;
      const inset = t.slotInsetMm ?? defaultSlotInset(g.thickness, t.clearanceMm);
      if (!(inset >= 0)) {
        say(joint.id, 'slot inset cannot be negative');
      } else if (inset < depth / 2) {
        say(
          joint.id,
          `a slot ${depth.toFixed(2)} mm deep set ${inset.toFixed(2)} mm from the edge would break out through it; move it at least ${(depth / 2).toFixed(2)} mm in, or use a weld gap if an open notch is what you want`,
        );
      }
    }
  }

  return problems;
}

interface Resolved {
  readonly face: Face;
  readonly edge: DirectedEdge;
}

function resolve(g: FaceBendGraph, ref: CornerEdgeRef): Resolved | string {
  const face = g.faces.get(ref.faceId);
  if (face === undefined) return `no face called ${ref.faceId}`;
  try {
    return { face, edge: namedEdge(face, ref.edgeName) };
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Apply every joint to the faces it touches, returning a new graph.
 *
 * Pure: the input graph is untouched, so the same graph always develops the
 * same way and a joint can never accumulate twice.
 */
export function applyCorners(g: FaceBendGraph): FaceBendGraph {
  if (g.corners.size === 0) return g;

  // Each face may be touched by more than one joint — a flange between two
  // corners is the ordinary case — so edits accumulate per face.
  const edits = new Map<FaceId, Profile>();
  const currentOf = (id: FaceId): Profile => edits.get(id) ?? g.faces.get(id)!.profile;

  for (const joint of g.corners.values()) {
    const a = resolve(g, joint.a);
    const b = resolve(g, joint.b);
    // Anything unresolvable has already been reported by `checkCorners`, which
    // gates the unfold; skipping here keeps this function total.
    if (typeof a === 'string' || typeof b === 'string') continue;

    if (joint.treatment.kind === 'weld-gap') {
      const half = joint.treatment.gapMm / 2;
      if (half <= 0) continue;
      edits.set(joint.a.faceId, cutBack(currentOf(joint.a.faceId), a.edge, half));
      edits.set(joint.b.faceId, cutBack(currentOf(joint.b.faceId), b.edge, half));
      continue;
    }

    const t = joint.treatment;
    const inset = t.slotInsetMm ?? defaultSlotInset(g.thickness, t.clearanceMm);
    const stations = tabStations(edgeLength(a.edge), t.tabCount);
    edits.set(
      joint.a.faceId,
      addTabs(currentOf(joint.a.faceId), a.edge, stations, t.tabWidthMm, t.tabLengthMm),
    );
    edits.set(
      joint.b.faceId,
      cutSlots(currentOf(joint.b.faceId), b.edge, stations, {
        widthMm: t.tabWidthMm + 2 * t.clearanceMm,
        depthMm: g.thickness + 2 * t.clearanceMm,
        insetMm: inset,
      }),
    );
  }

  if (edits.size === 0) return g;
  const faces = new Map(g.faces);
  for (const [id, p] of edits) faces.set(id, { ...faces.get(id)!, profile: p });
  return { ...g, faces };
}

/**
 * Where a slot sits when nobody has said.
 *
 * One thickness of land between the panel edge and the near side of the slot:
 * enough metal that the tab will not tear out through the edge, and closed
 * rather than open so it is a slot and not a notch. It is a floor, not a
 * design — the real number comes from how the panels sit together.
 */
export function defaultSlotInset(thicknessMm: number, clearanceMm: number): number {
  return thicknessMm + (thicknessMm + 2 * clearanceMm) / 2;
}

/**
 * Centre station of each tab, measured from the start of the edge.
 *
 * Evenly spread, each tab centred in its own share of the edge: predictable,
 * symmetric, and it never puts a tab hard against either end where the metal is
 * already busy with a bend.
 */
export function tabStations(edgeLengthMm: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => (edgeLengthMm * (i + 0.5)) / count);
}

/** Remove a strip of the given depth along one edge, inside its own face. */
function cutBack(p: Profile, edge: DirectedEdge, depthMm: number): Profile {
  const u = normalize(sub(edge.p1, edge.p0));
  // The edge is directed with its own material on the left, so "into the face"
  // is the left normal.
  const into = scale(leftNormal(u), depthMm);
  const strip = polygon([
    edge.p0,
    edge.p1,
    add(edge.p1, into),
    add(edge.p0, into),
  ]);
  return single(booleans().difference([p], [profile(strip)]), p);
}

/** Grow rectangular tabs out of one edge, away from its own material. */
function addTabs(
  p: Profile,
  edge: DirectedEdge,
  stations: readonly number[],
  widthMm: number,
  lengthMm: number,
): Profile {
  const u = normalize(sub(edge.p1, edge.p0));
  // Material is on the left, so the tab stands out to the right.
  const out = scale(rightNormal(u), lengthMm);
  const half = scale(u, widthMm / 2);
  const tabs = stations.map((s) => {
    const centre = add(edge.p0, scale(u, s));
    const c0 = sub(centre, half);
    const c1 = add(centre, half);
    return profile(polygon([c0, c1, add(c1, out), add(c0, out)]));
  });
  return single(booleans().union([p, ...tabs]), p);
}

interface SlotSpec {
  readonly widthMm: number;
  readonly depthMm: number;
  readonly insetMm: number;
}

/** Cut slots in a face, set in from one of its edges, to take the tabs. */
function cutSlots(
  p: Profile,
  edge: DirectedEdge,
  stations: readonly number[],
  slot: SlotSpec,
): Profile {
  const length = edgeLength(edge);
  const u = normalize(sub(edge.p1, edge.p0));
  const into = leftNormal(u);
  const holes = stations.map((s) => {
    // The two edges mate antiparallel, so a station from A's start is the same
    // distance from B's end.
    const centre = add(
      add(edge.p0, scale(u, length - s)),
      scale(into, slot.insetMm),
    );
    return profile(slotLoop(centre, u, into, slot.widthMm, slot.depthMm));
  });
  return single(booleans().difference([p], holes), p);
}

function slotLoop(
  centre: Vec2,
  along: Vec2,
  into: Vec2,
  widthMm: number,
  depthMm: number,
): Loop {
  const a = scale(along, widthMm / 2);
  const b = scale(into, depthMm / 2);
  return polygon([
    sub(sub(centre, a), b),
    add(sub(centre, b), a),
    add(add(centre, a), b),
    sub(add(centre, b), a),
  ]);
}

/**
 * A corner treatment must leave one piece of metal. More than one means the
 * cut severed the flange, which is a modelling mistake rather than something to
 * paper over, so the original profile is kept and the overlap and island checks
 * downstream report it.
 */
function single(result: readonly Profile[], fallback: Profile): Profile {
  if (result.length === 1) return result[0]!;
  return fallback;
}
