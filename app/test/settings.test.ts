/**
 * Shop settings and bend calibration.
 *
 * Both modules are deliberately free of React so the rules that matter — a
 * corrupt settings record must never stop the app starting, and a project's
 * own machine wins over yours — can be tested here rather than by clicking.
 */

import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_MATERIALS,
  GENERIC_2500_40T,
  type MachineProfile,
  type ProjectDocument,
  checkMachineProfile,
  findMaterial,
  resolveAllowance,
  withBendRow,
} from '@metal-mate/core';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  type Settings,
  type SettingsStore,
  adoptProjectSettings,
  deserializeSettings,
  embedSettings,
  loadSettings,
  saveSettings,
  serializeSettings,
  withMaterial,
} from '../src/state/settings.js';
import { calibrate, predictedDeduction, toBendRow } from '../src/state/calibration.js';

const REAL_BRAKE: MachineProfile = {
  ...GENERIC_2500_40T,
  id: 'shop-brake',
  name: 'Shop brake',
  placeholder: false,
  bedLengthMm: 3200,
  maxTonnes: 100,
};

function memoryStore(initial?: string): SettingsStore & { value: string | null } {
  return {
    value: initial ?? null,
    getItem() {
      return this.value;
    },
    setItem(_key: string, v: string) {
      this.value = v;
    },
  };
}

describe('machine profile checks', () => {
  it('accepts the built-in placeholder', () => {
    expect(checkMachineProfile(GENERIC_2500_40T)).toEqual([]);
  });

  it('names the field that is wrong', () => {
    const problems = checkMachineProfile({ ...GENERIC_2500_40T, bedLengthMm: 0, dies: [] });
    expect(problems.map((p) => p.field)).toEqual(['bedLengthMm', 'dies']);
  });

  it('rejects a duplicated V opening', () => {
    const problems = checkMachineProfile({
      ...GENERIC_2500_40T,
      dies: [{ width: 10 }, { width: 10 }],
    });
    expect(problems[0]?.message).toMatch(/same V opening twice/);
  });

  it('rejects a die radius factor that is not a fraction', () => {
    expect(checkMachineProfile({ ...GENERIC_2500_40T, dieRadiusFactor: 16 })[0]?.field).toBe(
      'dieRadiusFactor',
    );
    expect(checkMachineProfile({ ...GENERIC_2500_40T, dieRadiusFactor: 0 })).toHaveLength(1);
  });

  it('rejects a thickness range that runs backwards', () => {
    expect(
      checkMachineProfile({ ...GENERIC_2500_40T, thicknessLimits: [{ min: 6, max: 0.5 }] }),
    ).toHaveLength(1);
  });
});

describe('settings storage', () => {
  it('round-trips through storage', () => {
    const store = memoryStore();
    const settings: Settings = { machine: REAL_BRAKE, materials: BUILT_IN_MATERIALS };
    saveSettings(store, settings);
    expect(loadSettings(store)).toEqual(settings);
    expect(JSON.parse(store.value!).version).toBe(1);
  });

  it('falls back to the defaults rather than failing to start', () => {
    // Every one of these has been a real way an app fails to open.
    for (const bad of ['', 'not json', 'null', '[]', '{"machine":{"id":3}}']) {
      expect(deserializeSettings(bad)).toEqual(DEFAULT_SETTINGS);
    }
    expect(deserializeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('refuses a stored machine that could not be a machine', () => {
    const text = serializeSettings({
      machine: { ...REAL_BRAKE, bedLengthMm: -1 },
      materials: BUILT_IN_MATERIALS,
    });
    expect(deserializeSettings(text).machine).toEqual(DEFAULT_SETTINGS.machine);
  });

  it('survives storage that throws', () => {
    const hostile: SettingsStore = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('full');
      },
    };
    expect(loadSettings(hostile)).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(hostile, DEFAULT_SETTINGS)).not.toThrow();
  });

  it('does nothing at all without a store', () => {
    expect(loadSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(undefined, DEFAULT_SETTINGS)).not.toThrow();
    expect(SETTINGS_KEY).toMatch(/^metal-mate\./);
  });
});

