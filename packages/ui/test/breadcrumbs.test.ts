import { describe, expect, it } from 'vitest';
import { COLLAPSE_MARKER_ID, collapseBreadcrumbs } from '../src/breadcrumbs.ts';
import type { BreadcrumbItem } from '../src/types.ts';

function trail(...labels: string[]): BreadcrumbItem[] {
  return labels.map((label, index) => ({ id: index, label, totalSize: (index + 1) * 100 }));
}

const labelsOf = (items: readonly BreadcrumbItem[]): string[] => items.map((item) => item.label);

describe('collapseBreadcrumbs', () => {
  it('leaves a short trail untouched', () => {
    const items = trail('C:\\', 'Users', 'Yuvraj');
    const result = collapseBreadcrumbs(items, 5);

    expect(result.items).toBe(items);
    expect(result.hiddenCount).toBe(0);
  });

  it('leaves a trail exactly at the limit untouched', () => {
    const result = collapseBreadcrumbs(trail('a', 'b', 'c', 'd', 'e'), 5);
    expect(result.hiddenCount).toBe(0);
    expect(labelsOf(result.items)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('keeps the root and the tail, hiding the middle', () => {
    // Where you started and where you are now are what orient a person; the middle is the least
    // likely place they want to jump back to.
    const result = collapseBreadcrumbs(
      trail('C:\\', 'Users', 'Yuvraj', 'AppData', 'Local', 'Chrome', 'Cache'),
      5,
    );

    expect(labelsOf(result.items)).toEqual(['C:\\', '…', 'Local', 'Chrome', 'Cache']);
    expect(result.hiddenCount).toBe(3);
    expect(result.items[1]!.id).toBe(COLLAPSE_MARKER_ID);
  });

  it('always keeps the current location last', () => {
    const items = trail('root', 'a', 'b', 'c', 'd', 'e', 'f', 'g');
    for (const maxVisible of [3, 4, 5, 6, 7]) {
      const result = collapseBreadcrumbs(items, maxVisible);
      expect(result.items.at(-1)!.label).toBe('g');
      expect(result.items[0]!.label).toBe('root');
      expect(result.items).toHaveLength(maxVisible);
    }
  });

  it('accounts for every hidden entry', () => {
    const items = trail(...Array.from({ length: 40 }, (_unused, index) => `level-${index}`));
    const result = collapseBreadcrumbs(items, 5);

    // Rendered entries minus the marker, plus the hidden count, must equal the real trail.
    expect(result.items.length - 1 + result.hiddenCount).toBe(items.length);
  });

  it('does not collapse below a useful minimum', () => {
    // Fewer than three visible entries cannot express "root … here", so collapsing is skipped
    // rather than producing something misleading.
    const items = trail('a', 'b', 'c', 'd');
    expect(collapseBreadcrumbs(items, 2).items).toBe(items);
    expect(collapseBreadcrumbs(items, 0).hiddenCount).toBe(0);
  });

  it('handles the smallest collapsing arrangement', () => {
    const result = collapseBreadcrumbs(trail('a', 'b', 'c', 'd'), 3);
    expect(labelsOf(result.items)).toEqual(['a', '…', 'd']);
    expect(result.hiddenCount).toBe(2);
  });

  it('handles an empty and a single-entry trail', () => {
    expect(collapseBreadcrumbs([], 5).items).toEqual([]);
    expect(labelsOf(collapseBreadcrumbs(trail('C:\\'), 5).items)).toEqual(['C:\\']);
  });
});
