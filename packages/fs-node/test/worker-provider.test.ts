import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_ID, type NodeTable } from '@sv/core';
import { scan, type ScanResult } from '@sv/scan-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NodeFileSystemProvider } from '../src/node-provider.ts';
import { WorkerFileSystemProvider } from '../src/worker-provider.ts';

/**
 * Tests for the worker-pool provider.
 *
 * The pool is an optimisation, which means the only thing that really matters about it is that it
 * cannot change an answer. So the central test here is equivalence: the same tree, scanned by both
 * providers, must produce byte-identical results. Everything else — cancellation, crash recovery,
 * teardown — is about the pool failing safely rather than hanging a scan.
 */

const WORKER_ENTRY = new URL('../src/worker/entry.ts', import.meta.url);
const DYING_WORKER_ENTRY = new URL('./fixtures/dying-worker.ts', import.meta.url);

/** Bytes of content, so each file has a distinct and verifiable size. */
const content = (size: number): Uint8Array => new Uint8Array(size).fill(0x41);

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sv-worker-'));

  // Wide and deep enough that several workers are genuinely busy at once, and that a cancellation
  // can land partway through rather than always before or after the whole thing.
  for (let branch = 0; branch < 24; branch += 1) {
    const branchPath = join(root, `branch-${String(branch).padStart(2, '0')}`);
    await mkdir(join(branchPath, 'nested', 'deeper'), { recursive: true });
    await writeFile(join(branchPath, 'top.bin'), content(branch + 1));
    await writeFile(join(branchPath, 'nested', 'mid.bin'), content(100 + branch));
    await writeFile(join(branchPath, 'nested', 'deeper', 'leaf.bin'), content(1_000 + branch));
  }

  await mkdir(join(root, 'empty'));
  await mkdir(join(root, 'unicode'));
  await writeFile(join(root, 'unicode', 'café.txt'), content(10));
  await writeFile(join(root, 'unicode', '日本語.txt'), content(20));
  await writeFile(join(root, 'unicode', 'emoji 🎬.mkv'), content(30));
  await writeFile(join(root, 'zero.bin'), content(0));
});

afterAll(async () => {
  if (root === undefined) return;
  await rm(root, { recursive: true, force: true });
});

function createPool(options: { workerCount?: number } = {}): WorkerFileSystemProvider {
  return new WorkerFileSystemProvider({
    workerEntry: WORKER_ENTRY,
    workerCount: options.workerCount ?? 4,
  });
}

/** Runs `body` with a pool and guarantees its threads are gone afterwards. */
async function withPool<T>(
  options: { workerCount?: number },
  body: (provider: WorkerFileSystemProvider) => Promise<T>,
): Promise<T> {
  const provider = createPool(options);
  try {
    return await body(provider);
  } finally {
    await provider.dispose();
  }
}

/**
 * Flattens a table into a comparable shape.
 *
 * Paths rather than ids, because the two providers can legitimately assign different ids: the
 * engine numbers nodes in the order listings complete, and with four threads that order is not the
 * single-threaded one. The *set* of nodes and every number attached to them must still match
 * exactly.
 */
function fingerprint(table: NodeTable): string[] {
  const rows: string[] = [];
  for (let id = ROOT_ID; id < table.count; id += 1) {
    rows.push(
      [
        table.pathOf(id),
        table.isDirectory(id) ? 'dir' : 'file',
        table.totalSizeOf(id),
        table.directSizeOf(id),
        table.fileCountOf(id),
        table.directoryCountOf(id),
        table.flagsOf(id),
        table.isListed(id) ? 'listed' : 'unlisted',
      ].join('\u0000'),
    );
  }
  // Sorted because sibling order follows the filesystem's listing order, which is stable per
  // directory but interleaved differently across a concurrent scan.
  return rows.sort();
}

