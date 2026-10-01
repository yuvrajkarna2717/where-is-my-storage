/**
 * Measures the two Node filesystem providers against each other.
 *
 * Task 6 assumed a worker pool would beat the single-threaded provider, because Node dispatches
 * async filesystem calls to a four-thread libuv pool. The first end-to-end numbers contradicted
 * that, so this bench exists to find out where the time actually goes rather than to confirm the
 * assumption.
 *
 * It measures two different things on purpose:
 *
 *   replay   Listings only. The same fixed list of directory paths is pushed through each provider
 *            at a given concurrency, with no tree being built. This isolates the provider.
 *   scan     The whole engine. Shows whether any provider win survives the rest of the pipeline.
 *
 * Every configuration is run `--reps` times in alternating order (A B B A …) so that cache drift
 * and background disk activity land on both providers rather than on whichever ran first.
 *
 * Usage
 *   node packages/fs-node/bench/provider.bench.ts <path> [options]
 *
 *   --reps <n>           Repetitions per configuration (default 3)
 *   --concurrency <list> Comma-separated engine concurrency values (default 4,8,16,32,64,128)
 *   --workers <list>     Comma-separated worker counts (default 4,8)
 *   --mode <replay|scan|both>   Which benchmarks to run (default both)
 *   --limit <n>          Cap the replay directory list to the n largest directories
 */
import { ROOT_ID, formatCount, type NodeTable } from '@sv/core';
import { scan, type FileSystemProvider } from '@sv/scan-engine';
import { NodeFileSystemProvider } from '../src/node-provider.ts';
import { DEFAULT_WORKER_COUNT, WorkerFileSystemProvider } from '../src/worker-provider.ts';

const WORKER_ENTRY = new URL('../src/worker/entry.ts', import.meta.url);

interface Options {
  readonly path: string;
  readonly reps: number;
  readonly concurrencies: readonly number[];
  readonly workerCounts: readonly number[];
  readonly mode: 'replay' | 'scan' | 'both';
  readonly limit: number | null;
}

