/**
 * `pnpm scan <path>` — the scanner with no UI attached.
 *
 * This exists so the traversal engine can be exercised, measured and debugged against real
 * disks long before there is an Electron window to put it in. It prints a live top-level
 * breakdown while the scan runs, which is the same progressive-results behaviour the
 * product depends on, demonstrated at its simplest.
 */
import {
  ROOT_ID,
  formatBytes,
  formatCount,
  formatPercent,
  fractionOf,
  type NodeTable,
} from '@sv/core';
import { SCAN_ISSUE_CODES, scan, type ScanProgress, type ScanResult } from '@sv/scan-engine';
import { NodeFileSystemProvider } from '../node-provider.ts';
import { renderBar, renderTree } from './tree.ts';

const LOCALE = 'en-US';
const bytes = (value: number): string => formatBytes(value, { locale: LOCALE });
const count = (value: number): string => formatCount(value, LOCALE);
const percent = (value: number): string => formatPercent(value, { locale: LOCALE });

const USAGE = `
Usage
  pnpm scan <path> [options]
  pnpm scan --volumes

Options
  --volumes                   List volumes on this machine and exit
  --tree                      Print the hierarchy as an indented tree
  --depth <n>                 Levels to expand with --tree (default 3)
  --top <n>                   Rows of top-level breakdown to show (default 10)
  --concurrency <n>           Directory listings in flight (default 8)
  --metadata-concurrency <n>  Metadata lookups per directory (default 8)
  --max-depth <n>             Depth guard (default 4096)
  --json                      Emit a machine-readable summary instead of live output
  --no-live                   Plain line-by-line progress, for logs and CI
  --help

Press Ctrl+C during a scan to cancel; partial results are still reported.
`;

interface CommandLine {
  readonly path: string | null;
  readonly showVolumes: boolean;
  readonly json: boolean;
  readonly live: boolean;
  readonly tree: boolean;
  readonly treeDepth: number;
  readonly top: number;
  readonly concurrency: number | undefined;
  readonly metadataConcurrency: number | undefined;
  readonly maxDepth: number | undefined;
  readonly help: boolean;
}