describe('WorkerFileSystemProvider equivalence with the single-threaded provider', () => {
  let simple: ScanResult;
  let pooled: ScanResult;

  beforeAll(async () => {
    simple = await scan({ rootPath: root, provider: new NodeFileSystemProvider() });
    pooled = await withPool({ workerCount: 4 }, (provider) => scan({ rootPath: root, provider }));
  });

  it('produces an identical set of nodes with identical numbers', () => {
    // Asserted first so the comparison below cannot pass by comparing two empty trees, which is
    // exactly how this test would rot if the fixture ever stopped being created.
    expect(simple.table.count).toBeGreaterThan(100);
    expect(simple.statistics.totalSize).toBeGreaterThan(0);

    expect(fingerprint(pooled.table)).toEqual(fingerprint(simple.table));
  });

  it('agrees on every scan statistic that describes the tree', () => {
    expect(pooled.statistics.totalSize).toBe(simple.statistics.totalSize);
    expect(pooled.statistics.filesDiscovered).toBe(simple.statistics.filesDiscovered);
    expect(pooled.statistics.directoriesDiscovered).toBe(simple.statistics.directoriesDiscovered);
    expect(pooled.statistics.directoriesListed).toBe(simple.statistics.directoriesListed);
    expect(pooled.statistics.entriesSkipped).toBe(simple.statistics.entriesSkipped);
    expect(pooled.statistics.partial).toBe(simple.statistics.partial);
    expect(pooled.statistics.status).toBe('completed');
  });

  it('agrees on the root breakdown the UI would draw', () => {
    const names = (result: ScanResult): string[] =>
      [...result.table.sortedChildIds(ROOT_ID, { by: 'size', order: 'desc' })].map((id) =>
        result.table.nameOf(id),
      );
    expect(names(pooled)).toEqual(names(simple));
  });

  it('returns identical entries for a single directory listing', async () => {
    const path = join(root, 'unicode');
    const fromSimple = await new NodeFileSystemProvider().listDirectory(path);
    const fromPool = await withPool({ workerCount: 1 }, (provider) => provider.listDirectory(path));

    // Including order: the engine does not sort listings, so a difference here would surface as
    // differently ordered siblings in the UI.
    expect(fromPool.entries).toEqual(fromSimple.entries);
  });

  it('reports the same capabilities the engine relies on', () => {
    const pool = createPool();
    try {
      const simpleCapabilities = new NodeFileSystemProvider().capabilities;
      expect(pool.capabilities.listsIncrementally).toBe(simpleCapabilities.listsIncrementally);
      expect(pool.capabilities.detectsSymlinks).toBe(simpleCapabilities.detectsSymlinks);
      expect(pool.capabilities.enumeratesVolumes).toBe(simpleCapabilities.enumeratesVolumes);
      expect(pool.capabilities.reportsCapacity).toBe(simpleCapabilities.reportsCapacity);
      // The name must differ: it is what tells a bug report which provider produced a number.
      expect(pool.capabilities.name).not.toBe(simpleCapabilities.name);
    } finally {
      void pool.dispose();
    }
  });
});

describe('WorkerFileSystemProvider delegated metadata', () => {
  it('describes a root through the shared single-threaded implementation', async () => {
    const info = await withPool({ workerCount: 2 }, (provider) => provider.describeRoot(root));
    const reference = await new NodeFileSystemProvider().describeRoot(root);

    // Field by field rather than `toEqual`, because free and used bytes are live figures for a
    // volume the rest of the machine is also writing to: comparing two separate readings of them
    // is a test that fails whenever something else saves a file.
    expect(info.path).toBe(reference.path);
    expect(info.separator).toBe(reference.separator);
    expect(info.kind).toBe(reference.kind);
    expect(info.totalBytes).toBe(reference.totalBytes);
    // Capacity is still asserted, just as a shape rather than an exact value.
    expect(info.freeBytes).toBeGreaterThan(0);
    expect(info.usedBytes).toBeGreaterThan(0);
    expect(info.freeBytes! + info.usedBytes!).toBeLessThanOrEqual(info.totalBytes!);
  });

  it('enumerates the same volumes as the single-threaded provider', async () => {
    const volumes = await withPool({ workerCount: 2 }, (provider) => provider.listVolumes());
    const reference = await new NodeFileSystemProvider().listVolumes();
    expect(volumes.map((volume) => volume.rootPath)).toEqual(
      reference.map((volume) => volume.rootPath),
    );
  });

  it('does not spawn a thread just to answer a metadata question', async () => {
    const provider = createPool({ workerCount: 4 });
    try {
      await provider.describeRoot(root);
      await provider.listVolumes();
      expect(provider.workerCount).toBe(0);
    } finally {
      await provider.dispose();
    }
  });
});

