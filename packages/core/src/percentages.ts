import { NO_NODE, ROOT_ID, type NodeId } from './model.ts';
import type { NodeTable } from './node-table.ts';

/**
 * The same directory is a different percentage depending on what you divide by, and
 * conflating those framings is one of the easiest ways for a storage tool to mislead.
 * All four are computed here so the UI can label each one explicitly.
 *
 * Values are fractions in [0, 1], not percentages: converting once at the formatting
 * boundary avoids the "is this 0.38 or 38?" ambiguity spreading through the codebase.
 */
export interface PercentageBreakdown {
  /** Share of the immediate parent directory. */
  readonly ofParent: number;
  /** Share of the directory currently being viewed, which may be an ancestor. */
  readonly ofCurrentView: number;
  /** Share of everything the scan covered. */
  readonly ofScanRoot: number;
  /** Share of the whole volume, or null when capacity is unknown. */
  readonly ofVolumeCapacity: number | null;
}

export interface PercentageContext {
  /** Directory the user is looking inside. Defaults to the scan root. */
  readonly viewId?: NodeId;
  /** Total capacity of the underlying volume in bytes, when known. */
  readonly volumeCapacityBytes?: number | null;
}

/**
 * Safe division for size ratios.
 * An empty or unscanned denominator yields 0 rather than NaN or Infinity, because those
 * leak into layout arithmetic and produce invisible or infinitely large treemap tiles.
 */
export function fractionOf(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return part / whole;
}

export function percentagesFor(
  table: NodeTable,
  id: NodeId,
  context: PercentageContext = {},
): PercentageBreakdown {
  const size = table.totalSizeOf(id);
  const parent = table.parentOf(id);
  const viewId = context.viewId ?? ROOT_ID;
  const capacity = context.volumeCapacityBytes ?? null;

  return {
    // The root is the whole of itself; reporting 0 here would read as "this directory
    // accounts for nothing", which is the opposite of the truth.
    ofParent: parent === NO_NODE ? 1 : fractionOf(size, table.totalSizeOf(parent)),
    ofCurrentView: id === viewId ? 1 : fractionOf(size, table.totalSizeOf(viewId)),
    ofScanRoot: id === ROOT_ID ? 1 : fractionOf(size, table.totalSizeOf(ROOT_ID)),
    ofVolumeCapacity: capacity === null ? null : fractionOf(size, capacity),
  };
}
