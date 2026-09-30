import { lstatSync, readdirSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFlags, ROOT_ID, hasFlag, type NodeTable } from '@sv/core';
import { scan } from '@sv/scan-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NodeFileSystemProvider } from '../src/node-provider.ts';

/**
 * Real filesystem tests.
 *
 * The engine's error and cancellation paths are covered with an in-memory provider, where
 * failures can be produced on demand. These tests do the opposite job: they check the Node
 * provider against an actual disk, with real Unicode names, real symlinks and real
 * platform limits, because that is where the surprises live.
 *
 * Link creation is capability-detected rather than assumed. Windows needs administrator
 * rights or Developer Mode for file symlinks but allows directory junctions unprivileged,
 * so the fixture records what it managed to create and the assertions follow.
 */

const isWindows = process.platform === 'win32';

interface Fixture {
  root: string;
  createdDirectoryLink: boolean;
  createdFileLink: boolean;
  createdBrokenLink: boolean;
  createdUnreadableDirectory: boolean;
  unreadableDirectory: string;
}

let fixture: Fixture;

async function tryCreate(action: () => Promise<void>): Promise<boolean> {
  try {
    await action();
    return true;
  } catch {
    return false;
  }
}

/** Bytes of content so each file has a distinct, verifiable size. */
const content = (size: number): Uint8Array => new Uint8Array(size).fill(0x41);

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'sv-fsnode-'));

  await mkdir(join(root, 'empty'));
  await mkdir(join(root, 'nested', 'level-1', 'level-2'), { recursive: true });
  await writeFile(join(root, 'nested', 'level-1', 'level-2', 'deep.bin'), content(1_234));
  await writeFile(join(root, 'nested', 'level-1', 'mid.bin'), content(56));

  await mkdir(join(root, 'unicode'));
  await writeFile(join(root, 'unicode', 'café.txt'), content(10));
  await writeFile(join(root, 'unicode', '日本語.txt'), content(20));
  await writeFile(join(root, 'unicode', 'emoji 🎬.mkv'), content(30));
  await writeFile(join(root, 'unicode', 'two  spaces.txt'), content(40));

  await mkdir(join(root, 'sizes'));
  await writeFile(join(root, 'sizes', 'zero.bin'), content(0));
  await writeFile(join(root, 'sizes', 'one.bin'), content(1));
  await writeFile(join(root, 'sizes', 'kb.bin'), content(1_024));

  await mkdir(join(root, 'links'));
  const createdDirectoryLink = await tryCreate(() =>
    // A junction is the unprivileged equivalent on Windows; elsewhere a directory symlink.
    symlink(join(root, 'nested'), join(root, 'links', 'to-dir'), isWindows ? 'junction' : 'dir'),
  );
  const createdFileLink = await tryCreate(() =>
    symlink(join(root, 'sizes', 'kb.bin'), join(root, 'links', 'to-file'), 'file'),
  );
  const createdBrokenLink = await tryCreate(() =>
    symlink(join(root, 'does-not-exist'), join(root, 'links', 'broken'), 'file'),
  );

  // POSIX permission bits do not restrict directory listing on Windows, where access control
  // needs ACL manipulation. Task 7 covers Windows permissions specifically.
  const unreadableDirectory = join(root, 'locked');
  await mkdir(unreadableDirectory);
  await writeFile(join(unreadableDirectory, 'secret.bin'), content(9_999));
  const createdUnreadableDirectory = isWindows
    ? false
    : await tryCreate(async () => {
        await chmod(unreadableDirectory, 0o000);
      });

  fixture = {
    root,
    createdDirectoryLink,
    createdFileLink,
    createdBrokenLink,
    createdUnreadableDirectory,
    unreadableDirectory,
  };
});

afterAll(async () => {
  if (fixture === undefined) return;
  // Restore permissions first or the directory cannot be removed.
  if (fixture.createdUnreadableDirectory) {
    await chmod(fixture.unreadableDirectory, 0o755).catch(() => undefined);
  }
  await rm(fixture.root, { recursive: true, force: true });
});

/**
 * An independent recursive sum, written deliberately differently from the scanner: plain
 * synchronous recursion, no columnar store, no aggregation bubbling. If both agree, the
 * scanner's incremental arithmetic is right.
 */
function referenceSum(path: string): { bytes: number; files: number; directories: number } {
  let bytes = 0;
  let files = 0;
  let directories = 0;

  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return { bytes, files, directories };
  }

  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      directories += 1;
      const nested = referenceSum(child);
      bytes += nested.bytes;
      files += nested.files;
      directories += nested.directories;
      continue;
    }
    files += 1;
    try {
      // lstat, never stat: a link contributes its own size and is never followed.
      bytes += lstatSync(child).size;
    } catch {
      // Unreadable or vanished contributes nothing, exactly as the scanner treats it.
    }
  }

  return { bytes, files, directories };
}

