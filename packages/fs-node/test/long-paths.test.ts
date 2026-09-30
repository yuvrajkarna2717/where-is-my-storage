import { describe, expect, it } from 'vitest';
import { WINDOWS_LONG_PATH_THRESHOLD, toPlatformPath } from '../src/long-paths.ts';

const long = (prefix: string): string => `${prefix}${'a'.repeat(WINDOWS_LONG_PATH_THRESHOLD)}`;

describe('toPlatformPath', () => {
  it('leaves POSIX paths alone however long they are', () => {
    // Linux and macOS accept long paths directly; the kernel enforces per-component limits
    // and the provider surfaces those as `tooLong`.
    const path = long('/home/yuvraj/');
    expect(toPlatformPath(path, 'linux')).toBe(path);
    expect(toPlatformPath(path, 'darwin')).toBe(path);
  });

  it('leaves short Windows paths alone', () => {
    // Rewriting every path would suppress Windows path normalisation for no reason.
    expect(toPlatformPath('C:\\Users\\Yuvraj', 'win32')).toBe('C:\\Users\\Yuvraj');
  });

  it('rewrites a long drive-letter path into extended-length form', () => {
    const path = long('C:\\Users\\');
    expect(toPlatformPath(path, 'win32')).toBe(`\\\\?\\${path}`);
  });

  it('rewrites a long UNC path with the UNC marker', () => {
    const path = long('\\\\server\\share\\');
    // \\server\share becomes \\?\UNC\server\share, not \\?\\\server\share.
    expect(toPlatformPath(path, 'win32')).toBe(`\\\\?\\UNC\\${path.slice(2)}`);
  });

  it('does not double-prefix a path that already escapes the limit', () => {
    const already = `\\\\?\\${long('C:\\')}`;
    expect(toPlatformPath(already, 'win32')).toBe(already);

    const device = `\\\\.\\${long('PhysicalDrive0\\')}`;
    expect(toPlatformPath(device, 'win32')).toBe(device);
  });

  it('leaves a long relative path alone, because the prefix requires a full path', () => {
    const relative = long('some\\relative\\');
    expect(toPlatformPath(relative, 'win32')).toBe(relative);
  });

  it('switches over below MAX_PATH so a directory can still hold a child name', () => {
    // A directory at 259 characters is openable while everything inside it is not, so the
    // threshold has to leave room for a filename.
    expect(WINDOWS_LONG_PATH_THRESHOLD).toBeLessThan(260);
    expect(WINDOWS_LONG_PATH_THRESHOLD).toBeGreaterThan(200);
  });
});