function parseArguments(argv: readonly string[]): CommandLine {
  let path: string | null = null;
  let showVolumes = false;
  let json = false;
  let live = true;
  let tree = false;
  let treeDepth = 3;
  let top = 10;
  let concurrency: number | undefined;
  let metadataConcurrency: number | undefined;
  let maxDepth: number | undefined;
  let help = false;

  const readNumber = (index: number, flag: string): number => {
    const raw = argv[index];
    const value = raw === undefined ? Number.NaN : Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${flag} needs a positive number, got ${raw ?? '(nothing)'}`);
    }
    return Math.trunc(value);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    switch (argument) {
      case '--volumes':
        showVolumes = true;
        break;
      case '--json':
        json = true;
        break;
      case '--no-live':
        live = false;
        break;
      case '--tree':
        tree = true;
        break;
      case '--depth':
        treeDepth = readNumber(index + 1, '--depth');
        tree = true;
        index += 1;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      case '--top':
        top = readNumber(index + 1, '--top');
        index += 1;
        break;
      case '--concurrency':
        concurrency = readNumber(index + 1, '--concurrency');
        index += 1;
        break;
      case '--metadata-concurrency':
        metadataConcurrency = readNumber(index + 1, '--metadata-concurrency');
        index += 1;
        break;
      case '--max-depth':
        maxDepth = readNumber(index + 1, '--max-depth');
        index += 1;
        break;
      default:
        if (argument.startsWith('-')) throw new Error(`unknown option ${argument}`);
        if (path !== null) throw new Error('only one path may be scanned at a time');
        path = argument;
    }
  }

  return {
    path,
    showVolumes,
    json,
    live,
    tree,
    treeDepth,
    top,
    concurrency,
    metadataConcurrency,
    maxDepth,
    help,
  };
}

/** Shortens text from the middle, keeping both the drive and the filename visible. */
function ellipsize(text: string, width: number): string {
  if (width <= 4 || text.length <= width) return text;
  const head = Math.ceil((width - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (width - 1 - head))}`;
}

function topLevelRows(table: NodeTable, limit: number): string[] {
  if (!table.isListed(ROOT_ID)) return ['  (reading the top level…)'];

  const total = table.totalSizeOf(ROOT_ID);
  const ids = table.sortedChildIds(ROOT_ID, { by: 'size', order: 'desc' });
  const shown = Math.min(limit, ids.length);
  if (shown === 0) return ['  (empty)'];

  const rows: string[] = [];
  for (let index = 0; index < shown; index += 1) {
    const id = ids[index]!;
    // A trailing separator marks a directory, the way `ls -F` does.
    const name = table.isDirectory(id) ? table.nameOf(id) + table.separator : table.nameOf(id);
    const fraction = fractionOf(table.totalSizeOf(id), total);
    rows.push(
      `  ${ellipsize(name, 40).padEnd(40)} ${bytes(table.totalSizeOf(id)).padStart(10)} ` +
        `${percent(fraction).padStart(7)}  ${renderBar(fraction, 16)}`,
    );
  }
  if (ids.length > shown) rows.push(`  … and ${count(ids.length - shown)} more`);
  return rows;
}

/**
 * Renders live progress, either by redrawing a block in place on a terminal or by emitting
 * occasional lines when output is piped.
 */
class ProgressPrinter {
  readonly #interactive: boolean;
  readonly #rows: number;
  readonly #label: string;
  #table: NodeTable | null = null;
  #lastLineCount = 0;
  #lastRenderAt = 0;
  #lastLoggedDirectories = 0;

  constructor(label: string, rows: number, interactive: boolean) {
    this.#label = label;
    this.#rows = rows;
    this.#interactive = interactive;
  }

  attach(table: NodeTable): void {
    this.#table = table;
  }

  /** Stops overwriting, so the final report appends rather than replacing the live block. */
  detach(): void {
    this.#lastLineCount = 0;
  }

  handle(progress: ScanProgress): void {
    const table = this.#table;
    if (table === null) return;

    if (!this.#interactive) {
      if (progress.directoriesListed - this.#lastLoggedDirectories < 2_000) return;
      this.#lastLoggedDirectories = progress.directoriesListed;
      console.log(
        `  ${bytes(progress.bytesDiscovered)}  ${count(progress.filesDiscovered)} files  ` +
          `${count(progress.directoriesListed)} dirs read`,
      );
      return;
    }

    const now = Date.now();
    if (now - this.#lastRenderAt < 120) return;
    this.#lastRenderAt = now;

    const rate =
      progress.elapsedMs > 0
        ? `${bytes((progress.bytesDiscovered / progress.elapsedMs) * 1000)}/s`
        : '';
    const estimate =
      progress.estimatedFraction === null ? '' : `  ${percent(progress.estimatedFraction)}`;

    this.#draw([
      '',
      `Scanning ${this.#label}`,
      '',
      // Safe to read mid-scan: each listing is folded in by one synchronous block, so the
      // table can never be observed half-applied.
      ...topLevelRows(table, this.#rows),
      '',
      `  ${bytes(progress.bytesDiscovered)} in ${count(progress.filesDiscovered)} files, ` +
        `${count(progress.directoriesDiscovered)} directories${estimate}`,
      `  ${count(progress.directoriesPending)} directories queued   ${rate}`,
      `  reading ${progress.currentPath}`,
    ]);
  }

  #draw(lines: readonly string[]): void {
    // Clipping to the terminal width keeps the cursor arithmetic correct: a wrapped line
    // would occupy two rows and the next redraw would erase the wrong region.
    const width = (process.stdout.columns ?? 100) - 1;
    const clipped = lines.map((line) => ellipsize(line, width));
    if (this.#lastLineCount > 0) process.stdout.write(`\u001B[${this.#lastLineCount}A`);
    process.stdout.write('\u001B[0J');
    process.stdout.write(`${clipped.join('\n')}\n`);
    this.#lastLineCount = clipped.length;
  }
}

async function runVolumes(provider: NodeFileSystemProvider, json: boolean): Promise<void> {
  const volumes = await provider.listVolumes();

  if (json) {
    console.log(JSON.stringify({ platform: process.platform, volumes }, null, 2));
    return;
  }

  console.log('');
  console.log(`Volumes on this machine (${process.platform})`);
  console.log('');
  for (const volume of volumes) {
    const capacity =
      volume.totalBytes === null
        ? 'capacity unknown'
        : `${bytes(volume.usedBytes ?? 0)} used of ${bytes(volume.totalBytes)}, ` +
          `${bytes(volume.freeBytes ?? 0)} free`;
    console.log(`  ${volume.rootPath.padEnd(16)} ${capacity}`);
    if (!volume.scannable) {
      console.log(`  ${' '.repeat(16)} not offered: ${volume.note ?? 'unknown reason'}`);
    }
  }
  console.log('');
}

function reportStatistics(result: ScanResult): void {
  const { statistics } = result;
  const discovered = statistics.filesDiscovered + statistics.directoriesDiscovered;

  console.log('');
  console.log(`  ${count(statistics.filesDiscovered)} files`);
  console.log(`  ${count(statistics.directoriesDiscovered)} directories`);
  console.log(`  ${count(statistics.directoriesListed)} directories read`);
  console.log(`  ${count(Math.max(discovered - statistics.entriesSkipped, 0))} entries analysed`);
  console.log(`  ${count(statistics.entriesSkipped)} entries skipped`);

  const reported = SCAN_ISSUE_CODES.filter((code) => statistics.issueCounts[code] > 0);
  if (reported.length > 0) {
    console.log('');
    for (const code of reported) {
      console.log(`    ${code.padEnd(16)} ${count(statistics.issueCounts[code])}`);
    }
  }

  if (statistics.issueSamples.length > 0) {
    console.log('');
    console.log('  Examples');
    for (const issue of statistics.issueSamples.slice(0, 8)) {
      console.log(`    ${issue.code.padEnd(16)} ${ellipsize(issue.path, 68)}`);
    }
  }

  if (statistics.partial) {
    console.log('');
    console.log('  Some totals are a lower bound: parts of this tree could not be read.');
  }
}

function reportJson(result: ScanResult, top: number): void {
  const { table, statistics, root } = result;
  const ids = table.sortedChildIds(ROOT_ID, { by: 'size', order: 'desc' });
  console.log(
    JSON.stringify(
      {
        root,
        statistics,
        nodeCount: table.count,
        memory: table.stats(),
        topLevel: [...ids].slice(0, top).map((id) => ({
          name: table.nameOf(id),
          path: table.pathOf(id),
          directory: table.isDirectory(id),
          totalSize: table.totalSizeOf(id),
          directSize: table.directSizeOf(id),
          fileCount: table.fileCountOf(id),
          directoryCount: table.directoryCountOf(id),
        })),
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));

  if (options.help) {
    console.log(USAGE);
    return;
  }

  const provider = new NodeFileSystemProvider(
    options.metadataConcurrency === undefined
      ? {}
      : { metadataConcurrency: options.metadataConcurrency },
  );

  if (options.showVolumes) {
    await runVolumes(provider, options.json);
    return;
  }

  if (options.path === null) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  const controller = new AbortController();
  let interrupts = 0;
  const onInterrupt = (): void => {
    interrupts += 1;
    if (interrupts === 1) {
      controller.abort();
      return;
    }
    // A second Ctrl+C means the user has stopped waiting for a clean stop.
    process.exit(130);
  };
  process.on('SIGINT', onInterrupt);

  // SV_FORCE_LIVE exists so the redraw path can be exercised when stdout is a pipe, which
  // is how it gets tested and debugged.
  const interactive =
    options.live &&
    !options.json &&
    (process.stdout.isTTY === true || process.env['SV_FORCE_LIVE'] === '1');
  const printer = new ProgressPrinter(options.path, options.top, interactive);

  try {
    const result = await scan({
      rootPath: options.path,
      provider,
      signal: controller.signal,
      onTableReady: (table) => {
        printer.attach(table);
      },
      // `exactOptionalPropertyTypes` forbids an explicit undefined, so optional settings are
      // spread in only when present.
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
      ...(options.json ? {} : { onProgress: (progress: ScanProgress) => printer.handle(progress) }),
    });

    printer.detach();

    if (options.json) {
      reportJson(result, options.top);
      return;
    }

    const { table, statistics } = result;
    const memory = table.stats();
    const verb = statistics.status === 'cancelled' ? 'Cancelled scanning' : 'Scanned';

    console.log('');
    console.log(`${verb} ${table.rootPath} in ${(statistics.durationMs / 1000).toFixed(1)}s`);
    console.log('');
    console.log(`  ${bytes(statistics.totalSize)} total`);
    console.log('');

    if (options.tree) {
      const width = (process.stdout.columns ?? 100) - 2;
      for (const line of renderTree(table, { maxDepth: options.treeDepth, totalWidth: width })) {
        console.log(`  ${line}`);
      }
      console.log('');
      console.log(`  bars and percentages are shares of ${table.rootPath}`);
    } else {
      for (const line of topLevelRows(table, options.top)) console.log(line);
    }

    reportStatistics(result);
    console.log('');
    console.log(
      `  ${count(table.count)} nodes held in ${bytes(memory.columnBytes + memory.nameBytes)} ` +
        `(${memory.bytesPerNode.toFixed(1)} bytes each)`,
    );
    console.log('');
  } finally {
    process.off('SIGINT', onInterrupt);
  }
}

main().catch((error: unknown) => {
  console.error(`\nscan failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