function parseList(raw: string | undefined, flag: string): readonly number[] {
  if (raw === undefined) throw new Error(`${flag} needs a comma-separated list of numbers`);
  const values = raw.split(',').map((part) => Number(part.trim()));
  for (const value of values) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} has a bad value in ${raw}`);
  }
  return values.map((value) => Math.trunc(value));
}

function parseOptions(argv: readonly string[]): Options {
  let path: string | null = null;
  let reps = 3;
  let concurrencies: readonly number[] = [4, 8, 16, 32, 64, 128];
  let workerCounts: readonly number[] = [4, DEFAULT_WORKER_COUNT];
  let mode: Options['mode'] = 'both';
  let limit: number | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    switch (argument) {
      case '--reps':
        reps = Math.max(1, Math.trunc(Number(argv[index + 1])));
        index += 1;
        break;
      case '--concurrency':
        concurrencies = parseList(argv[index + 1], '--concurrency');
        index += 1;
        break;
      case '--workers':
        workerCounts = parseList(argv[index + 1], '--workers');
        index += 1;
        break;
      case '--mode': {
        const raw = argv[index + 1];
        if (raw !== 'replay' && raw !== 'scan' && raw !== 'both') {
          throw new Error('--mode must be replay, scan or both');
        }
        mode = raw;
        index += 1;
        break;
      }
      case '--limit':
        limit = Math.max(1, Math.trunc(Number(argv[index + 1])));
        index += 1;
        break;
      default:
        if (argument.startsWith('-')) throw new Error(`unknown option ${argument}`);
        path = argument;
    }
  }

  if (path === null) throw new Error('a path to benchmark is required');
  // De-duplicated because `--workers 8` on a 9-core machine would otherwise repeat the default.
  return { path, reps, concurrencies, workerCounts: [...new Set(workerCounts)], mode, limit };
}

// -- plumbing ---------------------------------------------------------------------------------

const line = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

const count = (value: number): string => formatCount(value, 'en-US');

/** Rate in units per second, rendered at a fixed width so columns line up. */
const rate = (units: number, ms: number): string =>
  `${count(Math.round(ms > 0 ? (units / ms) * 1000 : 0)).padStart(9)}/s`;

interface Variant {
  readonly label: string;
  readonly create: () => FileSystemProvider;
}

function simpleVariant(metadataConcurrency: number): Variant {
  return {
    label: `simple(meta=${String(metadataConcurrency)})`,
    create: () => new NodeFileSystemProvider({ metadataConcurrency }),
  };
}

function workerVariant(workerCount: number): Variant {
  return {
    label: `workers(${String(workerCount)})`,
    create: () => new WorkerFileSystemProvider({ workerEntry: WORKER_ENTRY, workerCount }),
  };
}

/**
 * Runs every configuration `reps` times, alternating the order on each pass.
 *
 * This matters more than it sounds. The first version of this bench looped
 * `for each concurrency { for each variant { for each rep } }`, and the results showed the
 * single-threaded provider getting monotonically slower as concurrency rose — 3.7s, 4.4s, 8.5s.
 * That was not concurrency. It was run order: each scan allocates tens of megabytes of typed
 * arrays, so configurations measured later in the process ran under heavier GC pressure than those
 * measured first. Sweeping the *whole* matrix on each pass, in alternating directions, spreads that
 * drift evenly instead of charging it to whichever configuration happened to go last.
 */
function* interleave<T>(configurations: readonly T[], reps: number): Generator<T> {
  for (let rep = 0; rep < reps; rep += 1) {
    const order = rep % 2 === 0 ? configurations : [...configurations].reverse();
    for (const configuration of order) yield configuration;
  }
}

/**
 * Collects the previous run's scan table before the next one is timed.
 *
 * Without this the measurement includes whatever garbage the preceding configuration left behind.
 * Only available under `--expose-gc`; the bench says so at startup when it is not.
 */
const collect: () => void = ((): (() => void) => {
  const gc = (globalThis as { gc?: () => void }).gc;
  return gc === undefined ? () => undefined : gc;
})();

interface Sample {
  readonly ms: number;
  readonly directories: number;
  readonly entries: number;
  /** Time to get the provider to its first answer, which for a pool includes spawning threads. */
  readonly startupMs: number;
}

/**
 * Gets a provider to its first answer and reports how long that took.
 *
 * The worker pool spawns threads lazily on its first listing, and each thread has to boot a Node
 * isolate and type-strip the entry module. Leaving that inside the measured window conflates a
 * one-off startup cost with per-directory throughput — on a small tree it *is* the entire
 * measurement. Charged separately, both numbers stay readable, and the startup column makes the
 * fixed cost visible rather than hiding it.
 */
async function prime(provider: FileSystemProvider, path: string): Promise<number> {
  const started = performance.now();
  try {
    await provider.listDirectory(path);
  } catch {
    // An unreadable root is the caller's problem, not the timer's.
  }
  return performance.now() - started;
}

/** Keeps the best and median of several runs; a mean would be dragged around by one stall. */
class Series {
  readonly #samples: Sample[] = [];

  add(sample: Sample): void {
    this.#samples.push(sample);
  }

  get best(): Sample {
    return [...this.#samples].sort((a, b) => a.ms - b.ms)[0]!;
  }

  get median(): Sample {
    const sorted = [...this.#samples].sort((a, b) => a.ms - b.ms);
    return sorted[Math.floor((sorted.length - 1) / 2)]!;
  }

  /** Slowest over fastest. Anything near 1 means the measurement is trustworthy. */
  get spread(): number {
    const sorted = [...this.#samples].sort((a, b) => a.ms - b.ms);
    const fastest = sorted[0]!.ms;
    return fastest > 0 ? sorted[sorted.length - 1]!.ms / fastest : 1;
  }
}

// -- replay: listings only --------------------------------------------------------------------

/** Every directory the scan successfully listed, deepest-first so the order is not insertion order. */
function directoryPaths(table: NodeTable, limit: number | null): readonly string[] {
  const ids: number[] = [];
  for (let id = ROOT_ID; id < table.count; id += 1) {
    if (table.isDirectory(id) && table.isListed(id)) ids.push(id);
  }
  // Largest first, so a truncated list still covers the directories that dominate a real scan.
  ids.sort((a, b) => table.totalSizeOf(b) - table.totalSizeOf(a));
  const chosen = limit === null ? ids : ids.slice(0, limit);
  return chosen.map((id) => table.pathOf(id));
}

/**
 * Pushes `paths` through the provider with at most `concurrency` listings outstanding.
 *
 * This is the same bounded-parallelism shape the engine uses, minus the tree building, the progress
 * reporting and the depth bookkeeping — so a difference here is a difference in the provider.
 */
async function replay(
  provider: FileSystemProvider,
  paths: readonly string[],
  concurrency: number,
): Promise<Sample> {
  const startupMs = await prime(provider, paths[0]!);

  let next = 0;
  let entries = 0;
  let listed = 0;

  const started = performance.now();
  const workers = Array.from({ length: Math.min(concurrency, paths.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= paths.length) return;
      try {
        const result = await provider.listDirectory(paths[index]!);
        entries += result.entries.length;
        listed += 1;
      } catch {
        // A directory that vanished or turned unreadable between the warm-up scan and now is not
        // interesting here; it just does not count towards throughput.
      }
    }
  });
  await Promise.all(workers);

  return { ms: performance.now() - started, directories: listed, entries, startupMs };
}

// -- scan: the whole engine ------------------------------------------------------------------

async function scanOnce(
  provider: FileSystemProvider,
  path: string,
  concurrency: number,
): Promise<Sample> {
  const startupMs = await prime(provider, path);
  const result = await scan({ rootPath: path, provider, concurrency });
  const { statistics } = result;
  return {
    ms: statistics.durationMs,
    directories: statistics.directoriesListed,
    entries: statistics.filesDiscovered + statistics.directoriesDiscovered,
    startupMs,
  };
}

// -- report ----------------------------------------------------------------------------------

/** One empty `Series` per matrix cell, keyed the way the sweep looks them up. */
function cell(matrix: readonly { readonly key: string }[]): [string, Series][] {
  return matrix.map(({ key }) => [key, new Series()]);
}

function reportTable(title: string, columns: readonly string[], rows: readonly string[][]): void {
  line('');
  line(title);
  line('');
  const widths = columns.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  const render = (cells: readonly string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index]!)).join('  ');
  line(`  ${render(columns)}`);
  line(`  ${widths.map((width) => '-'.repeat(width)).join('  ')}`);
  for (const row of rows) line(`  ${render(row)}`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  line('');
  // Deliberately ASCII-only throughout. Benchmark output gets pasted into issues and piped into
  // log files, and a Windows console at the default code page turns box-drawing and typographic
  // characters into mojibake, which makes the numbers harder to read than plain text would be.
  line(`Provider benchmark: ${options.path}`);
  line(`  ${String(options.reps)} reps per configuration, whole matrix interleaved`);
  if ((globalThis as { gc?: () => void }).gc === undefined) {
    line('  warning: run with --expose-gc so each measurement starts from a collected heap');
  }

  // The warm-up does double duty: it pulls the whole tree into the OS cache so later runs are
  // comparing providers rather than comparing disk luck, and it produces the directory list the
  // replay benchmark needs.
  const warmupStarted = performance.now();
  const warmup = await scan({ rootPath: options.path, provider: new NodeFileSystemProvider() });
  const warmupMs = performance.now() - warmupStarted;

  const paths = directoryPaths(warmup.table, options.limit);
  line(
    `  warm-up: ${count(warmup.statistics.directoriesListed)} directories, ` +
      `${count(warmup.statistics.filesDiscovered)} files in ${(warmupMs / 1000).toFixed(1)}s`,
  );
  line(`  replay list: ${count(paths.length)} directories`);

  const variants: readonly Variant[] = [
    simpleVariant(8),
    ...options.workerCounts.map(workerVariant),
  ];

  /** Every concurrency × variant pairing, measured as one interleaved matrix. */
  const matrix = options.concurrencies.flatMap((concurrency) =>
    variants.map((variant) => ({
      concurrency,
      variant,
      key: `${String(concurrency)}|${variant.label}`,
    })),
  );

  const sweep = async (
    title: string,
    measure: (provider: FileSystemProvider, concurrency: number) => Promise<Sample>,
  ): Promise<void> => {
    const series = new Map<string, Series>(cell(matrix));
    let done = 0;

    for (const { concurrency, variant, key } of interleave(matrix, options.reps)) {
      collect();
      const provider = variant.create();
      try {
        series.get(key)!.add(await measure(provider, concurrency));
      } finally {
        await provider.dispose?.();
      }
      done += 1;
      // Progress on stderr, so piping stdout to a file still gives a clean table.
      process.stderr.write(
        `\r  ${title}: ${String(done)}/${String(matrix.length * options.reps)}  `,
      );
    }
    process.stderr.write('\r\u001B[0K');

    const rows: string[][] = [];
    for (const concurrency of options.concurrencies) {
      const baseline = series.get(`${String(concurrency)}|${variants[0]!.label}`)!.best.ms;
      for (const variant of variants) {
        const measured = series.get(`${String(concurrency)}|${variant.label}`)!;
        const { best, median } = measured;
        rows.push([
          String(concurrency),
          variant.label,
          `${(best.ms / 1000).toFixed(2)}s`,
          `${(median.ms / 1000).toFixed(2)}s`,
          `${measured.spread.toFixed(2)}x`,
          `${best.startupMs.toFixed(0)}ms`,
          rate(best.directories, best.ms),
          rate(best.entries, best.ms),
          variant === variants[0] ? 'baseline' : `${(baseline / best.ms).toFixed(2)}x`,
        ]);
      }
    }

    reportTable(
      title,
      ['conc', 'provider', 'best', 'median', 'spread', 'startup', 'dirs', 'entries', 'vs simple'],
      rows,
    );
  };

  if (options.mode !== 'scan') {
    await sweep('Replay: listings only, no tree built', (provider, concurrency) =>
      replay(provider, paths, concurrency),
    );
  }

  if (options.mode !== 'replay') {
    await sweep('Scan: full engine, tree built', (provider, concurrency) =>
      scanOnce(provider, options.path, concurrency),
    );
  }

  line('');
  line("  startup    time to the provider's first answer: thread spawn for a pool, ~0 for simple");
  line('  spread     slowest run over fastest; well above 1.00x means this row is noise');
  line('  vs simple  above 1.00x means the worker pool is faster');
  line('');
}

await main();
