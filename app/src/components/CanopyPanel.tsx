/**
 * Canopy template wizard.
 *
 * Dimensions are **outside** sizes, the way somebody measures a ute tray. The
 * template cuts every panel to the neutral-surface box — one thickness smaller
 * in each direction — because that is what a butt-welded corner is, so the
 * panel sizes shown here are deliberately not the numbers typed above them.
 *
 * The one piece of real construction is the lip: each wall turns inward at the
 * top and bottom, and the roof and floor land on those lips. Everything else is
 * still skeleton — square corners, no window apertures, no tapers, no tabs. The
 * panel says so rather than letting somebody assume otherwise from a
 * clean-looking form.
 */

import type { CanopyMeasures, CanopyParams, Material } from '@metal-mate/core';
import { canopyMeasures, canopyPanels } from '@metal-mate/core';
import { NumberField } from './NumberField.js';

/** Drop the rivet spec entirely rather than setting it undefined. */
function withoutRivets(params: CanopyParams): CanopyParams {
  const { rivet: _rivet, ...rest } = params;
  return rest;
}

function measuresOf(params: CanopyParams): CanopyMeasures | null {
  try {
    return canopyMeasures(params);
  } catch {
    return null;
  }
}

export interface CanopyPanelProps {
  readonly params: CanopyParams;
  readonly materials: readonly Material[];
  readonly onChange: (next: CanopyParams) => void;
}

