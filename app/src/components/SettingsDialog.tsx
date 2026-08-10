/**
 * Shop settings: the press brake, and calibrating the bend allowance.
 *
 * These are the two things standing between "a drawing tool" and "something
 * the fabricator can trust". The panel says so, and it will not let you clear
 * the placeholder flag while the record still fails its structural check.
 *
 * Logic lives in `state/settings.ts` and `state/calibration.ts` so it can be
 * tested in Node; this file is the form around it.
 */

import { useState } from 'react';
import type { MachineProfile, Material, VDie } from '@metal-mate/core';
import { checkMachineProfile, withBendRow } from '@metal-mate/core';
import { NumberField } from './NumberField.js';
import { type Settings, withMaterial } from '../state/settings.js';
import { type TestStrip, calibrate, predictedDeduction, toBendRow } from '../state/calibration.js';

export interface SettingsDialogProps {
  readonly settings: Settings;
  readonly onChange: (next: Settings) => void;
  readonly onClose: () => void;
}

type Tab = 'machine' | 'calibration';

export function SettingsDialog({ settings, onChange, onClose }: SettingsDialogProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('machine');

  return (
    <div className="dialog-backdrop" data-testid="settings-dialog">
      <section className="dialog" role="dialog" aria-label="Shop settings">
        <header className="dialog-head">
          <h2>Shop settings</h2>
          <button type="button" className="link" data-testid="settings-close" onClick={onClose}>
            close
          </button>
        </header>

        <div className="view-tabs">
          <button
            type="button"
            className={tab === 'machine' ? 'active' : ''}
            onClick={() => setTab('machine')}
          >
            Press brake
          </button>
          <button
            type="button"
            className={tab === 'calibration' ? 'active' : ''}
            onClick={() => setTab('calibration')}
          >
            Bend calibration
          </button>
        </div>

        <div className="dialog-body">
          {tab === 'machine' ? (
            <MachineEditor
              machine={settings.machine}
              onChange={(machine) => onChange({ ...settings, machine })}
            />
          ) : (
            <CalibrationEditor settings={settings} onChange={onChange} />
          )}
        </div>
      </section>
    </div>
  );
}

/* ----------------------------------------------------------- press brake -- */

