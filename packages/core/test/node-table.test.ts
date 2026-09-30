import { describe, expect, it } from 'vitest';
import { NO_NODE, NOT_LISTED, NodeFlags, ROOT_ID, hasFlag } from '../src/model.ts';
import { NodeTable } from '../src/node-table.ts';

function windowsTable(rootPath = 'C:\\'): NodeTable {
  return new NodeTable({ rootPath });
}

/** Listing: C:\ -> { Users/ (Yuvraj/ -> 2 files), Windows/ (1 file), readme.txt } */
function buildSampleTree(): { table: NodeTable; users: number; yuvraj: number; windows: number } {
  const table = windowsTable();

  const firstTopLevel = table.addChildren(ROOT_ID, [
    { name: 'Users', directory: true, size: 0 },
    { name: 'Windows', directory: true, size: 0 },
    { name: 'readme.txt', directory: false, size: 500 },
  ]);
  const users = firstTopLevel;
  const windows = firstTopLevel + 1;

  const yuvraj = table.addChildren(users, [{ name: 'Yuvraj', directory: true, size: 0 }]);
  table.addChildren(yuvraj, [
    { name: 'movie.mkv', directory: false, size: 18_000 },
    { name: 'notes.md', directory: false, size: 2_000 },
  ]);
  table.addChildren(windows, [{ name: 'system.dll', directory: false, size: 1_000 }]);

  return { table, users, yuvraj, windows };
}

describe('NodeTable root', () => {
  it('always has a root at index 0', () => {
    const table = windowsTable();
    expect(table.count).toBe(1);
    expect(table.parentOf(ROOT_ID)).toBe(NO_NODE);
    expect(table.depthOf(ROOT_ID)).toBe(0);
    expect(table.isDirectory(ROOT_ID)).toBe(true);
    expect(table.totalSizeOf(ROOT_ID)).toBe(0);
  });

  it('names a volume root after the volume and a folder scan after the folder', () => {
    expect(windowsTable('C:\\').nameOf(ROOT_ID)).toBe('C:\\');
    expect(new NodeTable({ rootPath: '/' }).nameOf(ROOT_ID)).toBe('/');

    const folder = new NodeTable({ rootPath: 'C:\\Users\\Yuvraj\\Projects' });
    expect(folder.nameOf(ROOT_ID)).toBe('Projects');
    expect(folder.pathOf(ROOT_ID)).toBe('C:\\Users\\Yuvraj\\Projects');
  });

  it('normalises the root path separators once, on the way in', () => {
    const table = new NodeTable({ rootPath: 'C:/Users/Yuvraj' });
    expect(table.rootPath).toBe('C:\\Users\\Yuvraj');
    expect(table.separator).toBe('\\');
  });

  it('starts out not listed, which is different from being empty', () => {
    const table = windowsTable();
    expect(table.isListed(ROOT_ID)).toBe(false);
    expect(table.childRange(ROOT_ID).count).toBe(NOT_LISTED);

    table.addChildren(ROOT_ID, []);
    expect(table.isListed(ROOT_ID)).toBe(true);
    expect(table.childRange(ROOT_ID).count).toBe(0);
  });
});

