import { NodeFlags, ROOT_ID, hasFlag, type NodeTable } from '@sv/core';
import { describe, expect, it } from 'vitest';
import { scan, type ScanProgress, type ScanResult } from '../src/index.ts';
import { assertTableInvariants } from './helpers/invariants.ts';
import {
  MemoryFileSystemProvider,
  deepChain,
  dir,
  file,
  link,
  specTotals,
  type MemoryDirectory,
  type MemoryProviderOptions,
} from './helpers/memory-provider.ts';

async function scanSpec(
  root: MemoryDirectory,
  options: MemoryProviderOptions = {},
): Promise<{ provider: MemoryFileSystemProvider; result: ScanResult }> {
  const provider = new MemoryFileSystemProvider(root, options);
  const result = await scan({ rootPath: provider.rootPath, provider });
  return { provider, result };
}

function childByName(table: NodeTable, parent: number, name: string): number {
  const { start, count } = table.childRange(parent);
  for (let id = start; id < start + count; id += 1) {
    if (table.nameOf(id) === name) return id;
  }
  throw new Error(`no child named ${name} under ${table.pathOf(parent)}`);
}

const sampleTree = dir({
  Users: dir({
    Yuvraj: dir({
      Downloads: dir({ 'movie.mkv': file(18_000), 'iso.img': file(7_000) }),
      Documents: dir({ 'notes.md': file(300) }),
      Empty: dir({}),
    }),
    Public: dir({ 'shared.bin': file(1_200) }),
  }),
  'Program Files': dir({ App: dir({ 'app.exe': file(5_000) }) }),
  'readme.txt': file(500),
});

describe('scan over a nested tree', () => {
  it('aggregates exactly what the spec contains', async () => {
    const { result } = await scanSpec(sampleTree);
    const expected = specTotals(sampleTree);

    expect(result.statistics.status).toBe('completed');
    expect(result.statistics.totalSize).toBe(expected.totalSize);
    expect(result.statistics.filesDiscovered).toBe(expected.fileCount);
    expect(result.statistics.directoriesDiscovered).toBe(expected.directoryCount);
    assertTableInvariants(result.table);
  });

  it('separates direct size from subtree total at every level', async () => {
    const { result } = await scanSpec(sampleTree);
    const { table } = result;

    const users = childByName(table, ROOT_ID, 'Users');
    const yuvraj = childByName(table, users, 'Yuvraj');
    const downloads = childByName(table, yuvraj, 'Downloads');

    expect(table.directSizeOf(ROOT_ID)).toBe(500);
    expect(table.totalSizeOf(ROOT_ID)).toBe(32_000);
    expect(table.directSizeOf(users)).toBe(0);
    expect(table.totalSizeOf(users)).toBe(26_500);
    expect(table.directSizeOf(downloads)).toBe(25_000);
    expect(table.totalSizeOf(downloads)).toBe(25_000);
  });

  it('records an empty directory as listed-and-empty, not unexplored', async () => {
    const { result } = await scanSpec(sampleTree);
    const { table } = result;
    const empty = childByName(
      table,
      childByName(table, childByName(table, ROOT_ID, 'Users'), 'Yuvraj'),
      'Empty',
    );

    expect(table.isListed(empty)).toBe(true);
    expect(table.childRange(empty).count).toBe(0);
    expect(table.totalSizeOf(empty)).toBe(0);
  });

  it('reads every directory exactly once', async () => {
    const { provider, result } = await scanSpec(sampleTree);
    expect(new Set(provider.listedPaths).size).toBe(provider.listedPaths.length);
    expect(provider.listedPaths.length).toBe(result.statistics.directoriesListed);
  });

  it('reconstructs paths for awkward names', async () => {
    const tree = dir({
      'two  spaces': dir({ 'file with spaces.txt': file(10) }),
      café: dir({ 'cafe\u0301-decomposed.txt': file(20) }),
      日本語: dir({ 'emoji 🎬.mkv': file(30) }),
      'lone\ud800surrogate': file(40),
    });
    const { result } = await scanSpec(tree);
    const { table } = result;

    const cjk = childByName(table, ROOT_ID, '日本語');
    expect(table.pathOf(childByName(table, cjk, 'emoji 🎬.mkv'))).toBe('/scan/日本語/emoji 🎬.mkv');
    expect(table.nameOf(childByName(table, ROOT_ID, 'lone\ud800surrogate'))).toBe(
      'lone\ud800surrogate',
    );
    expect(result.statistics.totalSize).toBe(100);
    assertTableInvariants(table);
  });

  it('walks a ten-thousand-level chain without recursion', async () => {
    const provider = new MemoryFileSystemProvider(deepChain(10_000, 4_096));
    // The default depth guard is 4 096, which is far more than any real filesystem; raised
    // here so the test exercises stack depth rather than the guard.
    const result = await scan({ rootPath: provider.rootPath, provider, maxDepth: 20_000 });

    expect(result.statistics.status).toBe('completed');
    expect(result.statistics.totalSize).toBe(4_096);
    expect(result.statistics.directoriesDiscovered).toBe(10_000);
    expect(result.statistics.issueCounts.tooDeep).toBe(0);
    expect(result.table.depthOf(result.table.count - 1)).toBe(10_001);
  });
});

