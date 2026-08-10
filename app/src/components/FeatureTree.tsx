/**
 * Feature tree and bend table.
 *
 * Read-only in this build: the benchtop wizard owns the features, and editing
 * them directly is a v1.x job. It earns its place now because it is how you
 * see what the template actually generated — which faces exist, which bends
 * join them, and where each bend's allowance came from.
 */

import type { BuildResult } from '@metal-mate/core';

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
        {part.features.map((f) => (
          <li key={f.id}>
            <code>{f.id}</code>
            <span className="kind">{f.kind}</span>
            {f.label !== undefined && <span className="muted">{f.label}</span>}
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
