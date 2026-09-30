import { NODE_GROWTH_LINEAR_THRESHOLD, nextCapacity } from './growth.ts';
import { NamePool } from './name-pool.ts';
import { NO_NODE, NOT_LISTED, NodeFlags, ROOT_ID, type NodeId } from './model.ts';
import {
  basename,
  detectSeparator,
  joinPath,
  normalizeSeparators,
  type PathSeparator,
} from './path.ts';
import { wtf8ByteLength } from './wtf8.ts';

/*
 * A note on `!` in this file.
 *
 * The repository enables `noUncheckedIndexedAccess`, which types every typed-array read
 * as `number | undefined`. The columns here are dense: every index in `[0, count)` is
 * written before it can be read, and every public entry point validates its `NodeId`
 * through `#assertId` first. Non-null assertions are therefore load-bearing
 * documentation of that invariant rather than a way to dodge the check, and they are
 * confined to this one file so the flag keeps its value everywhere else.
 */

/** Byte cost of one node across all mandatory columns. See `stats()`. */
const BYTES_PER_NODE_BASE = 4 + 4 + 4 + 4 + 2 + 8 + 8 + 4 + 4 + 8 + 2 + 1;

/** Extra bytes per node when allocated-on-disk size is tracked. */
const BYTES_PER_NODE_ALLOCATED = 8;

/** A name longer than this cannot be addressed by the Uint16 length column. */
const MAX_NAME_BYTES = 0xffff;

/** `depth` is a Uint16 column; deeper trees clamp rather than wrap. */
const MAX_DEPTH = 0xffff;

export interface NodeTableOptions {
  /** Absolute path the scan was rooted at, for example `C:\` or `/home/yuvraj`. */
  readonly rootPath: string;
  /** Separator convention. Inferred from `rootPath` when omitted. */
  readonly separator?: PathSeparator;
  /** Pre-size the columns when an estimate is available, to avoid regrowth. */
  readonly initialCapacity?: number;
  /**
   * Also track allocated-on-disk size. Off by default: v1 reports apparent size, and
   * the column would otherwise cost 8 bytes per node for data nothing reads yet.
   */
  readonly trackAllocatedSize?: boolean;
}

/** Convenience shape for `addChildren`. Hot paths should prefer `pushChild`. */
export interface ChildEntry {
  readonly name: string;
  readonly directory: boolean;
  /** Apparent size in bytes. Directories pass 0; their size is aggregated. */
  readonly size: number;
  readonly mtimeMs?: number;
  /** Additional `NodeFlags` beyond `Directory`, which `directory` sets. */
  readonly flags?: number;
}

export type ChildSortKey = 'size' | 'name' | 'files' | 'modified';

export interface ChildSortOptions {
  readonly by?: ChildSortKey;
  readonly order?: 'asc' | 'desc';
  /** Locale for name ordering. Pass an explicit value when determinism matters. */
  readonly locale?: string;
}

export interface NodeTableStats {
  readonly nodeCount: number;
  readonly capacity: number;
  /** Files anywhere beneath the root. */
  readonly fileCount: number;
  /** Directories anywhere beneath the root. */
  readonly directoryCount: number;
  readonly totalSize: number;
  readonly nameBytes: number;
  readonly nameCapacity: number;
  /** Bytes held by the columns at the current capacity, including headroom. */
  readonly columnBytes: number;
  /** Total allocated bytes divided by nodes, the number the memory budget tracks. */
  readonly bytesPerNode: number;
}

function growInt32(source: Int32Array, capacity: number): Int32Array {
  const grown = new Int32Array(capacity);
  grown.set(source);
  return grown;
}

function growUint32(source: Uint32Array, capacity: number): Uint32Array {
  const grown = new Uint32Array(capacity);
  grown.set(source);
  return grown;
}

function growUint16(source: Uint16Array, capacity: number): Uint16Array {
  const grown = new Uint16Array(capacity);
  grown.set(source);
  return grown;
}