describe('NodeTable structure', () => {
  it('stores a listing as one contiguous block of ids', () => {
    const table = windowsTable();
    const first = table.addChildren(ROOT_ID, [
      { name: 'a', directory: false, size: 1 },
      { name: 'b', directory: false, size: 2 },
      { name: 'c', directory: false, size: 3 },
    ]);

    const range = table.childRange(ROOT_ID);
    expect(range.start).toBe(first);
    expect(range.count).toBe(3);
    expect([first, first + 1, first + 2].map((id) => table.nameOf(id))).toEqual(['a', 'b', 'c']);
  });

  it('reconstructs absolute paths by walking parents', () => {
    const { table, yuvraj } = buildSampleTree();
    const movie = table.childRange(yuvraj).start;

    expect(table.pathOf(yuvraj)).toBe('C:\\Users\\Yuvraj');
    expect(table.pathOf(movie)).toBe('C:\\Users\\Yuvraj\\movie.mkv');
  });

  it('reconstructs POSIX paths without a doubled root separator', () => {
    const table = new NodeTable({ rootPath: '/' });
    const home = table.addChildren(ROOT_ID, [{ name: 'home', directory: true, size: 0 }]);
    table.addChildren(home, [{ name: 'yuvraj', directory: true, size: 0 }]);

    expect(table.pathOf(home)).toBe('/home');
    expect(table.pathOf(table.childRange(home).start)).toBe('/home/yuvraj');
  });

  it('round-trips awkward Unicode names through the name pool', () => {
    const table = new NodeTable({ rootPath: '/data' });
    const names = [
      'café',
      'cafe\u0301',
      '日本語',
      'emoji 🎬.mkv',
      'lone\ud800surrogate',
      'two  spaces',
    ];
    const first = table.addChildren(
      ROOT_ID,
      names.map((name) => ({ name, directory: false, size: 1 })),
    );

    expect(names.map((_name, index) => table.nameOf(first + index))).toEqual(names);
    expect(table.pathOf(first + 3)).toBe('/data/emoji 🎬.mkv');
  });

  it('produces a breadcrumb trail from root to node', () => {
    const { table, yuvraj, users } = buildSampleTree();
    const movie = table.childRange(yuvraj).start;

    expect([...table.ancestorsOf(movie)]).toEqual([ROOT_ID, users, yuvraj, movie]);
    expect([...table.ancestorsOf(ROOT_ID)]).toEqual([ROOT_ID]);
  });

  it('handles a very deep chain without recursion', () => {
    const depth = 10_000;
    const table = new NodeTable({ rootPath: '/' });
    let current = ROOT_ID;
    for (let level = 0; level < depth; level += 1) {
      current = table.addChildren(current, [{ name: `level-${level}`, directory: true, size: 0 }]);
    }
    table.addChildren(current, [{ name: 'deep.bin', directory: false, size: 4096 }]);

    expect(table.depthOf(current)).toBe(depth);
    expect(table.totalSizeOf(ROOT_ID)).toBe(4096);
    expect(table.ancestorsOf(current).length).toBe(depth + 1);
    expect(table.pathOf(current).endsWith('/level-9999')).toBe(true);
  });

  it('grows past its initial capacity without losing data', () => {
    const table = new NodeTable({ rootPath: '/', initialCapacity: 16 });
    const count = 5_000;
    const entries = Array.from({ length: count }, (_unused, index) => ({
      name: `file-${index}`,
      directory: false,
      size: index,
    }));
    const first = table.addChildren(ROOT_ID, entries);

    expect(table.count).toBe(count + 1);
    expect(table.nameOf(first)).toBe('file-0');
    expect(table.nameOf(first + count - 1)).toBe(`file-${count - 1}`);
    expect(table.totalSizeOf(ROOT_ID)).toBe((count * (count - 1)) / 2);
  });
});

