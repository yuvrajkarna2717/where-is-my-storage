import type { Dirent } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { detectSeparator, isRootPath, joinPath, normalizeSeparators } from '@sv/core';
import {
  FileSystemAccessError,
  type CancellationSignal,
  type DirectoryEntry,
  type FileSystemProvider,
  type ListDirectoryResult,
  type ProviderCapabilities,
  type ScanIssue,
  type ScanRootInfo,
  type VolumeInfo,
} from '@sv/scan-engine';
import { forEachWithLimit } from './concurrency.ts';
import { directoryEntry, fileEntry, linkFlagsFor, unreadableEntry } from './entry-shapes.ts';
import { errnoOf, issueCodeForError, toAccessError } from './errors.ts';
import { toPlatformPath } from './long-paths.ts';
import { listNodeVolumes, readCapacity } from './volumes.ts';

/**
 * Metadata lookups in flight within a single directory listing.
 *
 * Multiplied by the engine's directory concurrency this is the total outstanding syscall
 * count, so it is kept modest. Node's libuv thread pool has four threads by default;
 * queueing far beyond that buys nothing and costs memory.
 */
export const DEFAULT_METADATA_CONCURRENCY = 8;

export interface NodeFileSystemProviderOptions {
  readonly metadataConcurrency?: number;
  /** Overridable for tests; defaults to the real platform. */
  readonly platform?: string;
}

/**
 * The Node filesystem provider: `readdir` plus `lstat`, and nothing else.
 *
 * File contents are never opened. Establishing that a 10 GB file occupies 10 GB is a
 * metadata question, and answering it by reading would make a scan cost as much I/O as the
 * disk holds.
 *
 * Symbolic links and Windows reparse points are reported but never descended into, which
 * makes directory cycles structurally impossible instead of something to detect.
 *
 * This is the straightforward single-threaded baseline. Task 6 replaces the internals with
 * a worker pool making synchronous calls, behind this same interface — that substitution is
 * the whole reason `FileSystemProvider` exists.
 */
export class NodeFileSystemProvider implements FileSystemProvider {
  readonly capabilities: ProviderCapabilities = {
    name: 'node',
    enumeratesVolumes: true,
    reportsCapacity: true,
    detectsSymlinks: true,
    reportsModificationTime: true,
    listsIncrementally: true,
  };

  readonly #metadataConcurrency: number;
  readonly #platform: string;

  constructor(options: NodeFileSystemProviderOptions = {}) {
    this.#metadataConcurrency = Math.max(
      1,
      Math.trunc(options.metadataConcurrency ?? DEFAULT_METADATA_CONCURRENCY),
    );
    this.#platform = options.platform ?? process.platform;
  }

  async listVolumes(): Promise<readonly VolumeInfo[]> {
    return listNodeVolumes(this.#platform);
  }

  async describeRoot(path: string): Promise<ScanRootInfo> {
    if (path.trim().length === 0) {
      throw new FileSystemAccessError('vanished', path, 'no path was given');
    }

    const separator = detectSeparator(resolve(path));
    const normalized = normalizeSeparators(resolve(path), separator);

    let stats;
    try {
      // `stat` rather than `lstat` for the root only. If a user deliberately points at a
      // symlinked folder, following it is what they asked for. Entries discovered *inside*
      // the scan are always lstat-ed, so links are never followed implicitly.
      stats = await stat(toPlatformPath(normalized, this.#platform));
    } catch (error) {
      throw toAccessError(error, normalized);
    }

    if (!stats.isDirectory()) {
      throw new FileSystemAccessError(
        'notADirectory',
        normalized,
        'scan roots must be directories',
      );
    }

    const capacity = await readCapacity(normalized);
    return {
      path: normalized,
      separator,
      kind: isRootPath(normalized, separator) ? 'volume' : 'directory',
      ...capacity,
    };
  }

  async listDirectory(path: string, signal?: CancellationSignal): Promise<ListDirectoryResult> {
    let dirents: Dirent[];
    try {
      dirents = await readdir(toPlatformPath(path, this.#platform), { withFileTypes: true });
    } catch (error) {
      // The directory itself is unreadable. The engine records it and moves on.
      throw toAccessError(error, path);
    }

    const separator = detectSeparator(path);
    // Results are written by index so the listing order the filesystem gave us survives
    // concurrent metadata lookups. Stable order makes traversal reproducible.
    const slots = new Array<DirectoryEntry | undefined>(dirents.length);
    const issues: ScanIssue[] = [];

    await forEachWithLimit(dirents.length, this.#metadataConcurrency, async (index) => {
      if (signal?.aborted === true) return;

      const dirent = dirents[index]!;

      // The shapes below come from `entry-shapes.ts`, shared with the worker pool, so the two
      // implementations of directory reading cannot disagree about what they found.
      if (dirent.isDirectory()) {
        slots[index] = directoryEntry(dirent.name);
        return;
      }

      const linkFlags = linkFlagsFor(dirent);
      const childPath = joinPath(path, dirent.name, separator);

      try {
        const stats = await lstat(toPlatformPath(childPath, this.#platform));
        slots[index] = fileEntry(dirent.name, stats.size, stats.mtimeMs, linkFlags);
      } catch (error) {
        const code = issueCodeForError(error);
        const detail = errnoOf(error);
        issues.push({ code, path: childPath, ...(detail === undefined ? {} : { detail }) });

        // A file that vanished between the listing and the lookup no longer exists.
        // Recording it with a size of zero would be inventing an entry.
        if (code === 'vanished') return;

        slots[index] = unreadableEntry(dirent.name, linkFlags);
      }
    });

    const entries = slots.filter((entry): entry is DirectoryEntry => entry !== undefined);
    return issues.length > 0 ? { entries, entryIssues: issues } : { entries };
  }
}
