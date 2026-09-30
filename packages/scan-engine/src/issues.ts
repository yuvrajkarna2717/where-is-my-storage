/**
 * The taxonomy of things that go wrong while walking a real filesystem.
 *
 * Real disks are messy: permissions bite, files vanish mid-scan, drives get unplugged,
 * and some paths are not really files at all. None of that may abort a scan, and none of
 * it may be silently swallowed either, because "your drive is 742 GB" means something
 * different when 40 GB of it could not be read.
 */
export const SCAN_ISSUE_CODES = [
  /** Permission denied, or the OS refused for privacy reasons (macOS TCC). */
  'accessDenied',
  /** The entry disappeared between being listed and being examined. */
  'vanished',
  /** Expected a directory, found something else. */
  'notADirectory',
  /** Path or name exceeded a platform limit. */
  'tooLong',
  /** Deeper than the configured depth guard. */
  'tooDeep',
  /** A name the storage model cannot represent. */
  'invalidName',
  /** Locked, busy, or otherwise unreadable right now. */
  'locked',
  /** A pseudo-filesystem or special file deliberately not traversed. */
  'unsupported',
  /** Anything else the filesystem reported. */
  'ioError',
] as const;

export type ScanIssueCode = (typeof SCAN_ISSUE_CODES)[number];

export interface ScanIssue {
  readonly code: ScanIssueCode;
  readonly path: string;
  readonly detail?: string;
}

export type ScanIssueCounts = Readonly<Record<ScanIssueCode, number>>;

/**
 * Thrown by a `FileSystemProvider` so the engine never has to interpret platform error
 * codes. Mapping `EACCES`/`EPERM`/`ENOENT` and their Windows equivalents is the
 * provider's job; classification belongs next to the platform that produced it.
 */
export class FileSystemAccessError extends Error {
  readonly code: ScanIssueCode;
  readonly path: string;
  readonly detail: string | undefined;

  constructor(code: ScanIssueCode, path: string, detail?: string) {
    super(`${code}: ${path}${detail === undefined ? '' : ` (${detail})`}`);
    this.name = 'FileSystemAccessError';
    this.code = code;
    this.path = path;
    this.detail = detail;
  }
}

/**
 * Counts every issue but retains only a bounded sample of each kind.
 *
 * A scan of a locked system directory can produce hundreds of thousands of
 * access-denied errors. Keeping them all would turn an error path into a memory leak,
 * and a user cannot read 300 000 paths anyway: they want the count and a few examples.
 */
export class IssueLog {
  readonly #samplesPerCode: number;
  readonly #counts = new Map<ScanIssueCode, number>();
  readonly #samples = new Map<ScanIssueCode, ScanIssue[]>();
  #total = 0;

  constructor(samplesPerCode = 20) {
    this.#samplesPerCode = Math.max(0, samplesPerCode);
  }

  get total(): number {
    return this.#total;
  }

  record(issue: ScanIssue): void {
    this.#total += 1;
    this.#counts.set(issue.code, (this.#counts.get(issue.code) ?? 0) + 1);

    let samples = this.#samples.get(issue.code);
    if (samples === undefined) {
      samples = [];
      this.#samples.set(issue.code, samples);
    }
    if (samples.length < this.#samplesPerCode) samples.push(issue);
  }

  countOf(code: ScanIssueCode): number {
    return this.#counts.get(code) ?? 0;
  }

  /** Every code, including zeroes, so the UI can render a stable table. */
  counts(): ScanIssueCounts {
    const result = {} as Record<ScanIssueCode, number>;
    for (const code of SCAN_ISSUE_CODES) result[code] = this.#counts.get(code) ?? 0;
    return result;
  }

  /** The retained examples, grouped by code in declaration order. */
  samples(): readonly ScanIssue[] {
    const result: ScanIssue[] = [];
    for (const code of SCAN_ISSUE_CODES) {
      const samples = this.#samples.get(code);
      if (samples !== undefined) result.push(...samples);
    }
    return result;
  }
}