describe('scan and links', () => {
  it('records links but never follows them', async () => {
    const tree = dir({
      real: dir({ 'big.bin': file(1_000_000) }),
      'symlink-to-dir': link({ size: 12, toDirectory: true }),
      'windows-junction': link({ size: 0, reparse: true }),
    });
    const { provider, result } = await scanSpec(tree);
    const { table } = result;

    // Only the link's own size counts; the target's contents are never walked, which is what
    // makes a cycle structurally impossible.
    expect(result.statistics.totalSize).toBe(1_000_012);
    expect(provider.listedPaths).not.toContain('/scan/symlink-to-dir');
    expect(provider.listedPaths).not.toContain('/scan/windows-junction');

    expect(
      hasFlag(table.flagsOf(childByName(table, ROOT_ID, 'symlink-to-dir')), NodeFlags.Symlink),
    ).toBe(true);
    expect(
      hasFlag(table.flagsOf(childByName(table, ROOT_ID, 'windows-junction')), NodeFlags.Reparse),
    ).toBe(true);
  });
});

describe('scan error handling', () => {
  it('survives a permission-denied directory and marks the ancestors partial', async () => {
    const tree = dir({
      open: dir({ 'a.bin': file(100) }),
      locked: dir({ 'never-seen.bin': file(999_999) }, { listingError: 'accessDenied' }),
    });
    const { result } = await scanSpec(tree);
    const { table, statistics } = result;

    expect(statistics.status).toBe('completed');
    expect(statistics.totalSize).toBe(100);
    expect(statistics.issueCounts.accessDenied).toBe(1);
    expect(statistics.partial).toBe(true);

    const locked = childByName(table, ROOT_ID, 'locked');
    expect(hasFlag(table.flagsOf(locked), NodeFlags.AccessDenied)).toBe(true);
    expect(table.isListed(locked)).toBe(true);
    expect(hasFlag(table.flagsOf(ROOT_ID), NodeFlags.Partial)).toBe(true);

    // The readable sibling is untouched by its neighbour's problem.
    expect(hasFlag(table.flagsOf(childByName(table, ROOT_ID, 'open')), NodeFlags.Partial)).toBe(
      false,
    );
    assertTableInvariants(table);
  });

  it('omits a file that vanished mid-scan and says so', async () => {
    const tree = dir({
      data: dir({
        'kept.bin': file(700),
        'temp.bin': file(50_000, { vanishes: true }),
      }),
    });
    const { result } = await scanSpec(tree);
    const { table, statistics } = result;

    expect(statistics.totalSize).toBe(700);
    expect(statistics.issueCounts.vanished).toBe(1);
    expect(statistics.entriesSkipped).toBe(1);

    const data = childByName(table, ROOT_ID, 'data');
    expect(table.childRange(data).count).toBe(1);
    // A file that no longer exists is not recorded at zero bytes; that would invent an entry.
    expect(() => childByName(table, data, 'temp.bin')).toThrow();
    expect(hasFlag(table.flagsOf(data), NodeFlags.Partial)).toBe(true);
    assertTableInvariants(table);
  });

  it('keeps an unreadable file in the tree, flagged, with no size', async () => {
    const tree = dir({ 'locked.bin': file(0, { unreadable: true }), 'ok.bin': file(10) });
    const { result } = await scanSpec(tree);
    const { table, statistics } = result;

    const locked = childByName(table, ROOT_ID, 'locked.bin');
    expect(hasFlag(table.flagsOf(locked), NodeFlags.AccessDenied)).toBe(true);
    expect(table.totalSizeOf(locked)).toBe(0);
    expect(statistics.totalSize).toBe(10);
    expect(statistics.partial).toBe(true);
  });

  it('classifies a non-permission listing failure without pretending the directory is empty', async () => {
    const tree = dir({
      flaky: dir({ 'x.bin': file(1) }, { listingError: 'ioError' }),
    });
    const { result } = await scanSpec(tree);
    const { table, statistics } = result;

    expect(statistics.issueCounts.ioError).toBe(1);
    const flaky = childByName(table, ROOT_ID, 'flaky');
    expect(table.isListed(flaky)).toBe(true);
    expect(hasFlag(table.flagsOf(flaky), NodeFlags.Partial)).toBe(true);
    expect(hasFlag(table.flagsOf(flaky), NodeFlags.AccessDenied)).toBe(false);
  });

  it('fails loudly when the scan root itself is unusable', async () => {
    const provider = new MemoryFileSystemProvider(dir({}));
    await expect(scan({ rootPath: '/does-not-exist', provider })).rejects.toThrow(/vanished/);
  });

  it('caps retained issue samples while still counting all of them', async () => {
    const children: Record<string, ReturnType<typeof dir>> = {};
    for (let index = 0; index < 100; index += 1) {
      children[`locked-${index}`] = dir({}, { listingError: 'accessDenied' });
    }

    const provider = new MemoryFileSystemProvider(dir(children));
    const result = await scan({
      rootPath: provider.rootPath,
      provider,
      issueSamplesPerCode: 5,
    });

    // Hundreds of thousands of denied paths must not become hundreds of thousands of retained
    // strings; the count is what matters and a handful of examples is what a user can read.
    expect(result.statistics.issueCounts.accessDenied).toBe(100);
    expect(result.statistics.issueSamples.length).toBe(5);
  });

  it('guards against unbounded depth', async () => {
    const provider = new MemoryFileSystemProvider(deepChain(50, 1_000));
    const result = await scan({ rootPath: provider.rootPath, provider, maxDepth: 10 });

    expect(result.statistics.issueCounts.tooDeep).toBeGreaterThan(0);
    expect(result.statistics.status).toBe('completed');
    assertTableInvariants(result.table);
  });

  it('rejects a name the storage model cannot address', async () => {
    const { result } = await scanSpec(dir({ ['x'.repeat(30_000)]: file(10), 'ok.bin': file(5) }));

    expect(result.statistics.issueCounts.invalidName).toBe(1);
    expect(result.statistics.totalSize).toBe(5);
  });
});

