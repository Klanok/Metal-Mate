/**
 * Multi-part documents.
 *
 * A canopy is a set of panels, not one folded part, so the document is the
 * unit that matters: everything builds, everything is named, and the export is
 * all or nothing. The rules that carry risk are the last two — a part that
 * cannot be told apart from another, and half an assembly reaching the laser.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { initBooleans } from '../src/geometry/boolean.js';
import { partId } from '../src/ids.js';
import { GENERIC_2500_40T } from '../src/machine/machineProfile.js';
import {
  DocumentExportBlockedError,
  buildDocument,
  exportDocumentDxf,
  keyOf,
  quantityOf,
} from '../src/pipeline.js';
import {
  NO_EDGE,
  type BenchtopParams,
  DEFAULT_BENCHTOP,
  benchtopPart,
} from '../src/templates/benchtop.js';
import type { Part } from '../src/features/types.js';

const OPTIONS = { machine: GENERIC_2500_40T };

const BASE: BenchtopParams = {
  ...DEFAULT_BENCHTOP,
  lengthMm: 1200,
  depthMm: 600,
  thicknessMm: 1.2,
  bendRadiusMm: 1.2,
  edges: {
    front: { style: 'square-drop', heightMm: 40 },
    back: { style: 'upstand', heightMm: 100 },
    left: NO_EDGE,
    right: NO_EDGE,
  },
  cutouts: [],
};

function bench(name: string, over: Partial<BenchtopParams> = {}): Part {
  return benchtopPart({ ...BASE, name, ...over });
}

/** A part whose two corner mitres cross, so regeneration throws. */
function brokenPart(): Part {
  return benchtopPart({
    ...BASE,
    name: 'Broken panel',
    lengthMm: 700,
    edges: {
      front: { style: 'drop-and-return', heightMm: 40, returnMm: 400 },
      back: { style: 'square-drop', heightMm: 40 },
      left: { style: 'square-drop', heightMm: 40 },
      right: { style: 'square-drop', heightMm: 40 },
    },
  });
}

beforeAll(async () => {
  await initBooleans();
});

describe('part identity', () => {
  it('is derived from what the user typed, not from array position', () => {
    expect(keyOf(bench('Left side panel'))).toBe('left-side-panel');
    expect(keyOf(benchtopPart({ ...BASE, name: 'Anything', partId: 'CAN-014' }))).toBe('can-014');
  });

  it('folds punctuation and spacing into one shape', () => {
    expect(partId('  Roof / front  ')).toBe('roof-front');
    expect(partId('Side (LH)')).toBe('side-lh');
  });

  it('refuses a name with nothing to make an id from', () => {
    expect(() => partId('   ')).toThrow(/give the part a name/);
    expect(() => partId('///')).toThrow(/give the part a name/);
  });

  it('treats a blank part number as not having one', () => {
    // The part number is a text box, so clearing it leaves an empty string.
    // Reading that as the identity would leave the part with no id at all.
    const part = benchtopPart({ ...BASE, name: 'Roof panel', partId: '' });
    expect(keyOf(part)).toBe('roof-panel');
    expect(keyOf(benchtopPart({ ...BASE, name: 'Roof panel', partId: '   ' }))).toBe('roof-panel');
  });

  it('treats a missing quantity as one', () => {
    expect(quantityOf(bench('a'))).toBe(1);
    expect(quantityOf(benchtopPart({ ...BASE, name: 'a' }))).toBe(1);
  });
});

