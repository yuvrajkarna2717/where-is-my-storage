import { NodeFlags, NodeTable, ROOT_ID, hasFlag, joinPath, type NodeId } from '@sv/core';
import { NEVER_CANCELLED, type CancellationSignal } from './cancellation.ts';
import { FileSystemAccessError, IssueLog, type ScanIssue, type ScanIssueCounts } from './issues.ts';
import type { FileSystemProvider, ListDirectoryResult, ScanRootInfo } from './provider.ts';

/** Directory listings in flight at once. Bounded on purpose, never unbounded. */
export const DEFAULT_CONCURRENCY = 8;

/** Roughly 10 Hz. Fast enough to feel live, slow enough not to flood the UI. */
export const DEFAULT_PROGRESS_INTERVAL_MS = 100;

/**
 * Depth guard. Links are never followed so a true cycle cannot form, but network and
 * FUSE mounts have been known to present effectively infinite trees, and an unbounded
 * walk on one of those is indistinguishable from a hang.
 */
export const DEFAULT_MAX_DEPTH = 4096;

/** The name column addresses 65 535 bytes, and WTF-8 costs at most 3 bytes per unit. */
const MAX_STORABLE_NAME_LENGTH = 21_845;

export interface ScanProgress {
  readonly filesDiscovered: number;
  readonly directoriesDiscovered: number;
  /** Directories whose listing has completed, which is what "progress" really tracks. */
  readonly directoriesListed: number;
  readonly directoriesPending: number;
  readonly bytesDiscovered: number;
  readonly currentPath: string;
  readonly elapsedMs: number;
  /**
   * Fraction in [0, 1], or null when no honest estimate exists.
   *
   * Derived from bytes seen against bytes known to be in use on the volume, which rises
   * monotonically. The obvious alternative — listed directories over discovered
   * directories — goes *backwards* every time a big folder is opened, and a progress bar
   * that retreats is worse than no progress bar.
   */
  readonly estimatedFraction: number | null;
  readonly issuesRecorded: number;
}

export type ScanStatus = 'completed' | 'cancelled';

export interface ScanStatistics {
  readonly status: ScanStatus;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
  readonly filesDiscovered: number;
  readonly directoriesDiscovered: number;
  readonly directoriesListed: number;
  /** Entries that were found but could not be measured or descended into. */
  readonly entriesSkipped: number;
  readonly totalSize: number;
  /** True when any total in the tree is a lower bound rather than the truth. */
  readonly partial: boolean;
  readonly issueCounts: ScanIssueCounts;
  readonly issueSamples: readonly ScanIssue[];
}

export interface ScanResult {
  readonly table: NodeTable;
  readonly root: ScanRootInfo;
  readonly statistics: ScanStatistics;
}

export interface ScanOptions {
  readonly rootPath: string;
  readonly provider: FileSystemProvider;
  readonly signal?: CancellationSignal;
  /**
   * Called once, as soon as the storage model exists and before traversal starts.
   *
   * Progressive results are impossible without this: the table is the live aggregate, and
   * waiting for the returned promise means waiting for the whole scan. The Electron scan
   * host uses it for the same reason, so it can answer queries while a scan is running.
   *
   * Reading the table concurrently is safe. Each listing is folded in by one synchronous
   * block, so no other JavaScript — progress callback, IPC handler, timer — can observe a
   * half-applied directory.
   */
  readonly onTableReady?: (table: NodeTable) => void;
  readonly onProgress?: (progress: ScanProgress) => void;
  readonly progressIntervalMs?: number;
  readonly concurrency?: number;
  readonly maxDepth?: number;
  readonly issueSamplesPerCode?: number;
  readonly initialCapacity?: number;
  readonly trackAllocatedSize?: boolean;
  /** Denominator for progress estimation; defaults to the volume's used bytes. */
  readonly expectedTotalBytes?: number | null;
}

function detailOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

