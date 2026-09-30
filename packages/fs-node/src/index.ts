// @sv/fs-node — the Node implementation of the filesystem seam.
//
// Everything platform-specific about reading a real disk lives here: error-code mapping,
// Windows extended-length paths, volume discovery. The engine above stays ignorant of all
// of it, which is what keeps a future native provider a drop-in rather than a rewrite.

export { forEachWithLimit } from './concurrency.ts';
export { errnoOf, issueCodeForError, toAccessError } from './errors.ts';
export { WINDOWS_LONG_PATH_THRESHOLD, toPlatformPath } from './long-paths.ts';
export {
  DEFAULT_METADATA_CONCURRENCY,
  NodeFileSystemProvider,
  type NodeFileSystemProviderOptions,
} from './node-provider.ts';
export { listNodeVolumes, readCapacity } from './volumes.ts';