describe('scan cancellation', () => {
  it('stops promptly and leaves a tree that still adds up', async () => {
    const wide: Record<string, ReturnType<typeof dir>> = {};
    for (let index = 0; index < 200; index += 1) {
      wide[`branch-${index}`] = dir({
        nested: dir({ 'a.bin': file(1_000), 'b.bin': file(2_000) }),
        'c.bin': file(3_000),
      });
    }

    const provider = new MemoryFileSystemProvider(dir(wide), { asynchronous: true });
    const controller = new AbortController();

    const result = await scan({
      rootPath: provider.rootPath,
      provider,
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.directoriesListed >= 20) controller.abort();
      },
      progressIntervalMs: 0,
    });

    expect(result.statistics.status).toBe('cancelled');
    expect(result.statistics.directoriesListed).toBeGreaterThan(0);
    // Well short of the 401 directories a complete walk would read.
    expect(result.statistics.directoriesListed).toBeLessThan(200);

    // The point of a clean cancellation: partial results are still trustworthy.
    assertTableInvariants(result.table);
    expect(result.table.isBatchOpen).toBe(false);
  });

  it('does nothing at all when cancelled before it starts', async () => {
    const provider = new MemoryFileSystemProvider(sampleTree);
    const controller = new AbortController();
    controller.abort();

    const result = await scan({ rootPath: provider.rootPath, provider, signal: controller.signal });

    expect(result.statistics.status).toBe('cancelled');
    expect(result.statistics.directoriesListed).toBe(0);
    expect(provider.listedPaths).toEqual([]);
    expect(result.table.count).toBe(1);
  });
});

