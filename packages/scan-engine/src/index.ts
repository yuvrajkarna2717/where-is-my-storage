// @sv/scan-engine — platform-agnostic traversal.
//
// This package contains no filesystem code at all. It drives a `FileSystemProvider`, folds
// the results into the shared storage model, and reports progress and failures. That is
// what lets the same engine serve Node, an Electron utility process, a web worker and a
// browser tab, and what makes replacing the provider a contained change.

export { NEVER_CANCELLED, type CancellationSignal } from './cancellation.ts';

export {
  FileSystemAccessError,
  IssueLog,
  SCAN_ISSUE_CODES,
  type ScanIssue,
  type ScanIssueCode,
  type ScanIssueCounts,
} from './issues.ts';

export type {
  DirectoryEntry,
  FileSystemProvider,
  ListDirectoryResult,
  ProviderCapabilities,
  ScanRootInfo,
  VolumeInfo,
} from './provider.ts';

export {
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_DEPTH,
  DEFAULT_PROGRESS_INTERVAL_MS,
  scan,
  type ScanOptions,
  type ScanProgress,
  type ScanResult,
  type ScanStatistics,
  type ScanStatus,
} from './scanner.ts';
