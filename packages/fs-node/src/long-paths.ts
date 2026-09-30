import { isUncPath, isWindowsPath } from '@sv/core';

const EXTENDED_PREFIX = '\\\\?\\';

/**
 * Length at which a Windows path is rewritten into extended-length form.
 *
 * `MAX_PATH` is 260 including the terminator, and a directory that can be opened may still
 * contain children that cannot. Switching over at 240 leaves room for a child name without
 * rewriting every ordinary path.
 */
export const WINDOWS_LONG_PATH_THRESHOLD = 240;

/**
 * Rewrites a long Windows path into `\\?\` form so the syscall can reach it.
 *
 * Applied only at the boundary where a path is handed to the filesystem. The storage model
 * keeps clean, displayable paths; the escape hatch never leaks into the tree, into
 * breadcrumbs, or into "reveal in Explorer".
 *
 * The prefix suppresses Windows path normalisation, so it is only safe for a fully
 * qualified path with no relative components. Every path the scanner produces comes from
 * joining directory entry names onto an already-resolved root, so that holds.
 *
 * On macOS and Linux this is the identity function: both accept long paths directly, with
 * per-component limits the kernel enforces and the provider reports as `tooLong`.
 */
export function toPlatformPath(path: string, platform: string = process.platform): string {
  if (platform !== 'win32') return path;
  if (path.length < WINDOWS_LONG_PATH_THRESHOLD) return path;
  if (path.startsWith(EXTENDED_PREFIX) || path.startsWith('\\\\.\\')) return path;
  if (!isWindowsPath(path)) return path;

  // \\server\share -> \\?\UNC\server\share
  if (isUncPath(path)) return `${EXTENDED_PREFIX}UNC\\${path.slice(2)}`;
  return `${EXTENDED_PREFIX}${path}`;
}
