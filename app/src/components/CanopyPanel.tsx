/**
 * Canopy template wizard.
 *
 * Dimensions are **outside** sizes, the way somebody measures a ute tray. The
 * template cuts every panel to the neutral-surface box — one thickness smaller
 * in each direction — because that is what a butt-welded corner is, so the
 * panel sizes shown here are deliberately not the numbers typed above them.
 *
 * This is the skeleton template: flat panels, square welded corners, no window
 * apertures, no tapers, no tabs. The panel says so rather than letting somebody
 * assume otherwise from a clean-looking form.
 */

import type { CanopyParams, Material } from '@metal-mate/core';
import { canopyPanels } from '@metal-mate/core';
import { NumberField } from './NumberField.js';

export interface CanopyPanelProps {
  readonly params: CanopyParams;
  readonly materials: readonly Material[];
  readonly onChange: (next: CanopyParams) => void;
}

export function CanopyPanel({ params, materials, onChange }: CanopyPanelProps): JSX.Element {
  const patch = (next: Partial<CanopyParams>): void => onChange({ ...params, ...next });
  const material = materials.find((m) => m.id === params.materialId);
  const t = params.thicknessMm;

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
          {canopyPanels(params).length} panels, each cut {t} mm under the outside size: butt-welded
          corners meet on the neutral surface, so every dimension loses half a thickness at each
          end.
        </p>
      </fieldset>

      <p className="caveat" data-testid="canopy-caveat">
        This is the <strong>skeleton</strong> canopy: flat panels, square welded seams, no window
        apertures, no tapers and no locating tabs. The seams have no weld gap yet, because a corner
        joint still applies within one part and these are between parts.
      </p>
    </section>
  );
}