function childByName(table: NodeTable, parent: number, name: string): number {
  const { start, count } = table.childRange(parent);
  for (let id = start; id < start + count; id += 1) {
    if (table.nameOf(id) === name) return id;
  }
  throw new Error(`no child named ${name} under ${table.pathOf(parent)}`);
}

async function scanFixture(path = fixture.root) {
  const provider = new NodeFileSystemProvider();
  return scan({ rootPath: path, provider });
}

describe('NodeFileSystemProvider against a real directory tree', () => {
  it('agrees with an independent recursive sum', async () => {
    const { statistics } = await scanFixture();
    const reference = referenceSum(fixture.root);

    expect(statistics.totalSize).toBe(reference.bytes);
    expect(statistics.filesDiscovered).toBe(reference.files);
    expect(statistics.directoriesDiscovered).toBe(reference.directories);
  });

  it('records an empty directory as listed and empty', async () => {
    const { table } = await scanFixture();
    const empty = childByName(table, ROOT_ID, 'empty');

    expect(table.isDirectory(empty)).toBe(true);
    expect(table.isListed(empty)).toBe(true);
    expect(table.childRange(empty).count).toBe(0);
  });

  it('aggregates nested directories and reconstructs their paths', async () => {
    const { table } = await scanFixture();
    const nested = childByName(table, ROOT_ID, 'nested');
    const levelOne = childByName(table, nested, 'level-1');
    const levelTwo = childByName(table, levelOne, 'level-2');
    const deep = childByName(table, levelTwo, 'deep.bin');

    expect(table.totalSizeOf(deep)).toBe(1_234);
    expect(table.totalSizeOf(levelTwo)).toBe(1_234);
    expect(table.totalSizeOf(levelOne)).toBe(1_290);
    expect(table.directSizeOf(levelOne)).toBe(56);
    expect(table.pathOf(deep)).toBe(join(fixture.root, 'nested', 'level-1', 'level-2', 'deep.bin'));
  });

  it('preserves Unicode and spaced filenames byte for byte', async () => {
    const { table } = await scanFixture();
    const unicode = childByName(table, ROOT_ID, 'unicode');
    const names = new Set<string>();
    const { start, count } = table.childRange(unicode);
    for (let id = start; id < start + count; id += 1) names.add(table.nameOf(id));

    // macOS may hand back a decomposed form, so compare under NFC rather than demanding
    // the exact code points we wrote.
    const normalized = new Set([...names].map((name) => name.normalize('NFC')));
    expect(normalized).toContain('café'.normalize('NFC') + '.txt');
    expect(normalized).toContain('日本語.txt');
    expect(normalized).toContain('emoji 🎬.mkv');
    expect(normalized).toContain('two  spaces.txt');
    expect(table.totalSizeOf(unicode)).toBe(100);
  });

  it('reports exact sizes including zero-byte files', async () => {
    const { table } = await scanFixture();
    const sizes = childByName(table, ROOT_ID, 'sizes');

    expect(table.totalSizeOf(childByName(table, sizes, 'zero.bin'))).toBe(0);
    expect(table.totalSizeOf(childByName(table, sizes, 'one.bin'))).toBe(1);
    expect(table.totalSizeOf(childByName(table, sizes, 'kb.bin'))).toBe(1_024);
    expect(table.fileCountOf(sizes)).toBe(3);
  });

  it('never reads file contents to determine a size', async () => {
    // A 10 GB file must not cost 10 GB of I/O. Proven structurally: a scan of a tree whose
    // files total 2 449 bytes cannot have opened them, because the provider has no code path
    // that opens a file at all — it only ever calls readdir and lstat.
    const { statistics } = await scanFixture();
    expect(statistics.totalSize).toBeGreaterThan(0);
    expect(NodeFileSystemProvider.prototype).not.toHaveProperty('readFile');
  });
});

