import { useCallback, useEffect, useState } from 'react';
import type { BenchtopParams, CanopyParams, ExportProfile, Part } from '@metal-mate/core';
import {
  CUT_ONLY_EXPORT_PROFILE,
  DEFAULT_EXPORT_PROFILE,
  deserializeProject,
  exportDocumentDxf,
  exportDxf,
  serializeProject,
} from '@metal-mate/core';
import { FeatureTree } from './components/FeatureTree.js';
import { CanopyPanel } from './components/CanopyPanel.js';
import { PartsPanel } from './components/PartsPanel.js';
import { SettingsDialog } from './components/SettingsDialog.js';
import { FlatPreview } from './components/FlatPreview.js';
import { TemplatePanel } from './components/TemplatePanel.js';
import { ValidationPanel } from './components/ValidationPanel.js';
import { Viewport3D } from './components/Viewport3D.js';
import { openTextFile, saveTextFile } from './platform/files.js';
import { useBooleanKernel } from './state/useBuild.js';
import {
  type DesignRow,
  benchtopRow,
  canopyRow,
  expandRow,
  useDocument,
  useDocumentBuild,
} from './state/useDocument.js';
import {
  type Settings,
  adoptProjectSettings,
  embedSettings,
  loadSettings,
  saveSettings,
} from './state/settings.js';

type View = '3d' | 'flat';

const EXPORT_PROFILES: readonly ExportProfile[] = [
  DEFAULT_EXPORT_PROFILE,
  CUT_ONLY_EXPORT_PROFILE,
];

