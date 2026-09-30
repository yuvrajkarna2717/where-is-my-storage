/**
 * Human-readable formatting for sizes, counts and percentages.
 *
 * `Intl` is available in every target runtime and is the only way to get the right
 * decimal separator and digit grouping for a user's locale, so it is used rather than
 * hand-rolled string work. Formatter construction is the expensive part, so instances
 * are cached: these functions are called once per visible row, many times per frame.
 */

/**
 * Which power to divide by.
 *
 * There is no universally correct default. Windows Explorer shows binary magnitudes
 * labelled "GB"; macOS and most Linux tooling show decimal "GB" meaning 10^9. Rather
 * than silently pick one and look wrong next to the user's file manager, both are
 * supported honestly, with labels that match the maths, and the choice is surfaced as a
 * setting in the UI layer.
 */
export type ByteUnitSystem = 'decimal' | 'binary';

const DECIMAL_UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB'] as const;
const BINARY_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'] as const;

export interface FormatBytesOptions {
  readonly system?: ByteUnitSystem;
  readonly locale?: string;
  /**
   * Fixed precision. Omit to get roughly three significant digits, which keeps a
   * column of sizes visually aligned without losing meaningful detail.
   */
  readonly maximumFractionDigits?: number;
}

const numberFormatters = new Map<string, Intl.NumberFormat>();

function numberFormatter(
  locale: string | undefined,
  minimumFractionDigits: number,
  maximumFractionDigits: number,
): Intl.NumberFormat {
  const key = `${locale ?? ''}|${minimumFractionDigits}|${maximumFractionDigits}`;
  let formatter = numberFormatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(locale, { minimumFractionDigits, maximumFractionDigits });
    numberFormatters.set(key, formatter);
  }
  return formatter;
}

/** Digits that keep about three significant figures. */
function adaptiveDigits(value: number): number {
  const magnitude = Math.abs(value);
  if (magnitude >= 100) return 0;
  if (magnitude >= 10) return 1;
  return 2;
}

/**
 * Formats a byte count, for example `380 GB` or `1.21 GiB`.
 * Non-finite input yields an em dash rather than "NaN", because an unknown size is a
 * normal outcome of a permission error and should read as unknown, not as broken.
 */
export function formatBytes(bytes: number, options: FormatBytesOptions = {}): string {
  if (!Number.isFinite(bytes)) return '—';

  const system = options.system ?? 'decimal';
  const units = system === 'binary' ? BINARY_UNITS : DECIMAL_UNITS;
  const base = system === 'binary' ? 1024 : 1000;

  const negative = bytes < 0;
  let value = Math.abs(bytes);
  let unitIndex = 0;
  while (value >= base && unitIndex < units.length - 1) {
    value /= base;
    unitIndex += 1;
  }

  // Whole bytes are never fractional, so "742 B" rather than "742.00 B".
  const digits = unitIndex === 0 ? 0 : (options.maximumFractionDigits ?? adaptiveDigits(value));
  const formatted = numberFormatter(options.locale, 0, digits).format(negative ? -value : value);
  return `${formatted} ${units[unitIndex]!}`;
}

/** Formats a file or directory count with locale-appropriate grouping. */
export function formatCount(value: number, locale?: string): string {
  if (!Number.isFinite(value)) return '—';
  return numberFormatter(locale, 0, 0).format(Math.trunc(value));
}

export interface FormatPercentOptions {
  readonly locale?: string;
  readonly maximumFractionDigits?: number;
}

const percentFormatters = new Map<string, Intl.NumberFormat>();

/**
 * Formats a fraction in [0, 1] as a percentage.
 *
 * A non-zero share that rounds to 0% is reported as `<0.1%`: showing "0%" for a
 * directory that does hold data is the kind of small dishonesty that makes users stop
 * trusting the totals.
 */
export function formatPercent(fraction: number, options: FormatPercentOptions = {}): string {
  if (!Number.isFinite(fraction)) return '—';

  const digits = options.maximumFractionDigits ?? 1;
  const key = `${options.locale ?? ''}|${digits}`;
  let formatter = percentFormatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(options.locale, {
      style: 'percent',
      maximumFractionDigits: digits,
    });
    percentFormatters.set(key, formatter);
  }

  const smallest = Math.pow(10, -digits) / 100;
  if (fraction > 0 && fraction < smallest) {
    return `<${formatter.format(smallest)}`;
  }
  return formatter.format(fraction);
}
