import type { PathSeparator, ScanRootKind } from '@sv/core';
import type { CancellationSignal } from './cancellation.ts';
import type { ScanIssue } from './issues.ts';

/**
 * The seam between the traversal engine and an actual filesystem.
 *
 * Everything platform-specific lives behind this interface: Node's `readdir`/`lstat`, the
 * browser's File System Access API, the `webkitdirectory` fallback, and — if benchmarks
 * ever justify it — a native Rust implementation. The engine above it knows nothing about
 * any of them, which is what keeps "swap the scanner later" a real option rather than an
 * aspiration.
 *
 * The contract is deliberately narrow. A provider lists one directory at a time and
 * reports metadata. It never reads file contents: determining that a 10 GB file occupies
 * 10 GB must not cost 10 GB of I/O.
 */
export interface ProviderCapabilities {
  /** Identifies the provider in diagnostics and in the UI's honesty messaging. */
  readonly name: string;
  /** Can enumerate volumes or mount points. Browsers cannot. */
  readonly enumeratesVolumes: boolean;
  /** Reports total and free capacity for a root. */
  readonly reportsCapacity: boolean;
  /** Distinguishes a symbolic link from whatever it points at. */
  readonly detectsSymlinks: boolean;
  /** Reports modification times. */
  readonly reportsModificationTime: boolean;
  /**
   * Can hand back one directory at a time, which is what makes progressive results and
   * cancellation possible. The browser `webkitdirectory` fallback cannot: it produces one
   * flat list of every entry up front, so the UI must say so plainly.
   */
  readonly listsIncrementally: boolean;
}

/** A volume or mount point the user could choose to scan. */
export interface VolumeInfo {
  /** Stable within a session; a drive letter, mount point or device identifier. */
  readonly id: string;
  /** What to show the user, for example `Local Disk (C:)`. */
  readonly label: string;
  /** Where a scan of this volume would start. */
  readonly rootPath: string;
  readonly kind: 'fixed' | 'removable' | 'network' | 'virtual' | 'unknown';
  readonly totalBytes: number | null;
  readonly freeBytes: number | null;
  readonly usedBytes: number | null;
  readonly readOnly: boolean;
  /**
   * Whether offering this as a scan target is meaningful. Pseudo-filesystems and
   * unmounted or unreadable volumes are listed but not offered, with `note` explaining
   * why rather than leaving the user wondering where their drive went.
   */
  readonly scannable: boolean;
  readonly note?: string;
}

/** What the engine needs to know before it starts walking. */
export interface ScanRootInfo {
  /** Normalised absolute path. */
  readonly path: string;
  readonly separator: PathSeparator;
  readonly kind: ScanRootKind;
  readonly totalBytes: number | null;
  readonly freeBytes: number | null;
  /**
   * Bytes in use on the containing volume. Used only to estimate scan progress, and only
   * when the whole volume is being scanned.
   */
  readonly usedBytes: number | null;
}

/**
 * One entry from a directory listing.
 *
 * `size` is the apparent size: what the file logically contains. Allocated-on-disk size
 * is a separate concern, deferred because Node exposes `blocks` on Unix but has no
 * Windows equivalent, so doing it properly needs platform-specific work.
 */
export interface DirectoryEntry {
  readonly name: string;
  /** True only for a real directory that is safe to descend into. */
  readonly directory: boolean;
  /** Apparent size in bytes. Directories report 0; their size is aggregated. */
  readonly size: number;
  /** Epoch milliseconds, or NaN when the provider cannot tell. */
  readonly mtimeMs: number;
  /** Additional `NodeFlags` bits: Symlink, Reparse, AccessDenied, DedupedHardlink. */
  readonly flags: number;
}

export interface ListDirectoryResult {
  readonly entries: readonly DirectoryEntry[];
  /**
   * Problems with individual entries inside this directory. The listing itself succeeded,
   * so the directory is still recorded; these entries just could not be measured. The
   * engine marks the directory's totals as a lower bound.
   */
  readonly entryIssues?: readonly ScanIssue[];
}

export interface FileSystemProvider {
  readonly capabilities: ProviderCapabilities;

  /** Volumes the user could scan. Empty when the platform cannot enumerate them. */
  listVolumes(): Promise<readonly VolumeInfo[]>;

  /**
   * Validates and normalises a scan root.
   * Throws `FileSystemAccessError` when the path is missing, unreadable or not a directory.
   */
  describeRoot(path: string): Promise<ScanRootInfo>;

  /**
   * Lists one directory.
   * Throws `FileSystemAccessError` when the directory itself cannot be read; per-entry
   * problems come back in `entryIssues` so one bad file cannot lose the whole listing.
   */
  listDirectory(path: string, signal?: CancellationSignal): Promise<ListDirectoryResult>;

  /** Releases workers, handles and other resources. Must be idempotent. */
  dispose?(): Promise<void> | void;
}