function MachineEditor({
  machine,
  onChange,
}: {
  machine: MachineProfile;
  onChange: (next: MachineProfile) => void;
}): JSX.Element {
  const problems = checkMachineProfile(machine);
  const patch = (next: Partial<MachineProfile>): void => onChange({ ...machine, ...next });
  const limit = machine.thicknessLimits[0] ?? { min: 0.5, max: 6 };

  return (
    <>
      {machine.placeholder === true && (
        <p className="caveat" data-testid="placeholder-warning">
          These are <strong>placeholder</strong> numbers. Every tonnage and minimum-flange result in
          the validation report is an estimate until they are the real machine&apos;s, and the
          report says so on every part.
        </p>
      )}

      <fieldset>
        <legend>Machine</legend>
        <label className="field">
          <span>Name</span>
          <input
            type="text"
            data-testid="machine-name"
            value={machine.name}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </label>
        <NumberField
          label="Bed length"
          value={machine.bedLengthMm}
          step={10}
          onChange={(v) => patch({ bedLengthMm: v })}
        />
        <NumberField
          label="Throat depth"
          value={machine.throatDepthMm}
          step={10}
          onChange={(v) => patch({ throatDepthMm: v })}
        />
        <NumberField
          label="Open height"
          value={machine.openHeightMm}
          step={10}
          onChange={(v) => patch({ openHeightMm: v })}
        />
        <NumberField
          label="Backgauge reach"
          value={machine.backgaugeMaxMm}
          step={10}
          onChange={(v) => patch({ backgaugeMaxMm: v })}
        />
      </fieldset>

      <fieldset>
        <legend>Force</legend>
        <NumberField
          label="Total"
          unit="t"
          value={machine.maxTonnes}
          onChange={(v) => patch({ maxTonnes: v })}
        />
        <NumberField
          label="Per metre"
          unit="t/m"
          value={machine.maxTonnesPerMetre}
          onChange={(v) => patch({ maxTonnesPerMetre: v })}
        />
      </fieldset>

      <fieldset>
        <legend>Die rack</legend>
        <p className="muted">
          V openings in the rack, mm. The inside radius a die produces is taken as a fraction of its
          opening — about 0.16 for air bending in stainless.
        </p>
        <ListField
          testId="die-widths"
          label="V openings"
          values={machine.dies.map((d) => d.width)}
          onChange={(widths) =>
            patch({ dies: widths.map((width): VDie => ({ width })) })
          }
        />
        <ListField
          testId="punch-radii"
          label="Punch radii"
          values={[...machine.punchRadii]}
          onChange={(punchRadii) => patch({ punchRadii })}
        />
        <NumberField
          label="Die radius factor"
          unit="× V"
          value={machine.dieRadiusFactor}
          step={0.01}
          onChange={(v) => patch({ dieRadiusFactor: v })}
        />
      </fieldset>

      <fieldset>
        <legend>Thickness range</legend>
        <NumberField
          label="Thinnest"
          value={limit.min}
          step={0.1}
          onChange={(min) => patch({ thicknessLimits: [{ ...limit, min }] })}
        />
        <NumberField
          label="Thickest"
          value={limit.max}
          step={0.1}
          onChange={(max) => patch({ thicknessLimits: [{ ...limit, max }] })}
        />
      </fieldset>

      {problems.length > 0 && (
        <ul className="findings" data-testid="machine-problems">
          {problems.map((p) => (
            <li className="finding error" key={`${p.field}-${p.message}`}>
              <div className="finding-head">
                <span className="severity">error</span>
                <code className="code">{p.field}</code>
              </div>
              <div className="finding-message">{p.message}</div>
            </li>
          ))}
        </ul>
      )}

      <label className="field toggle">
        <input
          type="checkbox"
          data-testid="machine-confirmed"
          disabled={problems.length > 0}
          checked={machine.placeholder !== true}
          onChange={(e) => patch({ placeholder: !e.target.checked })}
        />
        <span>
          These are the real machine&apos;s numbers, checked against the bed, the tonnage chart and
          the die rack
        </span>
      </label>
    </>
  );
}

/**
 * A comma-separated list of numbers.
 *
 * Kept as text while editing: a die rack is typed as a run of numbers, and
 * re-parsing into chips on every keystroke makes it impossible to type "12,"
 * before reaching the 5 of 125.
 */
function ListField({
  label,
  values,
  onChange,
  testId,
}: {
  label: string;
  values: readonly number[];
  onChange: (next: number[]) => void;
  testId: string;
}): JSX.Element {
  const [text, setText] = useState(() => values.join(', '));
  const parsed = parseList(text);

  return (
    <label className={`field${parsed === null ? ' invalid' : ''}`}>
      <span>{label}</span>
      <input
        type="text"
        data-testid={testId}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const next = parseList(e.target.value);
          if (next !== null && next.length > 0) onChange(next);
        }}
      />
    </label>
  );
}