function growUint8(source: Uint8Array, capacity: number): Uint8Array {
  const grown = new Uint8Array(capacity);
  grown.set(source);
  return grown;
}

function growFloat64(source: Float64Array, capacity: number): Float64Array {
  const grown = new Float64Array(capacity);
  grown.set(source);
  return grown;
}

/**
 * The normalized storage model: a hierarchy stored as parallel typed arrays where the
 * array index *is* the node identity.
 *
 * Why not a tree of objects with `children: StorageNode[]`. At a million entries that
 * shape costs hundreds of megabytes in per-object headers, duplicated path strings and
 * child arrays, and it puts the whole filesystem under the garbage collector's feet
 * during a scan. Columns cost about 53 bytes per node plus the encoded name.
 *
 * Two structural decisions follow from how filesystems are actually read:
 *
 * - **Children are contiguous.** `readdir` yields a directory's entire listing at once,
 *   so a listing is appended as one block and the parent records `childStart` and
 *   `childCount`. Iterating children is a sequential scan, and no per-node child array
 *   is ever allocated.
 * - **Paths are not stored.** A full path is reconstructed by walking `parent`, which
 *   removes the single largest source of duplicated bytes.
 *
 * Aggregation is incremental and always consistent: `totalSize` is the bytes discovered
 * in a subtree *so far*, so partially scanned trees show honest, monotonically rising
 * numbers rather than zeroes that jump at the end.
 */
export class NodeTable {
  #capacity: number;
  #count = 0;

  #parent: Int32Array;
  #childStart: Int32Array;
  #childCount: Int32Array;
  #nameOffset: Uint32Array;
  #nameLength: Uint16Array;
  #totalSize: Float64Array;
  #directSize: Float64Array;
  #fileCount: Uint32Array;
  #dirCount: Uint32Array;
  #mtimeMs: Float64Array;
  #depth: Uint16Array;
  #flags: Uint8Array;
  #allocatedSize: Float64Array | null;

  readonly #names = new NamePool();
  readonly #rootPath: string;
  readonly #separator: PathSeparator;

  #openParent: NodeId = NO_NODE;
  #openStart = 0;
  #collators = new Map<string, Intl.Collator>();

  constructor(options: NodeTableOptions) {
    const separator = options.separator ?? detectSeparator(options.rootPath);
    this.#separator = separator;
    this.#rootPath = normalizeSeparators(options.rootPath, separator);

    const capacity = Math.max(options.initialCapacity ?? 1024, 16);
    this.#capacity = capacity;

    this.#parent = new Int32Array(capacity);
    this.#childStart = new Int32Array(capacity);
    this.#childCount = new Int32Array(capacity);
    this.#nameOffset = new Uint32Array(capacity);
    this.#nameLength = new Uint16Array(capacity);
    this.#totalSize = new Float64Array(capacity);
    this.#directSize = new Float64Array(capacity);
    this.#fileCount = new Uint32Array(capacity);
    this.#dirCount = new Uint32Array(capacity);
    this.#mtimeMs = new Float64Array(capacity);
    this.#depth = new Uint16Array(capacity);
    this.#flags = new Uint8Array(capacity);
    this.#allocatedSize = options.trackAllocatedSize === true ? new Float64Array(capacity) : null;

    // The root always exists at index 0, which removes an entire class of "scan started
    // but has no root yet" states from every consumer.
    this.#count = 1;
    this.#parent[ROOT_ID] = NO_NODE;
    this.#childStart[ROOT_ID] = NO_NODE;
    this.#childCount[ROOT_ID] = NOT_LISTED;
    this.#depth[ROOT_ID] = 0;
    this.#flags[ROOT_ID] = NodeFlags.Directory;
    this.#mtimeMs[ROOT_ID] = Number.NaN;
    this.#writeName(ROOT_ID, basename(this.#rootPath, separator));
  }

  // ---------------------------------------------------------------- identity & shape

  /** Number of nodes recorded, including the root. */
  get count(): number {
    return this.#count;
  }

  /** Absolute path the scan was rooted at. */
  get rootPath(): string {
    return this.#rootPath;
  }

