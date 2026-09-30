import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatchToSession } from '../src/scan-host/dispatch.ts';
import { ScanSession } from '../src/scan-host/session.ts';
import type { ScanFinishedEvent, ScanProgressEvent } from '../src/shared/protocol.ts';

/**
 * The scan host's behaviour, tested without Electron.
 *
 * Everything interesting about the host is here: one scan at a time, answering queries while a
 * scan is still in flight, cancellation, replacing a running scan, and releasing resources. The
 * process wiring around it is verified separately by `--selftest`, which launches the real
 * application.
 */

let fixtureRoot: string;
let progressEvents: ScanProgressEvent[];
let finishedEvents: ScanFinishedEvent[];
let session: ScanSession;

/** Small, exact tree: 50 100 bytes across 4 files, 3 directories. */
async function buildSmallFixture(root: string): Promise<void> {
  await mkdir(join(root, 'alpha', 'nested'), { recursive: true });
  await mkdir(join(root, 'beta'), { recursive: true });
  await mkdir(join(root, 'empty'), { recursive: true });
  await writeFile(join(root, 'alpha', 'nested', 'big.bin'), new Uint8Array(40_000));
  await writeFile(join(root, 'alpha', 'small.bin'), new Uint8Array(1_000));
  await writeFile(join(root, 'beta', 'medium.bin'), new Uint8Array(9_000));
  await writeFile(join(root, 'readme.txt'), new Uint8Array(100));
}

/** Wide enough that a scan is still running when the first progress event arrives. */
async function buildWideFixture(root: string, branches: number): Promise<void> {
  for (let index = 0; index < branches; index += 1) {
    const branch = join(root, `branch-${String(index).padStart(4, '0')}`, 'nested');
    await mkdir(branch, { recursive: true });
    await writeFile(join(branch, 'leaf.bin'), new Uint8Array(10));
  }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

const waitForFinish = (scanId: string): Promise<void> =>
  waitFor(
    () => finishedEvents.some((event) => event.scanId === scanId),
    `scan ${scanId} to finish`,
  );

beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'sv-session-'));
  progressEvents = [];
  finishedEvents = [];
  session = new ScanSession(
    {
      onProgress: (event) => progressEvents.push(event),
      onFinished: (event) => finishedEvents.push(event),
    },
    // Every progress tick, so tests do not depend on wall-clock timing.
    { progressIntervalMs: 0 },
  );
});

