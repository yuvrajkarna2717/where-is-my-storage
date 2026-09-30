import { describe, expect, it } from 'vitest';
import {
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
} from '../src/path.ts';

describe('path shape detection', () => {
  it.each([
    ['C:\\', true],
    ['c:/Users', true],
    ['\\\\server\\share', true],
    ['\\\\?\\C:\\very\\long', true],
    ['/home/yuvraj', false],
    ['/', false],
    ['relative/path', false],
  ])('classifies %s as windows=%s', (path, expected) => {
    expect(isWindowsPath(path)).toBe(expected);
  });

  it('distinguishes UNC paths from extended-length paths', () => {
    expect(isUncPath('\\\\server\\share')).toBe(true);
    // \\?\ is a length-limit escape, not a network path; treating it as UNC would break
    // root detection for long local paths.
    expect(isUncPath('\\\\?\\C:\\dir')).toBe(false);
  });

  it('extracts and upper-cases the drive letter', () => {
    expect(windowsDriveLetter('c:/Users')).toBe('C');
    expect(windowsDriveLetter('D:\\')).toBe('D');
    expect(windowsDriveLetter('/home')).toBeNull();
    expect(windowsDriveLetter('\\\\server\\share')).toBeNull();
  });

  it('infers the separator from the path shape, not from the host platform', () => {
    // A snapshot taken on Windows must still render correctly when inspected elsewhere.
    expect(detectSeparator('C:\\Users')).toBe('\\');
    expect(detectSeparator('/home/yuvraj')).toBe('/');
  });
});

describe('normalizeSeparators', () => {
  it('rewrites mixed separators', () => {
    expect(normalizeSeparators('C:/Users\\Yuvraj/Projects', '\\')).toBe(
      'C:\\Users\\Yuvraj\\Projects',
    );
    expect(normalizeSeparators('/home//yuvraj', '/')).toBe('/home/yuvraj');
  });

  it('preserves the leading double separator of a UNC path', () => {
    expect(normalizeSeparators('\\\\server\\share\\dir', '\\')).toBe('\\\\server\\share\\dir');
    expect(normalizeSeparators('//server/share', '\\')).toBe('\\\\server\\share');
  });
});

describe('isRootPath', () => {
  it.each([
    ['/', true],
    ['/home', false],
    ['C:\\', true],
    ['C:', true],
    ['C:\\Users', false],
    ['\\\\server\\share', true],
    ['\\\\server\\share\\dir', false],
  ])('%s -> %s', (path, expected) => {
    expect(isRootPath(path)).toBe(expected);
  });
});

describe('joinPath', () => {
  it('does not double the separator at a root', () => {
    expect(joinPath('C:\\', 'Users', '\\')).toBe('C:\\Users');
    expect(joinPath('/', 'home', '/')).toBe('/home');
  });

  it('inserts a separator between ordinary segments', () => {
    expect(joinPath('C:\\Users', 'Yuvraj', '\\')).toBe('C:\\Users\\Yuvraj');
    expect(joinPath('/home/yuvraj', 'Downloads', '/')).toBe('/home/yuvraj/Downloads');
    expect(joinPath('\\\\server\\share', 'dir', '\\')).toBe('\\\\server\\share\\dir');
  });

  it('tolerates empty operands', () => {
    expect(joinPath('', 'name', '/')).toBe('name');
    expect(joinPath('/base', '', '/')).toBe('/base');
  });
});

describe('basename', () => {
  it.each([
    ['/home/yuvraj', 'yuvraj'],
    ['/home/yuvraj/', 'yuvraj'],
    ['C:\\Users\\Yuvraj', 'Yuvraj'],
    ['C:\\Users\\', 'Users'],
    ['single', 'single'],
  ])('%s -> %s', (path, expected) => {
    expect(basename(path)).toBe(expected);
  });

  it('returns roots unchanged so a volume still has a display name', () => {
    expect(basename('C:\\')).toBe('C:\\');
    expect(basename('/')).toBe('/');
  });
});

describe('parentPath', () => {
  it.each([
    ['/home/yuvraj/Downloads', '/home/yuvraj'],
    ['/home/yuvraj', '/home'],
    ['/home', '/'],
    ['C:\\Users\\Yuvraj', 'C:\\Users'],
    ['C:\\Users', 'C:\\'],
  ])('%s -> %s', (path, expected) => {
    expect(parentPath(path)).toBe(expected);
  });

  it('returns null at a root', () => {
    expect(parentPath('/')).toBeNull();
    expect(parentPath('C:\\')).toBeNull();
    expect(parentPath('\\\\server\\share')).toBeNull();
  });
});

describe('foldName', () => {
  it('folds case', () => {
    expect(foldName('CAFÉ')).toBe(foldName('café'));
  });

  it('folds NFC and NFD to the same comparison key', () => {
    // macOS can hand back either form for the same visible name, so search and
    // comparison must treat them as equal even though the stored bytes differ.
    expect(foldName('caf\u00e9')).toBe(foldName('cafe\u0301'));
  });
});

describe('extensionOf', () => {
  it.each([
    ['movie.mkv', 'mkv'],
    ['UPPER.TXT', 'txt'],
    ['archive.tar.gz', 'gz'],
    ['noextension', ''],
    ['.gitignore', ''],
    ['.env.local', 'local'],
    ['trailing.', ''],
    ['', ''],
  ])('%s -> %s', (name, expected) => {
    expect(extensionOf(name)).toBe(expected);
  });
});
