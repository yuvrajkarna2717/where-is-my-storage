import { FileSystemAccessError } from '@sv/scan-engine';
import { describe, expect, it } from 'vitest';
import { errnoOf, issueCodeForError, toAccessError } from '../src/errors.ts';

function errnoError(code: string): Error {
  return Object.assign(new Error(`mock ${code}`), { code });
}

describe('errno classification', () => {
  it.each([
    ['EACCES', 'accessDenied'],
    // Windows reports EPERM where Unix reports EACCES for protected system objects.
    ['EPERM', 'accessDenied'],
    ['ENOENT', 'vanished'],
    ['ESTALE', 'vanished'],
    ['ENOTDIR', 'notADirectory'],
    ['ENAMETOOLONG', 'tooLong'],
    ['ELOOP', 'unsupported'],
    ['EBUSY', 'locked'],
    // An unplugged external drive or a dropped network mount lands here.
    ['EIO', 'ioError'],
    ['ENODEV', 'ioError'],
    ['UNKNOWN', 'ioError'],
  ])('maps %s to %s', (errno, expected) => {
    expect(issueCodeForError(errnoError(errno))).toBe(expected);
  });

  it('falls back to ioError for anything unrecognised', () => {
    expect(issueCodeForError(errnoError('ESOMETHINGNEW'))).toBe('ioError');
    expect(issueCodeForError(new Error('no code at all'))).toBe('ioError');
    expect(issueCodeForError('a bare string')).toBe('ioError');
    expect(issueCodeForError(null)).toBe('ioError');
    expect(issueCodeForError(undefined)).toBe('ioError');
  });

  it('extracts the errno string only when it is actually a string', () => {
    expect(errnoOf(errnoError('EACCES'))).toBe('EACCES');
    expect(errnoOf({ code: 42 })).toBeUndefined();
    expect(errnoOf(null)).toBeUndefined();
  });

  it('wraps a Node error as the engine error type, keeping the path', () => {
    const wrapped = toAccessError(errnoError('EACCES'), '/locked/dir');

    expect(wrapped).toBeInstanceOf(FileSystemAccessError);
    expect(wrapped.code).toBe('accessDenied');
    expect(wrapped.path).toBe('/locked/dir');
    expect(wrapped.detail).toBe('EACCES');
    // The path belongs in the message too: an error with no path is unactionable.
    expect(wrapped.message).toContain('/locked/dir');
  });
});
