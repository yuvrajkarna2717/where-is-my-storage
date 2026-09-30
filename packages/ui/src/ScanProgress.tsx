import { formatBytes, formatCount, formatPercent } from '@sv/core';
import type { ScanProgressView } from './types.ts';

export interface ScanProgressPanelProps {
  readonly progress: ScanProgressView;
  readonly onCancel?: () => void;
}

/**
 * Live scan progress.
 *
 * Deliberately **not** an ARIA live region. These numbers change ten times a second, and announcing
 * them would make the application unusable with a screen reader. The completion summary is
 * announced instead, which is the part that carries news.
 *
 * The percentage appears only when there is an honest denominator for it — scanning a whole volume,
 * where bytes-seen against bytes-in-use is a real ratio. For a folder scan there is no way to know
 * the total in advance, so no bar is shown rather than an invented one.
 */
export function ScanProgressPanel(props: ScanProgressPanelProps): React.JSX.Element {
  const { progress } = props;
  const fraction = progress.estimatedFraction;
  const rate =
    progress.elapsedMs > 500 ? (progress.bytesDiscovered / progress.elapsedMs) * 1000 : null;

  return (
    <div className="scan-progress">
      <div className="scan-progress__headline">
        <strong>{formatBytes(progress.bytesDiscovered)}</strong> in{' '}
        {formatCount(progress.filesDiscovered)} files and{' '}
        {formatCount(progress.directoriesDiscovered)} folders
        {fraction !== null && <> · {formatPercent(fraction)}</>}
      </div>

      {fraction !== null && (
        <div
          className="scan-progress__bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(fraction * 100)}
          aria-label="Scan progress"
        >
          <div
            className="scan-progress__bar-fill"
            style={{ width: `${String(Math.round(fraction * 100))}%` }}
          />
        </div>
      )}

      <div className="scan-progress__meta">
        {formatCount(progress.directoriesPending)} folders queued
        {rate !== null && <> · {formatBytes(rate)}/s</>}
      </div>

      {/* Right-to-left so the filename stays visible when a path is longer than the panel. */}
      <div className="scan-progress__path" title={progress.currentPath}>
        {progress.currentPath}
      </div>

      {props.onCancel !== undefined && (
        <button type="button" onClick={props.onCancel}>
          Cancel scan
        </button>
      )}
    </div>
  );
}
