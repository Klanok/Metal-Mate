/**
 * Press brake description — "if it can't be bent, it can't be cut".
 *
 * The machine profile is what turns this from a drawing tool into something
 * the fabricator can trust: a part whose bend line is longer than the bed, or
 * whose flange is shorter than the smallest usable die allows, fails
 * validation and cannot be exported.
 *
 * NOTE: `GENERIC_2500_40T` is a placeholder so the pipeline has something to
 * run against. It must be replaced with the real machine's bed length, tonnage
 * chart and die rack before any of this is trusted on the shop floor
 * (Appendix C of the architecture doc).
 */

import { type Material, type MaterialFamily } from '../materials/material.js';

export interface VDie {
  /** V opening in mm. */
  readonly width: number;
  /** Shortest flange this die can form, mm. Defaults to 0.7 * width. */
  readonly minFlange?: number;
  /** Inside radius this die actually produces, mm. Defaults from the profile. */
  readonly producedRadius?: number;
  /** Die's own load limit in tonnes per metre, if the rack is derated. */
  readonly maxTonnesPerMetre?: number;
  readonly label?: string;
}

export interface ThicknessLimit {
  /** Applies to this material family, or to everything when omitted. */
  readonly family?: MaterialFamily;
  readonly min: number;
  readonly max: number;
}

export interface MachineProfile {
  readonly id: string;
  readonly name: string;
  /**
   * True while these numbers are guesses rather than a real machine's.
   *
   * Every tonnage and minimum-flange result in the validation report is only
   * as good as this record, so the report says so out loud whenever the flag is
   * set. Clearing it is a deliberate act: somebody has to have checked the bed,
   * the tonnage chart and the die rack against the machine on the floor.
   */
  readonly placeholder?: boolean;
  /** Longest bend line the machine can form, mm. */
  readonly bedLengthMm: number;
  /** Maximum total force, tonnes. */
  readonly maxTonnes: number;
  /** Maximum force per metre of bend, tonnes/m. */
  readonly maxTonnesPerMetre: number;
  readonly dies: readonly VDie[];
  /** Punch nose radii available, mm. */
  readonly punchRadii: readonly number[];
  /** Throat / gap depth, mm. Limits how deep a return bend can reach. */
  readonly throatDepthMm: number;
  /** Open height between bed and ram at top of stroke, mm. */
  readonly openHeightMm: number;
  /** Furthest the backgauge can reach behind the die centreline, mm. */
  readonly backgaugeMaxMm: number;
  readonly thicknessLimits: readonly ThicknessLimit[];
  /** Inside radius a die produces, as a fraction of the V opening. */
  readonly dieRadiusFactor: number;
}

export const GENERIC_2500_40T: MachineProfile = {
  id: 'generic-2500-40t',
  name: 'Generic 2500 mm / 40 t press brake',
  placeholder: true,
  bedLengthMm: 2500,
  maxTonnes: 40,
  maxTonnesPerMetre: 30,
  dies: [
    { width: 6 },
    { width: 8 },
    { width: 10 },
    { width: 12 },
    { width: 16 },
    { width: 20 },
    { width: 25 },
    { width: 35 },
  ],
  punchRadii: [0.6, 1.0, 1.5, 2.0, 3.0],
  throatDepthMm: 300,
  openHeightMm: 380,
  backgaugeMaxMm: 500,
  thicknessLimits: [{ min: 0.5, max: 6 }],
  dieRadiusFactor: 0.16,
};

export interface MachineProblem {
  /** Which field is wrong, as the editor names it. */
  readonly field: string;
  readonly message: string;
}

/**
 * Structural check on a machine record.
 *
 * This is not "is this the right machine" — nothing here can know that. It is
 * "could any machine be like this", so a half-typed profile fails loudly at the
 * point of editing instead of quietly producing a tonnage of Infinity three
 * layers down.
 */
