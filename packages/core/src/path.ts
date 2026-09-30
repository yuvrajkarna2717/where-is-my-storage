/**
 * Path handling for the shared model.
 *
 * This package cannot use `node:path`: it compiles with no ambient types so that the
 * same code runs in the Electron scan host, a Node CLI, a web worker and a browser tab.
 * The functions here are therefore explicit about which convention they are applying,
 * rather than inheriting whatever the host platform happens to be. That matters because
 * a snapshot taken on Windows can be inspected by a build running on Linux.
 */

export type PathSeparator = '/' | '\\';

const WINDOWS_DRIVE = /^[A-Za-z]:/;
const EXTENDED_LENGTH_PREFIX = /^\\\\[?.]\\/;

/** True for drive-letter paths, UNC paths and `\\?\` extended-length paths. */
export function isWindowsPath(path: string): boolean {
  return WINDOWS_DRIVE.test(path) || path.startsWith('\\\\') || EXTENDED_LENGTH_PREFIX.test(path);
}

/** True for `\\server\share` style paths. */
export function isUncPath(path: string): boolean {
  return path.startsWith('\\\\') && !EXTENDED_LENGTH_PREFIX.test(path);
}

/** Uppercase drive letter without the colon, or null when the path has none. */
export function windowsDriveLetter(path: string): string | null {
  const match = WINDOWS_DRIVE.exec(path);
  return match ? match[0][0]!.toUpperCase() : null;
}

/** The separator a path is written with, inferred from its shape. */
export function detectSeparator(path: string): PathSeparator {
  return isWindowsPath(path) ? '\\' : '/';
}

/**
 * Rewrites every separator to `separator`.
 *
 * Windows accepts both `/` and `\`, and users paste both, so a snapshot's root path is
 * normalised once on the way in rather than being handled at every comparison site.
 * A UNC path keeps its leading double separator.
 */
export function normalizeSeparators(path: string, separator: PathSeparator): string {
  const unified = path.replace(/[\\/]+/g, separator);
  if (separator === '\\' && (path.startsWith('\\\\') || path.startsWith('//'))) {
    return `\\${unified}`;
  }
  return unified;
}

/** True when `path` is a filesystem root: `/`, `C:\`, or `\\server\share`. */
export function isRootPath(
  path: string,
  separator: PathSeparator = detectSeparator(path),
): boolean {
  if (separator === '/') return path === '/';
  if (isUncPath(path)) {
    // \\server\share is a root; \\server\share\folder is not.
    const segments = path
      .slice(2)
      .split(/[\\/]+/)
      .filter(Boolean);
    return segments.length <= 2;
  }
  return /^[A-Za-z]:[\\/]?$/.test(path);
}

/**
 * Appends a single path segment.
 *
 * Handles the root case, where the base already ends in a separator and blindly
 * concatenating would produce `C:\\Users` or `//home`.
 */
export function joinPath(base: string, name: string, separator: PathSeparator): string {
  if (base.length === 0) return name;
  if (name.length === 0) return base;
  return base.endsWith(separator) ? base + name : base + separator + name;
}

/** The final segment of a path. Roots return themselves rather than an empty string. */
export function basename(path: string, separator: PathSeparator = detectSeparator(path)): string {
  if (isRootPath(path, separator)) return path;

  let end = path.length;
  while (end > 0 && (path[end - 1] === '/' || path[end - 1] === '\\')) end -= 1;

  let start = end;
  while (start > 0 && path[start - 1] !== '/' && path[start - 1] !== '\\') start -= 1;

  return path.slice(start, end);
}

/** The containing directory, or null when `path` is already a root. */
export function parentPath(
  path: string,
  separator: PathSeparator = detectSeparator(path),
): string | null {
  if (isRootPath(path, separator)) return null;

  let end = path.length;
  while (end > 0 && (path[end - 1] === '/' || path[end - 1] === '\\')) end -= 1;

  let cut = end;
  while (cut > 0 && path[cut - 1] !== '/' && path[cut - 1] !== '\\') cut -= 1;
  if (cut === 0) return null;

  const parent = path.slice(0, cut - 1);
  if (parent.length === 0) return separator === '/' ? '/' : null;
  if (WINDOWS_DRIVE.test(parent) && parent.length === 2) return `${parent}${separator}`;
  return parent;
}

/**
 * Case- and normalisation-insensitive form of a name, for comparison and search only.
 *
 * macOS returns decomposed names (NFD) from some filesystems while the same name typed
 * by a user arrives composed (NFC), so `"café"` can legitimately arrive as two different
 * strings. Comparisons fold both to NFC. Never store the folded form: it is lossy, and
 * the original bytes are what the OS needs to reopen the file.
 */
export function foldName(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/**
 * Lowercase extension without the leading dot, or an empty string when there is none.
 *
 * A leading dot means a hidden file, not an extension: `.gitignore` has no extension.
 * Only the last component counts, so `archive.tar.gz` reports `gz`.
 */
export function extensionOf(name: string): string {
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === name.length - 1) return '';
  return name.slice(lastDot + 1).toLowerCase();
}
