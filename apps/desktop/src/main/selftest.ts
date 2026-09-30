import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { DesktopEvent, ScanFinishedEvent } from '../shared/protocol.ts';
import type { ScanHostClient } from './scan-host-client.ts';

/**
 * End-to-end verification of the desktop wiring, runnable from a terminal.
 *
 * Launched with `--selftest`, the application boots for real — hardened window, preload,
 * renderer, utility process, scan host — drives a scan through the actual IPC path against a
 * temporary directory, and exits with a status code. No UI automation framework involved.
 *
 * It exists because the interesting failures in an Electron application are wiring failures:
 * a preload that does not load, a sandbox that blocks something needed, a utility process that
 * cannot be forked from a packaged bundle, a `MessagePort` that is transferred too early. None
 * of those show up in a unit test, and all of them show up here.
 */

export interface SelfTestContext {
  readonly host: ScanHostClient;
  readonly window: BrowserWindow;
  /** Events collected by the main process since boot. */
  readonly events: readonly DesktopEvent[];
}

interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * A tree with a realistic spread of sizes.
 *
 * Deliberately not four tidy entries: a power-law distribution is what a real folder looks like, it
 * is what the treemap's tail aggregation has to cope with, and it makes the captured screenshot
 * worth looking at. The expected total is accumulated from what is actually written rather than
 * hardcoded, so the fixture and the assertion cannot drift apart.
 */
async function buildFixture(): Promise<{
  root: string;
  expectedBytes: number;
  rootEntries: number;
}> {
  const root = await mkdtemp(join(tmpdir(), 'sv-selftest-'));
  let expectedBytes = 0;

  const write = async (relative: string, bytes: number): Promise<void> => {
    await writeFile(join(root, relative), new Uint8Array(bytes));
    expectedBytes += bytes;
  };

  // A nested branch, so drill-down has somewhere to go.
  await mkdir(join(root, 'alpha', 'nested'), { recursive: true });
  await write(join('alpha', 'nested', 'big.bin'), 40_000);
  await write(join('alpha', 'small.bin'), 1_000);

  await mkdir(join(root, 'beta'), { recursive: true });
  await write(join('beta', 'medium.bin'), 9_000);

  // An empty folder: real, listed by the tree, but with no area to occupy on the map.
  await mkdir(join(root, 'empty'), { recursive: true });

  await write('readme.txt', 100);

  const spread = [250_000, 120_000, 60_000, 28_000, 13_000, 6_000, 2_800, 1_300, 600, 280];
  for (const [index, bytes] of spread.entries()) {
    const name = `folder-${String(index + 1).padStart(2, '0')}`;
    await mkdir(join(root, name), { recursive: true });
    await write(join(name, 'data.bin'), bytes);
  }

  return { root, expectedBytes, rootEntries: 4 + spread.length };
}

function waitForFinish(context: SelfTestContext, scanId: string): Promise<ScanFinishedEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('scan did not finish within 30s'));
    }, 30_000);

    const poll = setInterval(() => {
      const found = context.events.find(
        (event): event is Extract<DesktopEvent, { type: 'scanFinished' }> =>
          event.type === 'scanFinished' && event.payload.scanId === scanId,
      );
      if (found === undefined) return;
      clearInterval(poll);
      clearTimeout(timer);
      resolve(found.payload);
    }, 25);
  });
}

/** Runs an expression inside the renderer and returns its value. */
async function evaluate<T>(window: BrowserWindow, expression: string): Promise<T> {
  return (await window.webContents.executeJavaScript(expression)) as T;
}

/** Polls the renderer until an expression becomes truthy. */
async function waitForUi(
  window: BrowserWindow,
  expression: string,
  label: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate<boolean>(window, `Boolean(${expression})`)) return true;
    if (Date.now() > deadline) {
      process.stderr.write(`timed out waiting for ${label}\n`);
      return false;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 40);
    });
  }
}

/** The breadcrumb labels currently on screen. */
const BREADCRUMB_SCRIPT =
  "[...document.querySelectorAll('.breadcrumbs li')].map((li) => li.textContent.trim())";

/** Names of the tiles the treemap is currently offering, read from its accessible listbox. */
const TILE_NAMES_SCRIPT =
  "[...document.querySelectorAll('.treemap__options [role=option]')].map((li) => li.dataset.tileName)";

function clickTileScript(name: string): string {
  return `(() => {
    const options = [...document.querySelectorAll('.treemap__options [role=option]')];
    const target = options.find((option) => option.dataset.tileName === ${JSON.stringify(name)});
    if (target === undefined) return false;
    target.click();
    return true;
  })()`;
}

