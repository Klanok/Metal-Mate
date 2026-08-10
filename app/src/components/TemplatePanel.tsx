/**
 * Benchtop template wizard.
 *
 * Every dimension here is an **outside** dimension, the way a joiner measures a
 * benchtop. The template subtracts the setback at each fold to get the
 * tangent-to-tangent legs the graph wants, so the user never has to think
 * about bend allowance.
 */

import type {
  BenchtopCutout,
  BenchtopEdges,
  BenchtopParams,
  CornerStyle,
  EdgeParams,
  EdgeStyle,
  Material,
  Side,
} from '@metal-mate/core';
import { NO_EDGE, SIDES, cornerTreatments, resolveEdges } from '@metal-mate/core';
import { NumberField } from './NumberField.js';

export interface TemplatePanelProps {
  readonly params: BenchtopParams;
  readonly materials: readonly Material[];
  readonly onChange: (next: BenchtopParams) => void;
}

const EDGE_STYLES: { value: EdgeStyle; label: string }[] = [
  { value: 'none', label: 'Open (no edge)' },
  { value: 'square-drop', label: 'Square fold-down' },
  { value: 'drop-and-return', label: 'Fold-down + return under' },
  { value: 'boxed', label: 'Full boxed edge' },
  { value: 'upstand', label: 'Fold up (splashback)' },
];

const SIDE_LABELS: Record<Side, string> = {
  front: 'Front edge',
  back: 'Back edge',
  left: 'Left end',
  right: 'Right end',
};

export function TemplatePanel({ params, materials, onChange }: TemplatePanelProps): JSX.Element {
  const patch = (next: Partial<BenchtopParams>): void => onChange({ ...params, ...next });
  const material = materials.find((m) => m.id === params.materialId);
  const edges = resolveEdges(params);

  const setEdge = (side: Side, edge: EdgeParams): void => {
    const next: BenchtopEdges = { ...edges, [side]: edge };
    // Always write the current spelling, and drop the legacy fields so the two
    // can never disagree about the same side.
    const { frontEdge: _f, splashback: _s, ...rest } = params;
    onChange({ ...rest, edges: next });
  };

  return (
    <section className="panel template" data-testid="template-panel">
      <h2>Benchtop</h2>
      <p className="muted">All dimensions are outside sizes, in millimetres.</p>

      <fieldset>
        <legend>Part</legend>
        <label className="field">
          <span>Name</span>
          <input type="text" value={params.name} onChange={(e) => patch({ name: e.target.value })} />
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

      {SIDES.map((side) => (
        <EdgeEditor
          key={side}
          side={side}
          edge={edges[side]}
          onChange={(edge) => setEdge(side, edge)}
        />
      ))}

      <CornerEditor params={params} edges={edges} onPatch={patch} />

      <CutoutEditor cutouts={params.cutouts} onChange={(cutouts) => patch({ cutouts })} />
    </section>
  );
}

function defaultRelief(params: BenchtopParams): number {
  return Math.max(2 * params.thicknessMm, params.bendRadiusMm + params.thicknessMm);
}

/**
 * The corner controls, which only appear once two folded sides actually meet.
 *
 * What is on offer depends on what the part needs: a weld gap where corners
 * close, a notch size where they cannot. Corners whose two sides fold opposite
 * ways are always relieved, so a part can legitimately want both fields at
 * once — a benchtop with folded ends and a splashback is exactly that case.
 */
function CornerEditor({
  params,
  edges,
  onPatch,
}: {
  params: BenchtopParams;
  edges: BenchtopEdges;
  onPatch: (next: Partial<BenchtopParams>) => void;
}): JSX.Element | null {
  const style = params.cornerStyle ?? 'mitre';
  const treatments = Object.values(cornerTreatments(edges, style));
  const mitred = treatments.filter((t) => t === 'mitre').length;
  const relieved = treatments.filter((t) => t === 'relief').length;
  if (mitred + relieved === 0) return null;

  return (
    <fieldset data-testid="corner-editor">
      <legend>Corners</legend>
      <label className="field">
        <span>Where sides meet</span>
        <select
          value={style}
          onChange={(e) => onPatch({ cornerStyle: e.target.value as CornerStyle })}
        >
          <option value="mitre">Close and weld</option>
          <option value="relief">Leave open (relief notch)</option>
        </select>
      </label>
      <p className="muted">
        {mitred > 0 && (
          <>
            {mitred} corner{mitred === 1 ? '' : 's'} close up, ready to weld and grind. Returns are
            mitred at 45° so they meet on the diagonal instead of overlapping.{' '}
          </>
        )}
        {relieved > 0 && (
          <>
            {relieved} corner{relieved === 1 ? '' : 's'} {mitred > 0 ? 'cannot close — one side folds up and the other down — so they are' : 'are'}{' '}
            notched instead.
          </>
        )}
      </p>
      {mitred > 0 && (
        <NumberField
          label="Weld gap"
          value={params.cornerGapMm ?? params.thicknessMm}
          step={0.1}
          onChange={(v) => onPatch({ cornerGapMm: v })}
        />
      )}
      {relieved > 0 && (
        <NumberField
          label="Relief notch"
          value={params.cornerReliefMm ?? defaultRelief(params)}
          step={0.5}
          onChange={(v) => onPatch({ cornerReliefMm: v })}
        />
      )}
    </fieldset>
  );
}

function EdgeEditor({
  side,
  edge,
  onChange,
}: {
  side: Side;
  edge: EdgeParams;
  onChange: (edge: EdgeParams) => void;
}): JSX.Element {
  const style = edge.style;
  const heightLabel = style === 'upstand' ? 'Height' : 'Drop';

  return (
    <fieldset data-testid={`edge-${side}`}>
      <legend>{SIDE_LABELS[side]}</legend>
      <label className="field">
        <span>Profile</span>
        <select
          value={style}
          onChange={(e) => onChange(withStyleDefaults(edge, e.target.value as EdgeStyle))}
        >
          {EDGE_STYLES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      {style !== 'none' && (
        <NumberField
          label={heightLabel}
          value={edge.heightMm}
          onChange={(v) => onChange({ ...edge, heightMm: v })}
        />
      )}
      {(style === 'drop-and-return' || style === 'boxed') && (
        <NumberField
          label="Return under"
          value={edge.returnMm ?? 25}
          onChange={(v) => onChange({ ...edge, returnMm: v })}
        />
      )}
      {style === 'boxed' && (
        <NumberField
          label="Upstand"
          value={edge.upstandMm ?? 15}
          onChange={(v) => onChange({ ...edge, upstandMm: v })}
        />
      )}
    </fieldset>
  );
}

/** Fill in the dimensions a newly chosen style needs but does not have yet. */
function withStyleDefaults(edge: EdgeParams, style: EdgeStyle): EdgeParams {
  if (style === 'none') return NO_EDGE;
  const heightMm = edge.heightMm > 0 ? edge.heightMm : style === 'upstand' ? 100 : 40;
  return {
    style,
    heightMm,
    ...(style === 'drop-and-return' || style === 'boxed' ? { returnMm: edge.returnMm ?? 25 } : {}),
    ...(style === 'boxed' ? { upstandMm: edge.upstandMm ?? 15 } : {}),
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
      {cutouts.length === 0 && (
        <p className="muted">None. Positions are measured from the front-left corner.</p>
      )}
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