describe('NodeTable aggregation', () => {
  it('separates direct size from subtree total', () => {
    const { table, users, yuvraj } = buildSampleTree();

    // C:\ holds one file directly (readme.txt) but 21 500 bytes in total.
    expect(table.directSizeOf(ROOT_ID)).toBe(500);
    expect(table.totalSizeOf(ROOT_ID)).toBe(21_500);

    // Users holds no files directly; everything comes from Yuvraj.
    expect(table.directSizeOf(users)).toBe(0);
    expect(table.totalSizeOf(users)).toBe(20_000);

    expect(table.directSizeOf(yuvraj)).toBe(20_000);
    expect(table.totalSizeOf(yuvraj)).toBe(20_000);
  });

  it('counts files and directories across the whole subtree, excluding itself', () => {
    const { table, users, yuvraj } = buildSampleTree();

    expect(table.fileCountOf(ROOT_ID)).toBe(4); // readme, movie, notes, system.dll
    expect(table.directoryCountOf(ROOT_ID)).toBe(3); // Users, Yuvraj, Windows
    expect(table.fileCountOf(users)).toBe(2);
    expect(table.directoryCountOf(users)).toBe(1);
    expect(table.fileCountOf(yuvraj)).toBe(2);
    expect(table.directoryCountOf(yuvraj)).toBe(0);
  });

  it('gives a file its own size as its total and nothing as its direct size', () => {
    const { table } = buildSampleTree();
    const readme = table.childRange(ROOT_ID).start + 2;

    expect(table.totalSizeOf(readme)).toBe(500);
    expect(table.directSizeOf(readme)).toBe(0);
    expect(table.fileCountOf(readme)).toBe(0);
  });

  it('keeps totals live and monotonic while a scan is still running', () => {
    // Progressive results are a product requirement: a partially scanned tree must show
    // honest rising numbers rather than zeroes that jump at the end.
    const table = windowsTable();
    const first = table.addChildren(ROOT_ID, [
      { name: 'Users', directory: true, size: 0 },
      { name: 'readme.txt', directory: false, size: 500 },
    ]);
    expect(table.totalSizeOf(ROOT_ID)).toBe(500);

    const deeper = table.addChildren(first, [{ name: 'Yuvraj', directory: true, size: 0 }]);
    expect(table.totalSizeOf(ROOT_ID)).toBe(500);

    table.addChildren(deeper, [{ name: 'movie.mkv', directory: false, size: 18_000 }]);
    expect(table.totalSizeOf(ROOT_ID)).toBe(18_500);
    expect(table.totalSizeOf(first)).toBe(18_000);
  });

  it('records flags for entries it deliberately does not traverse', () => {
    const table = new NodeTable({ rootPath: '/' });
    const first = table.addChildren(ROOT_ID, [
      { name: 'link', directory: false, size: 12, flags: NodeFlags.Symlink },
      { name: 'junction', directory: true, size: 0, flags: NodeFlags.Reparse },
    ]);

    expect(hasFlag(table.flagsOf(first), NodeFlags.Symlink)).toBe(true);
    // A symlink's own size counts; its target is never followed, so nothing else does.
    expect(table.totalSizeOf(ROOT_ID)).toBe(12);
    expect(hasFlag(table.flagsOf(first + 1), NodeFlags.Reparse)).toBe(true);
  });
});

describe('NodeTable partial results', () => {
  it('flags an unreadable directory and every ancestor as partial', () => {
    const table = windowsTable();
    const users = table.addChildren(ROOT_ID, [{ name: 'Users', directory: true, size: 0 }]);
    const yuvraj = table.addChildren(users, [{ name: 'Yuvraj', directory: true, size: 0 }]);
    const locked = table.addChildren(yuvraj, [
      { name: 'AppData', directory: true, size: 0 },
      { name: 'notes.md', directory: false, size: 100 },
    ]);

    table.markAccessDenied(locked);

    expect(hasFlag(table.flagsOf(locked), NodeFlags.AccessDenied)).toBe(true);
    for (const id of [locked, yuvraj, users, ROOT_ID]) {
      expect(hasFlag(table.flagsOf(id), NodeFlags.Partial)).toBe(true);
    }
    // The sibling file was read fine, so it is not itself suspect.
    expect(hasFlag(table.flagsOf(locked + 1), NodeFlags.Partial)).toBe(false);
  });

  it('treats an unreadable directory as listed-and-empty rather than never looked at', () => {
    const table = new NodeTable({ rootPath: '/' });
    const locked = table.addChildren(ROOT_ID, [{ name: 'root-only', directory: true, size: 0 }]);
    expect(table.isListed(locked)).toBe(false);

    table.markAccessDenied(locked);
    expect(table.isListed(locked)).toBe(true);
    expect(table.childRange(locked).count).toBe(0);
  });

  it('propagates partial from an inaccessible child discovered during a listing', () => {
    const table = new NodeTable({ rootPath: '/' });
    const parent = table.addChildren(ROOT_ID, [{ name: 'dir', directory: true, size: 0 }]);
    table.addChildren(parent, [
      { name: 'ok.txt', directory: false, size: 10 },
      { name: 'locked.txt', directory: false, size: 0, flags: NodeFlags.AccessDenied },
    ]);

    expect(hasFlag(table.flagsOf(parent), NodeFlags.Partial)).toBe(true);
    expect(hasFlag(table.flagsOf(ROOT_ID), NodeFlags.Partial)).toBe(true);
  });
});

