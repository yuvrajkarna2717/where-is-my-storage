// @sv/core — the normalized storage model every surface shares.
//
// Nothing in here knows what a filesystem is. It receives entries, aggregates them, and
// answers questions about the resulting hierarchy. That is what lets one visualisation
// layer serve Windows, macOS, Linux and browser filesystem APIs without branching.

export {
  NO_NODE,
  NOT_LISTED,
  NodeFlags,
  ROOT_ID,
  hasFlag,
  type NodeFlag,
  type NodeId,
  type ScanRootKind,
} from './model.ts';

export {
  NodeTable,
  type ChildEntry,
  type ChildSortKey,
  type ChildSortOptions,
  type NodeTableOptions,
  type NodeTableStats,
} from './node-table.ts';

export { NamePool } from './name-pool.ts';

export {
  fractionOf,
  percentagesFor,
  type PercentageBreakdown,
  type PercentageContext,
} from './percentages.ts';

export {
  formatBytes,
  formatCount,
  formatPercent,
  type ByteUnitSystem,
  type FormatBytesOptions,
  type FormatPercentOptions,
} from './format.ts';

export {
  basename,
  detectSeparator,
  extensionOf,
  foldName,
  isRootPath,
  isUncPath,
  isWindowsPath,
  joinPath,
  normalizeSeparators,
  parentPath,
  windowsDriveLetter,
  type PathSeparator,
} from './path.ts';

export { decodeWtf8, encodeWtf8Into, wtf8ByteLength, wtf8ByteLengthUpperBound } from './wtf8.ts';
