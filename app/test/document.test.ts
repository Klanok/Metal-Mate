/**
 * Document editing rules that are worth pinning down without a browser.
 *
 * The row list is ordinary immutable data, so add/duplicate/remove and the
 * naming rules are all testable here. The one that matters most is that a
 * duplicate is a *different part* — inheriting the original's part number is
 * how two panels end up sharing an identity and one of them never gets cut.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_BENCHTOP, keyOf, benchtopPart } from '@metal-mate/core';
import { initialDocument, makeRow, uniqueName, type PartRow } from '../src/state/useDocument.js';

function rows(...names: string[]): PartRow[] {
  return names.map((name) => makeRow({ ...DEFAULT_BENCHTOP, name }));
}

describe('naming parts in a document', () => {
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

  it('gives every row its own uid, even for identical parameters', () => {
    const [a, b] = rows('Side', 'Side');
    expect(a!.uid).not.toBe(b!.uid);
  });
});

describe('the starting document', () => {
  it('opens with one part, selected', () => {
    const doc = initialDocument();
    expect(doc.rows).toHaveLength(1);
    expect(doc.activeUid).toBe(doc.rows[0]!.uid);
  });
});

describe('part identity across a document', () => {
  it('distinguishes parts by name when they have no part number', () => {
    const keys = ['Floor', 'Left side', 'Right side'].map((name) =>
      keyOf(benchtopPart({ ...DEFAULT_BENCHTOP, name })),
    );
    expect(new Set(keys).size).toBe(3);
  });

  it('collides two parts that share a part number, which the build reports', () => {
    const a = keyOf(benchtopPart({ ...DEFAULT_BENCHTOP, name: 'Floor', partId: 'CAN-1' }));
    const b = keyOf(benchtopPart({ ...DEFAULT_BENCHTOP, name: 'Roof', partId: 'CAN-1' }));
    expect(a).toBe(b);
  });

  it('carries quantity from the wizard through to the part', () => {
    const part = benchtopPart({ ...DEFAULT_BENCHTOP, quantity: 2 });
    expect(part.parameters.quantity).toBe(2);
    expect(benchtopPart(DEFAULT_BENCHTOP).parameters.quantity).toBeUndefined();
  });
});