describe('scan progress', () => {
  it('reports monotonically rising totals and a final snapshot', async () => {
    const provider = new MemoryFileSystemProvider(
      dir({
        a: dir({ 'a1.bin': file(1_000), 'a2.bin': file(2_000) }),
        b: dir({ c: dir({ 'c1.bin': file(3_000) }) }),
      }),
      { asynchronous: true },
    );

    const updates: ScanProgress[] = [];
    const result = await scan({
      rootPath: provider.rootPath,
      provider,
      progressIntervalMs: 0,
      onProgress: (progress) => updates.push({ ...progress }),
    });

    expect(updates.length).toBeGreaterThan(1);
    for (let index = 1; index < updates.length; index += 1) {
      expect(updates[index]!.bytesDiscovered).toBeGreaterThanOrEqual(
        updates[index - 1]!.bytesDiscovered,
      );
      expect(updates[index]!.directoriesListed).toBeGreaterThanOrEqual(
        updates[index - 1]!.directoriesListed,
      );
    }

    const last = updates.at(-1)!;
    expect(last.bytesDiscovered).toBe(result.statistics.totalSize);
    expect(last.directoriesPending).toBe(0);
  });

  it('coalesces updates rather than emitting one per directory', async () => {
    const children: Record<string, ReturnType<typeof dir>> = {};
    for (let index = 0; index < 300; index += 1) children[`d-${index}`] = dir({ 'f.bin': file(1) });

    const provider = new MemoryFileSystemProvider(dir(children));
    let updates = 0;
    await scan({
      rootPath: provider.rootPath,
      provider,
      progressIntervalMs: 10_000,
      onProgress: () => {
        updates += 1;
      },
    });

    // One forced update at the start, one at the end. Anything more would be flooding the
    // UI across an IPC boundary 300 times for no benefit.
    expect(updates).toBe(2);
  });

  it('estimates a fraction only when it has an honest denominator', async () => {
    const tree = dir({ 'a.bin': file(400) });

    const withoutCapacity = new MemoryFileSystemProvider(tree);
    const withoutUpdates: ScanProgress[] = [];
    await scan({
      rootPath: withoutCapacity.rootPath,
      provider: withoutCapacity,
      progressIntervalMs: 0,
      onProgress: (progress) => withoutUpdates.push({ ...progress }),
    });
    // A directory scan has no meaningful total, so no percentage is invented.
    expect(withoutUpdates.at(-1)!.estimatedFraction).toBeNull();

    const withCapacity = new MemoryFileSystemProvider(tree);
    const withUpdates: ScanProgress[] = [];
    await scan({
      rootPath: withCapacity.rootPath,
      provider: withCapacity,
      expectedTotalBytes: 1_000,
      progressIntervalMs: 0,
      onProgress: (progress) => withUpdates.push({ ...progress }),
    });
    expect(withUpdates.at(-1)!.estimatedFraction).toBeCloseTo(0.4, 10);
  });

  it('never reports a fraction above 1 even if the estimate was low', async () => {
    const provider = new MemoryFileSystemProvider(dir({ 'a.bin': file(10_000) }));
    const updates: ScanProgress[] = [];
    await scan({
      rootPath: provider.rootPath,
      provider,
      expectedTotalBytes: 100,
      progressIntervalMs: 0,
      onProgress: (progress) => updates.push({ ...progress }),
    });
    expect(updates.at(-1)!.estimatedFraction).toBe(1);
  });
});

