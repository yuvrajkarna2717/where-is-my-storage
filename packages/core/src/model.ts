/** Index into the columnar node table. The index *is* the identity of a node. */
export type NodeId = number;

/** The scan root always occupies index 0. */
export const ROOT_ID: NodeId = 0;

/** Sentinel for "no such node", used by `parentOf` on the root. */
export const NO_NODE: NodeId = -1;

/** Sentinel for `childCount` meaning "this directory has not been listed yet". */
export const NOT_LISTED = -1;

/**
 * Per-node filesystem facts, packed into one byte.
 *
 * These describe what the filesystem reported, not how the UI should present it.
 * Presentation-only concepts (such as the treemap's aggregated "Other" tile) belong to
 * the visualisation layer and deliberately have no flag here.
 */
export const NodeFlags = {
  None: 0,
  /** Entry is a directory. Absence means a file or a non-directory special entry. */
  Directory: 1 << 0,
  /** A symbolic link. Recorded, never traversed. */
  Symlink: 1 << 1,
  /** A Windows junction or other reparse point. Recorded, never traversed. */
  Reparse: 1 << 2,
  /** This entry could not be read: permission denied, locked, or an I/O error. */
  AccessDenied: 1 << 3,
  /**
   * This node's totals are a lower bound, because something inside it could not be
   * read. Propagates to ancestors so the UI can say "at least this much" honestly.
   */
  Partial: 1 << 4,
  /** A hardlink whose bytes were already attributed to an earlier path in this scan. */
  DedupedHardlink: 1 << 5,
} as const;

export type NodeFlag = (typeof NodeFlags)[keyof typeof NodeFlags];

export function hasFlag(flags: number, flag: NodeFlag): boolean {
  return (flags & flag) !== 0;
}

/** What a scan was pointed at. Metadata about the snapshot, not about a single node. */
export type ScanRootKind = 'volume' | 'directory';
