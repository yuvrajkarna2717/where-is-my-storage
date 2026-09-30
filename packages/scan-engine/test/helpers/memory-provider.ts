import { NodeFlags, joinPath, type PathSeparator } from '@sv/core';
import {
  FileSystemAccessError,
  type CancellationSignal,
  type DirectoryEntry,
  type FileSystemProvider,
  type ListDirectoryResult,
  type ProviderCapabilities,
  type ScanIssue,
  type ScanIssueCode,
  type ScanRootInfo,
  type VolumeInfo,
} from '../../src/index.ts';

/**
 * An in-memory `FileSystemProvider` for testing the engine.
 *
 * Real filesystems cannot be made to fail on demand: you cannot reliably ask a disk to
 * make a file vanish between the listing and the measurement, to deny permission on one
 * specific directory on every platform, or to be exactly ten thousand levels deep. This
 * provider can do all of that deterministically, which is what makes the engine's error
 * and cancellation paths testable rather than hoped-about.
 *
 * Fixtures on a real disk are still needed, and Task 3 has them too — in the fs-node tests,
 * where they belong.
 */

export type MemorySpec = MemoryFile | MemoryDirectory | MemoryLink;

export interface MemoryFile {
  readonly kind: 'file';
  readonly size: number;
  readonly mtimeMs?: number;
  /** The entry disappears between being listed and being measured. */
  readonly vanishes?: boolean;
  /** The entry is listed but its metadata cannot be read. */
  readonly unreadable?: boolean;
}

export interface MemoryDirectory {
  readonly kind: 'dir';
  readonly children: Readonly<Record<string, MemorySpec>>;
  /** Listing this directory fails with this code. */
  readonly listingError?: ScanIssueCode;
}

export interface MemoryLink {
  readonly kind: 'link';
  readonly size?: number;
  /** Points at a directory. Must still never be traversed. */
  readonly toDirectory?: boolean;
  /** Emulates a Windows junction rather than a POSIX symlink. */
  readonly reparse?: boolean;
}

export const file = (size: number, extra: Omit<MemoryFile, 'kind' | 'size'> = {}): MemoryFile => ({
  kind: 'file',
  size,
  ...extra,
});

export const dir = (
  children: Readonly<Record<string, MemorySpec>>,
  extra: Omit<MemoryDirectory, 'kind' | 'children'> = {},
): MemoryDirectory => ({ kind: 'dir', children, ...extra });

export const link = (extra: Omit<MemoryLink, 'kind'> = {}): MemoryLink => ({
  kind: 'link',
  ...extra,
});

/** Builds a chain of `depth` nested directories with one file at the bottom. */
export function deepChain(depth: number, leafSize: number): MemoryDirectory {
  let current: MemoryDirectory = dir({ 'leaf.bin': file(leafSize) });
  for (let level = depth; level > 0; level -= 1) {
    current = dir({ [`level-${level}`]: current });
  }
  return current;
}

export interface MemoryProviderOptions {
  readonly rootPath?: string;
  readonly separator?: PathSeparator;
  readonly volumeTotalBytes?: number | null;
  readonly volumeUsedBytes?: number | null;
  /** Resolve listings after a macrotask, so cancellation has a chance to interleave. */
  readonly asynchronous?: boolean;
  readonly capabilities?: Partial<ProviderCapabilities>;
}

export class MemoryFileSystemProvider implements FileSystemProvider {
  readonly capabilities: ProviderCapabilities;
  readonly rootPath: string;

  /** Every directory path this provider was asked to list, in order. */
  readonly listedPaths: string[] = [];
  /** Highest number of concurrent `listDirectory` calls observed. */
  peakConcurrency = 0;

  readonly #nodes = new Map<string, MemorySpec>();
  readonly #separator: PathSeparator;
  readonly #asynchronous: boolean;
  readonly #volumeTotalBytes: number | null;
  readonly #volumeUsedBytes: number | null;
  #inFlight = 0;

  constructor(root: MemoryDirectory, options: MemoryProviderOptions = {}) {
    this.rootPath = options.rootPath ?? '/scan';
    this.#separator = options.separator ?? '/';
    this.#asynchronous = options.asynchronous ?? false;
    this.#volumeTotalBytes = options.volumeTotalBytes ?? null;
    this.#volumeUsedBytes = options.volumeUsedBytes ?? null;
    this.capabilities = {
      name: 'memory',
      enumeratesVolumes: true,
      reportsCapacity: options.volumeTotalBytes !== undefined,
      detectsSymlinks: true,
      reportsModificationTime: true,
      listsIncrementally: true,
      ...options.capabilities,
    };
    this.#index(this.rootPath, root);
  }

  /**
   * Indexed with an explicit stack rather than recursion.
   *
   * The engine is specifically built to survive a ten-thousand-level tree; a recursive
   * helper would overflow while *setting up* that test and look like a scanner defect.
   */
  #index(rootPath: string, rootSpec: MemorySpec): void {
    const paths: string[] = [rootPath];
    const specs: MemorySpec[] = [rootSpec];