describe('scan concurrency', () => {
  it('never exceeds the configured number of directory listings in flight', async () => {
    const children: Record<string, ReturnType<typeof dir>> = {};
    for (let index = 0; index < 50; index += 1) {
      children[`d-${index}`] = dir({ nested: dir({ 'f.bin': file(1) }) });
    }

    const provider = new MemoryFileSystemProvider(dir(children), { asynchronous: true });
    await scan({ rootPath: provider.rootPath, provider, concurrency: 4 });

    // Unbounded concurrency over a real filesystem exhausts file descriptors; the cap is a
    // correctness property, not a tuning knob.
    expect(provider.peakConcurrency).toBeGreaterThan(1);
    expect(provider.peakConcurrency).toBeLessThanOrEqual(4);
  });

  it('still completes correctly when restricted to one listing at a time', async () => {
    const provider = new MemoryFileSystemProvider(sampleTree, { asynchronous: true });
    const result = await scan({ rootPath: provider.rootPath, provider, concurrency: 1 });

    expect(provider.peakConcurrency).toBe(1);
    expect(result.statistics.totalSize).toBe(specTotals(sampleTree).totalSize);
    assertTableInvariants(result.table);
  });

  it('visits entries in listing order despite a LIFO frontier', async () => {
    const provider = new MemoryFileSystemProvider(
      dir({ alpha: dir({}), beta: dir({}), gamma: dir({}) }),
    );
    await scan({ rootPath: provider.rootPath, provider, concurrency: 1 });

    expect(provider.listedPaths).toEqual(['/scan', '/scan/alpha', '/scan/beta', '/scan/gamma']);
  });
});

describe('scan statistics', () => {
  it('reconciles discovered, analysed and skipped counts', async () => {
    const tree = dir({
      good: dir({ 'a.bin': file(10), 'b.bin': file(20) }),
      locked: dir({}, { listingError: 'accessDenied' }),
      gone: dir({ 'ghost.bin': file(999, { vanishes: true }) }),
    });
    const { result } = await scanSpec(tree);
    const { statistics } = result;

    expect(statistics.issueCounts.accessDenied).toBe(1);
    expect(statistics.issueCounts.vanished).toBe(1);
    expect(statistics.entriesSkipped).toBe(2);
    expect(statistics.issueSamples.length).toBe(2);
    expect(statistics.durationMs).toBeGreaterThanOrEqual(0);
    expect(statistics.finishedAt).toBeGreaterThanOrEqual(statistics.startedAt);
  });

  it('compacts the table so a finished scan holds no growth headroom', async () => {
    const { result } = await scanSpec(sampleTree);
    const stats = result.table.stats();
    expect(stats.capacity).toBe(stats.nodeCount);
  });

  it('exposes the root description it was given', async () => {
    const provider = new MemoryFileSystemProvider(sampleTree, {
      rootPath: '/',
      volumeTotalBytes: 500_000,
      volumeUsedBytes: 250_000,
    });
    const result = await scan({ rootPath: '/', provider });

    expect(result.root.kind).toBe('volume');
    expect(result.root.totalBytes).toBe(500_000);
    expect(result.table.rootPath).toBe('/');
  });
});