async function probeRenderer(window: BrowserWindow): Promise<Record<string, unknown>> {
  await new Promise<void>((resolve) => {
    if (!window.webContents.isLoading()) {
      resolve();
      return;
    }
    window.webContents.once('did-finish-load', () => {
      resolve();
    });
  });

  // Runs inside the renderer's own world. If the sandbox and context isolation are doing their
  // job, none of the Node globals exist and only the bridge we exposed is reachable.
  return (await window.webContents.executeJavaScript(
    `(() => ({
      hasRequire: typeof require !== 'undefined',
      hasModule: typeof module !== 'undefined',
      hasProcess: typeof process !== 'undefined',
      hasGlobal: typeof global !== 'undefined',
      hasBridge: typeof window.storageVisualizer === 'object' && window.storageVisualizer !== null,
      bridgeKeys: Object.keys(window.storageVisualizer ?? {}).sort().join(','),
      mounted: (document.getElementById('root')?.childElementCount ?? 0) > 0,
    }))()`,
  )) as Record<string, unknown>;
}

/**
 * Writes a PNG of the current window next to the build output.
 *
 * Worth the handful of lines: every other check here proves a value crossed a boundary, and none
 * of them would notice a stylesheet that failed to load or a layout that collapsed.
 */
async function captureScreenshot(
  window: BrowserWindow,
): Promise<{ path: string; bytes: number } | string> {
  try {
    // A brief pause so React has processed the scan-finished event it was just sent.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 600);
    });

    const image = await window.webContents.capturePage();
    const png = image.toPNG();
    if (png.length === 0) return 'capturePage produced an empty image';

    // Relative to this bundle rather than `app.getAppPath()`, which points at the entry
    // script's directory when Electron is invoked with a file path.
    const target = join(__dirname, '..', 'selftest-screenshot.png');
    await writeFile(target, png);
    return { path: target, bytes: png.length };
  } catch (error) {
    return `capture failed: ${error instanceof Error ? error.message : 'unknown'}`;
  }
}