describe('NodeTable invariants', () => {
  it('rejects a second listing for the same directory', () => {
    const table = windowsTable();
    table.addChildren(ROOT_ID, [{ name: 'a', directory: false, size: 1 }]);
    expect(() => table.addChildren(ROOT_ID, [])).toThrow(/already recorded/);
  });

  it('rejects interleaved listings, which would break child contiguity', () => {
    const table = windowsTable();
    const dir = table.addChildren(ROOT_ID, [{ name: 'dir', directory: true, size: 0 }]);
    table.beginChildren(dir);
    expect(() => table.beginChildren(ROOT_ID)).toThrow(/still open/);
  });

  it('rejects listing a file', () => {
    const table = windowsTable();
    const file = table.addChildren(ROOT_ID, [{ name: 'a.txt', directory: false, size: 1 }]);
    expect(() => table.beginChildren(file)).toThrow(/not a directory/);
  });

  it('rejects pushing or ending without an open batch', () => {
    const table = windowsTable();
    expect(() => table.pushChild('x', 0, 1, Number.NaN)).toThrow(/open batch/);
    expect(() => table.endChildren()).toThrow(/open batch/);
  });

  it('rejects out-of-range node ids', () => {
    const table = windowsTable();
    expect(() => table.nameOf(1)).toThrow(RangeError);
    expect(() => table.nameOf(-1)).toThrow(RangeError);
    expect(() => table.totalSizeOf(1.5)).toThrow(RangeError);
  });

  it('rejects compaction while a listing is open', () => {
    const table = windowsTable();
    table.beginChildren(ROOT_ID);
    expect(() => table.compact()).toThrow(/batch is open/);
  });

  it('rejects a name too long to address', () => {
    const table = windowsTable();
    table.beginChildren(ROOT_ID);
    expect(() => table.pushChild('x'.repeat(70_000), 0, 1, Number.NaN)).toThrow(RangeError);
  });
});

