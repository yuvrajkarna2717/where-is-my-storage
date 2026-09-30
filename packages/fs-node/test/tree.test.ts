import { NodeTable, ROOT_ID } from '@sv/core';
import { describe, expect, it } from 'vitest';
import { renderBar, renderTree } from '../src/cli/tree.ts';

/**
 * The terminal tree view.
 *
 * It is the whole product rendered with box characters, so the things that make it trustworthy are
 * worth pinning: rows ordered largest first, a tail that is summarised rather than dropped, and a
 * summary line that lands *below* the siblings it stands in for rather than above them.
 */

function buildTree(): NodeTable {
  const table = new NodeTable({ rootPath: '/scan', separator: '/' });

  const top = table.addChildren(ROOT_ID, [
    { name: 'big', directory: true, size: 0 },
    { name: 'medium', directory: true, size: 0 },
    { name: 'note.txt', directory: false, size: 100 },
  ]);
  const big = top;
  const medium = top + 1;

  table.addChildren(big, [
    { name: 'huge.bin', directory: false, size: 800_000 },
    { name: 'small.bin', directory: false, size: 1_000 },
  ]);
  table.addChildren(medium, [{ name: 'data.bin', directory: false, size: 150_000 }]);

  return table;
}

/**
 * Width of the name column with the default options: `totalWidth - barWidth - 22`, where 22 covers
 * the size and percentage columns and the gaps between them.
 */
const NAME_COLUMN = 100 - 18 - 22;

/** Keeps the indented name, dropping the size, percentage and bar columns. */
const namesOf = (lines: readonly string[]): string[] =>
  lines.map((line) => line.slice(0, NAME_COLUMN).trimEnd());

describe('renderBar', () => {
  it('is empty for nothing and full for everything', () => {
    expect(renderBar(0, 10)).toBe('');
    expect(renderBar(1, 10)).toBe('█'.repeat(10));
  });

  it('is proportional', () => {
    expect(renderBar(0.5, 10)).toBe('█'.repeat(5));
    expect(renderBar(0.25, 8)).toBe('█'.repeat(2));
  });

  it('uses partial blocks so a bar grows smoothly', () => {
    // Without eighth-width blocks a bar jumps a whole character at a time, which reads as though
    // nothing changed and then something doubled. 0.55 of 10 is 44 eighths: five full blocks and
    // a half.
    expect(renderBar(0.55, 10)).toBe('█████▌');
    expect(renderBar(0.5375, 10)).toBe('█████▍');
  });

  it('always shows something for a non-zero share', () => {
    // A folder holding real bytes must never render as an empty row.
    expect(renderBar(0.000_01, 10)).toBe('▏');
  });

  it('clamps rather than overflowing', () => {
    expect(renderBar(5, 4)).toBe('█'.repeat(4));
  });

  it('handles degenerate input', () => {
    expect(renderBar(0.5, 0)).toBe('');
    expect(renderBar(Number.NaN, 10)).toBe('');
    expect(renderBar(-1, 10)).toBe('');
  });
});

