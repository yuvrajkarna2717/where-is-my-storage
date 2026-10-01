import { randomBytes } from 'node:crypto';
import { NO_NODE, ROOT_ID, type NodeId, type NodeTable } from '@sv/core';
import { NodeFileSystemProvider } from '@sv/fs-node';
import {
  scan,
  type FileSystemProvider,
  type ScanProgress,
  type ScanStatistics,
} from '@sv/scan-engine';
import type {
  BreadcrumbEntry,
  ChildrenPage,
  NodeDetail,
  NodeDetailResult,
  NodeRow,
  QueryChildrenPayload,
  RootSummary,
  ScanFinishedEvent,
  ScanPhase,
  ScanProgressEvent,
  ScanStatisticsSummary,
  StatusSnapshot,
  VolumeSummary,
} from '../shared/protocol.ts';

/**
 * Everything the scan host actually does, with no Electron in sight.
 *
 * Keeping the process wiring (`process.parentPort`) out of this class is what makes the
 * interesting behaviour — one scan at a time, queries served while a scan is still running,
 * cancellation, teardown — testable against a real temporary directory instead of only
 * through a launched application.
 */

export interface ScanSessionCallbacks {
  readonly onProgress: (event: ScanProgressEvent) => void;
  readonly onFinished: (event: ScanFinishedEvent) => void;
}

export interface ScanSessionOptions {
  /**
   * Injectable so tests and a future native provider can substitute an implementation.
   *
   * The default is deliberately the single-threaded `NodeFileSystemProvider` and not
   * `WorkerFileSystemProvider`, which exists and works but measured *slower* end to end — see
   * docs/architecture.md. Switching this without re-running `pnpm bench:providers` would be a
   * regression dressed as an optimisation.
   */
  readonly createProvider?: () => FileSystemProvider;
  readonly progressIntervalMs?: number;
}

