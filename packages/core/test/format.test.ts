import { describe, expect, it } from 'vitest';
import { formatBytes, formatCount, formatPercent } from '../src/format.ts';

// Every assertion pins an explicit locale. Without one these tests would pass or fail
// depending on the machine's regional settings.
const en = { locale: 'en-US' } as const;

describe('formatBytes', () => {
  it('reports raw bytes without a fractional part', () => {
    expect(formatBytes(0, en)).toBe('0 B');
    expect(formatBytes(742, en)).toBe('742 B');
    expect(formatBytes(999, en)).toBe('999 B');
  });

  it('uses SI magnitudes with SI labels by default', () => {
    expect(formatBytes(1000, en)).toBe('1 kB');
    expect(formatBytes(1500, en)).toBe('1.5 kB');
    expect(formatBytes(380_000_000_000, en)).toBe('380 GB');
    expect(formatBytes(1_000_000_000_000, en)).toBe('1 TB');
  });

  it('uses binary magnitudes with binary labels when asked', () => {
    // The labels must match the arithmetic. Showing 1024-based numbers as "KB" is the
    // ambiguity this option exists to avoid.
    expect(formatBytes(1024, { ...en, system: 'binary' })).toBe('1 KiB');
    expect(formatBytes(1536, { ...en, system: 'binary' })).toBe('1.5 KiB');
    expect(formatBytes(1024 ** 3, { ...en, system: 'binary' })).toBe('1 GiB');
  });

  it('keeps roughly three significant digits', () => {
    expect(formatBytes(1_234_000_000, en)).toBe('1.23 GB');
    expect(formatBytes(12_340_000_000, en)).toBe('12.3 GB');
    expect(formatBytes(123_400_000_000, en)).toBe('123 GB');
  });

  it('honours an explicit precision', () => {
    expect(formatBytes(1_234_000_000, { ...en, maximumFractionDigits: 0 })).toBe('1 GB');
    expect(formatBytes(1_234_000_000, { ...en, maximumFractionDigits: 3 })).toBe('1.234 GB');
  });

  it('respects locale decimal separators', () => {
    expect(formatBytes(1500, { locale: 'de-DE' })).toBe('1,5 kB');
  });

  it('handles negative deltas, which the history view needs', () => {
    expect(formatBytes(-1_500_000, en)).toBe('-1.5 MB');
  });

  it('renders an unknown size as an em dash rather than NaN', () => {
    // An unreadable file is a normal outcome of a permission error; it should read as
    // unknown, not as a bug.
    expect(formatBytes(Number.NaN, en)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY, en)).toBe('—');
  });

  it('does not run out of units on absurd values', () => {
    expect(formatBytes(Number.MAX_SAFE_INTEGER, en)).toBe('9.01 PB');
    expect(formatBytes(1e30, en)).toMatch(/EB$/);
  });
});

describe('formatCount', () => {
  it('groups digits', () => {
    expect(formatCount(342_891, 'en-US')).toBe('342,891');
    expect(formatCount(0, 'en-US')).toBe('0');
  });

  it('truncates rather than rounding a fractional count', () => {
    expect(formatCount(5.9, 'en-US')).toBe('5');
  });
});

describe('formatPercent', () => {
  it('formats fractions, not pre-multiplied percentages', () => {
    expect(formatPercent(0.38, en)).toBe('38%');
    expect(formatPercent(0.921, en)).toBe('92.1%');
    expect(formatPercent(0.742, en)).toBe('74.2%');
    expect(formatPercent(1, en)).toBe('100%');
    expect(formatPercent(0, en)).toBe('0%');
  });

  it('never rounds a non-empty directory down to 0%', () => {
    // "0%" next to a real size is the kind of small inconsistency that makes a user stop
    // trusting every other number on the screen.
    expect(formatPercent(0.0000001, en)).toBe('<0.1%');
  });

  it('honours requested precision', () => {
    expect(formatPercent(0.92137, { ...en, maximumFractionDigits: 3 })).toBe('92.137%');
    expect(formatPercent(0.92137, { ...en, maximumFractionDigits: 0 })).toBe('92%');
  });
});
