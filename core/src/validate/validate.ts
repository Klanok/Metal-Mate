/**
 * Validation: "if it can't be bent, it can't be cut".
 *
 * Runs on every regeneration and gates export. Every rule here is testable in
 * isolation and every rule has a fixture part that passes it and one that
 * fails it (see test/validate.test.ts).
 *
 * The fold-collision rule is deliberately a conservative heuristic, not a
 * simulation: it compares flange depths against the brake's throat and open
 * height and says so in the message. Full fold-sequence simulation is out of
 * scope for v1 and the report never pretends otherwise.
 */

import { booleans } from '../geometry/boolean.js';
import { linearise } from '../geometry/loop.js';
import { profile, profileBounds } from '../geometry/profile.js';
import { type Vec2, cross, distance, normalize, sub } from '../geometry/vec2.js';
import { type BendId, type FaceId } from '../ids.js';
import {
  type DieChoice,
  type MachineProfile,
  minFlangeFor,
  requiredTonnes,
  selectDie,
  thicknessLimitFor,
  tonnesPerMetre,
} from '../machine/machineProfile.js';
import { type Material } from '../materials/material.js';
import { type FaceBendGraph, getBend, incidentBends } from '../model/graph.js';
import { type FlatBendLine, type FlatPattern } from '../unfold/unfold.js';
import { type Finding, type ValidationReport, buildReport } from './report.js';

export interface StockSheet {
  readonly widthMm: number;
  readonly lengthMm: number;
}

export interface ValidationOptions {
  /**
   * Minimum clear distance from a cutout to a bend zone before the metal
   * distorts around the hole, in multiples of thickness.
   */
  readonly cutoutClearanceFactor?: number;
  /** Sheet the blank must fit inside, if the shop works to fixed stock. */
  readonly stockSheet?: StockSheet;
  /**
   * Warn when a bend's allowance came from a default rather than a calibrated
   * table row. Off by default; useful before a first production run.
   */
  readonly requireCalibratedAllowance?: boolean;
}

export interface ValidationInput {
  readonly graph: FaceBendGraph;
  readonly flat: FlatPattern;
  readonly material: Material;
  readonly machine: MachineProfile;
  readonly options?: ValidationOptions;
}

export function validate(input: ValidationInput): ValidationReport {
  const findings: Finding[] = [];
  const { graph, flat, material, machine } = input;
  const options = input.options ?? {};
  const thickness = graph.thickness;

  checkThickness(findings, machine, material, thickness);
  checkFlatIntegrity(findings, flat);
  checkStock(findings, flat, options);

  for (const line of flat.bendLines) {
    const die = checkBend(findings, input, line, thickness);
    checkFlange(findings, input, line, die);
    checkRelief(findings, input, line);
    if (options.requireCalibratedAllowance === true && !isCalibrated(line)) {
      findings.push({
        code: 'uncalibrated-allowance',
        severity: 'warning',
        bendId: line.bendId,
        message: `bend allowance came from ${line.allowance.source}, not from a measured bend table row`,
        suggestion: 'fold a test strip on the brake and record the measured deduction against this material, thickness and die',
      });
    }
  }

  checkFoldCollision(findings, input);
  checkCutoutClearance(findings, input);

  return buildReport(findings);
}

function isCalibrated(line: FlatBendLine): boolean {
  return (
    line.allowance.source === 'bend-table-deduction' ||
    line.allowance.source === 'bend-table-k' ||
    line.allowance.source === 'bend-override'
  );
}

function checkThickness(
  findings: Finding[],
  machine: MachineProfile,
  material: Material,
  thickness: number,
): void {
  const limit = thicknessLimitFor(machine, material.family);
  if (limit === undefined) return;
  if (thickness < limit.min || thickness > limit.max) {
    findings.push({
      code: 'thickness-out-of-range',
      severity: 'error',
      message: `${thickness} mm ${material.name} is outside ${machine.name}'s range of ${limit.min}–${limit.max} mm`,
    });
  }
}