describe('WorkerFileSystemProvider errors', () => {
  it('classifies a missing directory the same way the simple provider does', async () => {
    const missing = join(root, 'does-not-exist');
    await expect(
      withPool({ workerCount: 1 }, (provider) => provider.listDirectory(missing)),
    ).rejects.toThrow(/vanished/);
  });

  it('rejects rather than hangs when the worker entry cannot be loaded', async () => {
    const provider = new WorkerFileSystemProvider({
      workerEntry: new URL('./fixtures/not-a-real-module.ts', import.meta.url),
      workerCount: 1,
    });
    try {
      // The failure arrives as an `error` event on the worker, not as a rejected postMessage, so
      // without the retire path this call would never settle and a scan would stall forever.
      await expect(provider.listDirectory(root)).rejects.toThrow(/ioError/);
    } finally {
      await provider.dispose();
    }
  });

  it('answers the request a crashed worker was holding and replaces the worker', async () => {
    const provider = new WorkerFileSystemProvider({
      workerEntry: DYING_WORKER_ENTRY,
      workerCount: 1,
    });
    try {
      await expect(provider.listDirectory(root)).rejects.toThrow(/ioError/);
      // The dead worker is gone rather than left in the pool marked busy, which would deadlock
      // every later listing behind a thread that is never going to answer.
      expect(provider.workerCount).toBe(0);

      // A second request proves the pool refills instead of silently degrading to no workers.
      await expect(provider.listDirectory(root)).rejects.toThrow(/ioError/);
    } finally {
      await provider.dispose();
    }
  });

  it('does not lose other listings when one worker dies', async () => {
    // Two workers, one request each: a crash must cost exactly the directory it was holding.
    const provider = new WorkerFileSystemProvider({
      workerEntry: DYING_WORKER_ENTRY,
      workerCount: 2,
    });
    try {
      const results = await Promise.allSettled([
        provider.listDirectory(root),
        provider.listDirectory(join(root, 'unicode')),
      ]);
      // Both fail here because this entry kills every worker, but the point is that both *settle*.
      expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    } finally {
      await provider.dispose();
    }
  });
});

