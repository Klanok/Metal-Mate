/**
 * Shop settings: the press brake, and any bend tables calibrated against it.
 *
 * These belong to the shop rather than to a part, so they live in local
 * storage and outlast any one project. They are *also* embedded in every
 * project file, so a part opened on the other person's computer is checked
 * against the machine it was designed for rather than silently re-checked
 * against a different one.
 *
 * Everything here is a pure function over plain data so it can be tested in
 * Node. Nothing in this file touches React.
 */

import type { MachineProfile, Material, ProjectDocument } from '@metal-mate/core';
import { BUILT_IN_MATERIALS, GENERIC_2500_40T, checkMachineProfile } from '@metal-mate/core';

export const SETTINGS_KEY = 'metal-mate.settings.v1';

export interface Settings {
  readonly machine: MachineProfile;
  /** Materials as edited here, including any calibrated bend tables. */
  readonly materials: readonly Material[];
}

export const DEFAULT_SETTINGS: Settings = {
  machine: GENERIC_2500_40T,
  materials: BUILT_IN_MATERIALS,
};

/** Minimal storage surface, so tests can pass a plain object. */
export interface SettingsStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function serializeSettings(settings: Settings): string {
  return JSON.stringify({ version: 1, ...settings });
}

/**
 * Read settings back, falling back to the defaults for anything missing or
 * unusable.
 *
 * Settings are the one thing that survives a version change without a
 * migration path, so a corrupt or half-written record must never stop the app
 * starting — the worst case is that somebody re-enters the machine.
 */
export function deserializeSettings(text: string | null): Settings {
  if (text === null || text === '') return DEFAULT_SETTINGS;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return DEFAULT_SETTINGS;
  }
  if (typeof raw !== 'object' || raw === null) return DEFAULT_SETTINGS;
  const doc = raw as Partial<Settings>;

  const machine =
    isMachineLike(doc.machine) && checkMachineProfile(doc.machine).length === 0
      ? doc.machine
      : DEFAULT_SETTINGS.machine;
  const materials =
    Array.isArray(doc.materials) && doc.materials.length > 0 && doc.materials.every(isMaterialLike)
      ? doc.materials
      : DEFAULT_SETTINGS.materials;

  return { machine, materials };
}

export function loadSettings(store: SettingsStore | undefined): Settings {
  if (store === undefined) return DEFAULT_SETTINGS;
  try {
    return deserializeSettings(store.getItem(SETTINGS_KEY));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(store: SettingsStore | undefined, settings: Settings): void {
  if (store === undefined) return;
  try {
    store.setItem(SETTINGS_KEY, serializeSettings(settings));
  } catch {
    // A full or blocked storage is not worth interrupting the work for.
  }
}

/** Replace one material by id, keeping the list order stable. */
export function withMaterial(settings: Settings, next: Material): Settings {
  const materials = settings.materials.some((m) => m.id === next.id)
    ? settings.materials.map((m) => (m.id === next.id ? next : m))
    : [...settings.materials, next];
  return { ...settings, materials };
}

/**
 * What a project carries with it, so it opens the same way on both computers.
 */
export function embedSettings(settings: Settings): Pick<
  ProjectDocument,
  'embeddedMachines' | 'embeddedMaterials'
> {
  return { embeddedMachines: [settings.machine], embeddedMaterials: [...settings.materials] };
}

export interface AdoptedSettings {
  readonly settings: Settings;
  /** What changed, for the status bar. Empty when the project matched. */
  readonly notes: readonly string[];
}

/**
 * Take on the machine and materials a project was designed against.
 *
 * The project wins, because the part was validated against it — quietly
 * re-checking someone else's part against your own machine is how a part gets
 * cut that will not fold. A machine that fails its structural check is
 * refused rather than adopted, and that is said out loud.
 */
export function adoptProjectSettings(current: Settings, doc: ProjectDocument): AdoptedSettings {
  const notes: string[] = [];
  let settings = current;

  const machine = doc.embeddedMachines?.[0];
  if (machine !== undefined && isMachineLike(machine)) {
    const problems = checkMachineProfile(machine);
    if (problems.length > 0) {
      notes.push(
        `kept your press brake: the one in the project is not usable (${problems[0]!.message})`,
      );
    } else if (machine.id !== current.machine.id || machine.name !== current.machine.name) {
      settings = { ...settings, machine };
      notes.push(`now checking against "${machine.name}", the brake this part was designed for`);
    } else {
      settings = { ...settings, machine };
    }
  }

  for (const material of doc.embeddedMaterials ?? []) {
    if (!isMaterialLike(material)) continue;
    const mine = settings.materials.find((m) => m.id === material.id);
    settings = withMaterial(settings, material);
    if (mine !== undefined && mine.bendTable.length !== material.bendTable.length) {
      notes.push(`took the bend table for ${material.name} from the project`);
    }
  }

  return { settings, notes };
}

function isMachineLike(value: unknown): value is MachineProfile {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Partial<MachineProfile>;
  return (
    typeof m.id === 'string' &&
    typeof m.name === 'string' &&
    typeof m.bedLengthMm === 'number' &&
    Array.isArray(m.dies) &&
    Array.isArray(m.punchRadii) &&
    Array.isArray(m.thicknessLimits)
  );
}

function isMaterialLike(value: unknown): value is Material {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Partial<Material>;
  return (
    typeof m.id === 'string' &&
    typeof m.name === 'string' &&
    typeof m.utsMPa === 'number' &&
    typeof m.densityKgM3 === 'number' &&
    Array.isArray(m.thicknesses) &&
    Array.isArray(m.bendTable)
  );
}