function checkFlatIntegrity(findings: Finding[], flat: FlatPattern): void {
  if (flat.overlapAreaMm2 > 0) {
    findings.push({
      code: 'unfold-overlap',
      severity: 'error',
      message: `flat pattern self-overlaps by ${flat.overlapAreaMm2.toFixed(2)} mm²; the part cannot be made from one blank`,
      suggestion: 'shorten the interfering flanges, or add a corner relief / corner joint where they meet',
    });
  }
  if (flat.islandCount > 1) {
    findings.push({
      code: 'flat-disconnected',
      severity: 'error',
      message: `flat pattern came out in ${flat.islandCount} disconnected pieces`,
      suggestion: 'a cutout has separated the blank; check cutout sizes and positions',
    });
  }
}

function checkStock(findings: Finding[], flat: FlatPattern, options: ValidationOptions): void {
  const stock = options.stockSheet;
  if (stock === undefined) return;
  const w = flat.bounds.max.x - flat.bounds.min.x;
  const h = flat.bounds.max.y - flat.bounds.min.y;
  const fits =
    (w <= stock.lengthMm && h <= stock.widthMm) || (w <= stock.widthMm && h <= stock.lengthMm);
  if (!fits) {
    findings.push({
      code: 'blank-exceeds-stock',
      severity: 'error',
      message: `blank is ${w.toFixed(1)} × ${h.toFixed(1)} mm, which does not fit ${stock.lengthMm} × ${stock.widthMm} mm stock`,
    });
  }
}

/** Bed length, die availability, radius and tonnage for one bend. */
function checkBend(
  findings: Finding[],
  input: ValidationInput,
  line: FlatBendLine,
  thickness: number,
): DieChoice | undefined {
  const { machine, material } = input;

  if (line.lengthMm > machine.bedLengthMm) {
    findings.push({
      code: 'bend-longer-than-bed',
      severity: 'error',
      bendId: line.bendId,
      message: `bend line is ${line.lengthMm.toFixed(1)} mm but ${machine.name} has a ${machine.bedLengthMm} mm bed`,
      suggestion: 'split the part, or make this edge a separate welded piece',
    });
  }

  const die = selectDie(machine, thickness, line.insideRadius);
  if (die === undefined) {
    findings.push({
      code: 'no-suitable-die',
      severity: 'error',
      bendId: line.bendId,
      message: `no V-die in the rack suits ${thickness} mm material (want roughly ${(8 * thickness).toFixed(0)} mm V)`,
      suggestion: 'add the die to the machine profile, or change thickness',
    });
    return undefined;
  }

  // A quarter of the thickness is about the point where the difference starts
  // to show in the finished flange height.
  if (die.radiusError > thickness / 4) {
    findings.push({
      code: 'radius-not-achievable',
      severity: 'warning',
      bendId: line.bendId,
      message: `bend asks for a ${line.insideRadius.toFixed(2)} mm inside radius; the closest die (${die.die.width} mm V) produces about ${die.producedRadius.toFixed(2)} mm`,
      suggestion: `set the bend radius to ${die.producedRadius.toFixed(2)} mm, or add a suitable die to the machine profile`,
    });
  }

  const perMetre = tonnesPerMetre(material, thickness, die.die.width);
  const total = requiredTonnes(material, thickness, die.die.width, line.lengthMm);
  const dieLimit = die.die.maxTonnesPerMetre ?? machine.maxTonnesPerMetre;
  if (perMetre > dieLimit) {
    findings.push({
      code: 'tonnage-per-metre-exceeded',
      severity: 'error',
      bendId: line.bendId,
      message: `estimated ${perMetre.toFixed(1)} t/m exceeds the ${dieLimit} t/m limit for the ${die.die.width} mm V (estimate, not the machine's own chart)`,
      suggestion: 'use a wider V-die, or thinner material',
    });
  }
  if (total > machine.maxTonnes) {
    findings.push({
      code: 'tonnage-exceeded',
      severity: 'error',
      bendId: line.bendId,
      message: `estimated ${total.toFixed(1)} t to form this bend, above the machine's ${machine.maxTonnes} t (estimate, not the machine's own chart)`,
      suggestion: 'use a wider V-die, shorten the bend, or step the bend in stages',
    });
  }
  return die;
}

