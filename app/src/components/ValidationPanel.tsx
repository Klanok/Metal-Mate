/**
 * The validation report.
 *
 * This panel is the reason the tool is trustworthy between two people, so it
 * states the verdict plainly rather than burying it: errors block export, and
 * it says which machine the answer came from — currently a placeholder, which
 * it also says.
 */

import type { Finding, MachineProfile, ValidationReport } from '@metal-mate/core';

export interface ValidationPanelProps {
  readonly report: ValidationReport | null;
  readonly machine: MachineProfile;
  readonly buildError: string | null;
}

export function ValidationPanel({
  report,
  machine,
  buildError,
}: ValidationPanelProps): JSX.Element {
  // An explicit flag, not a word in the name: somebody has to have gone
  // through the machine's own numbers and confirmed them for this to clear.
  const placeholder = machine.placeholder === true;

  return (
    <section className="panel validation" data-testid="validation-panel">
      <h2>Validation</h2>

      {buildError !== null && (
        <p className="verdict blocked" data-testid="build-error">
          Cannot build this part: {buildError}
        </p>
      )}

      {buildError === null && report !== null && (
        <>
          <p
            className={report.exportAllowed ? 'verdict ok' : 'verdict blocked'}
            data-testid="verdict"
          >
            {report.exportAllowed
              ? `Ready to export — ${report.warningCount} warning${report.warningCount === 1 ? '' : 's'}`
              : `Export blocked — ${report.errorCount} error${report.errorCount === 1 ? '' : 's'}, ${report.warningCount} warning${report.warningCount === 1 ? '' : 's'}`}
          </p>
          {report.findings.length === 0 ? (
            <p className="muted">Nothing to report.</p>
          ) : (
            <ul className="findings">
              {report.findings.map((f, i) => (
                <FindingRow key={`${f.code}-${i}`} finding={f} />
              ))}
            </ul>
          )}
        </>
      )}

      {placeholder && (
        <p className="caveat" data-testid="machine-caveat">
          Checked against <strong>{machine.name}</strong>, which is still marked a placeholder.
          Tonnage and minimum-flange results are estimates until its bed, tonnage chart and die
          rack are the real machine&apos;s — set them under Settings.
        </p>
      )}
    </section>
  );
}

function FindingRow({ finding }: { finding: Finding }): JSX.Element {
  const where = finding.bendId ?? finding.faceId;
  return (
    <li className={`finding ${finding.severity}`}>
      <div className="finding-head">
        <span className="severity">{finding.severity}</span>
        <code className="code">{finding.code}</code>
        {where !== undefined && <span className="where">{String(where)}</span>}
      </div>
      <div className="finding-message">{finding.message}</div>
      {finding.suggestion !== undefined && (
        <div className="finding-suggestion">{finding.suggestion}</div>
      )}
    </li>
  );
}