export function checkMachineProfile(m: MachineProfile): MachineProblem[] {
  const problems: MachineProblem[] = [];
  const positive = (field: string, value: number, what: string): void => {
    if (!Number.isFinite(value) || value <= 0) {
      problems.push({ field, message: `${what} must be a positive number of mm` });
    }
  };

  if (m.name.trim() === '') problems.push({ field: 'name', message: 'give the machine a name' });
  positive('bedLengthMm', m.bedLengthMm, 'bed length');
  positive('throatDepthMm', m.throatDepthMm, 'throat depth');
  positive('openHeightMm', m.openHeightMm, 'open height');
  if (!Number.isFinite(m.backgaugeMaxMm) || m.backgaugeMaxMm < 0) {
    problems.push({ field: 'backgaugeMaxMm', message: 'backgauge reach cannot be negative' });
  }
  if (!Number.isFinite(m.maxTonnes) || m.maxTonnes <= 0) {
    problems.push({ field: 'maxTonnes', message: 'total tonnage must be a positive number' });
  }
  if (!Number.isFinite(m.maxTonnesPerMetre) || m.maxTonnesPerMetre <= 0) {
    problems.push({
      field: 'maxTonnesPerMetre',
      message: 'tonnage per metre must be a positive number',
    });
  }

  if (m.dies.length === 0) {
    problems.push({ field: 'dies', message: 'the rack needs at least one V die' });
  }
  if (m.dies.some((d) => !Number.isFinite(d.width) || d.width <= 0)) {
    problems.push({ field: 'dies', message: 'every V opening must be a positive number of mm' });
  }
  const widths = m.dies.map((d) => d.width);
  if (new Set(widths).size !== widths.length) {
    problems.push({ field: 'dies', message: 'the rack lists the same V opening twice' });
  }

  if (m.punchRadii.length === 0) {
    problems.push({ field: 'punchRadii', message: 'list at least one punch nose radius' });
  }
  if (m.punchRadii.some((r) => !Number.isFinite(r) || r <= 0)) {
    problems.push({ field: 'punchRadii', message: 'every punch radius must be positive' });
  }

  if (m.thicknessLimits.length === 0) {
    problems.push({ field: 'thicknessLimits', message: 'set a thickness range the machine takes' });
  }
  for (const limit of m.thicknessLimits) {
    if (!Number.isFinite(limit.min) || limit.min <= 0 || limit.max <= limit.min) {
      problems.push({
        field: 'thicknessLimits',
        message: `thickness range ${limit.min}–${limit.max} mm is not a range`,
      });
    }
  }

  if (!Number.isFinite(m.dieRadiusFactor) || m.dieRadiusFactor <= 0 || m.dieRadiusFactor >= 1) {
    problems.push({
      field: 'dieRadiusFactor',
      message: 'die radius factor is a fraction of the V opening, so it sits between 0 and 1 (0.16 is typical)',
    });
  }

  return problems;
}

export function minFlangeFor(die: VDie): number {
  return die.minFlange ?? 0.7 * die.width;
}

export function producedRadiusFor(machine: MachineProfile, die: VDie): number {
  return die.producedRadius ?? machine.dieRadiusFactor * die.width;
}

export function thicknessLimitFor(
  machine: MachineProfile,
  family: MaterialFamily,
): ThicknessLimit | undefined {
  return (
    machine.thicknessLimits.find((l) => l.family === family) ??
    machine.thicknessLimits.find((l) => l.family === undefined)
  );
}

/**
 * Dies that can sensibly air-bend this thickness, best first.
 *
 * The usual shop rule is V about 8x thickness, with anything from roughly 4x
 * to 16x workable. Ordering is by distance from the 8x ideal so that "the
 * first candidate" is also "what the operator would reach for".
 */
export function dieCandidates(machine: MachineProfile, thickness: number): VDie[] {
  const ideal = 8 * thickness;
  return machine.dies
    .filter((d) => d.width >= 4 * thickness && d.width <= 16 * thickness)
    .sort((a, b) => Math.abs(a.width - ideal) - Math.abs(b.width - ideal));
}

export interface DieChoice {
  readonly die: VDie;
  readonly producedRadius: number;
  /** How far the produced radius is from what the bend asks for, mm. */
  readonly radiusError: number;
}

/**
 * Best die for a bend: among the dies that suit the thickness, the one whose
 * produced inside radius is closest to the requested radius. Returns undefined
 * when the rack has nothing suitable for this thickness at all.
 */
export function selectDie(
  machine: MachineProfile,
  thickness: number,
  requestedRadius: number,
): DieChoice | undefined {
  const candidates = dieCandidates(machine, thickness);
  let best: DieChoice | undefined;
  for (const die of candidates) {
    const producedRadius = producedRadiusFor(machine, die);
    const radiusError = Math.abs(producedRadius - requestedRadius);
    if (best === undefined || radiusError < best.radiusError) {
      best = { die, producedRadius, radiusError };
    }
  }
  return best;
}

/**
 * Air-bending force estimate, tonnes per metre of bend:
 *
 *   P[kN/m] = 1.42 * UTS[MPa] * T[mm]^2 / V[mm]
 *
 * This is the standard chart approximation. It is an estimate and is labelled
 * as one in the validation report; the machine's own chart wins when the shop
 * supplies it.
 */
export function tonnesPerMetre(material: Material, thickness: number, dieWidth: number): number {
  if (dieWidth <= 0) throw new Error('die width must be positive');
  const kNPerMetre = (1.42 * material.utsMPa * thickness * thickness) / dieWidth;
  return kNPerMetre / 9.80665;
}

export function requiredTonnes(
  material: Material,
  thickness: number,
  dieWidth: number,
  bendLengthMm: number,
): number {
  return tonnesPerMetre(material, thickness, dieWidth) * (bendLengthMm / 1000);
}
