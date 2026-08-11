/**
 * Feature tree and bend table.
 *
 * Read-only in this build: the benchtop wizard owns the features, and editing
 * them directly is a v1.x job. It earns its place now because it is how you
 * see what the template actually generated — which faces exist, which bends
 * join them, and where each bend's allowance came from.
 */

import type { BuildResult, Feature } from '@metal-mate/core';

interface FeatureRow {
  readonly id: string;
  readonly kind: string;
  readonly label?: string;
}

/**
 * Collapse a run of identical cutouts on one face into a single row.
 *
 * A riveted seam is 19 holes, and a canopy wall is four of those runs. Listing
 * every one buries the two features that actually describe the part, so a run
 * is shown as what it is — a line of holes, and how many.
 */
export function groupRuns(features: readonly Feature[]): FeatureRow[] {
  const rows: FeatureRow[] = [];
  let on: string | null = null;
  let ids: string[] = [];

  const flush = (): void => {
    if (on === null) return;
    rows.push(
      ids.length === 1
        ? { id: ids[0]!, kind: 'cutout', label: `1 hole in ${on}` }
        : { id: `${on} holes`, kind: 'cutout', label: `${ids.length} holes` },
    );
    on = null;
    ids = [];
  };

  for (const f of features) {
    if (f.kind === 'cutout') {
      const face = String(f.faceId);
      if (on !== null && on !== face) flush();
      on = face;
      ids.push(String(f.id));
      continue;
    }
    flush();
    rows.push({
      id: String(f.id),
      kind: f.kind,
      ...(f.label !== undefined ? { label: f.label } : {}),
    });
  }
  flush();
  return rows;
}

export interface FeatureTreeProps {
  readonly result: BuildResult | null;
}

export function FeatureTree({ result }: FeatureTreeProps): JSX.Element {
  if (result === null) {
    return (
      <section className="panel tree">
        <h2>Features</h2>
        <p className="muted">Nothing built yet.</p>
      </section>
    );
  }

  const { part, graph, flat } = result;

  return (
    <section className="panel tree" data-testid="feature-tree">
      <h2>Features</h2>
      <ul className="features">
        {groupRuns(part.features).map((row) => (
          <li key={row.id}>
            <code>{row.id}</code>
            <span className="kind">{row.kind}</span>
            {row.label !== undefined && <span className="muted">{row.label}</span>}
          </li>
        ))}
      </ul>

      <h2>Bends</h2>
      <table className="bend-table" data-testid="bend-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Angle</th>
            <th>Dir</th>
            <th>Radius</th>
            <th>Length</th>
            <th>Allowance</th>
            <th>From</th>
          </tr>
        </thead>
        <tbody>
          {flat.bendLines.map((b, i) => (
            <tr key={String(b.bendId)}>
              <td>{i + 1}</td>
              <td>{b.angleDeg.toFixed(0)}°</td>
              <td>{b.direction}</td>
              <td>{b.insideRadius.toFixed(2)}</td>
              <td>{b.lengthMm.toFixed(1)}</td>
              <td>{b.allowance.bendAllowance.toFixed(3)}</td>
              <td className="source">{b.allowance.source}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="stats" data-testid="part-stats">
        <div>
          <dt>Faces</dt>
          <dd>{graph.faces.size}</dd>
        </div>
        <div>
          <dt>Blank</dt>
          <dd>
            {(flat.bounds.max.x - flat.bounds.min.x).toFixed(1)} ×{' '}
            {(flat.bounds.max.y - flat.bounds.min.y).toFixed(1)} mm
          </dd>
        </div>
        <div>
          <dt>Cut length</dt>
          <dd>{(flat.cutLengthMm / 1000).toFixed(2)} m</dd>
        </div>
        <div>
          <dt>Mass</dt>
          <dd>{result.massKg.toFixed(2)} kg</dd>
        </div>
      </dl>
    </section>
  );
}
