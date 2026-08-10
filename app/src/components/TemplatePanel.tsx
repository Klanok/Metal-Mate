/**
 * Benchtop template wizard.
 *
 * Every dimension here is an **outside** dimension, the way a joiner measures a
 * benchtop. The template subtracts the setback at each fold to get the
 * tangent-to-tangent legs the graph wants, so the user never has to think
 * about bend allowance.
 */

import type { BenchtopCutout, BenchtopParams, FrontEdgeStyle, Material } from '@metal-mate/core';
import { NumberField } from './NumberField.js';

export interface TemplatePanelProps {
  readonly params: BenchtopParams;
  readonly materials: readonly Material[];
  readonly onChange: (next: BenchtopParams) => void;
}

const FRONT_EDGE_STYLES: { value: FrontEdgeStyle; label: string }[] = [
  { value: 'none', label: 'None (flat edge)' },
  { value: 'square-drop', label: 'Square fold-down' },
  { value: 'drop-and-return', label: 'Fold-down + return under' },
  { value: 'boxed', label: 'Full boxed edge' },
];

export function TemplatePanel({ params, materials, onChange }: TemplatePanelProps): JSX.Element {
  const patch = (next: Partial<BenchtopParams>): void => onChange({ ...params, ...next });
  const material = materials.find((m) => m.id === params.materialId);
  const style = params.frontEdge.style;

  return (
    <section className="panel template" data-testid="template-panel">
      <h2>Benchtop</h2>
      <p className="muted">All dimensions are outside sizes, in millimetres.</p>

      <fieldset>
        <legend>Part</legend>
        <label className="field">
          <span>Name</span>
          <input
            type="text"
            value={params.name}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Part ID</span>
          <input
            type="text"
            value={params.partId ?? ''}
            placeholder="BT-001"
            onChange={(e) => patch({ partId: e.target.value })}
          />
        </label>
      </fieldset>

      <fieldset>
        <legend>Plan</legend>
        <NumberField label="Length" value={params.lengthMm} onChange={(v) => patch({ lengthMm: v })} />
        <NumberField label="Depth" value={params.depthMm} onChange={(v) => patch({ depthMm: v })} />
      </fieldset>

      <fieldset>
        <legend>Material</legend>
        <label className="field">
          <span>Grade</span>
          <select
            value={params.materialId}
            onChange={(e) => patch({ materialId: e.target.value })}
          >
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
            {(material?.thicknesses ?? [params.thicknessMm]).map((t) => (
              <option key={t} value={String(t)}>
                {t} mm
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
            onChange={(e) => patch({ grain: e.target.value as NonNullable<BenchtopParams['grain']> })}
          >
            <option value="length">Along length</option>
            <option value="width">Across width</option>
            <option value="none">None / unpolished</option>
          </select>
        </label>
      </fieldset>

      <fieldset>
        <legend>Front edge</legend>
        <label className="field">
          <span>Profile</span>
          <select
            value={style}
            onChange={(e) =>
              patch({
                frontEdge: withStyleDefaults(params, e.target.value as FrontEdgeStyle),
              })
            }
          >
            {FRONT_EDGE_STYLES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {style !== 'none' && (
          <NumberField
            label="Drop"
            value={params.frontEdge.dropMm}
            onChange={(v) => patch({ frontEdge: { ...params.frontEdge, dropMm: v } })}
          />
        )}
        {(style === 'drop-and-return' || style === 'boxed') && (
          <NumberField
            label="Return under"
            value={params.frontEdge.returnMm ?? 25}
            onChange={(v) => patch({ frontEdge: { ...params.frontEdge, returnMm: v } })}
          />
        )}
        {style === 'boxed' && (
          <NumberField
            label="Upstand"
            value={params.frontEdge.upstandMm ?? 15}
            onChange={(v) => patch({ frontEdge: { ...params.frontEdge, upstandMm: v } })}
          />
        )}
      </fieldset>

      <fieldset>
        <legend>Splashback</legend>
        <label className="field">
          <span>Style</span>
          <select
            value={params.splashback.style}
            onChange={(e) =>
              patch({
                splashback: {
                  style: e.target.value as 'none' | 'integral',
                  heightMm: params.splashback.heightMm > 0 ? params.splashback.heightMm : 100,
                },
              })
            }
          >
            <option value="none">None</option>
            <option value="integral">Integral (folded up)</option>
          </select>
        </label>
        {params.splashback.style === 'integral' && (
          <NumberField
            label="Height"
            value={params.splashback.heightMm}
            onChange={(v) => patch({ splashback: { ...params.splashback, heightMm: v } })}
          />
        )}
      </fieldset>

      <CutoutEditor
        cutouts={params.cutouts}
        onChange={(cutouts) => patch({ cutouts })}
      />
    </section>
  );
}

/** Fill in the dimensions a newly chosen edge style needs but does not have. */
function withStyleDefaults(params: BenchtopParams, style: FrontEdgeStyle): BenchtopParams['frontEdge'] {
  const current = params.frontEdge;
  return {
    style,
    dropMm: current.dropMm > 0 ? current.dropMm : 40,
    ...(style === 'drop-and-return' || style === 'boxed'
      ? { returnMm: current.returnMm ?? 25 }
      : {}),
    ...(style === 'boxed' ? { upstandMm: current.upstandMm ?? 15 } : {}),
  };
}

function CutoutEditor({
  cutouts,
  onChange,
}: {
  cutouts: readonly BenchtopCutout[];
  onChange: (next: BenchtopCutout[]) => void;
}): JSX.Element {
  const replace = (index: number, next: BenchtopCutout): void => {
    onChange(cutouts.map((c, i) => (i === index ? next : c)));
  };
  const nextId = (prefix: string): string => {
    let n = 1;
    while (cutouts.some((c) => c.id === `${prefix}${n}`)) n += 1;
    return `${prefix}${n}`;
  };

  return (
    <fieldset data-testid="cutout-editor">
      <legend>Cutouts</legend>
      {cutouts.length === 0 && <p className="muted">None. Positions are measured from the front-left corner.</p>}
      {cutouts.map((cutout, index) => (
        <div className="cutout" key={cutout.id}>
          <div className="cutout-head">
            <strong>
              {cutout.kind === 'hole' ? 'Tap hole' : cutout.kind === 'sink' ? 'Sink' : 'Hob'} ·{' '}
              {cutout.id}
            </strong>
            <button
              type="button"
              className="link"
              onClick={() => onChange(cutouts.filter((_, i) => i !== index))}
            >
              remove
            </button>
          </div>
          <NumberField
            label="From left"
            value={cutout.fromLeftMm}
            onChange={(v) => replace(index, { ...cutout, fromLeftMm: v })}
          />
          <NumberField
            label="From front"
            value={cutout.fromFrontMm}
            onChange={(v) => replace(index, { ...cutout, fromFrontMm: v })}
          />
          {cutout.kind === 'hole' ? (
            <NumberField
              label="Diameter"
              value={cutout.diameterMm}
              onChange={(v) => replace(index, { ...cutout, diameterMm: v })}
            />
          ) : (
            <>
              <NumberField
                label="Width"
                value={cutout.widthMm}
                onChange={(v) => replace(index, { ...cutout, widthMm: v })}
              />
              <NumberField
                label="Depth"
                value={cutout.depthMm}
                onChange={(v) => replace(index, { ...cutout, depthMm: v })}
              />
              <NumberField
                label="Corner radius"
                value={cutout.cornerRadiusMm}
                onChange={(v) => replace(index, { ...cutout, cornerRadiusMm: v })}
              />
            </>
          )}
        </div>
      ))}
      <div className="button-row">
        <button
          type="button"
          onClick={() =>
            onChange([
              ...cutouts,
              {
                kind: 'sink',
                id: nextId('sink'),
                fromLeftMm: 400,
                fromFrontMm: 90,
                widthMm: 400,
                depthMm: 350,
                cornerRadiusMm: 10,
              },
            ])
          }
        >
          Add sink
        </button>
        <button
          type="button"
          onClick={() =>
            onChange([
              ...cutouts,
              {
                kind: 'hob',
                id: nextId('hob'),
                fromLeftMm: 1000,
                fromFrontMm: 90,
                widthMm: 560,
                depthMm: 480,
                cornerRadiusMm: 8,
              },
            ])
          }
        >
          Add hob
        </button>
        <button
          type="button"
          onClick={() =>
            onChange([
              ...cutouts,
              { kind: 'hole', id: nextId('tap'), fromLeftMm: 620, fromFrontMm: 500, diameterMm: 35 },
            ])
          }
        >
          Add tap hole
        </button>
      </div>
    </fieldset>
  );
}