function checkFlange(
  findings: Finding[],
  input: ValidationInput,
  line: FlatBendLine,
  die: DieChoice | undefined,
): void {
  if (die === undefined) return;
  const minFlange = minFlangeFor(die.die);
  const extents = flangeExtents(input, line.bendId);
  const shortest = Math.min(extents.aSide, extents.bSide);
  if (shortest + 1e-9 < minFlange) {
    findings.push({
      code: 'flange-below-minimum',
      severity: 'error',
      bendId: line.bendId,
      message: `shortest leg at this bend is ${shortest.toFixed(1)} mm; the ${die.die.width} mm V-die needs at least ${minFlange.toFixed(1)} mm to hold the material`,
      suggestion: `lengthen the flange to ${minFlange.toFixed(1)} mm, or fit a narrower die`,
    });
  }
}

/**
 * Perpendicular reach of the material on each side of a bend, measured in the
 * flat. Everything beyond the bend counts, so a leg that carries further bends
 * is measured over its whole developed length rather than just its own face.
 */
export function flangeExtents(
  input: ValidationInput,
  bendId: BendId,
): { aSide: number; bSide: number } {
  const { graph, flat } = input;
  const bend = getBend(graph, bendId);
  const line = flat.bendLines.find((l) => l.bendId === bendId);
  if (line === undefined) throw new Error(`bend ${bendId} is not in the flat pattern`);
  const sides = splitAtBend(graph, bendId);
  return {
    aSide: reachFrom(flat, sides.aSide, line.tangentA),
    bSide: reachFrom(flat, sides.bSide, line.tangentB),
  };
}

function reachFrom(
  flat: FlatPattern,
  faces: ReadonlySet<FaceId>,
  tangent: readonly [Vec2, Vec2],
): number {
  const dir = normalize(sub(tangent[1], tangent[0]));
  let maxDistance = 0;
  for (const placed of flat.faces) {
    if (!faces.has(placed.faceId)) continue;
    for (const p of linearise(placed.profile.outer)) {
      const d = Math.abs(cross(dir, sub(p, tangent[0])));
      if (d > maxDistance) maxDistance = d;
    }
  }
  return maxDistance;
}

/** The two connected components the tree falls into when one bend is removed. */
export function splitAtBend(
  graph: FaceBendGraph,
  bendId: BendId,
): { aSide: Set<FaceId>; bSide: Set<FaceId> } {
  const bend = getBend(graph, bendId);
  const walk = (start: FaceId): Set<FaceId> => {
    const seen = new Set<FaceId>([start]);
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.pop()!;
      for (const { bend: b, other } of incidentBends(graph, current)) {
        if (b.id === bendId || seen.has(other)) continue;
        seen.add(other);
        queue.push(other);
      }
    }
    return seen;
  };
  return { aSide: walk(bend.faceA), bSide: walk(bend.faceB) };
}

/**
 * A bend that stops inside material needs a relief notch at that end, or the
 * metal tears. Detected by probing just past each end of the bend line, along
 * the line: if there is still material there, the bend runs into it.
 */
function checkRelief(findings: Finding[], input: ValidationInput, line: FlatBendLine): void {
  const thickness = input.graph.thickness;
  const along = 1.5 * thickness;
  // Step a little way into the face as well as past the end of the bend line:
  // the point directly off the end sits in the bend zone, where there is no
  // material either way.
  const inward = 0.25 * thickness;

  const probesFor = (tangent: readonly [Vec2, Vec2], toward: Vec2): Vec2[] => {
    const dir = normalize(sub(tangent[1], tangent[0]));
    return [
      {
        x: tangent[0].x - dir.x * along + toward.x * inward,
        y: tangent[0].y - dir.y * along + toward.y * inward,
      },
      {
        x: tangent[1].x + dir.x * along + toward.x * inward,
        y: tangent[1].y + dir.y * along + toward.y * inward,
      },
    ];
  };

  // The two tangent lines bound the bend zone, so each one's "into my own
  // material" direction is simply away from the other.
  const towardA = normalize(sub(line.tangentA[0], line.tangentB[1]));
  const towardB = normalize(sub(line.tangentB[0], line.tangentA[1]));
  const probes = [...probesFor(line.tangentA, towardA), ...probesFor(line.tangentB, towardB)];

  const ends = [
    probes[0] !== undefined && containsInFlat(input.flat, probes[0]),
    probes[1] !== undefined && containsInFlat(input.flat, probes[1]),
    probes[2] !== undefined && containsInFlat(input.flat, probes[2]),
    probes[3] !== undefined && containsInFlat(input.flat, probes[3]),
  ];
  // Probes 0/3 sit at one end of the bend, 1/2 at the other.
  const hits = Number(ends[0] === true || ends[3] === true) + Number(ends[1] === true || ends[2] === true);
  if (hits > 0) {
    findings.push({
      code: 'missing-bend-relief',
      severity: 'warning',
      bendId: line.bendId,
      message: `bend stops inside material at ${hits === 2 ? 'both ends' : 'one end'}; without a relief notch the metal will tear or pucker there`,
      suggestion: `add a bend relief at least ${(thickness * 1.5).toFixed(1)} mm wide and ${(thickness + line.insideRadius).toFixed(1)} mm deep at each affected end`,
    });
  }
}