  get separator(): PathSeparator {
    return this.#separator;
  }

  /** True while a `beginChildren` batch is open. */
  get isBatchOpen(): boolean {
    return this.#openParent !== NO_NODE;
  }

  nameOf(id: NodeId): string {
    this.#assertId(id);
    return this.#names.read(this.#nameOffset[id]!, this.#nameLength[id]!);
  }

  /** Reconstructs the absolute path by walking to the root. */
  pathOf(id: NodeId): string {
    this.#assertId(id);
    if (id === ROOT_ID) return this.#rootPath;

    const segments: string[] = [];
    for (let current = id; current !== ROOT_ID && current !== NO_NODE;) {
      segments.push(this.nameOf(current));
      current = this.#parent[current]!;
    }

    let path = this.#rootPath;
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      path = joinPath(path, segments[index]!, this.#separator);
    }
    return path;
  }

  parentOf(id: NodeId): NodeId {
    this.#assertId(id);
    return this.#parent[id]!;
  }

  depthOf(id: NodeId): number {
    this.#assertId(id);
    return this.#depth[id]!;
  }

  flagsOf(id: NodeId): number {
    this.#assertId(id);
    return this.#flags[id]!;
  }

  isDirectory(id: NodeId): boolean {
    this.#assertId(id);
    return (this.#flags[id]! & NodeFlags.Directory) !== 0;
  }

  /** True once this directory's listing has been recorded, even if it was empty. */
  isListed(id: NodeId): boolean {
    this.#assertId(id);
    return this.#childCount[id]! !== NOT_LISTED;
  }

  /**
   * Children occupy `[start, start + count)`. `count` is -1 (`NOT_LISTED`) for a
   * directory that has not been read yet, which the UI must distinguish from an empty
   * directory: one is unknown, the other is known to be empty.
   */
  childRange(id: NodeId): { start: NodeId; count: number } {
    this.#assertId(id);
    const count = this.#childCount[id]!;
    return { start: count > 0 ? this.#childStart[id]! : NO_NODE, count };
  }

  /** Breadcrumb trail: root first, `id` last, inclusive. */
  ancestorsOf(id: NodeId): Int32Array {
    this.#assertId(id);
    const depth = this.#depth[id]!;
    const trail = new Int32Array(depth + 1);
    let current = id;
    for (let index = depth; index >= 0; index -= 1) {
      trail[index] = current;
      if (current === ROOT_ID) break;
      current = this.#parent[current]!;
    }
    return trail;
  }

  // -------------------------------------------------------------------------- metrics

  /** Bytes contained by this node: its own size for a file, the subtree for a directory. */
  totalSizeOf(id: NodeId): number {
    this.#assertId(id);
    return this.#totalSize[id]!;
  }

  /** Bytes of the files sitting immediately inside this directory. 0 for a file. */
  directSizeOf(id: NodeId): number {
    this.#assertId(id);
    return this.#directSize[id]!;
  }

  /** Allocated-on-disk bytes, or null when the table is not tracking them. */
  allocatedSizeOf(id: NodeId): number | null {
    this.#assertId(id);
    return this.#allocatedSize === null ? null : this.#allocatedSize[id]!;
  }

  /** Files anywhere beneath this node, excluding itself. */
  fileCountOf(id: NodeId): number {
    this.#assertId(id);
    return this.#fileCount[id]!;
  }

  /** Directories anywhere beneath this node, excluding itself. */
  directoryCountOf(id: NodeId): number {
    this.#assertId(id);
    return this.#dirCount[id]!;
  }

  /** Modification time in epoch milliseconds, or NaN when unknown. */
  mtimeOf(id: NodeId): number {
    this.#assertId(id);
    return this.#mtimeMs[id]!;
  }

  // ------------------------------------------------------------------------- building

  /**
   * Opens a listing for `parentId`. Exactly one batch may be open at a time, which is
   * what guarantees a directory's children stay contiguous even when several workers are
   * producing listings concurrently: the host applies each completed listing atomically.
   */
  beginChildren(parentId: NodeId): void {
    this.#assertId(parentId);
    if (this.#openParent !== NO_NODE) {
      throw new Error(
        `cannot list ${this.#describe(parentId)}: a batch for ${this.#describe(this.#openParent)} is still open`,
      );
    }
    if (!this.isDirectory(parentId)) {
      throw new Error(`cannot list ${this.#describe(parentId)}: it is not a directory`);
    }
    if (this.#childCount[parentId]! !== NOT_LISTED) {
      throw new Error(`children of ${this.#describe(parentId)} were already recorded`);
    }
    this.#openParent = parentId;
    this.#openStart = this.#count;
  }

  /**
   * Appends one entry to the open listing.
   * Positional rather than object-shaped on purpose: at a million entries, one temporary
   * object per file is exactly the garbage this store exists to avoid.
   */
  pushChild(name: string, flags: number, size: number, mtimeMs: number): NodeId {
    const parent = this.#openParent;
    if (parent === NO_NODE) {
      throw new Error('pushChild requires an open batch; call beginChildren first');
    }

    const id = this.#count;
    this.#reserve(id + 1);

    const isDirectory = (flags & NodeFlags.Directory) !== 0;
    this.#parent[id] = parent;
    this.#childStart[id] = NO_NODE;
    this.#childCount[id] = isDirectory ? NOT_LISTED : 0;
    this.#totalSize[id] = isDirectory ? 0 : size;
    this.#directSize[id] = 0;
    this.#fileCount[id] = 0;
    this.#dirCount[id] = 0;
    this.#mtimeMs[id] = mtimeMs;
    this.#depth[id] = Math.min(this.#depth[parent]! + 1, MAX_DEPTH);
    this.#flags[id] = flags;
    if (this.#allocatedSize !== null) this.#allocatedSize[id] = 0;
    this.#writeName(id, name);

    this.#count = id + 1;
    return id;
  }

  /**
   * Closes the open listing and folds its totals into the ancestors.
   *
   * Aggregation happens once per *directory* rather than once per file: a listing's file
   * sizes are summed locally and the single total is bubbled up, so the cost is
   * O(depth) per directory instead of O(depth) per file, while top-level numbers stay
   * live for a scan in progress.
   */
  endChildren(): void {
    const parent = this.#openParent;
    if (parent === NO_NODE) {
      throw new Error('endChildren requires an open batch; call beginChildren first');
    }

    const start = this.#openStart;
    const count = this.#count - start;
    this.#childStart[parent] = count > 0 ? start : NO_NODE;
    this.#childCount[parent] = count;
    this.#openParent = NO_NODE;

    const flags = this.#flags;
    const totalSize = this.#totalSize;

    let fileBytes = 0;
    let files = 0;
    let directories = 0;
    let sawInaccessible = false;

    for (let id = start; id < start + count; id += 1) {
      const entryFlags = flags[id]!;
      if ((entryFlags & NodeFlags.Directory) !== 0) {
        directories += 1;
      } else {
        files += 1;
        fileBytes += totalSize[id]!;
      }
      if ((entryFlags & NodeFlags.AccessDenied) !== 0) sawInaccessible = true;
    }

    const directSize = this.#directSize;
    directSize[parent] = directSize[parent]! + fileBytes;

    const parents = this.#parent;
    const fileCounts = this.#fileCount;
    const dirCounts = this.#dirCount;
    for (let ancestor = parent; ancestor !== NO_NODE; ancestor = parents[ancestor]!) {
      totalSize[ancestor] = totalSize[ancestor]! + fileBytes;
      fileCounts[ancestor] = fileCounts[ancestor]! + files;
      dirCounts[ancestor] = dirCounts[ancestor]! + directories;
    }

    if (sawInaccessible) this.markPartial(parent);
  }

  /** Records a whole listing in one call. Convenient for tests and simple callers. */
  addChildren(parentId: NodeId, entries: readonly ChildEntry[]): NodeId {
    this.beginChildren(parentId);
    const first = this.#count;
    for (const entry of entries) {
      const flags = (entry.flags ?? 0) | (entry.directory ? NodeFlags.Directory : 0);
      this.pushChild(entry.name, flags, entry.size, entry.mtimeMs ?? Number.NaN);
    }
    this.endChildren();
    return entries.length > 0 ? first : NO_NODE;
  }

  /**
   * Marks a node unreadable. Its subtree totals become a lower bound, so every ancestor
   * is flagged `Partial` and the UI can say "at least this much" instead of implying a
   * precision it does not have.
   */
  markAccessDenied(id: NodeId): void {
    this.#assertId(id);
    this.#flags[id] = this.#flags[id]! | NodeFlags.AccessDenied;
    // A directory we could not read is known to have no *recorded* children, which is
    // different from never having been looked at.
    if (this.#childCount[id]! === NOT_LISTED) this.#childCount[id] = 0;
    this.markPartial(id);
  }

  /** Flags `id` and every ancestor as having incomplete totals. */
  markPartial(id: NodeId): void {
    this.#assertId(id);
    const flags = this.#flags;
    const parents = this.#parent;
    for (let current = id; current !== NO_NODE; current = parents[current]!) {
      if ((flags[current]! & NodeFlags.Partial) !== 0) break; // ancestors already flagged
      flags[current] = flags[current]! | NodeFlags.Partial;
    }
  }

  /** Records allocated-on-disk bytes. No-op unless the table tracks them. */
  setAllocatedSize(id: NodeId, bytes: number): void {
    this.#assertId(id);
    if (this.#allocatedSize !== null) this.#allocatedSize[id] = bytes;
  }

  // ------------------------------------------------------------------------- ordering

  /**
   * Child ids ordered for display. Size descending by default, because "what is big"
   * is the question the product exists to answer.
   *
   * Every comparator breaks ties by id so the order is total and reproducible, rather
   * than relying on sort stability.
   */
  sortedChildIds(id: NodeId, options: ChildSortOptions = {}): Int32Array {
    const { start, count } = this.childRange(id);
    if (count <= 0) return new Int32Array(0);

    const ids = new Int32Array(count);
    for (let index = 0; index < count; index += 1) ids[index] = start + index;
    if (count === 1) return ids;

    const by = options.by ?? 'size';
    const descending = (options.order ?? (by === 'name' ? 'asc' : 'desc')) === 'desc';

    if (by === 'name') {
      const names = new Array<string>(count);
      for (let index = 0; index < count; index += 1) names[index] = this.nameOf(start + index);
      const collator = this.#collator(options.locale);
      ids.sort((left, right) => {
        const compared = collator.compare(names[left - start]!, names[right - start]!);
        if (compared !== 0) return descending ? -compared : compared;
        return left - right;
      });
      return ids;
    }

    const column =
      by === 'size' ? this.#totalSize : by === 'files' ? this.#fileCount : this.#mtimeMs;

    ids.sort((left, right) => {
      // Unknown timestamps sort as the oldest possible value rather than poisoning the
      // comparison, which a raw NaN would do by making every comparison report "equal".
      const leftValue = column[left]!;
      const rightValue = column[right]!;
      const a = Number.isNaN(leftValue) ? Number.NEGATIVE_INFINITY : leftValue;
      const b = Number.isNaN(rightValue) ? Number.NEGATIVE_INFINITY : rightValue;
      if (a !== b) return descending ? b - a : a - b;
      return left - right;
    });
    return ids;
  }

  // --------------------------------------------------------------------------- upkeep

  /**
   * Releases growth headroom by shrinking every column to the exact node count.
   * Worth calling once a scan finishes, before a snapshot is written.
   */
  compact(): void {
    if (this.#openParent !== NO_NODE) {
      throw new Error('cannot compact while a listing batch is open');
    }
    if (this.#capacity === this.#count) return;

    const count = this.#count;
    this.#parent = this.#parent.slice(0, count);
    this.#childStart = this.#childStart.slice(0, count);
    this.#childCount = this.#childCount.slice(0, count);
    this.#nameOffset = this.#nameOffset.slice(0, count);
    this.#nameLength = this.#nameLength.slice(0, count);
    this.#totalSize = this.#totalSize.slice(0, count);
    this.#directSize = this.#directSize.slice(0, count);
    this.#fileCount = this.#fileCount.slice(0, count);
    this.#dirCount = this.#dirCount.slice(0, count);
    this.#mtimeMs = this.#mtimeMs.slice(0, count);
    this.#depth = this.#depth.slice(0, count);
    this.#flags = this.#flags.slice(0, count);
    if (this.#allocatedSize !== null) this.#allocatedSize = this.#allocatedSize.slice(0, count);
    this.#names.compact();
    this.#capacity = count;
  }

  stats(): NodeTableStats {
    const perNode =
      BYTES_PER_NODE_BASE + (this.#allocatedSize !== null ? BYTES_PER_NODE_ALLOCATED : 0);
    const columnBytes = this.#capacity * perNode;
    return {
      nodeCount: this.#count,
      capacity: this.#capacity,
      fileCount: this.#fileCount[ROOT_ID]!,
      directoryCount: this.#dirCount[ROOT_ID]!,
      totalSize: this.#totalSize[ROOT_ID]!,
      nameBytes: this.#names.byteLength,
      nameCapacity: this.#names.capacity,
      columnBytes,
      bytesPerNode: (columnBytes + this.#names.capacity) / Math.max(this.#count, 1),
    };
  }

  // -------------------------------------------------------------------------- private

  #writeName(id: NodeId, name: string): void {
    // Only worth an exact measurement for absurd names; path components are capped at
    // 255 characters on every mainstream filesystem.
    if (name.length * 3 > MAX_NAME_BYTES && wtf8ByteLength(name) > MAX_NAME_BYTES) {
      throw new RangeError(`name exceeds ${MAX_NAME_BYTES} encoded bytes and cannot be stored`);
    }
    const offset = this.#names.byteLength;
    const length = this.#names.append(name);
    this.#nameOffset[id] = offset;
    this.#nameLength[id] = length;
  }

  #reserve(required: number): void {
    if (required <= this.#capacity) return;
    const capacity = nextCapacity(this.#capacity, required, NODE_GROWTH_LINEAR_THRESHOLD, 1024);

    this.#parent = growInt32(this.#parent, capacity);
    this.#childStart = growInt32(this.#childStart, capacity);
    this.#childCount = growInt32(this.#childCount, capacity);
    this.#nameOffset = growUint32(this.#nameOffset, capacity);
    this.#nameLength = growUint16(this.#nameLength, capacity);
    this.#totalSize = growFloat64(this.#totalSize, capacity);
    this.#directSize = growFloat64(this.#directSize, capacity);
    this.#fileCount = growUint32(this.#fileCount, capacity);
    this.#dirCount = growUint32(this.#dirCount, capacity);
    this.#mtimeMs = growFloat64(this.#mtimeMs, capacity);
    this.#depth = growUint16(this.#depth, capacity);
    this.#flags = growUint8(this.#flags, capacity);
    if (this.#allocatedSize !== null) {
      this.#allocatedSize = growFloat64(this.#allocatedSize, capacity);
    }
    this.#capacity = capacity;
  }

  #assertId(id: NodeId): void {
    if (!Number.isInteger(id) || id < 0 || id >= this.#count) {
      throw new RangeError(`node id ${id} is outside [0, ${this.#count})`);
    }
  }

  #describe(id: NodeId): string {
    return `node ${id} (${this.pathOf(id)})`;
  }

  #collator(locale: string | undefined): Intl.Collator {
    const key = locale ?? '';
    let collator = this.#collators.get(key);
    if (collator === undefined) {
      // `numeric` makes "file10" sort after "file9", which is what a file manager does
      // and what a user expects.
      collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
      this.#collators.set(key, collator);
    }
    return collator;
  }
}
