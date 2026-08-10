/**
 * The parts in this document, and the cut list.
 *
 * An assembly is several panels, so this is the thing you navigate by. It also
 * carries the rollup — total mass and cut length across every part, counting
 * quantities — because that is the number somebody orders material against.
 */

import type { DocumentBuild, PartBuild } from '@metal-mate/core';
import type { PartRow } from '../state/useDocument.js';

export interface PartsPanelProps {
  readonly rows: readonly PartRow[];
  readonly activeUid: string;
  readonly document: DocumentBuild | null;
  /** Row uid to its build, worked out once in `useDocumentBuild`. */
  readonly buildByUid: ReadonlyMap<string, PartBuild>;
  readonly onSelect: (uid: string) => void;
  readonly onAdd: () => void;
  readonly onDuplicate: (uid: string) => void;
  readonly onRemove: (uid: string) => void;
}

export function PartsPanel({
  rows,
  activeUid,
  document,
  buildByUid,
  onSelect,
  onAdd,
  onDuplicate,
  onRemove,
}: PartsPanelProps): JSX.Element {
  return (
    <section className="panel parts" data-testid="parts-panel">
      <h2>Parts</h2>

      <ul className="part-list">
        {rows.map((row) => {
          const build = buildByUid.get(row.uid) ?? null;
          const quantity = row.params.quantity ?? 1;
          return (
            <li
              key={row.uid}
              className={`part-row${row.uid === activeUid ? ' active' : ''}${
                build !== null && !build.ok ? ' broken' : ''
              }`}
            >
              <button
                type="button"
                className="part-select"
                data-testid={`part-select-${row.uid}`}
                onClick={() => onSelect(row.uid)}
              >
                <span className="part-name">{row.params.name}</span>
                <span className="muted">
                  {quantity > 1 && `${quantity} off · `}
                  {statusOf(build)}
                </span>
              </button>
              <span className="part-actions">
                <button
                  type="button"
                  className="link"
                  title="Duplicate"
                  onClick={() => onDuplicate(row.uid)}
                >
                  copy
                </button>
                <button
                  type="button"
                  className="link"
                  title="Remove"
                  disabled={rows.length <= 1}
                  onClick={() => onRemove(row.uid)}
                >
                  remove
                </button>
              </span>
            </li>
          );
        })}
      </ul>

      <div className="button-row">
        <button type="button" data-testid="add-part" onClick={onAdd}>
          Add part
        </button>
      </div>

      {document !== null && document.problems.length > 0 && (
        <ul className="findings" data-testid="document-problems">
          {document.problems.map((p) => (
            <li className="finding error" key={`${p.key ?? 'document'}-${p.message}`}>
              <div className="finding-message">{p.message}</div>
            </li>
          ))}
        </ul>
      )}

      {document !== null && rows.length > 1 && (
        <dl className="stats" data-testid="cut-list-totals">
          <dt>Parts</dt>
          <dd>{totalPieces(rows)}</dd>
          <dt>Mass</dt>
          <dd>{document.totalMassKg.toFixed(1)} kg</dd>
          <dt>Cut length</dt>
          <dd>{(document.totalCutLengthMm / 1000).toFixed(1)} m</dd>
        </dl>
      )}
    </section>
  );
}

function statusOf(build: PartBuild | null): string {
  if (build === null) return '…';
  if (!build.ok) return 'will not build';
  const { report } = build.result;
  if (!report.exportAllowed) return `${report.errorCount} error${report.errorCount === 1 ? '' : 's'}`;
  if (report.warningCount > 0) {
    return `${report.warningCount} warning${report.warningCount === 1 ? '' : 's'}`;
  }
  return 'ready';
}

function totalPieces(rows: readonly PartRow[]): number {
  return rows.reduce((sum, r) => sum + (r.params.quantity ?? 1), 0);
}