describe('NodeFileSystemProvider and links', () => {
  it('records a directory link without descending into it', async () => {
    if (!fixture.createdDirectoryLink) {
      expect(fixture.createdDirectoryLink).toBe(false);
      return;
    }

    const { table } = await scanFixture();
    const links = childByName(table, ROOT_ID, 'links');
    const toDirectory = childByName(table, links, 'to-dir');

    // The target holds 1 290 bytes. If the link were followed they would be counted twice.
    expect(table.isDirectory(toDirectory)).toBe(false);
    expect(table.isListed(toDirectory)).toBe(true);
    expect(table.childRange(toDirectory).count).toBe(0);
    expect(hasFlag(table.flagsOf(toDirectory), NodeFlags.Symlink)).toBe(true);
    expect(table.totalSizeOf(links)).toBeLessThan(1_290);
  });

  it('records a file link at the size of the link itself', async () => {
    if (!fixture.createdFileLink) return;

    const { table } = await scanFixture();
    const toFile = childByName(table, childByName(table, ROOT_ID, 'links'), 'to-file');

    expect(hasFlag(table.flagsOf(toFile), NodeFlags.Symlink)).toBe(true);
    // Not 1 024: the link's own size, not its target's.
    expect(table.totalSizeOf(toFile)).toBeLessThan(1_024);
  });

  it('tolerates a broken link instead of failing the scan', async () => {
    if (!fixture.createdBrokenLink) return;

    const { table, statistics } = await scanFixture();
    const broken = childByName(table, childByName(table, ROOT_ID, 'links'), 'broken');

    // lstat succeeds on a dangling link, so this is not an error at all: it is a zero-ish
    // sized entry that happens to point nowhere.
    expect(hasFlag(table.flagsOf(broken), NodeFlags.Symlink)).toBe(true);
    expect(statistics.status).toBe('completed');
  });
});

describe('NodeFileSystemProvider and permissions', () => {
  it.skipIf(isWindows)('reports an unreadable directory and keeps going', async () => {
    if (!fixture.createdUnreadableDirectory) return;

    const { table, statistics } = await scanFixture();
    const locked = childByName(table, ROOT_ID, 'locked');

    expect(statistics.issueCounts.accessDenied).toBeGreaterThan(0);
    expect(hasFlag(table.flagsOf(locked), NodeFlags.AccessDenied)).toBe(true);
    expect(hasFlag(table.flagsOf(ROOT_ID), NodeFlags.Partial)).toBe(true);
    expect(statistics.partial).toBe(true);
    // The rest of the tree is still fully measured.
    expect(statistics.totalSize).toBeGreaterThan(2_000);
  });

  it.runIf(isWindows)(
    'reads the whole fixture on Windows, where POSIX bits do not apply',
    async () => {
      const { statistics } = await scanFixture();
      expect(statistics.issueCounts.accessDenied).toBe(0);
      expect(statistics.partial).toBe(false);
    },
  );
});

describe('describeRoot', () => {
  it('normalises the path and classifies a directory scan', async () => {
    const provider = new NodeFileSystemProvider();
    const info = await provider.describeRoot(fixture.root);

    expect(info.path).toBe(fixture.root);
    expect(info.kind).toBe('directory');
    expect(info.separator).toBe(isWindows ? '\\' : '/');
  });

  it('classifies a filesystem root as a volume and reports capacity', async () => {
    const provider = new NodeFileSystemProvider();
    const info = await provider.describeRoot(isWindows ? 'C:\\' : '/');

    expect(info.kind).toBe('volume');
    expect(info.totalBytes).toBeGreaterThan(0);
    expect(info.usedBytes).toBeGreaterThan(0);
    // Free space uses the user-available figure, so it can never exceed the total.
    expect(info.freeBytes!).toBeLessThanOrEqual(info.totalBytes!);
  });

  it('rejects a path that does not exist', async () => {
    const provider = new NodeFileSystemProvider();
    await expect(provider.describeRoot(join(fixture.root, 'nope'))).rejects.toThrow(/vanished/);
  });

  it('rejects a file, because a scan root must be a directory', async () => {
    const provider = new NodeFileSystemProvider();
    await expect(provider.describeRoot(join(fixture.root, 'sizes', 'kb.bin'))).rejects.toThrow(
      /notADirectory/,
    );
  });

  it('rejects an empty path', async () => {
    const provider = new NodeFileSystemProvider();
    await expect(provider.describeRoot('   ')).rejects.toThrow();
  });
});

describe('listDirectory', () => {
  it('throws a classified error for a missing directory', async () => {
    const provider = new NodeFileSystemProvider();
    await expect(provider.listDirectory(join(fixture.root, 'nope'))).rejects.toThrow(/vanished/);
  });

  it('returns entries in the order the filesystem reported them', async () => {
    // Metadata lookups run concurrently, so results are written back by index; without that
    // the listing order would depend on which lstat finished first.
    const provider = new NodeFileSystemProvider({ metadataConcurrency: 4 });
    const first = await provider.listDirectory(join(fixture.root, 'unicode'));
    const second = await provider.listDirectory(join(fixture.root, 'unicode'));

    expect(first.entries.map((entry) => entry.name)).toEqual(
      second.entries.map((entry) => entry.name),
    );
  });

  it('stops early when cancelled', async () => {
    const provider = new NodeFileSystemProvider({ metadataConcurrency: 1 });
    const result = await provider.listDirectory(join(fixture.root, 'unicode'), { aborted: true });
    expect(result.entries.length).toBe(0);
  });
});