/**
 * Walks a filesystem through a provider and aggregates it into a `NodeTable`.
 *
 * Three properties matter more than speed here.
 *
 * **It cannot blow the stack.** Traversal uses an explicit frontier, not recursion, so a
 * ten-thousand-level directory chain is just a longer loop.
 *
 * **It cannot be derailed by one bad entry.** Every failure is classified, counted and
 * attributed to a path, and the affected subtree is flagged so its totals read as a lower
 * bound. A locked system folder degrades the answer; it does not end the scan.
 *
 * **It yields useful numbers immediately.** The first listing reveals the whole top level,
 * and aggregates rise monotonically from there, so the UI never has to wait for a
 * complete walk before showing something true.
 *
 * The frontier is last-in-first-out, which is depth-first. That is deliberate: it keeps
 * the frontier proportional to depth rather than to the widest level of the tree, and it
 * reads directories that are physically near each other close together in time, which
 * matters a great deal on a spinning disk.
 */
export async function scan(options: ScanOptions): Promise<ScanResult> {
  const provider = options.provider;
  const signal = options.signal ?? NEVER_CANCELLED;
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? DEFAULT_CONCURRENCY));
  const progressIntervalMs = Math.max(
    0,
    options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS,
  );
  const maxDepth = Math.max(1, Math.trunc(options.maxDepth ?? DEFAULT_MAX_DEPTH));
  const issues = new IssueLog(options.issueSamplesPerCode);

  const root = await provider.describeRoot(options.rootPath);

  const table = new NodeTable({
    rootPath: root.path,
    separator: root.separator,
    ...(options.initialCapacity === undefined ? {} : { initialCapacity: options.initialCapacity }),
    ...(options.trackAllocatedSize === undefined
      ? {}
      : { trackAllocatedSize: options.trackAllocatedSize }),
  });

  options.onTableReady?.(table);

  const estimateDenominator =
    options.expectedTotalBytes ?? (root.kind === 'volume' ? root.usedBytes : null);

  // Parallel arrays rather than an array of objects: one fewer allocation per directory,
  // and the frontier is the one structure that grows with the tree.
  const frontierIds: NodeId[] = [ROOT_ID];
  const frontierPaths: string[] = [root.path];

  const active = new Set<Promise<void>>();
  const startedAt = Date.now();

  let directoriesListed = 0;
  let entriesSkipped = 0;
  let currentPath = root.path;
  let lastProgressAt = 0;
  let cancelled = false;

  const snapshot = (): ScanProgress => {
    const bytesDiscovered = table.totalSizeOf(ROOT_ID);
    return {
      filesDiscovered: table.fileCountOf(ROOT_ID),
      directoriesDiscovered: table.directoryCountOf(ROOT_ID),
      directoriesListed,
      directoriesPending: frontierIds.length + active.size,
      bytesDiscovered,
      currentPath,
      elapsedMs: Date.now() - startedAt,
      estimatedFraction:
        estimateDenominator !== null && estimateDenominator > 0
          ? Math.min(1, bytesDiscovered / estimateDenominator)
          : null,
      issuesRecorded: issues.total,
    };
  };

  const emitProgress = (force: boolean): void => {
    const callback = options.onProgress;
    if (callback === undefined) return;
    const now = Date.now();
    if (!force && now - lastProgressAt < progressIntervalMs) return;
    lastProgressAt = now;
    callback(snapshot());
  };

  const applyListing = (id: NodeId, path: string, listing: ListDirectoryResult): void => {
    const depth = table.depthOf(id);
    const descendIds: NodeId[] = [];
    const descendPaths: string[] = [];
    const unreadableChildren: NodeId[] = [];

    table.beginChildren(id);
    try {
      for (const entry of listing.entries) {
        if (entry.name.length > MAX_STORABLE_NAME_LENGTH) {
          issues.record({
            code: 'invalidName',
            path,
            detail: `entry name of ${entry.name.length} characters cannot be stored`,
          });
          entriesSkipped += 1;
          continue;
        }

        const flags = entry.flags | (entry.directory ? NodeFlags.Directory : 0);
        const childId = table.pushChild(entry.name, flags, entry.size, entry.mtimeMs);

        if (!entry.directory) continue;

        if (hasFlag(flags, NodeFlags.AccessDenied)) {
          unreadableChildren.push(childId);
          continue;
        }
        // Symlinks and reparse points are recorded but never followed, which is what makes
        // cycles structurally impossible rather than something to detect and recover from.
        if (hasFlag(flags, NodeFlags.Symlink) || hasFlag(flags, NodeFlags.Reparse)) continue;

        if (depth + 1 >= maxDepth) {
          issues.record({
            code: 'tooDeep',
            path: joinPath(path, entry.name, root.separator),
            detail: `deeper than the ${maxDepth} level guard`,
          });
          entriesSkipped += 1;
          continue;
        }

        descendIds.push(childId);
        descendPaths.push(joinPath(path, entry.name, root.separator));
      }
    } finally {
      // Leaving a batch open would make the table reject every subsequent listing, so the
      // scan must not be able to exit this block with one dangling.
      if (table.isBatchOpen) table.endChildren();
    }

    for (const childId of unreadableChildren) table.markAccessDenied(childId);

    // Pushed in reverse so a last-in-first-out frontier still visits entries in the order
    // the directory listed them, which keeps progress output readable and reproducible.
    for (let index = descendIds.length - 1; index >= 0; index -= 1) {
      frontierIds.push(descendIds[index]!);
      frontierPaths.push(descendPaths[index]!);
    }

    directoriesListed += 1;

    const entryIssues = listing.entryIssues;
    if (entryIssues !== undefined && entryIssues.length > 0) {
      for (const issue of entryIssues) issues.record(issue);
      entriesSkipped += entryIssues.length;
      table.markPartial(id);
    }
  };

  const recordDirectoryFailure = (id: NodeId, path: string, error: unknown): void => {
    const issue: ScanIssue =
      error instanceof FileSystemAccessError
        ? {
            code: error.code,
            path: error.path,
            ...(error.detail === undefined ? {} : { detail: error.detail }),
          }
        : { code: 'ioError', path, detail: detailOf(error) };

    issues.record(issue);
    entriesSkipped += 1;

    if (issue.code === 'accessDenied') {
      table.markAccessDenied(id);
    } else {
      // The directory is real and we did look; we simply learned nothing. Recording an
      // empty listing distinguishes that from "never visited".
      if (!table.isListed(id)) table.addChildren(id, []);
      table.markPartial(id);
    }
  };

  const processDirectory = async (id: NodeId, path: string): Promise<void> => {
    currentPath = path;
    let listing: ListDirectoryResult;
    try {
      listing = await provider.listDirectory(path, signal);
    } catch (error) {
      recordDirectoryFailure(id, path, error);
      return;
    }

    try {
      applyListing(id, path, listing);
    } catch (error) {
      // Defensive: a defect while folding one listing into the table must not discard a
      // scan that may have been running for many minutes. It is recorded as an issue so
      // it surfaces in the statistics instead of vanishing.
      issues.record({ code: 'ioError', path, detail: detailOf(error) });
      entriesSkipped += 1;
    }

    emitProgress(false);
  };

  emitProgress(true);

  for (;;) {
    if (signal.aborted) {
      cancelled = true;
      break;
    }

    while (frontierIds.length > 0 && active.size < concurrency) {
      const id = frontierIds.pop()!;
      const path = frontierPaths.pop()!;
      // The callback closes over `task` but only runs after the binding is initialised, so
      // self-reference here is safe and lets each task remove itself from the set.
      const task: Promise<void> = processDirectory(id, path).finally(() => {
        active.delete(task);
      });
      active.add(task);
    }

    if (active.size === 0) break;
    await Promise.race(active);
  }

  if (active.size > 0) {
    // Let in-flight listings finish so nothing touches the table after we return and no
    // provider work is left orphaned. This is why cancellation is clean rather than abrupt.
    await Promise.allSettled(active);
  }

  table.compact();
  emitProgress(true);

  const finishedAt = Date.now();
  const statistics: ScanStatistics = {
    status: cancelled ? 'cancelled' : 'completed',
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    filesDiscovered: table.fileCountOf(ROOT_ID),
    directoriesDiscovered: table.directoryCountOf(ROOT_ID),
    directoriesListed,
    entriesSkipped,
    totalSize: table.totalSizeOf(ROOT_ID),
    partial: hasFlag(table.flagsOf(ROOT_ID), NodeFlags.Partial),
    issueCounts: issues.counts(),
    issueSamples: issues.samples(),
  };

  return { table, root, statistics };
}