afterEach(async () => {
  await session.dispose();
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe('an idle session', () => {
  it('reports idle and answers queries without a table', () => {
    const status = session.status();
    expect(status.phase).toBe('idle');
    expect(status.scanId).toBeNull();
    expect(status.root).toBeNull();
    expect(status.finishedAgoMs).toBeNull();

    // Must not throw: the renderer queries on mount, before anything has been scanned.
    expect(session.node(0)).toBeNull();
    expect(
      session.children({ nodeId: 0, sort: 'size', order: 'desc', offset: 0, limit: 10 }),
    ).toEqual({ nodeId: 0, offset: 0, total: 0, rows: [] });
  });

  it('reports false when asked to cancel nothing', () => {
    expect(session.cancel('abc-123456')).toBe(false);
  });

  it('lists at least one volume', async () => {
    const volumes = await session.listVolumes();
    expect(volumes.length).toBeGreaterThan(0);
    expect(volumes.some((volume) => volume.scannable)).toBe(true);
  });
});

describe('a completed scan', () => {
  beforeEach(async () => {
    await buildSmallFixture(fixtureRoot);
  });

  it('reports the normalised root before reading anything', async () => {
    const { root, scanId } = await session.start(fixtureRoot);
    expect(root.path).toBe(fixtureRoot);
    expect(root.kind).toBe('directory');
    expect(scanId).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
    await waitForFinish(scanId);
  });

  it('moves through scanning to completed with exact totals', async () => {
    const { scanId } = await session.start(fixtureRoot);
    expect(session.status().phase).toBe('scanning');

    await waitForFinish(scanId);
    const status = session.status();

    expect(status.phase).toBe('completed');
    expect(status.statistics?.totalSize).toBe(50_100);
    expect(status.statistics?.filesDiscovered).toBe(4);
    // alpha, alpha/nested, beta, empty
    expect(status.statistics?.directoriesDiscovered).toBe(4);
    expect(status.statistics?.partial).toBe(false);
    expect(status.finishedAgoMs).toBeGreaterThanOrEqual(0);
  });

  it('emits progress and exactly one finish event', async () => {
    const { scanId } = await session.start(fixtureRoot);
    await waitForFinish(scanId);

    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents.every((event) => event.scanId === scanId)).toBe(true);
    expect(finishedEvents).toHaveLength(1);
    expect(finishedEvents[0]!.phase).toBe('completed');
  });

  it('returns the root with a single-entry breadcrumb', async () => {
    const { scanId } = await session.start(fixtureRoot);
    await waitForFinish(scanId);

    const result = session.node(0);
    expect(result?.node.path).toBe(fixtureRoot);
    expect(result?.node.parentId).toBeNull();
    expect(result?.node.depth).toBe(0);
    expect(result?.node.childCount).toBe(4);
    expect(result?.ancestors).toHaveLength(1);
  });

  it('builds a breadcrumb trail for a nested node', async () => {
    const { scanId } = await session.start(fixtureRoot);
    await waitForFinish(scanId);

    const top = session.children({ nodeId: 0, sort: 'size', order: 'desc', offset: 0, limit: 10 });
    const alpha = top.rows.find((row) => row.name === 'alpha');
    expect(alpha).toBeDefined();

    const nested = session.children({
      nodeId: alpha!.id,
      sort: 'size',
      order: 'desc',
      offset: 0,
      limit: 10,
    });
    const nestedDir = nested.rows.find((row) => row.name === 'nested');
    const detail = session.node(nestedDir!.id);

    expect(detail?.ancestors.map((entry) => entry.name)).toEqual([
      detail!.ancestors[0]!.name,
      'alpha',
      'nested',
    ]);
    expect(detail?.node.depth).toBe(2);
  });

  it('orders and pages children', async () => {
    const { scanId } = await session.start(fixtureRoot);
    await waitForFinish(scanId);

    const descending = session.children({
      nodeId: 0,
      sort: 'size',
      order: 'desc',
      offset: 0,
      limit: 10,
    });
    expect(descending.total).toBe(4);
    expect(descending.rows.map((row) => row.name)).toEqual([
      'alpha',
      'beta',
      'readme.txt',
      'empty',
    ]);

    const firstPage = session.children({
      nodeId: 0,
      sort: 'size',
      order: 'desc',
      offset: 0,
      limit: 2,
    });
    const secondPage = session.children({
      nodeId: 0,
      sort: 'size',
      order: 'desc',
      offset: 2,
      limit: 2,
    });
    expect(firstPage.rows.map((row) => row.name)).toEqual(['alpha', 'beta']);
    expect(secondPage.rows.map((row) => row.name)).toEqual(['readme.txt', 'empty']);
    expect(secondPage.total).toBe(4);

    const byName = session.children({
      nodeId: 0,
      sort: 'name',
      order: 'asc',
      offset: 0,
      limit: 10,
    });
    expect(byName.rows.map((row) => row.name)).toEqual(['alpha', 'beta', 'empty', 'readme.txt']);
  });

  it('clamps an offset beyond the end instead of failing', async () => {
    const { scanId } = await session.start(fixtureRoot);
    await waitForFinish(scanId);

    const page = session.children({
      nodeId: 0,
      sort: 'size',
      order: 'desc',
      offset: 9_999,
      limit: 10,
    });
    expect(page.rows).toEqual([]);
    expect(page.total).toBe(4);
    expect(page.offset).toBe(4);
  });

  it('answers a stale node id as empty rather than throwing', async () => {
    const { scanId } = await session.start(fixtureRoot);
    await waitForFinish(scanId);

    // The renderer can legitimately hold an id from a previous, larger scan.
    expect(session.node(999_999)).toBeNull();
    expect(
      session.children({ nodeId: 999_999, sort: 'size', order: 'desc', offset: 0, limit: 10 })
        .total,
    ).toBe(0);
  });

  it('returns an empty page for a file', async () => {
    const { scanId } = await session.start(fixtureRoot);
    await waitForFinish(scanId);

    const top = session.children({ nodeId: 0, sort: 'size', order: 'desc', offset: 0, limit: 10 });
    const file = top.rows.find((row) => !row.directory);
    expect(file).toBeDefined();
    expect(
      session.children({ nodeId: file!.id, sort: 'size', order: 'desc', offset: 0, limit: 10 })
        .rows,
    ).toEqual([]);
  });
});

describe('queries during a scan', () => {
  it('serves the live tree before the scan has finished', async () => {
    // This is the property that makes progressive results possible: the model is readable while
    // it is still being built, and every read sees a consistent tree.
    await buildWideFixture(fixtureRoot, 400);
    const { scanId } = await session.start(fixtureRoot);

    await waitFor(() => progressEvents.length > 0, 'the first progress event');
    const duringScan = session.children({
      nodeId: 0,
      sort: 'size',
      order: 'desc',
      offset: 0,
      limit: 5,
    });

    expect(session.status().phase).toBe('scanning');
    expect(duringScan.total).toBeGreaterThan(0);
    expect(session.node(0)?.node.path).toBe(fixtureRoot);

    await waitForFinish(scanId);
    expect(session.status().phase).toBe('completed');
  });
});

describe('cancellation', () => {
  it('cancels a running scan and reports it', async () => {
    await buildWideFixture(fixtureRoot, 600);
    const { scanId } = await session.start(fixtureRoot);

    await waitFor(() => progressEvents.length > 0, 'the first progress event');
    expect(session.cancel(scanId)).toBe(true);

    await waitForFinish(scanId);
    expect(finishedEvents[0]!.phase).toBe('cancelled');
    expect(session.status().phase).toBe('cancelled');
  });

  it('ignores a cancel for a different scan id', async () => {
    await buildWideFixture(fixtureRoot, 100);
    const { scanId } = await session.start(fixtureRoot);

    expect(session.cancel('zzzz-999999')).toBe(false);
    await waitForFinish(scanId);
    expect(session.status().phase).toBe('completed');
  });

  it('reports false once the scan has already finished', async () => {
    await buildSmallFixture(fixtureRoot);
    const { scanId } = await session.start(fixtureRoot);
    await waitForFinish(scanId);

    expect(session.cancel(scanId)).toBe(false);
  });
});

describe('replacing a running scan', () => {
  it('supersedes the first scan and keeps only the second as current', async () => {
    await buildWideFixture(fixtureRoot, 400);
    const first = await session.start(fixtureRoot);
    await waitFor(() => progressEvents.length > 0, 'the first scan to start producing');

    const second = await session.start(fixtureRoot);
    expect(second.scanId).not.toBe(first.scanId);
    expect(session.status().scanId).toBe(second.scanId);

    await waitForFinish(second.scanId);

    // The superseded scan must not have overwritten the newer one's state.
    expect(session.status().scanId).toBe(second.scanId);
    expect(session.status().phase).toBe('completed');
    expect(
      progressEvents.every(
        (event) => event.scanId === first.scanId || event.scanId === second.scanId,
      ),
    ).toBe(true);
  });
});

describe('failures', () => {
  it('rejects a start on a path that does not exist', async () => {
    await expect(session.start(join(fixtureRoot, 'nope'))).rejects.toThrow(/vanished/);
    // A failed start leaves the session usable rather than wedged.
    expect(['idle', 'scanning', 'failed']).toContain(session.status().phase);
  });

  it('rejects a start on a file', async () => {
    const file = join(fixtureRoot, 'a.bin');
    await writeFile(file, new Uint8Array(4));
    await expect(session.start(file)).rejects.toThrow(/notADirectory/);
  });
});

describe('dispose', () => {
  it('cancels a running scan and can be called twice', async () => {
    await buildWideFixture(fixtureRoot, 400);
    const { scanId } = await session.start(fixtureRoot);
    await waitFor(() => progressEvents.length > 0, 'the scan to start producing');

    await session.dispose();
    await session.dispose();

    // Nothing may still be reading the disk after disposal.
    expect(session.node(0)).toBeNull();
    expect(finishedEvents.some((event) => event.scanId === scanId)).toBe(true);
  });
});

describe('dispatchToSession', () => {
  it('turns a session failure into a response rather than a rejection', async () => {
    // A rejection would cross two process boundaries and surface a privileged stack trace in
    // the renderer.
    const response = await dispatchToSession(session, {
      command: 'startScan',
      payload: { path: join(fixtureRoot, 'missing') },
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.code).toBe('scanFailed');
      expect(response.message).toMatch(/vanished/);
    }
  });

  it('refuses pickDirectory, which belongs to the main process', async () => {
    const response = await dispatchToSession(session, { command: 'pickDirectory', payload: {} });
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.code).toBe('internal');
  });

  it('answers every other command', async () => {
    await buildSmallFixture(fixtureRoot);

    const started = await dispatchToSession(session, {
      command: 'startScan',
      payload: { path: fixtureRoot },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const { scanId } = started.value as { scanId: string };
    await waitForFinish(scanId);

    for (const request of [
      { command: 'listVolumes', payload: {} },
      { command: 'queryStatus', payload: {} },
      { command: 'queryNode', payload: { nodeId: 0 } },
      {
        command: 'queryChildren',
        payload: { nodeId: 0, sort: 'size', order: 'desc', offset: 0, limit: 5 },
      },
      { command: 'cancelScan', payload: { scanId } },
    ] as const) {
      const response = await dispatchToSession(session, request);
      expect(response.ok, `${request.command} should succeed`).toBe(true);
    }
  });
});