describe('NodeTable ordering', () => {
  function orderingTable(): NodeTable {
    const table = new NodeTable({ rootPath: '/' });
    table.addChildren(ROOT_ID, [
      { name: 'file10', directory: false, size: 300, mtimeMs: 3000 },
      { name: 'file2', directory: false, size: 100, mtimeMs: 1000 },
      { name: 'Alpha', directory: false, size: 300, mtimeMs: Number.NaN },
      { name: 'beta', directory: false, size: 200, mtimeMs: 2000 },
    ]);
    return table;
  }

  function names(table: NodeTable, ids: Int32Array): string[] {
    return [...ids].map((id) => table.nameOf(id));
  }

  it('orders by size descending by default, because that is the product question', () => {
    const table = orderingTable();
    expect(names(table, table.sortedChildIds(ROOT_ID))).toEqual([
      'file10',
      'Alpha',
      'beta',
      'file2',
    ]);
  });

  it('breaks ties deterministically by id rather than relying on sort stability', () => {
    const table = orderingTable();
    const ids = table.sortedChildIds(ROOT_ID, { by: 'size', order: 'desc' });
    // file10 and Alpha are both 300 bytes; the earlier id wins.
    expect(ids[0]).toBeLessThan(ids[1]!);
  });

  it('orders by size ascending on request', () => {
    const table = orderingTable();
    // The 300-byte tie resolves by ascending id in both directions, so the ascending
    // result is not simply the reverse of the descending one. That is intentional: a
    // total, reproducible order matters more than being a mirror image.
    expect(names(table, table.sortedChildIds(ROOT_ID, { order: 'asc' }))).toEqual([
      'file2',
      'beta',
      'file10',
      'Alpha',
    ]);
  });

  it('orders names naturally and case-insensitively, like a file manager', () => {
    const table = orderingTable();
    expect(names(table, table.sortedChildIds(ROOT_ID, { by: 'name', locale: 'en' }))).toEqual([
      'Alpha',
      'beta',
      'file2',
      'file10',
    ]);
  });

  it('sorts unknown timestamps as oldest instead of poisoning the comparison', () => {
    const table = orderingTable();
    const ordered = names(table, table.sortedChildIds(ROOT_ID, { by: 'modified' }));
    expect(ordered).toEqual(['file10', 'beta', 'file2', 'Alpha']);
  });

  it('returns an empty result for files and unlisted directories', () => {
    const table = orderingTable();
    expect(table.sortedChildIds(table.childRange(ROOT_ID).start).length).toBe(0);

    const fresh = new NodeTable({ rootPath: '/' });
    expect(fresh.sortedChildIds(ROOT_ID).length).toBe(0);
  });
});

describe('NodeTable upkeep', () => {
  it('compacts away growth headroom without changing any answer', () => {
    const table = new NodeTable({ rootPath: '/', initialCapacity: 1024 });
    const first = table.addChildren(
      ROOT_ID,
      Array.from({ length: 100 }, (_unused, index) => ({
        name: `file-${index}`,
        directory: false,
        size: index * 10,
      })),
    );

    const before = table.stats();
    const totalBefore = table.totalSizeOf(ROOT_ID);
    table.compact();
    const after = table.stats();

    expect(after.capacity).toBe(101);
    expect(after.capacity).toBeLessThan(before.capacity);
    expect(after.columnBytes).toBeLessThan(before.columnBytes);
    expect(table.totalSizeOf(ROOT_ID)).toBe(totalBefore);
    expect(table.nameOf(first + 99)).toBe('file-99');
    expect(table.pathOf(first + 50)).toBe('/file-50');
  });

  it('reports scan-wide statistics from the root', () => {
    const { table } = buildSampleTree();
    const stats = table.stats();

    expect(stats.nodeCount).toBe(table.count);
    expect(stats.fileCount).toBe(4);
    expect(stats.directoryCount).toBe(3);
    expect(stats.totalSize).toBe(21_500);
    expect(stats.nameBytes).toBeGreaterThan(0);
  });

  it('omits the allocated-size column unless asked, then tracks it', () => {
    const plain = new NodeTable({ rootPath: '/' });
    expect(plain.allocatedSizeOf(ROOT_ID)).toBeNull();
    plain.setAllocatedSize(ROOT_ID, 4096); // no-op, must not throw
    expect(plain.allocatedSizeOf(ROOT_ID)).toBeNull();

    const tracked = new NodeTable({ rootPath: '/', trackAllocatedSize: true });
    const file = tracked.addChildren(ROOT_ID, [{ name: 'sparse.bin', directory: false, size: 1 }]);
    tracked.setAllocatedSize(file, 4096);

    expect(tracked.allocatedSizeOf(file)).toBe(4096);
    // Apparent size is unchanged: the two are deliberately independent.
    expect(tracked.totalSizeOf(file)).toBe(1);

    // Compare per-capacity column cost, not per-node cost: with a handful of nodes the
    // fixed name-pool headroom dominates and would mask the difference.
    const plainStats = plain.stats();
    const trackedStats = tracked.stats();
    expect(plainStats.columnBytes / plainStats.capacity).toBe(53);
    expect(trackedStats.columnBytes / trackedStats.capacity).toBe(61);
  });
});
