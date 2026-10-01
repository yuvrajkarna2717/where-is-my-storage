import { NodeFlags } from '@sv/core';
import type { DirectoryEntry } from '@sv/scan-engine';
import type { Dirent } from 'node:fs';

/**
 * How a directory entry becomes a `DirectoryEntry`, in one place.
 *
 * There are two implementations of directory reading — the straightforward asynchronous one and the
 * worker pool's synchronous one — and they must agree exactly, because the tests compare their
 * output tree for tree. Anything either of them *decides* lives here so the two cannot drift; only
 * the mechanics of getting the metadata differ.
 */

/**
 * Link flags for an entry.
 *
 * Windows junctions and POSIX symlinks both arrive as links. Telling them apart needs the reparse
 * tag, which Node does not expose, so both are marked `Symlink` — and the behaviour that matters is
 * already right either way: recorded, never followed.
 */
export function linkFlagsFor(dirent: Dirent): number {
  return dirent.isSymbolicLink() ? NodeFlags.Symlink : NodeFlags.None;
}

/**
 * A plain directory, recorded without a metadata call.
 *
 * Its kind comes from the directory listing and its size is by definition the aggregate of its
 * contents, so there is nothing to ask the filesystem. That removes one syscall for every directory
 * on the disk. The cost is an unknown modification time for directories, which nothing reads.
 */
export function directoryEntry(name: string): DirectoryEntry {
  return {
    name,
    directory: true,
    size: 0,
    mtimeMs: Number.NaN,
    flags: NodeFlags.None,
  };
}

export function fileEntry(
  name: string,
  size: number,
  mtimeMs: number,
  linkFlags: number,
): DirectoryEntry {
  return { name, directory: false, size, mtimeMs, flags: linkFlags };
}

/**
 * An entry that was listed but could not be measured.
 *
 * Kept in the tree, flagged, and contributing nothing — which is what makes the parent's total
 * honestly a lower bound rather than silently short.
 */
export function unreadableEntry(name: string, linkFlags: number): DirectoryEntry {
  return {
    name,
    directory: false,
    size: 0,
    mtimeMs: Number.NaN,
    flags: linkFlags | NodeFlags.AccessDenied,
  };
}
