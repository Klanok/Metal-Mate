/**
 * The designs in this document, the parts each one makes, and the cut list.
 *
 * A benchtop makes one part and a canopy makes six, so the list is two levels:
 * the design you edit, and under it the parts it produced. Clicking a part puts
 * it on screen and selects the design that made it, because those are never
 * separate intentions.
 */

import type { DocumentBuild, PartBuild } from '@metal-mate/core';
import type { DesignRow, ExpandedRow, TemplateKind } from '../state/useDocument.js';

export interface PartsPanelProps {
  readonly expanded: readonly ExpandedRow[];
  readonly activeUid: string;
  readonly activePartUid: string;
  readonly document: DocumentBuild | null;
  /** Part uid to its build, worked out once in `useDocumentBuild`. */
  readonly buildByUid: ReadonlyMap<string, PartBuild>;
  readonly onSelectRow: (uid: string) => void;
  readonly onSelectPart: (partUid: string, rowUid: string) => void;
  readonly onAdd: (kind: TemplateKind) => void;
  readonly onDuplicate: (uid: string) => void;
  readonly onRemove: (uid: string) => void;
}

const KIND_LABELS: Record<TemplateKind, string> = {
  benchtop: 'Benchtop',
  canopy: 'Canopy',
};

export function PartsPanel({
  expanded,
  activeUid,
  activePartUid,
  document,
  buildByUid,
  onSelectRow,
  onSelectPart,
  onAdd,
  onDuplicate,
  onRemove,
}: PartsPanelProps): JSX.Element {
  // Pieces, not distinct parts: the mass and cut length beside this come from
  // the document build, which counts quantities, and two numbers on one line
  // that disagree about what they are counting is worse than either alone.
  const totalPieces = expanded.reduce(
    (n, e) => n + e.parts.reduce((m, p) => m + (p.part?.parameters.quantity ?? 1), 0),
    0,
  );

  return (
    <section className="panel parts" data-testid="parts-panel">
      <h2>Designs</h2>

      <ul className="part-list">
        {expanded.map(({ row, parts, error }) => (
          <li key={row.uid} className={`design${row.uid === activeUid ? ' active' : ''}`}>
            <div className="part-row">
              <button
                type="button"
                className="part-select"
                data-testid={`design-select-${row.uid}`}
                onClick={() => onSelectRow(row.uid)}
              >
                <span className="part-name">{row.params.name}</span>
                <span className="muted">
                  {KIND_LABELS[row.kind]}
                  {error === null && parts.length > 1 && ` · ${parts.length} panels`}
                  {error !== null && ' · will not build'}
                </span>
              </button>
              <span className="part-actions">
                <button type="button" className="link" onClick={() => onDuplicate(row.uid)}>
                  copy
                </button>
                <button
                  type="button"
                  className="link"
                  disabled={expanded.length <= 1}
                  onClick={() => onRemove(row.uid)}
                >
                  remove
                </button>
              </span>
            </div>

            {error !== null && <div className="finding-message design-error">{error}</div>}

            {parts.length > 0 && (
              <ul className="panel-list">
                {parts.map((p) => {
                  const build = buildByUid.get(p.partUid) ?? null;
                  const quantity = p.part?.parameters.quantity ?? 1;
                  return (
                    <li
                      key={p.partUid}
                      className={`panel-row${p.partUid === activePartUid ? ' active' : ''}`}
                    >
                      <button
                        type="button"
                        data-testid={`part-select-${p.partUid}`}
                        onClick={() => onSelectPart(p.partUid, row.uid)}
                      >
                        <span>{p.part?.parameters.partId ?? p.name}</span>
                        <span className="muted">
                          {quantity > 1 && `${quantity} off · `}
                          {statusOf(build)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        ))}
      </ul>

      <div className="button-row">
        <button type="button" data-testid="add-benchtop" onClick={() => onAdd('benchtop')}>
          Add benchtop
        </button>
        <button type="button" data-testid="add-canopy" onClick={() => onAdd('canopy')}>
          Add canopy
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

      {document !== null && totalPieces > 1 && (
        <dl className="stats" data-testid="cut-list-totals">
          <dt>Parts</dt>
          <dd>{totalPieces}</dd>
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
  if (!report.exportAllowed) {
    return `${report.errorCount} error${report.errorCount === 1 ? '' : 's'}`;
  }
  if (report.warningCount > 0) {
    return `${report.warningCount} warning${report.warningCount === 1 ? '' : 's'}`;
  }
  return 'ready';
}

/** Exported for the tests, which care that a design keeps its own identity. */
export function designLabel(row: DesignRow): string {
  return `${row.params.name} (${KIND_LABELS[row.kind]})`;
}
