import { formatBytes, formatCount } from '@sv/core';
import { Breadcrumbs, ScanProgressPanel, Treemap, VolumePicker } from '@sv/ui';
import { useCallback, useEffect, useMemo } from 'react';
import { useScanView } from './useScanView.ts';

/**
 * The desktop application.
 *
 * Every visual piece comes from @sv/ui, which knows nothing about Electron; this file's only job is
 * to translate between the IPC protocol and those components, and to arrange them. That is what
 * makes the browser application in Task 18 a matter of supplying a different data source rather
 * than a second implementation of the same screens.
 */
export function App(): React.JSX.Element {
  const view = useScanView();
  const { node, rows, status } = view;

  const trail = useMemo(
    () =>
      (node?.ancestors ?? []).map((entry) => ({
        id: entry.id,
        label: entry.name,
        totalSize: entry.totalSize,
      })),
    [node?.ancestors],
  );

  // Backspace and Escape go up a level, which is what every file manager does and what a person
  // tries first after clicking into the wrong folder.
  const handleKeyDown = useCallback(
    (event: KeyboardEvent): void => {
      if (event.key !== 'Backspace' && event.key !== 'Escape') return;
      const target = event.target as HTMLElement | null;
      // Never steal Backspace from a text field.
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
      if (!view.canGoUp) return;
      event.preventDefault();
      view.goUp();
    },
    [view],
  );

  useEffect(() => {
    globalThis.addEventListener('keydown', handleKeyDown);
    return () => {
      globalThis.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);

  const statistics = status?.statistics ?? null;
  const hasScan = node !== null && rows.length > 0;

  return (
    <div className="app">
      <header className="masthead">
        <div>
          <h1>Storage Visualizer</h1>
          <p className="privacy">
            Your storage stays on your computer. Nothing about your files is uploaded.
          </p>
        </div>
        <div className="masthead__actions">
          <button type="button" onClick={() => void view.chooseFolder()} disabled={view.busy}>
            Choose a folder…
          </button>
        </div>
      </header>

      {view.error !== null && (
        <div className="notice notice--error" role="alert">
          <span>{view.error}</span>
          <button type="button" onClick={view.dismissError}>
            Dismiss
          </button>
        </div>
      )}

      {!view.scanning && !hasScan && (
        <section className="panel">
          <h2>Drives</h2>
          <VolumePicker
            volumes={view.volumes}
            disabled={view.busy || view.scanning}
            onScan={(volume) => void view.startScan(volume.rootPath)}
          />
        </section>
      )}

      {view.scanning && view.progress !== null && (
        <section className="panel">
          <h2>Scanning</h2>
          <ScanProgressPanel progress={view.progress} onCancel={() => void view.cancelScan()} />
        </section>
      )}

      {node !== null && (
        <section className="panel panel--map">
          <div className="map-header">
            <Breadcrumbs trail={trail} onNavigate={view.open} />
            <div className="map-header__summary">
              {formatBytes(node.node.totalSize)}
              {node.node.directory && (
                <>
                  {' · '}
                  {formatCount(node.node.fileCount)} files
                  {' · '}
                  {formatCount(node.node.directoryCount)} folders
                </>
              )}
            </div>
          </div>

          <div className="map-surface">
            <Treemap
              rows={rows}
              selectedId={view.selectedId}
              onSelect={(row) => {
                view.select(row?.id ?? null);
              }}
              onOpen={(row) => {
                view.open(row.id);
              }}
              label={`Contents of ${node.node.name}`}
              emptyMessage={
                node.node.directory && !node.node.listed
                  ? 'Still reading this folder…'
                  : 'This folder holds nothing that takes up space'
              }
            />
          </div>

          {statistics !== null && !view.scanning && (
            <p className="muted map-footer">
              {status?.phase === 'cancelled' ? 'Cancelled after ' : 'Scanned in '}
              {(statistics.durationMs / 1000).toFixed(1)}s ·{' '}
              {formatCount(statistics.filesDiscovered)} files ·{' '}
              {formatCount(statistics.entriesSkipped)} skipped
              {statistics.partial && ' · some totals are a lower bound'}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