function newScanId(): string {
  // Only has to be distinct within a session and match the validator's shape. It is not a
  // secret and is never used for authorisation.
  return `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
}

function summariseStatistics(statistics: ScanStatistics): ScanStatisticsSummary {
  return {
    status: statistics.status,
    durationMs: statistics.durationMs,
    filesDiscovered: statistics.filesDiscovered,
    directoriesDiscovered: statistics.directoriesDiscovered,
    directoriesListed: statistics.directoriesListed,
    entriesSkipped: statistics.entriesSkipped,
    totalSize: statistics.totalSize,
    partial: statistics.partial,
    issueCounts: statistics.issueCounts,
    issueSamples: statistics.issueSamples,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

export class ScanSession {
  readonly #provider: FileSystemProvider;
  readonly #callbacks: ScanSessionCallbacks;
  readonly #progressIntervalMs: number | undefined;

  #table: NodeTable | null = null;
  #phase: ScanPhase = 'idle';
  #scanId: string | null = null;
  #root: RootSummary | null = null;
  #progress: ScanProgressEvent | null = null;
  #statistics: ScanStatisticsSummary | null = null;
  #error: string | null = null;
  #finishedAt: number | null = null;
  #controller: AbortController | null = null;
  #running: Promise<void> | null = null;

  constructor(callbacks: ScanSessionCallbacks, options: ScanSessionOptions = {}) {
    this.#provider = (options.createProvider ?? (() => new NodeFileSystemProvider()))();
    this.#callbacks = callbacks;
    this.#progressIntervalMs = options.progressIntervalMs;
  }

  async listVolumes(): Promise<readonly VolumeSummary[]> {
    const volumes = await this.#provider.listVolumes();
    return volumes.map((volume) => ({
      id: volume.id,
      label: volume.label,
      rootPath: volume.rootPath,
      kind: volume.kind,
      totalBytes: volume.totalBytes,
      freeBytes: volume.freeBytes,
      usedBytes: volume.usedBytes,
      scannable: volume.scannable,
      ...(volume.note === undefined ? {} : { note: volume.note }),
    }));
  }

  /**
   * Starts a scan, replacing any scan already running.
   *
   * The root is described here rather than read out of the engine so the renderer gets the
   * normalised path and the volume's capacity immediately, before a single directory has
   * been read. It costs one extra `stat` and one `statfs`, and it means an invalid path is
   * reported as a failed command rather than as a scan that dies a moment later.
   */
  async start(path: string): Promise<{ scanId: string; root: RootSummary }> {
    await this.#stopRunningScan();

    const info = await this.#provider.describeRoot(path);
    const root: RootSummary = {
      path: info.path,
      separator: info.separator,
      kind: info.kind,
      totalBytes: info.totalBytes,
      freeBytes: info.freeBytes,
      usedBytes: info.usedBytes,
    };

    const scanId = newScanId();
    const controller = new AbortController();

    this.#scanId = scanId;
    this.#root = root;
    this.#controller = controller;
    this.#phase = 'scanning';
    this.#table = null;
    this.#progress = null;
    this.#statistics = null;
    this.#error = null;
    this.#finishedAt = null;

    this.#running = this.#run(scanId, path, controller);
    return { scanId, root };
  }

  async #run(scanId: string, path: string, controller: AbortController): Promise<void> {
    try {
      const result = await scan({
        rootPath: path,
        provider: this.#provider,
        signal: controller.signal,
        ...(this.#progressIntervalMs === undefined
          ? {}
          : { progressIntervalMs: this.#progressIntervalMs }),
        onTableReady: (table) => {
          // Published before traversal starts. Without this the UI could not show anything
          // until the whole disk had been read.
          if (this.#scanId === scanId) this.#table = table;
        },
        onProgress: (progress) => {
          if (this.#scanId !== scanId) return;
          this.#progress = this.#toProgressEvent(scanId, progress);
          this.#callbacks.onProgress(this.#progress);
        },
      });

      // A scan superseded by a newer one must not overwrite the newer one's state.
      if (this.#scanId !== scanId) return;

      this.#table = result.table;
      this.#statistics = summariseStatistics(result.statistics);
      this.#phase = result.statistics.status === 'cancelled' ? 'cancelled' : 'completed';
      this.#finishedAt = Date.now();
      this.#callbacks.onFinished({
        scanId,
        phase: this.#phase,
        statistics: this.#statistics,
        error: null,
      });
    } catch (error) {
      if (this.#scanId !== scanId) return;
      this.#phase = 'failed';
      this.#error = describeError(error);
      this.#finishedAt = Date.now();
      this.#callbacks.onFinished({
        scanId,
        phase: 'failed',
        statistics: null,
        error: this.#error,
      });
    }
  }

  cancel(scanId: string): boolean {
    if (this.#scanId !== scanId || this.#controller === null || this.#phase !== 'scanning') {
      return false;
    }
    this.#controller.abort();
    return true;
  }

  status(): StatusSnapshot {
    return {
      phase: this.#phase,
      scanId: this.#scanId,
      root: this.#root,
      progress: this.#progress,
      statistics: this.#statistics,
      error: this.#error,
      finishedAgoMs: this.#finishedAt === null ? null : Date.now() - this.#finishedAt,
    };
  }

  node(nodeId: number): NodeDetailResult | null {
    const table = this.#table;
    if (table === null || !this.#isKnownNode(table, nodeId)) return null;

    const parent = table.parentOf(nodeId);
    const range = table.childRange(nodeId);
    const modified = table.mtimeOf(nodeId);

    const detail: NodeDetail = {
      ...this.#toRow(table, nodeId),
      path: table.pathOf(nodeId),
      depth: table.depthOf(nodeId),
      parentId: parent === NO_NODE ? null : parent,
      modifiedMs: Number.isNaN(modified) ? null : modified,
      childCount: Math.max(range.count, 0),
    };

    const trail = table.ancestorsOf(nodeId);
    const ancestors: BreadcrumbEntry[] = [];
    for (const id of trail) {
      ancestors.push({ id, name: table.nameOf(id), totalSize: table.totalSizeOf(id) });
    }

    return { node: detail, ancestors };
  }

  children(query: QueryChildrenPayload): ChildrenPage {
    const table = this.#table;
    const empty: ChildrenPage = { nodeId: query.nodeId, offset: query.offset, total: 0, rows: [] };
    if (table === null || !this.#isKnownNode(table, query.nodeId)) return empty;
    if (!table.isDirectory(query.nodeId) || !table.isListed(query.nodeId)) return empty;

    // Task 11 caches these orderings; today each page request re-sorts the child range,
    // which is fine for the directory sizes a person actually browses.
    const ordered = table.sortedChildIds(query.nodeId, {
      by: query.sort,
      order: query.order,
    });

    const total = ordered.length;
    const start = Math.min(query.offset, total);
    const end = Math.min(start + query.limit, total);

    const rows: NodeRow[] = [];
    for (let index = start; index < end; index += 1) {
      rows.push(this.#toRow(table, ordered[index]!));
    }

    return { nodeId: query.nodeId, offset: start, total, rows };
  }

  /** Cancels, waits, and releases the provider. Safe to call more than once. */
  async dispose(): Promise<void> {
    await this.#stopRunningScan();
    this.#table = null;
    await this.#provider.dispose?.();
  }

  async #stopRunningScan(): Promise<void> {
    this.#controller?.abort();
    const running = this.#running;
    this.#running = null;
    if (running !== null) {
      // Waiting matters: the engine only releases its worker and in-flight listings once it
      // has settled, and a replacement scan must not start competing for them.
      await running;
    }
  }

  #isKnownNode(table: NodeTable, nodeId: number): boolean {
    // Ids are indices, and the renderer may hold one from a previous scan. Bounds-checking
    // here turns a stale id into an empty answer rather than a thrown RangeError.
    return Number.isInteger(nodeId) && nodeId >= ROOT_ID && nodeId < table.count;
  }

  #toRow(table: NodeTable, id: NodeId): NodeRow {
    return {
      id,
      name: table.nameOf(id),
      directory: table.isDirectory(id),
      listed: table.isListed(id),
      totalSize: table.totalSizeOf(id),
      directSize: table.directSizeOf(id),
      fileCount: table.fileCountOf(id),
      directoryCount: table.directoryCountOf(id),
      flags: table.flagsOf(id),
    };
  }

  #toProgressEvent(scanId: string, progress: ScanProgress): ScanProgressEvent {
    return {
      scanId,
      filesDiscovered: progress.filesDiscovered,
      directoriesDiscovered: progress.directoriesDiscovered,
      directoriesListed: progress.directoriesListed,
      directoriesPending: progress.directoriesPending,
      bytesDiscovered: progress.bytesDiscovered,
      currentPath: progress.currentPath,
      elapsedMs: progress.elapsedMs,
      estimatedFraction: progress.estimatedFraction,
      issuesRecorded: progress.issuesRecorded,
    };
  }
}