/** null when the text is not a list of numbers at all. */
function parseList(text: string): number[] | null {
  const parts = text
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  const numbers = parts.map(Number);
  if (numbers.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  return [...numbers].sort((a, b) => a - b);
}

/* ---------------------------------------------------------- calibration -- */

const DEFAULT_STRIP: TestStrip = {
  angleDeg: 90,
  insideRadiusMm: 1.2,
  thicknessMm: 1.2,
  legAMm: 100,
  legBMm: 100,
  measuredFlatMm: 197.8,
};

function CalibrationEditor({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (next: Settings) => void;
}): JSX.Element {
  const [materialId, setMaterialId] = useState(settings.materials[0]?.id ?? '');
  const [strip, setStrip] = useState<TestStrip>(DEFAULT_STRIP);
  const material = settings.materials.find((m) => m.id === materialId);
  const result = calibrate(strip);
  const patch = (next: Partial<TestStrip>): void => setStrip({ ...strip, ...next });

  const save = (): void => {
    if (material === undefined || result.error !== undefined) return;
    onChange(withMaterial(settings, withBendRow(material, toBendRow(strip, result))));
  };

  return (
    <>
      <p className="muted">
        Fold a strip, measure each leg <strong>to the apex</strong> — where the two flat faces would
        cross if you continued them, not the outside of the radius — and measure the blank it was
        cut from. That is enough to solve for K.
      </p>

      <fieldset>
        <legend>Test strip</legend>
        <label className="field">
          <span>Material</span>
          <select
            data-testid="calibration-material"
            value={materialId}
            onChange={(e) => setMaterialId(e.target.value)}
          >
            {settings.materials.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <NumberField
          label="Bend angle"
          unit="°"
          value={strip.angleDeg}
          onChange={(v) => patch({ angleDeg: v })}
        />
        <NumberField
          label="Thickness"
          value={strip.thicknessMm}
          step={0.1}
          onChange={(v) => patch({ thicknessMm: v })}
        />
        <NumberField
          label="Inside radius"
          value={strip.insideRadiusMm}
          step={0.1}
          onChange={(v) => patch({ insideRadiusMm: v })}
        />
        <NumberField
          label="Leg A (to apex)"
          value={strip.legAMm}
          onChange={(v) => patch({ legAMm: v })}
        />
        <NumberField
          label="Leg B (to apex)"
          value={strip.legBMm}
          onChange={(v) => patch({ legBMm: v })}
        />
        <NumberField
          label="Blank length"
          value={strip.measuredFlatMm}
          step={0.1}
          onChange={(v) => patch({ measuredFlatMm: v })}
        />
      </fieldset>

      <div className="calibration-result" data-testid="calibration-result">
        {result.error !== undefined ? (
          <p className="verdict blocked">{result.error}</p>
        ) : (
          <>
            <dl className="stats">
              <dt>K factor</dt>
              <dd data-testid="calibration-k">{result.kFactor.toFixed(3)}</dd>
              <dt>Bend deduction</dt>
              <dd>{result.bendDeductionMm.toFixed(2)} mm</dd>
              <dt>Bend allowance</dt>
              <dd>{result.bendAllowanceMm.toFixed(2)} mm</dd>
              {material !== undefined && (
                <>
                  <dt>Was predicting</dt>
                  <dd>
                    {predictedDeduction(strip, material.defaultK).toFixed(2)} mm at K{' '}
                    {material.defaultK.toFixed(2)}
                  </dd>
                </>
              )}
            </dl>
            {result.warning !== undefined && <p className="caveat">{result.warning}</p>}
          </>
        )}
      </div>

      <div className="button-row">
        <button
          type="button"
          className="primary"
          data-testid="calibration-save"
          disabled={result.error !== undefined || material === undefined}
          onClick={save}
        >
          Add to {material?.name ?? 'material'} bend table
        </button>
      </div>

      {material !== undefined && material.bendTable.length > 0 && (
        <fieldset data-testid="bend-table-rows">
          <legend>Calibrated rows</legend>
          <table className="bend-table">
            <thead>
              <tr>
                <th>T</th>
                <th>Angle</th>
                <th>Radius</th>
                <th>Die</th>
                <th>K</th>
              </tr>
            </thead>
            <tbody>
              {material.bendTable.map((row, i) => (
                <tr key={`${row.thickness}-${row.angleDeg ?? 'any'}-${i}`}>
                  <td>{row.thickness}</td>
                  <td>{row.angleDeg ?? 'any'}</td>
                  <td>{row.insideRadius ?? '—'}</td>
                  <td>{row.dieWidth ?? 'any'}</td>
                  <td>{row.kFactor?.toFixed(3) ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="button-row">
            <button
              type="button"
              className="link"
              data-testid="calibration-clear"
              onClick={() => onChange(withMaterial(settings, clearBendTable(material)))}
            >
              clear this table
            </button>
          </div>
        </fieldset>
      )}
    </>
  );
}

function clearBendTable(material: Material): Material {
  return { ...material, bendTable: [] };
}