export function CanopyPanel({ params, materials, onChange }: CanopyPanelProps): JSX.Element {
  const patch = (next: Partial<CanopyParams>): void => onChange({ ...params, ...next });
  const material = materials.find((m) => m.id === params.materialId);
  const t = params.thicknessMm;
  const lip = params.lipMm ?? 0;
  // A body that cannot be built has no dimensions to report; the parts list
  // says what is wrong with it, so this just goes quiet rather than throwing
  // out of a render.
  const measures = measuresOf(params);

  return (
    <section className="panel template" data-testid="canopy-panel">
      <h2>Canopy</h2>
      <p className="muted">All dimensions are outside sizes, in millimetres.</p>

      <fieldset>
        <legend>Box</legend>
        <NumberField label="Length" value={params.lengthMm} onChange={(v) => patch({ lengthMm: v })} />
        <NumberField label="Width" value={params.widthMm} onChange={(v) => patch({ widthMm: v })} />
        <NumberField label="Height" value={params.heightMm} onChange={(v) => patch({ heightMm: v })} />
        <label className="field toggle">
          <input
            type="checkbox"
            data-testid="canopy-floor"
            checked={params.floor !== false}
            onChange={(e) => patch({ floor: e.target.checked })}
          />
          <span>Include a floor — leave it off if the canopy sits on the ute&apos;s own tray</span>
        </label>
        <NumberField label="Lip" value={params.lipMm ?? 0} onChange={(v) => patch({ lipMm: v })} />
        <p className="muted" data-testid="canopy-lip-note">
          {lip > 0
            ? `Each wall turns ${lip} mm inward at the top and bottom, mitred at every corner. The roof lands on the top lips and the bottom lips land on the floor, so the outside height is still ${params.heightMm} mm.`
            : 'Zero lip: the panels butt edge to edge, with nothing to bolt or clamp through.'}
        </p>
      </fieldset>

      <fieldset data-testid="canopy-rivets">
        <legend>Rivets</legend>
        <label className="field toggle">
          <input
            type="checkbox"
            data-testid="canopy-riveted"
            checked={params.rivet !== undefined}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? { ...params, rivet: params.rivet ?? { diameterMm: 4.8, pitchMm: 100 } }
                  : withoutRivets(params),
              )
            }
          />
          <span>Rivet the seams</span>
        </label>
        {params.rivet !== undefined && (
          <>
            <NumberField
              label="Rivet"
              value={params.rivet.diameterMm}
              step={0.2}
              onChange={(v) => patch({ rivet: { ...params.rivet!, diameterMm: v } })}
            />
            <NumberField
              label="Pitch"
              value={params.rivet.pitchMm}
              step={5}
              onChange={(v) => patch({ rivet: { ...params.rivet!, pitchMm: v } })}
            />
            <p className="muted" data-testid="canopy-rivet-note">
              Holes go down the middle of each lip at this pitch or a little under, so the run
              divides evenly. They are cut in the <strong>lip only</strong>: the spacing would match
              on the panel that lands on it, but how far the holes sit from the seam depends on the
              bend allowance, and K has not been measured for this shop yet. Clamp up and drill
              through.
            </p>
          </>
        )}
      </fieldset>

      <fieldset data-testid="canopy-taper">
        <legend>Taper</legend>
        <p className="muted">
          Length, width and height above are the <strong>footprint and the front</strong>. Leaning a
          wall in or dropping the roof changes what the back and the top measure, so those are
          reported below rather than assumed.
        </p>
        <NumberField
          label="Roof drop"
          value={params.roofDropMm ?? 0}
          onChange={(v) => patch({ roofDropMm: v })}
        />
        {(
          [
            ['leftDeg', 'Left lean'],
            ['rightDeg', 'Right lean'],
            ['frontDeg', 'Front lean'],
            ['rearDeg', 'Rear lean'],
          ] as const
        ).map(([field, label]) => (
          <NumberField
            key={field}
            label={label}
            unit="°"
            step={0.5}
            value={params.taperDeg?.[field] ?? 0}
            onChange={(v) => patch({ taperDeg: { ...params.taperDeg, [field]: v } })}
          />
        ))}
        {measures !== null && (
          <dl className="stats" data-testid="canopy-measures">
            <div>
              <dt>Roof width</dt>
              <dd>
                {measures.roofWidthFrontMm.toFixed(0)} front / {measures.roofWidthRearMm.toFixed(0)}{' '}
                rear
              </dd>
            </div>
            <div>
              <dt>Roof length</dt>
              <dd>{measures.roofLengthMm.toFixed(0)} mm</dd>
            </div>
            <div>
              <dt>Height at rear</dt>
              <dd>{measures.rearHeightMm.toFixed(0)} mm</dd>
            </div>
          </dl>
        )}
      </fieldset>

      <fieldset>
        <legend>Design</legend>
        <label className="field">
          <span>Name</span>
          <input type="text" value={params.name} onChange={(e) => patch({ name: e.target.value })} />
        </label>
        <label className="field">
          <span>Part prefix</span>
          <input
            type="text"
            data-testid="canopy-prefix"
            value={params.partPrefix ?? ''}
            placeholder="CAN"
            onChange={(e) => patch({ partPrefix: e.target.value })}
          />
        </label>
      </fieldset>

      <fieldset>
        <legend>Material</legend>
        <label className="field">
          <span>Grade</span>
          <select value={params.materialId} onChange={(e) => patch({ materialId: e.target.value })}>
            {materials.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Thickness</span>
          <select
            value={String(params.thicknessMm)}
            onChange={(e) => patch({ thicknessMm: Number(e.target.value) })}
          >
            {(material?.thicknesses ?? [params.thicknessMm]).map((th) => (
              <option key={th} value={String(th)}>
                {th} mm
              </option>
            ))}
          </select>
        </label>
        <NumberField
          label="Bend radius"
          value={params.bendRadiusMm}
          step={0.1}
          onChange={(v) => patch({ bendRadiusMm: v })}
        />
        <label className="field">
          <span>Grain</span>
          <select
            value={params.grain ?? 'length'}
            onChange={(e) => patch({ grain: e.target.value as NonNullable<CanopyParams['grain']> })}
          >
            <option value="length">Along length</option>
            <option value="width">Across width</option>
            <option value="none">None / unpolished</option>
          </select>
        </label>
      </fieldset>

      <fieldset data-testid="canopy-panels">
        <legend>Panels</legend>
        <p className="muted">
          {canopyPanels(params).length} panels, each cut {t} mm under the outside size: the corners
          meet on the neutral surface, so every dimension loses half a thickness at each end.
          {lip > 0 ? ' The walls are shorter again by what their lips take.' : ''}
        </p>
      </fieldset>

      <p className="caveat" data-testid="canopy-caveat">
        This is still the <strong>skeleton</strong> canopy: square corners, no window apertures, no
        tapers and no locating tabs. The seams have no weld gap yet, because a corner joint still
        applies within one part and these are between parts.
      </p>
    </section>
  );
}
