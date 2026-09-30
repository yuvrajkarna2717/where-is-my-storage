import { formatBytes, formatPercent, fractionOf } from '@sv/core';
import type { VolumeCard } from './types.ts';

export interface VolumePickerProps {
  readonly volumes: readonly VolumeCard[];
  readonly onScan: (volume: VolumeCard) => void;
  readonly disabled?: boolean;
  readonly emptyMessage?: string;
}

/**
 * The drives a person can analyse, with how full each one is.
 *
 * This is the first thing shown, before any scan, because "how full is my disk" is answerable
 * instantly from the filesystem's own figures and is half of what the user came to find out. It
 * also means the application never opens on an empty screen waiting to be told what to do.
 */
export function VolumePicker(props: VolumePickerProps): React.JSX.Element {
  if (props.volumes.length === 0) {
    return <p className="muted">{props.emptyMessage ?? 'Looking for drives…'}</p>;
  }

  return (
    <ul className="volumes">
      {props.volumes.map((volume) => {
        const capacity = volume.totalBytes ?? 0;
        const used = volume.usedBytes ?? 0;
        const usedFraction = fractionOf(used, capacity);

        return (
          <li key={volume.id}>
            <button
              type="button"
              className="volume"
              disabled={props.disabled === true || !volume.scannable}
              onClick={() => {
                props.onScan(volume);
              }}
            >
              <span className="volume__label">{volume.label}</span>

              {capacity > 0 ? (
                <>
                  {/* The bar is decorative; the sentence below it carries the same information in
                      text, so there is nothing for a screen reader to miss. */}
                  <span className="volume__bar" aria-hidden="true">
                    <span
                      className="volume__bar-fill"
                      style={{ width: `${String(Math.round(usedFraction * 100))}%` }}
                    />
                  </span>
                  <span className="volume__detail">
                    {formatBytes(used)} used of {formatBytes(capacity)} ·{' '}
                    {formatPercent(usedFraction)} full
                  </span>
                  <span className="volume__detail">{formatBytes(volume.freeBytes ?? 0)} free</span>
                </>
              ) : (
                <span className="volume__detail">Capacity unknown</span>
              )}

              {!volume.scannable && volume.note !== undefined && (
                <span className="volume__detail volume__detail--warning">{volume.note}</span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