describe('building a document', () => {
  it('builds every part and keys them by name', () => {
    const doc = buildDocument([bench('Floor'), bench('Roof')], OPTIONS);
    expect(doc.parts.map((p) => p.key)).toEqual(['floor', 'roof']);
    expect(doc.parts.every((p) => p.ok)).toBe(true);
    expect(doc.exportAllowed).toBe(true);
    expect(doc.errorCount).toBe(0);
  });

  it('counts quantity into the mass and the cut length', () => {
    const one = buildDocument([bench('Side')], OPTIONS);
    const two = buildDocument(
      [benchtopPart({ ...BASE, name: 'Side' })].map((p) => ({
        ...p,
        parameters: { ...p.parameters, quantity: 2 },
      })),
      OPTIONS,
    );
    expect(two.totalMassKg).toBeCloseTo(one.totalMassKg * 2, 9);
    expect(two.totalCutLengthMm).toBeCloseTo(one.totalCutLengthMm * 2, 6);
  });

  it('does not let one broken part take the others down', () => {
    const doc = buildDocument([bench('Floor'), brokenPart(), bench('Roof')], OPTIONS);
    expect(doc.parts.map((p) => p.ok)).toEqual([true, false, true]);
    const broken = doc.parts.find((p) => !p.ok)!;
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error).toMatch(/mitre/);
    expect(doc.exportAllowed).toBe(false);
    // The two good parts still have their mass counted, so the cut list is
    // useful while the third is being fixed.
    expect(doc.totalMassKg).toBeGreaterThan(0);
  });

  it('reports two parts that cannot be told apart', () => {
    const doc = buildDocument([bench('Side panel'), bench('Side panel')], OPTIONS);
    expect(doc.problems.map((p) => p.message).join()).toMatch(/2 parts are called "side-panel"/);
    expect(doc.exportAllowed).toBe(false);
  });

  it('treats a part number and a name that collide as the same part', () => {
    const doc = buildDocument(
      [bench('CAN-014'), benchtopPart({ ...BASE, name: 'Roof', partId: 'CAN-014' })],
      OPTIONS,
    );
    expect(doc.problems).toHaveLength(1);
  });

  it('reports an empty document rather than quietly succeeding', () => {
    const doc = buildDocument([], OPTIONS);
    expect(doc.exportAllowed).toBe(false);
    expect(doc.problems[0]?.message).toMatch(/no parts/);
  });

  it('rejects a quantity that is not a whole number of parts', () => {
    for (const quantity of [0, -1, 2.5]) {
      const part = bench('Side');
      const doc = buildDocument(
        [{ ...part, parameters: { ...part.parameters, quantity } }],
        OPTIONS,
      );
      expect(doc.problems.map((p) => p.message).join()).toMatch(/whole number/);
      expect(doc.exportAllowed).toBe(false);
    }
  });

  it('rolls a blocked part up into the document verdict', () => {
    // 3000 mm exceeds the 2500 mm bed, so that part cannot be exported.
    const doc = buildDocument([bench('Floor'), bench('Long top', { lengthMm: 3000 })], OPTIONS);
    expect(doc.parts.every((p) => p.ok)).toBe(true);
    expect(doc.errorCount).toBeGreaterThan(0);
    expect(doc.exportAllowed).toBe(false);
  });

  it('skips folding, which only the part on screen needs', () => {
    const doc = buildDocument([bench('Floor')], { ...OPTIONS, foldFraction: 1 });
    const only = doc.parts[0]!;
    expect(only.ok).toBe(true);
    if (only.ok) expect(only.result.folded).toBeUndefined();
  });
});

describe('exporting a document', () => {
  it('writes one file per part, named by the part', () => {
    const doc = buildDocument([bench('Floor'), bench('Roof')], OPTIONS);
    const files = exportDocumentDxf(doc, { dateStamp: '2026-08-10' });
    expect(files.map((f) => f.fileName)).toEqual(['floor.dxf', 'roof.dxf']);
    for (const f of files) expect(f.dxf).toContain('AC1009');
  });

  it('carries the quantity for the cut list without putting it in the DXF', () => {
    const part = bench('Side');
    const doc = buildDocument(
      [{ ...part, parameters: { ...part.parameters, quantity: 2 } }],
      OPTIONS,
    );
    const [file] = exportDocumentDxf(doc);
    expect(file!.quantity).toBe(2);
    expect(file!.dxf).not.toContain('QTY');
  });

  it('is all or nothing: one blocked part stops the whole export', () => {
    const doc = buildDocument([bench('Floor'), bench('Long top', { lengthMm: 3000 })], OPTIONS);
    expect(() => exportDocumentDxf(doc)).toThrow(DocumentExportBlockedError);
    // Half an assembly reaching the laser is the failure this prevents, so the
    // good part must not be written either.
    try {
      exportDocumentDxf(doc);
    } catch (e) {
      expect((e as DocumentExportBlockedError).reasons.join()).toMatch(/long-top/);
    }
  });

  it('refuses when a part failed to build at all', () => {
    const doc = buildDocument([bench('Floor'), brokenPart()], OPTIONS);
    expect(() => exportDocumentDxf(doc)).toThrow(/broken-panel/);
  });

  it('refuses on a document-level problem even when every part is fine', () => {
    const doc = buildDocument([bench('Side'), bench('Side')], OPTIONS);
    expect(doc.parts.every((p) => p.ok && p.result.report.exportAllowed)).toBe(true);
    expect(() => exportDocumentDxf(doc)).toThrow(DocumentExportBlockedError);
  });

  it('can export a subset, and still refuses if the subset is bad', () => {
    const doc = buildDocument([bench('Floor'), bench('Long top', { lengthMm: 3000 })], OPTIONS);
    expect(() => exportDocumentDxf(doc, { only: [partId('long-top')] })).toThrow(
      DocumentExportBlockedError,
    );
    // The document-level verdict is unchanged, but a clean subset goes through.
    const files = exportDocumentDxf(doc, {
      only: [partId('floor')],
      ignoreValidationErrors: true,
    });
    expect(files.map((f) => f.key)).toEqual(['floor']);
  });

  it('says so rather than writing nothing when the selection matches no part', () => {
    const doc = buildDocument([bench('Floor')], OPTIONS);
    expect(() => exportDocumentDxf(doc, { only: [partId('missing')] })).toThrow(/no parts matched/);
  });
});