export function App(): JSX.Element {
  const doc = useDocument();
  // The press brake and the bend tables belong to the shop, not to a part, so
  // they outlive any one project.
  const store = typeof localStorage === 'undefined' ? undefined : localStorage;
  const [settings, setSettings] = useState<Settings>(() => loadSettings(store));
  const [showSettings, setShowSettings] = useState(false);
  useEffect(() => saveSettings(store, settings), [store, settings]);
  const machine = settings.machine;
  const [view, setView] = useState<View>('3d');
  const [foldFraction, setFoldFraction] = useState(1);
  const [showEdges, setShowEdges] = useState(true);
  const [exportProfileId, setExportProfileId] = useState(DEFAULT_EXPORT_PROFILE.id);
  const [status, setStatus] = useState<string | null>(null);

  const kernel = useBooleanKernel();
  const built = useDocumentBuild(
    doc.state.rows,
    doc.state.activeUid,
    doc.state.activePartUid,
    machine,
    settings.materials,
    foldFraction,
    kernel.ready,
  );
  const { document, expanded, active, buildByUid, scene, error } = built;
  const result = active !== null && active.ok ? active.result : null;
  const report = result?.report ?? null;
  const canExport = result !== null && report !== null && report.exportAllowed;
  const canExportAll = document !== null && document.exportAllowed;

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
      const p = result.part.parameters;
      const name = `${p.partId ?? p.name}.dxf`.replace(/\s+/g, '-');
      const written = await saveTextFile(name, dxf, [{ name: 'DXF', extensions: ['dxf'] }]);
      setStatus(written === null ? 'Export cancelled' : `Exported ${written}`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }, [result, exportProfileId]);

  /**
   * One DXF per part.
   *
   * `exportDocumentDxf` is all or nothing: if any part is blocked it writes
   * none of them, because half an assembly reaching the laser is worse than
   * none of it. Each file then goes through the ordinary save dialog, so this
   * is one prompt per part rather than a folder picker.
   */
  const onExportAll = useCallback(async () => {
    if (document === null) return;
    const exportProfile = EXPORT_PROFILES.find((p) => p.id === exportProfileId) ?? DEFAULT_EXPORT_PROFILE;
    try {
      const files = exportDocumentDxf(document, {
        exportProfile,
        dateStamp: new Date().toISOString().slice(0, 10),
      });
      let written = 0;
      for (const file of files) {
        const path = await saveTextFile(file.fileName, file.dxf, [
          { name: 'DXF', extensions: ['dxf'] },
        ]);
        if (path === null) break;
        written += 1;
      }
      setStatus(
        written === files.length
          ? `Exported ${written} part${written === 1 ? '' : 's'}`
          : `Exported ${written} of ${files.length}; the rest were cancelled`,
      );
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }, [document, exportProfileId]);

  const onSaveProject = useCallback(async () => {
    if (result === null) return;
    // Every part in the document, plus the machine and any calibrated bend
    // tables, so it opens on the other computer checked against what it was
    // designed for.
    const parts = doc.state.rows.flatMap((r) =>
      expandRow(r).parts.flatMap((p) => (p.part === null ? [] : [p.part])),
    );
    const text = serializeProject({ parts, ...embedSettings(settings) });
    const name = `${doc.active.params.name}.smp`.replace(/\s+/g, '-');
    const written = await saveTextFile(name, text, [{ name: 'Metal Mate project', extensions: ['smp'] }]);
    setStatus(written === null ? 'Save cancelled' : `Saved ${written}`);
  }, [result, settings, doc.state.rows, doc.active]);

  const onOpenProject = useCallback(async () => {
    const file = await openTextFile([{ name: 'Metal Mate project', extensions: ['smp', 'json'] }]);
    if (file === null) return;
    try {
      const opened = deserializeProject(file.contents);
      // Refusing beats loading what we can: saving afterwards would write the
      // document back without the parts this build could not read.
      const rows = rowsFromParts(opened.parts);
      if (rows === null) {
        setStatus(
          'That project has parts this build cannot edit, so opening it would lose them. This build knows benchtops and canopies.',
        );
        return;
      }
      const adopted = adoptProjectSettings(settings, opened);
      setSettings(adopted.settings);
      doc.replaceAll(rows);
      setStatus([`Opened ${file.name}`, ...adopted.notes].join(' — '));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }, [doc, settings]);

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">
          <strong>Metal Mate</strong>
          <span className="muted">{machine.name}</span>
        </div>
        <div className="toolbar-actions">
          <button type="button" onClick={() => void onOpenProject()}>
            Open
          </button>
          <button type="button" data-testid="open-settings" onClick={() => setShowSettings(true)}>
            Settings
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
            data-testid="export-all"
            disabled={!canExportAll || doc.state.rows.length < 2}
            title={
              canExportAll
                ? 'Write one DXF for every part in the document'
                : 'Every part has to pass validation before any of them export'
            }
            onClick={() => void onExportAll()}
          >
            Export all
          </button>
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

      {showSettings && (
        <SettingsDialog
          settings={settings}
          onChange={setSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {status !== null && (
        <div className="status-bar" data-testid="status" onClick={() => setStatus(null)}>
          {status}
        </div>
      )}

      <main className="layout">
        <aside className="column left">
          <PartsPanel
            expanded={expanded}
            activeUid={doc.state.activeUid}
            activePartUid={active !== null && active.ok ? doc.state.activePartUid : ''}
            document={document}
            buildByUid={buildByUid}
            onSelectRow={doc.setActiveRow}
            onSelectPart={doc.setActivePart}
            onAdd={doc.add}
            onDuplicate={doc.duplicate}
            onRemove={doc.remove}
          />
          {/* One wizard per template kind. The document holds the parameters
              either way, so switching designs swaps the form and nothing else. */}
          {doc.active.kind === 'benchtop' ? (
            <TemplatePanel
              params={doc.active.params}
              materials={settings.materials}
              onChange={doc.updateActive}
            />
          ) : (
            <CanopyPanel
              params={doc.active.params}
              materials={settings.materials}
              onChange={doc.updateActive}
            />
          )}
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
              <Viewport3D scene={scene} showEdges={showEdges} />
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

/**
 * Rebuild the design list from a project's parts.
 *
 * A canopy writes six parts that all carry the same template record, so its
 * panels have to be gathered back into one design rather than six. Parts are
 * grouped by template kind and parameters; anything this build does not know
 * how to edit returns null, because loading what we can and saving afterwards
 * would write the document back without the rest.
 */
function rowsFromParts(parts: readonly Part[]): DesignRow[] | null {
  if (parts.length === 0) return null;
  const rows: DesignRow[] = [];
  const seen = new Map<string, true>();
  for (const part of parts) {
    const template = part.template;
    if (template === undefined) return null;
    if (template.kind === 'benchtop') {
      rows.push(benchtopRow(template.params as BenchtopParams));
      continue;
    }
    if (template.kind === 'canopy') {
      const key = JSON.stringify(template.params);
      if (seen.has(key)) continue;
      seen.set(key, true);
      rows.push(canopyRow(template.params as CanopyParams));
      continue;
    }
    return null;
  }
  return rows;
}