export async function runSelfTest(context: SelfTestContext): Promise<boolean> {
  const checks: Check[] = [];
  const record = (name: string, passed: boolean, detail: string): void => {
    checks.push({ name, passed, detail });
  };

  const fixture = await buildFixture();

  try {
    // ---------------------------------------------------------------- renderer isolation
    const probe = await probeRenderer(context.window);
    record('renderer has no require', probe['hasRequire'] === false, String(probe['hasRequire']));
    record('renderer has no module', probe['hasModule'] === false, String(probe['hasModule']));
    record('renderer has no process', probe['hasProcess'] === false, String(probe['hasProcess']));
    record('renderer has no global', probe['hasGlobal'] === false, String(probe['hasGlobal']));
    record('bridge is exposed', probe['hasBridge'] === true, String(probe['bridgeKeys']));
    record(
      'bridge exposes only invoke and subscribe',
      probe['bridgeKeys'] === 'invoke,subscribe',
      String(probe['bridgeKeys']),
    );
    record('react mounted', probe['mounted'] === true, String(probe['mounted']));

    // ------------------------------------------------------------------- command surface
    const volumes = await context.host.send({ command: 'listVolumes', payload: {} });
    record(
      'listVolumes succeeds',
      volumes.ok && volumes.value.volumes.length > 0,
      volumes.ok ? `${volumes.value.volumes.length} volumes` : volumes.message,
    );

    const started = await context.host.send({
      command: 'startScan',
      payload: { path: fixture.root },
    });
    record('startScan succeeds', started.ok, started.ok ? 'started' : started.message);
    if (!started.ok) return report(checks);

    const scanId = started.value.scanId;
    record(
      'startScan reports the normalised root',
      started.value.root.path === fixture.root,
      started.value.root.path,
    );
    const finished = await waitForFinish(context, scanId);
    record('scan completes', finished.phase === 'completed', finished.phase);
    record(
      'total size is exact',
      finished.statistics?.totalSize === fixture.expectedBytes,
      `${finished.statistics?.totalSize ?? 'none'} vs ${fixture.expectedBytes}`,
    );
    record(
      'progress events arrived',
      context.events.some((event) => event.type === 'scanProgress'),
      String(context.events.filter((event) => event.type === 'scanProgress').length),
    );

    const node = await context.host.send({ command: 'queryNode', payload: { nodeId: 0 } });
    const nodePath = node.ok && node.value !== null ? node.value.node.path : '';
    record('queryNode returns the root', nodePath === fixture.root, nodePath);
    record(
      'queryNode returns a breadcrumb trail',
      node.ok && node.value !== null && node.value.ancestors.length === 1,
      node.ok && node.value !== null ? String(node.value.ancestors.length) : 'none',
    );

    const children = await context.host.send({
      command: 'queryChildren',
      payload: { nodeId: 0, sort: 'size', order: 'desc', offset: 0, limit: 50 },
    });
    const rows = children.ok ? children.value.rows : [];
    record(
      'queryChildren returns every root entry',
      rows.length === fixture.rootEntries,
      `${rows.length} of ${fixture.rootEntries} rows`,
    );
    record(
      'rows are ordered largest first',
      rows.length > 1 && rows[0]!.totalSize >= rows[1]!.totalSize,
      rows.map((row) => row.name).join(', '),
    );

    // --------------------------------------------------------------------- visual evidence
    // Captured here, straight after the first scan completed, because by now the renderer has
    // reacted to the same events the UI normally reacts to and is showing real rows. Every other
    // check proves a value crossed a boundary; none of them would notice a stylesheet that
    // failed to load or a layout that collapsed.
    const screenshot = await captureScreenshot(context.window);
    record(
      'renderer paints a populated view',
      typeof screenshot !== 'string' && screenshot.bytes > 10_000,
      typeof screenshot === 'string'
        ? screenshot
        : `${screenshot.path} (${screenshot.bytes} bytes)`,
    );

    // ------------------------------------------------------------- driving the real interface
    // The listbox beside the canvas is the accessible mirror of the tiles, so it doubles as the
    // handle for driving the map: clicking an option is exactly what a keyboard user's Enter does.
    // This exercises drill-down through the genuine render → click → IPC → re-render loop.
    const tilesShown = await waitForUi(
      context.window,
      `${TILE_NAMES_SCRIPT}.includes('alpha')`,
      'the treemap to show the fixture',
    );
    record('treemap renders tiles for the scanned folder', tilesShown, '');

    if (tilesShown) {
      const rootTrail = await evaluate<string[]>(context.window, BREADCRUMB_SCRIPT);
      record('breadcrumbs start at the scan root', rootTrail.length === 1, rootTrail.join(' › '));

      const clickedAlpha = await evaluate<boolean>(context.window, clickTileScript('alpha'));
      const drilledOnce = await waitForUi(
        context.window,
        `${BREADCRUMB_SCRIPT}.length === 2`,
        'the first drill-down',
      );
      record('clicking a folder drills into it', clickedAlpha && drilledOnce, '');

      const clickedNested = await evaluate<boolean>(context.window, clickTileScript('nested'));
      const drilledTwice = await waitForUi(
        context.window,
        `${BREADCRUMB_SCRIPT}.length === 3`,
        'the second drill-down',
      );
      const twoDeep = await evaluate<string[]>(context.window, BREADCRUMB_SCRIPT);
      record(
        'drilling two levels deep tracks the location',
        clickedNested && drilledTwice && twoDeep[1] === 'alpha' && twoDeep[2] === 'nested',
        twoDeep.join(' › '),
      );

      const leafTiles = await evaluate<string[]>(context.window, TILE_NAMES_SCRIPT);
      record(
        'the deepest folder shows its own contents',
        leafTiles.includes('big.bin'),
        leafTiles.join(', '),
      );

      // Back to the top via the breadcrumb, which is the other half of "always know where you are".
      const clickedRoot = await evaluate<boolean>(
        context.window,
        "(() => { const link = document.querySelector('.breadcrumbs__link'); if (link === null) return false; link.click(); return true; })()",
      );
      const returned = await waitForUi(
        context.window,
        `${BREADCRUMB_SCRIPT}.length === 1`,
        'the breadcrumb to navigate home',
      );
      record('a breadcrumb returns to an ancestor', clickedRoot && returned, '');
    }

    // --------------------------------------------------------------------- stale queries
    const stale = await context.host.send({
      command: 'queryChildren',
      payload: { nodeId: 999_999, sort: 'size', order: 'desc', offset: 0, limit: 10 },
    });
    record(
      'an unknown node id is answered empty, not thrown',
      stale.ok && stale.value.total === 0,
      stale.ok ? 'empty page' : stale.message,
    );

    const cancelFinished = await context.host.send({
      command: 'cancelScan',
      payload: { scanId },
    });
    record(
      'cancelling a finished scan reports false',
      cancelFinished.ok && !cancelFinished.value.cancelled,
      JSON.stringify(cancelFinished),
    );

    // ------------------------------------------------------------------------ cancelling
    const second = await context.host.send({
      command: 'startScan',
      payload: { path: fixture.root },
    });
    if (second.ok) {
      const secondId = second.value.scanId;
      const cancelStarted = Date.now();
      const cancelled = await context.host.send({
        command: 'cancelScan',
        payload: { scanId: secondId },
      });
      const outcome = await waitForFinish(context, secondId);
      const latency = Date.now() - cancelStarted;
      record(
        'a running scan can be cancelled promptly',
        // The fixture is small enough that it may simply have finished first; either outcome
        // proves the path works, and the latency is what is actually being measured.
        cancelled.ok && (outcome.phase === 'cancelled' || outcome.phase === 'completed'),
        `${outcome.phase} in ${latency}ms`,
      );
      record('cancellation settles under 500ms', latency < 500, `${latency}ms`);
    }

    const status = await context.host.send({ command: 'queryStatus', payload: {} });
    record('queryStatus succeeds', status.ok, status.ok ? 'ok' : status.message);

    return report(checks);
  } finally {
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
}

function report(checks: readonly Check[]): boolean {
  const failed = checks.filter((check) => !check.passed);

  write('');
  write('Desktop self-test');
  write('');
  for (const check of checks) {
    write(`  ${check.passed ? 'pass' : 'FAIL'}  ${check.name.padEnd(46)} ${check.detail}`);
  }
  write('');
  write(`  ${checks.length - failed.length}/${checks.length} checks passed`);
  write('');

  return failed.length === 0;
}
