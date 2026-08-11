/**
 * Document editing rules that are worth pinning down without a browser.
 *
 * The document is a list of *designs*, and the thing that makes that necessary
 * is here: a benchtop design expands to one part, a canopy design to six. Get
 * that mapping wrong and the wrong panel goes on screen, or the wrong design
 * gets edited — neither of which the geometry tests would notice.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_BENCHTOP, DEFAULT_CANOPY, initBooleans, keyOf } from '@metal-mate/core';
import {
  type DesignRow,
  benchtopRow,
  canopyRow,
  expandRow,
  initialDocument,
  uniqueName,
} from '../src/state/useDocument.js';

function rows(...names: string[]): DesignRow[] {
  return names.map((name) => benchtopRow({ ...DEFAULT_BENCHTOP, name }));
}

beforeAll(async () => {
  await initBooleans();
});

describe('naming designs in a document', () => {
  it('leaves a free name alone', () => {
    expect(uniqueName(rows('Floor'), 'Roof')).toBe('Roof');
  });

  it('numbers a name that is taken', () => {
    expect(uniqueName(rows('Side'), 'Side')).toBe('Side 2');
    expect(uniqueName(rows('Side', 'Side 2'), 'Side')).toBe('Side 3');
  });

  it('keeps going past a gap rather than reusing a taken name', () => {
    expect(uniqueName(rows('Side', 'Side 3'), 'Side')).toBe('Side 2');
  });

  it('gives every design its own uid, even for identical parameters', () => {
    const [a, b] = rows('Side', 'Side');
    expect(a!.uid).not.toBe(b!.uid);
  });
});

describe('the starting document', () => {
  it('opens with one benchtop, selected', () => {
    const doc = initialDocument();
    expect(doc.rows).toHaveLength(1);
    expect(doc.rows[0]!.kind).toBe('benchtop');
    expect(doc.activeUid).toBe(doc.rows[0]!.uid);
  });
});

describe('expanding a design into parts', () => {
  it('makes one part from a benchtop', () => {
    const expanded = expandRow(benchtopRow());
    expect(expanded.error).toBeNull();
    expect(expanded.parts).toHaveLength(1);
  });

  it('makes six panels from a canopy, all under the one design', () => {
    const row = canopyRow();
    const expanded = expandRow(row);
    expect(expanded.error).toBeNull();
    expect(expanded.parts).toHaveLength(6);
    expect(expanded.parts.every((p) => p.rowUid === row.uid)).toBe(true);
    expect(expanded.parts.map((p) => p.part!.parameters.partId)).toEqual([
      'CAN-FLOOR',
      'CAN-FRONT',
      'CAN-REAR',
      'CAN-LEFT',
      'CAN-RIGHT',
      'CAN-ROOF',
    ]);
  });

  it('drops to five panels when the canopy sits on the tray', () => {
    expect(expandRow(canopyRow({ ...DEFAULT_CANOPY, floor: false })).parts).toHaveLength(5);
  });

  it('gives every part its own uid across the whole document', () => {
    const all = [expandRow(canopyRow()), expandRow(canopyRow()), expandRow(benchtopRow())]
      .flatMap((e) => e.parts)
      .map((p) => p.partUid);
    expect(new Set(all).size).toBe(all.length);
  });

  it('reports a design that cannot build, rather than throwing', () => {
    const expanded = expandRow(canopyRow({ ...DEFAULT_CANOPY, widthMm: 1 }));
    expect(expanded.parts).toEqual([]);
    expect(expanded.error).toMatch(/nothing left/);
  });

  it('keeps every panel of one canopy distinct once keyed for the document', () => {
    // Six panels that shared a key would look like six copies of one part and
    // the document build would refuse the lot.
    const parts = expandRow(canopyRow()).parts.map((p) => keyOf(p.part!));
    expect(new Set(parts).size).toBe(6);
  });
});