describe('settings travelling with a project', () => {
  const mine: Settings = { machine: GENERIC_2500_40T, materials: BUILT_IN_MATERIALS };

  it('embeds the machine and the materials', () => {
    const embedded = embedSettings({ ...mine, machine: REAL_BRAKE });
    expect(embedded.embeddedMachines).toEqual([REAL_BRAKE]);
    expect(embedded.embeddedMaterials).toHaveLength(BUILT_IN_MATERIALS.length);
  });

  it("adopts the project's machine, because the part was validated against it", () => {
    const doc: ProjectDocument = { schemaVersion: 1, parts: [], embeddedMachines: [REAL_BRAKE] };
    const { settings, notes } = adoptProjectSettings(mine, doc);
    expect(settings.machine).toEqual(REAL_BRAKE);
    expect(notes.join()).toMatch(/Shop brake/);
  });

  it('keeps yours, and says so, when the project machine is unusable', () => {
    const doc: ProjectDocument = {
      schemaVersion: 1,
      parts: [],
      embeddedMachines: [{ ...REAL_BRAKE, dies: [] }],
    };
    const { settings, notes } = adoptProjectSettings(mine, doc);
    expect(settings.machine).toEqual(GENERIC_2500_40T);
    expect(notes.join()).toMatch(/kept your press brake/);
  });

  it('takes a calibrated bend table across', () => {
    const calibrated = withBendRow(findMaterial('ss304')!, { thickness: 1.2, kFactor: 0.38 });
    const doc: ProjectDocument = {
      schemaVersion: 1,
      parts: [],
      embeddedMaterials: [calibrated],
    };
    const { settings, notes } = adoptProjectSettings(mine, doc);
    expect(settings.materials.find((m) => m.id === 'ss304')!.bendTable).toHaveLength(1);
    expect(notes.join()).toMatch(/bend table/);
  });

  it('says nothing when the project matches what you already have', () => {
    const doc: ProjectDocument = { schemaVersion: 1, parts: [], ...embedSettings(mine) };
    expect(adoptProjectSettings(mine, doc).notes).toEqual([]);
  });

  it('replaces a material in place rather than appending a duplicate', () => {
    const edited = { ...findMaterial('ss304')!, defaultK: 0.39 };
    const next = withMaterial(mine, edited);
    expect(next.materials).toHaveLength(BUILT_IN_MATERIALS.length);
    expect(next.materials.find((m) => m.id === 'ss304')!.defaultK).toBe(0.39);
  });
});

describe('calibrating from a test strip', () => {
  const strip = {
    angleDeg: 90,
    insideRadiusMm: 1.2,
    thicknessMm: 1.2,
    legAMm: 100,
    legBMm: 100,
    measuredFlatMm: 197.8,
  };

  it('recovers the K that produced a measurement', () => {
    // Fold a strip whose flat length was computed from a known K, and the
    // calibration has to give that K back.
    const knownK = 0.41;
    const flat = 200 - predictedDeduction(strip, knownK);
    const result = calibrate({ ...strip, measuredFlatMm: flat });
    expect(result.error).toBeUndefined();
    expect(result.kFactor).toBeCloseTo(knownK, 9);
  });

  it('reports the deduction the shop actually measured', () => {
    expect(calibrate(strip).bendDeductionMm).toBeCloseTo(2.2, 9);
  });

  it('explains the apex-measuring mistake rather than returning a number', () => {
    // Legs measured to the outside of the radius come out short, so the two
    // legs no longer exceed the blank and there is no deduction to solve.
    const result = calibrate({ ...strip, measuredFlatMm: 200 });
    expect(result.error).toMatch(/apex/);
    expect(result.kFactor).toBe(0);
  });

  it('rejects incomplete or impossible input', () => {
    expect(calibrate({ ...strip, thicknessMm: 0 }).error).toMatch(/positive/);
    expect(calibrate({ ...strip, angleDeg: 200 }).error).toMatch(/under 180/);
  });

  it('warns rather than blocks when K lands outside the usual range', () => {
    // 2.73 mm of deduction on this strip solves to K ~= 0.10: possible
    // arithmetic, but not a fold anyone gets, so it is worth a second look
    // rather than a refusal.
    const result = calibrate({ ...strip, measuredFlatMm: 197.27 });
    expect(result.error).toBeUndefined();
    expect(result.kFactor).toBeLessThan(0.15);
    expect(result.warning).toMatch(/outside/);
  });

  it('refuses a deduction so large the bend zone would have negative length', () => {
    const result = calibrate({ ...strip, measuredFlatMm: 195 });
    expect(result.error).toMatch(/cannot happen|do not describe/);
  });

  it('records provenance on the row it produces', () => {
    const withDie = { ...strip, dieWidthMm: 10, note: 'folded 2026-08-10, strip 3' };
    const row = toBendRow(withDie, calibrate(withDie));
    expect(row).toMatchObject({
      thickness: 1.2,
      angleDeg: 90,
      insideRadius: 1.2,
      dieWidth: 10,
      note: 'folded 2026-08-10, strip 3',
    });
    expect(row.kFactor).toBeCloseTo(calibrate(withDie).kFactor, 12);
  });

  it('changes what the unfold engine uses, which is the whole point', () => {
    const material = findMaterial('ss304')!;
    const bend = {
      id: 'b' as never,
      faceA: 'a' as never,
      faceB: 'b' as never,
      lineA: { p0: { x: 0, y: 0 }, p1: { x: 1, y: 0 } },
      lineB: { p0: { x: 0, y: 0 }, p1: { x: 1, y: 0 } },
      angleDeg: 90,
      direction: 'down' as const,
      insideRadius: 1.2,
    };
    const before = resolveAllowance(bend, material, 1.2);
    expect(before.source).toBe('material-default');

    const calibrated = withBendRow(material, toBendRow(strip, calibrate(strip)));
    const after = resolveAllowance(bend, calibrated, 1.2);
    expect(after.source).toBe('bend-table-deduction');
    expect(after.bendAllowance).not.toBeCloseTo(before.bendAllowance, 6);
  });
});
