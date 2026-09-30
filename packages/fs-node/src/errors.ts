import { FileSystemAccessError, type ScanIssueCode } from '@sv/scan-engine';

/**
 * Translates platform error codes into the engine's issue taxonomy.
 *
 * This mapping lives here, next to the platform that produces the codes, rather than in
 * the engine. The engine is compiled without Node types on purpose, and teaching it about
 * `EACCES` would make every future provider inherit Node's error vocabulary.
 */
const ISSUE_BY_ERRNO: Readonly<Record<string, ScanIssueCode>> = {
  // Windows reports EPERM for protected system objects where Unix reports EACCES.
  EACCES: 'accessDenied',
  EPERM: 'accessDenied',

  ENOENT: 'vanished',
  ENOTDIR: 'notADirectory',
  ENAMETOOLONG: 'tooLong',

  // A symlink chain too long to resolve. We never follow links, so this comes from the
  // root path itself or from an exotic mount.
  ELOOP: 'unsupported',

  EBUSY: 'locked',
  ETXTBSY: 'locked',

  // An unplugged external drive or a dropped network mount surfaces as one of these.
  EIO: 'ioError',
  ENXIO: 'ioError',
  ENODEV: 'ioError',
  EHOSTDOWN: 'ioError',
  ENETDOWN: 'ioError',
  ESTALE: 'vanished',

  EMFILE: 'ioError',
  ENFILE: 'ioError',
  EINVAL: 'ioError',
  UNKNOWN: 'ioError',
};

/** Extracts an errno string such as `EACCES` from an unknown thrown value. */
export function errnoOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function issueCodeForError(error: unknown): ScanIssueCode {
  const errno = errnoOf(error);
  return (errno !== undefined ? ISSUE_BY_ERRNO[errno] : undefined) ?? 'ioError';
}

/** Wraps a Node filesystem error as the engine's transport-neutral error type. */
export function toAccessError(error: unknown, path: string): FileSystemAccessError {
  const errno = errnoOf(error);
  const message = error instanceof Error ? error.message : undefined;
  return new FileSystemAccessError(
    issueCodeForError(error),
    path,
    errno ?? message ?? 'unknown filesystem error',
  );
}
