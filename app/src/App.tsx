import { useCallback, useState } from 'react';
import type { BenchtopParams, ExportProfile } from '@metal-mate/core';
import {
  CUT_ONLY_EXPORT_PROFILE,
  DEFAULT_BENCHTOP,
  DEFAULT_EXPORT_PROFILE,
  benchtopPart,
  deserializeProject,
  exportDxf,
  serializeProject,
} from '@metal-mate/core';
import { FeatureTree } from './components/FeatureTree.js';
import { FlatPreview } from './components/FlatPreview.js';
import { TemplatePanel } from './components/TemplatePanel.js';
import { ValidationPanel } from './components/ValidationPanel.js';
import { Viewport3D } from './components/Viewport3D.js';
import { openTextFile, saveTextFile } from './platform/files.js';
import {
  MACHINES,
  MATERIALS,
  useBenchtopBuild,
  useBenchtopParams,
  useBooleanKernel,
} from './state/useBuild.js';

type View = '3d' | 'flat';

const EXPORT_PROFILES: readonly ExportProfile[] = [
  DEFAULT_EXPORT_PROFILE,
  CUT_ONLY_EXPORT_PROFILE,
];

export function App(): JSX.Element {
  const { params, replace } = useBenchtopParams(DEFAULT_BENCHTOP);
  const [machine] = useState(MACHINES[0]!);
  const [view, setView] = useState<View>('3d');
  const [foldFraction, setFoldFraction] = useState(1);
  const [showEdges, setShowEdges] = useState(true);
  const [exportProfileId, setExportProfileId] = useState(DEFAULT_EXPORT_PROFILE.id);
  const [status, setStatus] = useState<string | null>(null);

  const kernel = useBooleanKernel();
  const { result, error } = useBenchtopBuild(params, machine, foldFraction, kernel.ready);
  const report = result?.report ?? null;
  const canExport = result !== null && report !== null && report.exportAllowed;

  const onExportDxf = useCallback(async () => {
    if (result === null) return;
    const exportProfile = EXPORT_PROFILES.find((p) => p.id === exportProfileId) ?? DEFAULT_EXPORT_PROFILE;
    try {
      // `exportDxf` re-checks the validation report and throws if it is not
      // clean. The disabled button is a courtesy; this is the actual gate.
      const dxf = exportDxf(result, {
        exportProfile,
        dateStamp: new Date().toISOString().slice(0, 10),
      });
      const name = `${params.partId ?? params.name}.dxf`.replace(/\s+/g, '-');
      const written = await saveTextFile(name, dxf, [{ name: 'DXF', extensions: ['dxf'] }]);
      setStatus(written === null ? 'Export cancelled' : `Exported ${written}`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }, [result, exportProfileId, params]);

  const onSaveProject = useCallback(async () => {
    if (result === null) return;
    const text = serializeProject({ parts: [benchtopPart(params)] });
    const name = `${params.partId ?? params.name}.smp`.replace(/\s+/g, '-');
    const written = await saveTextFile(name, text, [{ name: 'Metal Mate project', extensions: ['smp'] }]);
    setStatus(written === null ? 'Save cancelled' : `Saved ${written}`);
  }, [result, params]);

  const onOpenProject = useCallback(async () => {
    const file = await openTextFile([{ name: 'Metal Mate project', extensions: ['smp', 'json'] }]);
    if (file === null) return;
    try {
      const doc = deserializeProject(file.contents);
      const first = doc.parts[0];
      if (first?.template?.kind !== 'benchtop') {
        setStatus('That project has no benchtop part; this build can only edit benchtops.');
        return;
      }
      replace(first.template.params as BenchtopParams);
      setStatus(`Opened ${file.name}`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }, [replace]);

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">
          <strong>Metal Mate</strong>
          <span className="muted">{machine.name.split('(')[0]!.trim()}</span>
        </div>
        <div className="toolbar-actions">
          <button type="button" onClick={() => void onOpenProject()}>
            Open
          </button>
          <button type="button" onClick={() => void onSaveProject()} disabled={result === null}>
            Save
          </button>
          <select
            aria-label="Export profile"
            value={exportProfileId}
            onChange={(e) => setExportProfileId(e.target.value)}
          >
            {EXPORT_PROFILES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="primary"
            data-testid="export-dxf"
            disabled={!canExport}
            title={
              canExport
                ? 'Write the flat pattern as DXF R12'
                : 'Fix the validation errors before exporting'
            }
            onClick={() => void onExportDxf()}
          >
            Export DXF
          </button>
        </div>
      </header>

      {status !== null && (
        <div className="status-bar" data-testid="status" onClick={() => setStatus(null)}>
          {status}
        </div>
      )}

      <main className="layout">
        <aside className="column left">
          <TemplatePanel params={params} materials={MATERIALS} onChange={replace} />
        </aside>

        <section className="column centre">
          <div className="view-tabs">
            <button
              type="button"
              className={view === '3d' ? 'active' : ''}
              onClick={() => setView('3d')}
            >
              3D
            </button>
            <button
              type="button"
              className={view === 'flat' ? 'active' : ''}
              onClick={() => setView('flat')}
            >
              Flat pattern
            </button>
            {view === '3d' && (
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={showEdges}
                  onChange={(e) => setShowEdges(e.target.checked)}
                />
                Edges
              </label>
            )}
          </div>

          <div className="view-body">
            {kernel.error !== null && <div className="kernel-error">{kernel.error}</div>}
            {!kernel.ready && kernel.error === null && (
              <div className="loading" data-testid="loading">
                Loading geometry kernel…
              </div>
            )}
            {kernel.ready && view === '3d' && (
              <Viewport3D
                graph={result?.graph ?? null}
                folded={result?.folded ?? null}
                showEdges={showEdges}
              />
            )}
            {kernel.ready && view === 'flat' && <FlatPreview flat={result?.flat ?? null} showBendLines />}
          </div>

          {view === '3d' && (
            <div className="fold-slider">
              <label>
                Fold
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={foldFraction}
                  data-testid="fold-slider"
                  onChange={(e) => setFoldFraction(Number(e.target.value))}
                />
              </label>
              <span className="muted">{Math.round(foldFraction * 100)}%</span>
              <button type="button" className="link" onClick={() => setFoldFraction(0)}>
                flat
              </button>
              <button type="button" className="link" onClick={() => setFoldFraction(1)}>
                folded
              </button>
            </div>
          )}
        </section>

        <aside className="column right">
          <ValidationPanel report={report} machine={machine} buildError={error} />
          <FeatureTree result={result} />
        </aside>
      </main>
    </div>
  );
}
