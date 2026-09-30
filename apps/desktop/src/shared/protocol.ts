/**
 * The complete contract between the renderer and everything behind it.
 *
 * This file is the only thing the renderer, the main process and the scan host all agree
 * on, and it is deliberately the narrowest surface that supports the product. Two rules
 * hold it in shape:
 *
 * 1. **The renderer never handles a filesystem path as a capability.** It may *display*
 *    paths, but every command that acts refers to a node by id. A compromised renderer
 *    therefore cannot ask for an arbitrary path to be read or revealed; it can only name
 *    something the scan already found. `startScan` is the single exception, and it exists
 *    only so the user's own directory-picker choice can be forwarded.
 * 2. **Types only, no runtime code.** It compiles under both the Node and DOM type-check
 *    programs, so it cannot accidentally depend on either platform, and importing it adds
 *    nothing to the renderer bundle.
 */
import type { ScanIssue, ScanIssueCounts, ScanStatus } from '@sv/scan-engine';

/** Channel the renderer invokes. One channel, discriminated by command name. */
export const COMMAND_CHANNEL = 'sv:command';

/** Channel the main process pushes events down. */
export const EVENT_CHANNEL = 'sv:event';

/**
 * Every command the renderer may issue. Anything not on this list is rejected before it is
 * looked at, so adding a capability is a deliberate edit here rather than an accident
 * somewhere in a handler.
 */
export const COMMANDS = [
  'listVolumes',
  'pickDirectory',
  'startScan',
  'cancelScan',
  'queryStatus',
  'queryNode',
  'queryChildren',
] as const;

export type CommandName = (typeof COMMANDS)[number];

export const CHILD_SORT_KEYS = ['size', 'name', 'files', 'modified'] as const;
export type ChildSortKey = (typeof CHILD_SORT_KEYS)[number];

export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

/** Hard cap on rows per page, enforced during validation, not merely documented. */
export const MAX_CHILDREN_PAGE_SIZE = 500;

/** Longest path the renderer may hand back from the directory picker. */
export const MAX_PATH_LENGTH = 4096;

// ----------------------------------------------------------------------------- payloads

export interface EmptyPayload {
  readonly [key: string]: never;
}

export interface StartScanPayload {
  readonly path: string;
}

export interface CancelScanPayload {
  readonly scanId: string;
}

export interface QueryNodePayload {
  readonly nodeId: number;
}

export interface QueryChildrenPayload {
  readonly nodeId: number;
  readonly sort: ChildSortKey;
  readonly order: SortOrder;
  readonly offset: number;
  readonly limit: number;
}

export interface CommandPayloads {
  readonly listVolumes: EmptyPayload;
  readonly pickDirectory: EmptyPayload;
  readonly startScan: StartScanPayload;
  readonly cancelScan: CancelScanPayload;
  readonly queryStatus: EmptyPayload;
  readonly queryNode: QueryNodePayload;
  readonly queryChildren: QueryChildrenPayload;
}

// ------------------------------------------------------------------------------ results

export interface VolumeSummary {
  readonly id: string;
  readonly label: string;
  readonly rootPath: string;
  readonly kind: 'fixed' | 'removable' | 'network' | 'virtual' | 'unknown';
  readonly totalBytes: number | null;
  readonly freeBytes: number | null;
  readonly usedBytes: number | null;
  readonly scannable: boolean;
  readonly note?: string;
}

export interface RootSummary {
  readonly path: string;
  readonly separator: '/' | '\\';
  readonly kind: 'volume' | 'directory';
  readonly totalBytes: number | null;
  readonly freeBytes: number | null;
  readonly usedBytes: number | null;
}

/**
 * One row of a directory listing.
 *
 * Note what is absent: the path. A row carries only what is needed to draw it, which keeps
 * a page of 500 rows to a few tens of kilobytes even for deeply nested trees where paths
 * would dominate the payload.
 */
export interface NodeRow {
  readonly id: number;
  readonly name: string;
  readonly directory: boolean;
  /** False for a directory that has not been read yet, which is not the same as empty. */
  readonly listed: boolean;
  readonly totalSize: number;
  readonly directSize: number;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly flags: number;
}

export interface BreadcrumbEntry {
  readonly id: number;
  readonly name: string;
  readonly totalSize: number;
}

export interface NodeDetail extends NodeRow {
  /** For display only. Commands always address nodes by id. */
  readonly path: string;
  readonly depth: number;
  readonly parentId: number | null;
  readonly modifiedMs: number | null;
  readonly childCount: number;
}

