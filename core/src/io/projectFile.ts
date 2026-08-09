/**
 * Project document serialisation.
 *
 * The parametric history is the source of truth: a project stores features and
 * template parameters, never derived geometry. Opening a file regenerates
 * everything, so a fixed bug in the unfold engine improves every existing
 * project rather than leaving stale geometry behind.
 *
 * The application layer wraps this in a single-file SQLite container (`.smp`)
 * with the settings, embedded material and machine records, and a thumbnail;
 * this module owns the part payload and its migrations.
 */

import { type Part } from '../features/types.js';
import { type Material } from '../materials/material.js';
import { type MachineProfile } from '../machine/machineProfile.js';
import { type ExportProfile } from './exportProfile.js';

export const SCHEMA_VERSION = 1;

export interface ProjectDocument {
  readonly schemaVersion: number;
  readonly parts: readonly Part[];
  /**
   * Copies of any custom material and machine records the parts depend on, so
   * a project opens correctly on the other person's machine.
   */
  readonly embeddedMaterials?: readonly Material[];
  readonly embeddedMachines?: readonly MachineProfile[];
  readonly embeddedExportProfiles?: readonly ExportProfile[];
  readonly notes?: string;
}

export class ProjectFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectFormatError';
  }
}

export function serializeProject(doc: Omit<ProjectDocument, 'schemaVersion'>): string {
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...doc }, null, 2);
}

export function deserializeProject(text: string): ProjectDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ProjectFormatError(`not valid JSON: ${(e as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new ProjectFormatError('project must be a JSON object');
  }
  const doc = raw as Partial<ProjectDocument>;
  const version = doc.schemaVersion;
  if (typeof version !== 'number') {
    throw new ProjectFormatError('project is missing schemaVersion');
  }
  if (version > SCHEMA_VERSION) {
    throw new ProjectFormatError(
      `project was written by a newer version (schema ${version}, this build understands ${SCHEMA_VERSION})`,
    );
  }
  if (!Array.isArray(doc.parts)) {
    throw new ProjectFormatError('project is missing a parts array');
  }
  return migrate(doc as ProjectDocument);
}

/**
 * Bring an older document up to the current schema.
 *
 * Nothing to do yet — version 1 is the first release. The seam exists now so
 * that the first migration is an addition here rather than a redesign.
 */
function migrate(doc: ProjectDocument): ProjectDocument {
  return { ...doc, schemaVersion: SCHEMA_VERSION };
}