    while (paths.length > 0) {
      const path = paths.pop()!;
      const spec = specs.pop()!;
      this.#nodes.set(path, spec);
      if (spec.kind !== 'dir') continue;

      for (const [name, child] of Object.entries(spec.children)) {
        paths.push(joinPath(path, name, this.#separator));
        specs.push(child);
      }
    }
  }

  // Not `async`: there is nothing to await, and an async function with no await is a lie
  // about the shape of the work. Rejections are produced explicitly instead.
  listVolumes(): Promise<readonly VolumeInfo[]> {
    return Promise.resolve([
      {
        id: this.rootPath,
        label: 'memory',
        rootPath: this.rootPath,
        kind: 'virtual',
        totalBytes: this.#volumeTotalBytes,
        freeBytes: null,
        usedBytes: this.#volumeUsedBytes,
        readOnly: false,
        scannable: true,
      },
    ]);
  }

  describeRoot(path: string): Promise<ScanRootInfo> {
    const spec = this.#nodes.get(path);
    if (spec === undefined) {
      return Promise.reject(new FileSystemAccessError('vanished', path));
    }
    if (spec.kind !== 'dir') {
      return Promise.reject(new FileSystemAccessError('notADirectory', path));
    }

    return Promise.resolve({
      path,
      separator: this.#separator,
      kind: path === '/' ? 'volume' : 'directory',
      totalBytes: this.#volumeTotalBytes,
      freeBytes: null,
      usedBytes: this.#volumeUsedBytes,
    });
  }

  async listDirectory(path: string, signal?: CancellationSignal): Promise<ListDirectoryResult> {
    this.#inFlight += 1;
    this.peakConcurrency = Math.max(this.peakConcurrency, this.#inFlight);
    this.listedPaths.push(path);

    try {
      if (this.#asynchronous) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      }

      const spec = this.#nodes.get(path);
      if (spec === undefined) throw new FileSystemAccessError('vanished', path);
      if (spec.kind !== 'dir') throw new FileSystemAccessError('notADirectory', path);
      if (spec.listingError !== undefined) {
        throw new FileSystemAccessError(spec.listingError, path, 'injected by the test fixture');
      }

      const entries: DirectoryEntry[] = [];
      const entryIssues: ScanIssue[] = [];

      for (const [name, child] of Object.entries(spec.children)) {
        if (signal?.aborted === true) break;
        const childPath = joinPath(path, name, this.#separator);

        if (child.kind === 'dir') {
          entries.push({
            name,
            directory: true,
            size: 0,
            mtimeMs: Number.NaN,
            flags: NodeFlags.None,
          });
          continue;
        }

        if (child.kind === 'link') {
          entries.push({
            name,
            // A link is never presented as a traversable directory, even when it points at
            // one. That is what makes cycles impossible rather than merely unlikely.
            directory: false,
            size: child.size ?? 0,
            mtimeMs: Number.NaN,
            flags: child.reparse === true ? NodeFlags.Reparse : NodeFlags.Symlink,
          });
          continue;
        }

        if (child.vanishes === true) {
          entryIssues.push({ code: 'vanished', path: childPath });
          continue;
        }

        if (child.unreadable === true) {
          entryIssues.push({ code: 'accessDenied', path: childPath });
          entries.push({
            name,
            directory: false,
            size: 0,
            mtimeMs: Number.NaN,
            flags: NodeFlags.AccessDenied,
          });
          continue;
        }

        entries.push({
          name,
          directory: false,
          size: child.size,
          mtimeMs: child.mtimeMs ?? Number.NaN,
          flags: NodeFlags.None,
        });
      }

      return entryIssues.length > 0 ? { entries, entryIssues } : { entries };
    } finally {
      this.#inFlight -= 1;
    }
  }
}

/** Totals computed straight from the spec, independently of the engine. */
export interface SpecTotals {
  totalSize: number;
  fileCount: number;
  directoryCount: number;
}

/**
 * The obviously-correct reference: recursively adds up the spec, applying the same rules the
 * scanner is supposed to apply (links contribute only their own size and are counted as
 * files; vanished entries contribute nothing).
 */
export function specTotals(spec: MemorySpec): SpecTotals {
  if (spec.kind === 'file') {
    if (spec.vanishes === true) return { totalSize: 0, fileCount: 0, directoryCount: 0 };
    return { totalSize: spec.unreadable === true ? 0 : spec.size, fileCount: 1, directoryCount: 0 };
  }
  if (spec.kind === 'link') {
    return { totalSize: spec.size ?? 0, fileCount: 1, directoryCount: 0 };
  }

  const totals: SpecTotals = { totalSize: 0, fileCount: 0, directoryCount: 0 };
  if (spec.listingError !== undefined) return totals;

  for (const child of Object.values(spec.children)) {
    const childTotals = specTotals(child);
    totals.totalSize += childTotals.totalSize;
    totals.fileCount += childTotals.fileCount;
    totals.directoryCount += childTotals.directoryCount + (child.kind === 'dir' ? 1 : 0);
  }
  return totals;
}