function containsInFlat(flat: FlatPattern, p: Vec2): boolean {
  const ops = booleans();
  // Point containment via a tiny probe square keeps this on the same code path
  // (and the same tolerances) as everything else that asks "is there metal here".
  const eps = 0.01;
  const probe = profile({
    verts: [
      { x: p.x - eps, y: p.y - eps, bulge: 0 },
      { x: p.x + eps, y: p.y - eps, bulge: 0 },
      { x: p.x + eps, y: p.y + eps, bulge: 0 },
      { x: p.x - eps, y: p.y + eps, bulge: 0 },
    ],
  });
  return ops.intersectionArea([flat.profile], [probe]) > (eps * eps * 4) / 2;
}

/**
 * Conservative fold-collision heuristic.
 *
 * The quantity that matters is the depth of the *flange being formed* — the
 * shorter of the two legs, which is the material that swings up past the ram
 * and into the machine frame. The long side lies flat on the bed and is
 * limited by the shop floor, not by the brake, so measuring it would flag
 * every ordinary benchtop and teach the user to ignore the report.
 *
 * This is a rule of thumb, not a fold-sequence simulation, and the message
 * says so. Full simulation is explicitly out of scope for v1.
 */
function checkFoldCollision(findings: Finding[], input: ValidationInput): void {
  const { flat, machine } = input;
  const caveat =
    'check the fold order with the operator — v1 uses a conservative rule of thumb and does not simulate the fold sequence';
  for (const line of flat.bendLines) {
    const extents = flangeExtents(input, line.bendId);
    const flangeDepth = Math.min(extents.aSide, extents.bSide);
    if (flangeDepth > machine.throatDepthMm) {
      findings.push({
        code: 'fold-collision-risk',
        severity: 'warning',
        bendId: line.bendId,
        message: `the flange formed at this bend is ${flangeDepth.toFixed(0)} mm deep, past the ${machine.throatDepthMm} mm throat; it may foul the machine frame`,
        suggestion: caveat,
      });
    } else if (flangeDepth > machine.openHeightMm) {
      findings.push({
        code: 'fold-collision-risk',
        severity: 'warning',
        bendId: line.bendId,
        message: `the flange formed at this bend is ${flangeDepth.toFixed(0)} mm deep, more than the ${machine.openHeightMm} mm open height`,
        suggestion: caveat,
      });
    }
  }
}

/**
 * Cutouts too close to a bend zone distort as the metal is formed. The
 * clearance is measured from the bend zone (not the bend centreline), so it is
 * the real distance from where the material starts to move.
 */
function checkCutoutClearance(findings: Finding[], input: ValidationInput): void {
  const { flat, graph, options } = { ...input, options: input.options ?? {} };
  const factor = options.cutoutClearanceFactor ?? 3;
  const clearance = factor * graph.thickness;
  if (flat.profile.inners.length === 0 || clearance <= 0) return;
  const ops = booleans();
  const grown = ops.offset(flat.bendZones, clearance);
  for (const inner of flat.profile.inners) {
    const hole = profile(inner);
    const encroachment = ops.intersectionArea(grown, [hole]);
    if (encroachment > 1e-6) {
      const box = profileBounds(hole);
      const centre = { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2 };
      findings.push({
        code: 'cutout-near-bend',
        severity: 'warning',
        message: `cutout near (${centre.x.toFixed(0)}, ${centre.y.toFixed(0)}) is within ${clearance.toFixed(1)} mm of a bend zone and will distort when formed`,
        suggestion: `move the cutout at least ${clearance.toFixed(1)} mm clear of the bend, or accept the distortion`,
      });
    }
  }
}

/** Straight-line distance between two points; re-exported for rule tests. */
export const pointDistance = distance;