export interface ScanProgressEvent {
  readonly scanId: string;
  readonly filesDiscovered: number;
  readonly directoriesDiscovered: number;
  readonly directoriesListed: number;
  readonly directoriesPending: number;
  readonly bytesDiscovered: number;
  readonly currentPath: string;
  readonly elapsedMs: number;
  readonly estimatedFraction: number | null;
  readonly issuesRecorded: number;
}

export interface ScanStatisticsSummary {
  readonly status: ScanStatus;
  readonly durationMs: number;
  readonly filesDiscovered: number;
  readonly directoriesDiscovered: number;
  readonly directoriesListed: number;
  readonly entriesSkipped: number;
  readonly totalSize: number;
  readonly partial: boolean;
  readonly issueCounts: ScanIssueCounts;
  readonly issueSamples: readonly ScanIssue[];
}

export type ScanPhase = 'idle' | 'scanning' | 'completed' | 'cancelled' | 'failed';

export interface StatusSnapshot {
  readonly phase: ScanPhase;
  readonly scanId: string | null;
  readonly root: RootSummary | null;
  readonly progress: ScanProgressEvent | null;
  readonly statistics: ScanStatisticsSummary | null;
  readonly error: string | null;
  /** Milliseconds since the scan finished, so the UI can say "scanned 2 hours ago". */
  readonly finishedAgoMs: number | null;
}

export interface ChildrenPage {
  readonly nodeId: number;
  readonly offset: number;
  /** Total children available, so the UI can size a scrollbar without fetching them. */
  readonly total: number;
  readonly rows: readonly NodeRow[];
}

export interface NodeDetailResult {
  readonly node: NodeDetail;
  /** Root first, the node itself last: exactly a breadcrumb trail. */
  readonly ancestors: readonly BreadcrumbEntry[];
}

export interface CommandResults {
  readonly listVolumes: { readonly volumes: readonly VolumeSummary[] };
  readonly pickDirectory: { readonly path: string | null };
  readonly startScan: { readonly scanId: string; readonly root: RootSummary };
  readonly cancelScan: { readonly cancelled: boolean };
  readonly queryStatus: StatusSnapshot;
  readonly queryNode: NodeDetailResult | null;
  readonly queryChildren: ChildrenPage;
}

// ------------------------------------------------------------------------------- events

export interface ScanFinishedEvent {
  readonly scanId: string;
  readonly phase: Extract<ScanPhase, 'completed' | 'cancelled' | 'failed'>;
  readonly statistics: ScanStatisticsSummary | null;
  readonly error: string | null;
}

export type DesktopEvent =
  | { readonly type: 'scanProgress'; readonly payload: ScanProgressEvent }
  | { readonly type: 'scanFinished'; readonly payload: ScanFinishedEvent };

export type DesktopEventType = DesktopEvent['type'];

// ------------------------------------------------------------- envelopes and error shape

/**
 * A validated request.
 *
 * Written as a distributive mapped type rather than `{ command: CommandName; payload: ... }`
 * so it is a genuine discriminated union: switching on `command` narrows `payload` to that
 * command's shape. The naive form would make every payload the union of all payloads, and
 * the dispatcher would need casts to do its job — exactly where a cast is most dangerous.
 */
export type CommandRequest = {
  [K in CommandName]: { readonly command: K; readonly payload: CommandPayloads[K] };
}[CommandName];

/**
 * Failures cross the boundary as data, never as a thrown Electron-serialised error.
 *
 * A rejected `ipcMain.handle` leaks the main process stack into the renderer, which is both
 * an information disclosure and useless to the user. The renderer gets a code it can branch
 * on and a message it can show.
 */
export type CommandResponse<K extends CommandName = CommandName> =
  | { readonly ok: true; readonly value: CommandResults[K] }
  | { readonly ok: false; readonly code: CommandErrorCode; readonly message: string };

export const COMMAND_ERROR_CODES = [
  'invalidRequest',
  'unknownCommand',
  'notReady',
  'noActiveScan',
  'scanFailed',
  'internal',
] as const;

export type CommandErrorCode = (typeof COMMAND_ERROR_CODES)[number];

/** The surface `contextBridge` exposes on `window`. Nothing else is reachable. */
export interface DesktopBridge {
  invoke<K extends CommandName>(
    command: K,
    payload: CommandPayloads[K],
  ): Promise<CommandResponse<K>>;
  /** Returns an unsubscribe function; the renderer must not be able to leak listeners. */
  subscribe(listener: (event: DesktopEvent) => void): () => void;
}