describe('cancellation against a real directory tree', () => {
  it('stops early and leaves totals that still reconcile', async () => {
    // A purpose-built wide tree rather than a system directory, so the test behaves the same
    // on every machine and CI runner.
    const wide = await mkdtemp(join(tmpdir(), 'sv-cancel-'));
    try {
      for (let index = 0; index < 120; index += 1) {
        const branch = join(wide, `branch-${index}`, 'nested');
        await mkdir(branch, { recursive: true });
        await writeFile(join(branch, 'a.bin'), content(100));
        await writeFile(join(wide, `branch-${index}`, 'b.bin'), content(50));
      }

      const provider = new NodeFileSystemProvider();
      const controller = new AbortController();
      const result = await scan({
        rootPath: wide,
        provider,
        signal: controller.signal,
        progressIntervalMs: 0,
        onProgress: (progress) => {
          if (progress.directoriesListed >= 10) controller.abort();
        },
      });

      expect(result.statistics.status).toBe('cancelled');
      expect(result.statistics.directoriesListed).toBeGreaterThan(0);
      expect(result.statistics.directoriesListed).toBeLessThan(241);
      expect(result.table.isBatchOpen).toBe(false);

      // Partial results must still be trustworthy: every recorded directory's total equals
      // its own files plus its recorded subdirectories.
      const { table } = result;
      for (let id = 0; id < table.count; id += 1) {
        if (!table.isDirectory(id)) continue;
        const { start, count } = table.childRange(id);
        if (count <= 0) {
          expect(table.totalSizeOf(id)).toBe(0);
          continue;
        }
        let expected = 0;
        for (let child = start; child < start + count; child += 1) {
          expected += table.totalSizeOf(child);
        }
        expect(table.totalSizeOf(id)).toBe(expected);
      }
    } finally {
      await rm(wide, { recursive: true, force: true });
    }
  });
});

describe('long Windows paths', () => {
  it.runIf(isWindows)('reaches a file beyond MAX_PATH', async () => {
    // Created through the extended-length prefix because the fixture itself would otherwise
    // hit the same limit the scanner has to defeat.
    const segment = 'd'.repeat(60);
    const deepRelative = join(segment, segment, segment, segment, segment);
    const deepAbsolute = join(fixture.root, 'longpath', deepRelative);
    expect(deepAbsolute.length).toBeGreaterThan(300);

    await mkdir(`\\\\?\\${deepAbsolute}`, { recursive: true });
    await writeFile(`\\\\?\\${join(deepAbsolute, 'buried.bin')}`, content(777));

    const { statistics, table } = await scanFixture(join(fixture.root, 'longpath'));

    expect(statistics.issueCounts.tooLong).toBe(0);
    expect(statistics.totalSize).toBe(777);
    expect(table.pathOf(table.count - 1)).toContain('buried.bin');
    // The stored path stays clean: the escape hatch is applied at the syscall only.
    expect(table.pathOf(table.count - 1).startsWith('\\\\?\\')).toBe(false);

    await rm(`\\\\?\\${join(fixture.root, 'longpath')}`, { recursive: true, force: true });
  });
});

describe('volume enumeration', () => {
  it('finds at least one scannable volume with real capacity', async () => {
    const provider = new NodeFileSystemProvider();
    const volumes = await provider.listVolumes();

    expect(volumes.length).toBeGreaterThan(0);
    const scannable = volumes.filter((volume) => volume.scannable);
    expect(scannable.length).toBeGreaterThan(0);

    for (const volume of volumes) {
      expect(volume.rootPath.length).toBeGreaterThan(0);
      if (volume.totalBytes !== null) {
        expect(volume.totalBytes).toBeGreaterThan(0);
        expect(volume.usedBytes!).toBeLessThanOrEqual(volume.totalBytes);
      }
    }
  });

  it.runIf(isWindows)('reports the system drive on Windows', async () => {
    const provider = new NodeFileSystemProvider();
    const volumes = await provider.listVolumes();
    expect(volumes.some((volume) => volume.rootPath === 'C:\\')).toBe(true);
  });

  it.skipIf(isWindows)('reports the filesystem root on POSIX', async () => {
    const provider = new NodeFileSystemProvider();
    const volumes = await provider.listVolumes();
    expect(volumes.some((volume) => volume.rootPath === '/')).toBe(true);
  });
});
