// @sv/fs-node — the Node implementation of the filesystem seam.
//
// Everything platform-specific about reading a real disk lives here: error-code mapping,
// Windows extended-length paths, volume discovery. The engine above stays ignorant of all
// of it, which is what keeps a future native provider a drop-in rather than a rewrite.

export { forEachWithLimit } from './concurrency.ts';
export { directoryEntry, fileEntry, linkFlagsFor, unreadableEntry } from './entry-shapes.ts';
export { errnoOf, issueCodeForError, toAccessError } from './errors.ts';
export { WINDOWS_LONG_PATH_THRESHOLD, toPlatformPath } from './long-paths.ts';
export {
  DEFAULT_METADATA_CONCURRENCY,
  NodeFileSystemProvider,
  type NodeFileSystemProviderOptions,
} from './node-provider.ts';
export { listNodeVolumes, readCapacity } from './volumes.ts';

export {
  DEFAULT_WORKER_COUNT,
  WorkerFileSystemProvider,
  type WorkerFileSystemProviderOptions,
} from './worker-provider.ts';

export {
  CANCEL_BUFFER_BYTES,
  createCancelFlag,
  isCancelled,
  setCancelled,
  type CancelFlag,
  type ListDirectoryRequest,
  type ListDirectoryResponse,
  type WorkerInit,
} from './worker/protocol.ts';

/**
 * The worker body, for consumers that supply their own entry module.
 *
 * The Electron build cannot spawn `worker/entry.ts` directly — its scan host is a CommonJS bundle
 * with no separate file for it — so it provides a one-line entry that electron-vite emits as its own
 * chunk and which calls this.
 *
 * Note that this package deliberately does *not* export a default worker path. Computing one would
 * need `import.meta.url`, which is meaningless once this module has been bundled into CommonJS, and
 * it would be evaluated on import even by consumers that supply their own entry. Each consumer
 * expresses the path in the terms its own bundler understands.
 */
export { runFileSystemWorker } from './worker/run.ts';
