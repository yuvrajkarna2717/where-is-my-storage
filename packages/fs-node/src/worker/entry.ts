/**
 * Worker entry point for consumers that resolve modules the way Node does.
 *
 * It is a separate file from `run.ts` because a `Worker` is spawned from a *path*, and which path is
 * correct depends on who bundled the code. The Node CLI can point at this file directly through
 * `import.meta.url`; the Electron build cannot, because its scan host is a CommonJS bundle with no
 * separate file for this module, so it supplies its own entry that electron-vite emits as a distinct
 * chunk. Both entries do nothing but call the same shared implementation.
 */
import { runFileSystemWorker } from './run.ts';

runFileSystemWorker();
