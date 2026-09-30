/**
 * View models for the shared UI.
 *
 * These are deliberately *not* the desktop IPC types. The visualisation layer must not know
 * whether its data arrived over an Electron message port or from a browser filesystem handle,
 * which is what lets one treemap serve both surfaces. They are defined as structural subsets of
 * the desktop protocol's row types, so the desktop can pass its rows straight through without a
 * mapping layer, and the web app will be able to do the same.
 */

/** Synthetic id for the aggregated tail tile. Never a real node. */
export const OTHER_TILE_ID = -1;

export interface TreemapRow {
  readonly id: number;
  readonly name: string;
  /**
   * Bytes contained. Named to match the desktop protocol's row field exactly, so a page of rows
   * from the scan host is already a valid `TreemapRow[]` and needs no mapping layer between the
   * transport and the visualisation.
   */
  readonly totalSize: number;
  readonly directory: boolean;
  /** `NodeFlags` bitmask from @sv/core, used for partial and link markers. */
  readonly flags: number;
}

export interface BreadcrumbItem {
  readonly id: number;
  readonly label: string;
  readonly totalSize: number;
}

export interface VolumeCard {
  readonly id: string;
  readonly label: string;
  readonly rootPath: string;
  readonly totalBytes: number | null;
  readonly freeBytes: number | null;
  readonly usedBytes: number | null;
  readonly scannable: boolean;
  readonly note?: string;
}

export interface ScanProgressView {
  readonly filesDiscovered: number;
  readonly directoriesDiscovered: number;
  readonly directoriesPending: number;
  readonly bytesDiscovered: number;
  readonly currentPath: string;
  readonly elapsedMs: number;
  readonly estimatedFraction: number | null;
}
