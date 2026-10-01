import { lstatSync, readdirSync, type Dirent } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { detectSeparator, joinPath } from '@sv/core';
import type { DirectoryEntry, ScanIssue } from '@sv/scan-engine';
import { directoryEntry, fileEntry, linkFlagsFor, unreadableEntry } from '../entry-shapes.ts';
import { errnoOf, issueCodeForError } from '../errors.ts';
import { toPlatformPath } from '../long-paths.ts';
import {
  isCancelled,
  type ListDirectoryRequest,
  type ListDirectoryResponse,
  type WorkerInit,
} from './protocol.ts';

/**
 * The body of a filesystem worker.
 *
 * **Synchronous on purpose.** A worker already is its own thread of execution, so there is nothing
 * for an asynchronous call to overlap with here, and the async form would add a promise, a microtask
 * and a callback per entry for no benefit. Measured, this is the part of the worker-pool idea that
 * worked: `bench/provider.bench.ts` shows raw listing throughput 10-17% above the single-threaded
 * provider. What it does not buy is a faster scan — see the note on `WorkerFileSystemProvider` for
 * why, and for why the pool is not the default.
 *
 * The entry point is kept separate from this module because the file a `Worker` is spawned from has
 * to be resolvable by whatever bundled the consumer, and that differs between the Node CLI and the
 * Electron build.
 */
export function runFileSystemWorker(): void {
  const port = parentPort;
  if (port === null) {
    throw new Error('fs worker started outside a worker thread');
  }

  const init = workerData as WorkerInit;
  const cancelView = new Int32Array(init.cancelBuffer);

  port.on('message', (request: ListDirectoryRequest) => {
    port.postMessage(listDirectorySync(request, init.platform, cancelView));
  });
}

function listDirectorySync(
  request: ListDirectoryRequest,
  platform: string,
  cancelView: Int32Array,
): ListDirectoryResponse {
  let dirents: Dirent[];
  try {
    dirents = readdirSync(toPlatformPath(request.path, platform), { withFileTypes: true });
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      code: issueCodeForError(error),
      path: request.path,
      detail: errnoOf(error),
    };
  }

  const separator = detectSeparator(request.path);
  const entries: DirectoryEntry[] = [];
  const issues: ScanIssue[] = [];
  let cancelled = false;

  for (const dirent of dirents) {
    // Checked per entry, not per directory: a folder with two hundred thousand files would otherwise
    // run to completion after the user pressed Cancel.
    if (isCancelled(cancelView)) {
      cancelled = true;
      break;
    }

    if (dirent.isDirectory()) {
      entries.push(directoryEntry(dirent.name));
      continue;
    }

    const linkFlags = linkFlagsFor(dirent);
    const childPath = joinPath(request.path, dirent.name, separator);

    try {
      // `throwIfNoEntry: false` returns undefined instead of throwing for a file that has just been
      // deleted. That is the most common transient failure during a scan of a live filesystem, and
      // constructing an exception for each one is far more expensive than a null check.
      const stats = lstatSync(toPlatformPath(childPath, platform), { throwIfNoEntry: false });

      if (stats === undefined) {
        // Gone between the listing and the measurement. Recording it at zero bytes would be
        // inventing an entry that no longer exists.
        issues.push({ code: 'vanished', path: childPath });
        continue;
      }

      entries.push(fileEntry(dirent.name, stats.size, stats.mtimeMs, linkFlags));
    } catch (error) {
      const code = issueCodeForError(error);
      const detail = errnoOf(error);
      issues.push({ code, path: childPath, ...(detail === undefined ? {} : { detail }) });
      entries.push(unreadableEntry(dirent.name, linkFlags));
    }
  }

  return { id: request.id, ok: true, entries, issues, cancelled };
}