describe('renderTree', () => {
  it('starts with the scan root at 100%', () => {
    const lines = renderTree(buildTree(), { minShare: 0 });
    expect(lines[0]).toContain('/scan');
    expect(lines[0]).toContain('100%');
  });

  it('orders siblings largest first', () => {
    const lines = namesOf(renderTree(buildTree(), { minShare: 0 }));
    const topLevel = lines.filter((line) => /^[├└]─ /.test(line));
    expect(topLevel).toEqual(['├─ big/', '├─ medium/', '└─ note.txt']);
  });

  it('marks directories with a trailing separator', () => {
    const lines = namesOf(renderTree(buildTree(), { minShare: 0 }));
    expect(lines.some((line) => line.endsWith('big/'))).toBe(true);
    expect(lines.some((line) => line.endsWith('note.txt'))).toBe(true);
  });

  it('indents children under their parent', () => {
    const lines = namesOf(renderTree(buildTree(), { minShare: 0 }));
    expect(lines).toContain('│  ├─ huge.bin');
    expect(lines).toContain('│  └─ small.bin');
  });

  it('stops at the requested depth', () => {
    const shallow = namesOf(renderTree(buildTree(), { maxDepth: 1, minShare: 0 }));
    expect(shallow.some((line) => line.includes('huge.bin'))).toBe(false);
    expect(shallow.filter((line) => /^[├└]─ /.test(line))).toHaveLength(3);
  });

  it('places the tail summary below the siblings it replaces, not above', () => {
    // The bug this guards against: writing the summary when the tail is discovered puts it before
    // the rows it summarises, which reads as though it belonged to the previous branch.
    const table = new NodeTable({ rootPath: '/scan', separator: '/' });
    table.addChildren(
      ROOT_ID,
      Array.from({ length: 10 }, (_unused, index) => ({
        name: `entry-${String(index).padStart(2, '0')}`,
        directory: false,
        size: 1_000 - index * 10,
      })),
    );

    const lines = namesOf(renderTree(table, { maxChildren: 3, minShare: 0 }));
    const rows = lines.filter((line) => /^[├└]─ /.test(line));

    expect(rows).toHaveLength(4);
    expect(rows.at(-1)).toContain('… and 7 smaller');
    expect(rows[0]).toContain('entry-00');
  });

  it('accounts for every byte it does not show individually', () => {
    const table = new NodeTable({ rootPath: '/scan', separator: '/' });
    table.addChildren(
      ROOT_ID,
      Array.from({ length: 6 }, (_unused, index) => ({
        name: `f-${index}`,
        directory: false,
        size: 100,
      })),
    );

    const lines = renderTree(table, { maxChildren: 2, minShare: 0 });
    const summary = lines.find((line) => line.includes('… and 4 smaller'));
    // Four hidden entries at 100 bytes each.
    expect(summary).toContain('400 B');
  });

  it('hides entries below the share floor', () => {
    const table = new NodeTable({ rootPath: '/scan', separator: '/' });
    table.addChildren(ROOT_ID, [
      { name: 'dominant.bin', directory: false, size: 1_000_000 },
      { name: 'speck.bin', directory: false, size: 10 },
    ]);

    const lines = namesOf(renderTree(table, { minShare: 0.01 }));
    expect(lines.some((line) => line.includes('dominant.bin'))).toBe(true);
    expect(lines.some((line) => line.includes('speck.bin'))).toBe(false);
    expect(lines.some((line) => line.includes('… and 1 smaller'))).toBe(true);
  });

  it('survives a tree far deeper than the call stack would allow', () => {
    // Rendering uses an explicit stack for the same reason the scanner does: this is a debugging
    // tool, and it must not fall over on precisely the filesystem that needed debugging.
    const table = new NodeTable({ rootPath: '/scan', separator: '/' });
    let current = ROOT_ID;
    for (let depth = 0; depth < 5_000; depth += 1) {
      current = table.addChildren(current, [{ name: `level-${depth}`, directory: true, size: 0 }]);
    }
    table.addChildren(current, [{ name: 'leaf.bin', directory: false, size: 4_096 }]);

    const lines = renderTree(table, { maxDepth: 4_000, minShare: 0 });
    expect(lines.length).toBeGreaterThan(1_000);
  });

  it('truncates long names instead of wrapping', () => {
    const table = new NodeTable({ rootPath: '/scan', separator: '/' });
    table.addChildren(ROOT_ID, [
      { name: 'a-very-long-directory-name-'.repeat(8), directory: true, size: 500 },
    ]);

    for (const line of renderTree(table, { totalWidth: 80, minShare: 0 })) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it('handles an empty scan without crashing', () => {
    const table = new NodeTable({ rootPath: '/scan', separator: '/' });
    table.addChildren(ROOT_ID, []);
    expect(renderTree(table).length).toBe(1);
  });
});