describe('WorkerFileSystemProvider cancellation', () => {
  it('stops a scan early and leaves reconcilable totals', async () => {
    const provider = createPool({ workerCount: 4 });
    try {
      const controller = new AbortController();
      const result = await scan({
        rootPath: root,
        provider,
        signal: controller.signal,
        progressIntervalMs: 0,
        onProgress: (progress) => {
          if (progress.directoriesListed >= 4) controller.abort();
        },
      });

      expect(result.statistics.status).toBe('cancelled');
      expect(result.statistics.directoriesListed).toBeGreaterThan(0);
      expect(result.table.isBatchOpen).toBe(false);

      // Partial results still have to be internally consistent: every listed directory's total is
      // exactly the sum of what was recorded beneath it.
      const { table } = result;
      for (let id = ROOT_ID; id < table.count; id += 1) {
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
      await provider.dispose();
    }
  });

  it('returns an empty listing when the signal is already aborted', async () => {
    const result = await withPool({ workerCount: 1 }, (provider) =>
      provider.listDirectory(join(root, 'unicode'), { aborted: true }),
    );
    // The shared flag is written before the request is posted, so the worker sees it on its first
    // entry check rather than after reading the directory.
    expect(result.entries.length).toBe(0);
  });

  it('scans normally again after a cancelled scan', async () => {
    const provider = createPool({ workerCount: 4 });
    try {
      const controller = new AbortController();
      await scan({
        rootPath: root,
        provider,
        signal: controller.signal,
        progressIntervalMs: 0,
        onProgress: () => controller.abort(),
      });

      // The cancel flag is shared across the whole pool, so if a cancelled scan left it set the
      // next scan would read every directory as empty. This is the test that catches that.
      const second = await scan({ rootPath: root, provider });
      const reference = await scan({ rootPath: root, provider: new NodeFileSystemProvider() });

      expect(second.statistics.status).toBe('completed');
      expect(second.statistics.totalSize).toBe(reference.statistics.totalSize);
    } finally {
      await provider.dispose();
    }
  });
});

describe('WorkerFileSystemProvider teardown', () => {
  it('leaves no workers alive', async () => {
    const provider = createPool({ workerCount: 4 });
    await scan({ rootPath: root, provider });
    expect(provider.workerCount).toBe(4);

    await provider.dispose();
    expect(provider.workerCount).toBe(0);
  });

  it('is idempotent', async () => {
    const provider = createPool({ workerCount: 2 });
    await provider.listDirectory(root);
    await provider.dispose();
    await expect(provider.dispose()).resolves.toBeUndefined();
    expect(provider.workerCount).toBe(0);
  });

  it('refuses further listings instead of silently spawning new threads', async () => {
    const provider = createPool({ workerCount: 2 });
    await provider.dispose();
    await expect(provider.listDirectory(root)).rejects.toThrow(/disposed/);
    expect(provider.workerCount).toBe(0);
  });

  it('settles listings that were still outstanding', async () => {
    const provider = createPool({ workerCount: 1 });
    // Not awaited: dispose has to answer a request that is genuinely in flight. If these were left
    // pending the caller would await forever and a scan would never finish shutting down.
    const inFlight = Promise.allSettled([
      provider.listDirectory(root),
      // Queued behind the first, with only one worker, so this exercises the waiting list too.
      provider.listDirectory(join(root, 'unicode')),
    ]);

    await provider.dispose();
    const results = await inFlight;
    expect(results).toHaveLength(2);
    for (const result of results) expect(result.status).toBeDefined();
  });

  it('does not accumulate workers across repeated scans', async () => {
    const provider = createPool({ workerCount: 3 });
    try {
      for (let round = 0; round < 4; round += 1) {
        const result = await scan({ rootPath: root, provider });
        expect(result.statistics.status).toBe('completed');
        // A pool that respawned per scan, or leaked a worker per listing, would climb here.
        expect(provider.workerCount).toBe(3);
      }
    } finally {
      await provider.dispose();
    }
  });

  it('holds memory flat across repeated scans', async () => {
    const provider = createPool({ workerCount: 3 });
    try {
      await scan({ rootPath: root, provider });
      // Typed arrays live outside the V8 heap, so `arrayBuffers` is the figure that would move if
      // the pool were retaining listings or cancel buffers.
      const before = process.memoryUsage().arrayBuffers;
      for (let round = 0; round < 6; round += 1) await scan({ rootPath: root, provider });
      const after = process.memoryUsage().arrayBuffers;

      // Generous, because the scan tables themselves are not collected deterministically. The leak
      // this catches is per-scan growth, which over six rounds would be far larger than this.
      expect(after - before).toBeLessThan(16 * 1024 * 1024);
    } finally {
      await provider.dispose();
    }
  });
});

describe('WorkerFileSystemProvider configuration', () => {
  it('spawns exactly the requested number of workers', async () => {
    for (const workerCount of [1, 2, 6]) {
      const provider = createPool({ workerCount });
      try {
        await scan({ rootPath: root, provider });
        expect(provider.workerCount).toBe(workerCount);
      } finally {
        await provider.dispose();
      }
    }
  });

  it('treats a nonsensical worker count as one worker', async () => {
    const provider = new WorkerFileSystemProvider({
      workerEntry: WORKER_ENTRY,
      workerCount: 0,
    });
    try {
      await provider.listDirectory(root);
      expect(provider.workerCount).toBe(1);
    } finally {
      await provider.dispose();
    }
  });

  it('spawns lazily, so constructing a provider costs nothing', () => {
    const provider = createPool({ workerCount: 8 });
    try {
      expect(provider.workerCount).toBe(0);
    } finally {
      void provider.dispose();
    }
  });

  it('works with more engine concurrency than workers, by queueing', async () => {
    // The engine's concurrency and the pool size are independent settings; a deeper queue must
    // slow things down at worst, never drop or duplicate a listing.
    const provider = createPool({ workerCount: 2 });
    try {
      const result = await scan({ rootPath: root, provider, concurrency: 32 });
      const reference = await scan({ rootPath: root, provider: new NodeFileSystemProvider() });
      expect(fingerprint(result.table)).toEqual(fingerprint(reference.table));
    } finally {
      await provider.dispose();
    }
  });
});
