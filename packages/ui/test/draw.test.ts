import { NodeFlags } from '@sv/core';
import { describe, expect, it } from 'vitest';
import { FALLBACK_THEME, hashName, tileColor } from '../src/treemap/colors.ts';
import {
  MIN_DETAIL_HEIGHT,
  MIN_LABEL_HEIGHT,
  MIN_LABEL_WIDTH,
  drawTreemap,
  textColorFor,
  truncateToWidth,
  type TreemapContext,
} from '../src/treemap/draw.ts';
import type { Tile } from '../src/treemap/layout.ts';
import { OTHER_TILE_ID } from '../src/types.ts';

/**
 * Painting decisions, verified against a recording fake.
 *
 * jsdom provides no canvas implementation at all, so a component test could not check any of this.
 * A fake context is both sufficient and more precise: it can assert *that a label was not drawn*
 * on a tile too small to hold one, which is the behaviour that keeps the map readable.
 */

interface DrawCall {
  readonly kind: 'fillRect' | 'strokeRect' | 'fillText' | 'clearRect';
  readonly text?: string;
  readonly x: number;
  readonly y: number;
}

/** Character width is fixed at 7px, which makes expected truncation arithmetic obvious. */
const CHARACTER_WIDTH = 7;

function recordingContext(): { context: TreemapContext; calls: DrawCall[] } {
  const calls: DrawCall[] = [];
  const context: TreemapContext = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textBaseline: 'top',
    globalAlpha: 1,
    save: () => undefined,
    restore: () => undefined,
    beginPath: () => undefined,
    rect: () => undefined,
    clip: () => undefined,
    clearRect: (x, y) => calls.push({ kind: 'clearRect', x, y }),
    fillRect: (x, y) => calls.push({ kind: 'fillRect', x, y }),
    strokeRect: (x, y) => calls.push({ kind: 'strokeRect', x, y }),
    fillText: (text, x, y) => calls.push({ kind: 'fillText', text, x, y }),
    measureText: (text) => ({ width: text.length * CHARACTER_WIDTH }),
  };
  return { context, calls };
}

function tile(overrides: Partial<Tile> = {}): Tile {
  return {
    id: 1,
    name: 'Downloads',
    value: 140_000_000_000,
    directory: true,
    flags: NodeFlags.Directory,
    x: 0,
    y: 0,
    width: 200,
    height: 120,
    share: 0.5,
    groupedCount: 1,
    ...overrides,
  };
}

const options = {
  theme: FALLBACK_THEME,
  hoveredId: null,
  selectedId: null,
  formatValue: (bytes: number) => `${String(bytes)}B`,
  formatShare: (fraction: number) => `${String(Math.round(fraction * 100))}%`,
};

describe('truncateToWidth', () => {
  const { context } = recordingContext();

  it('returns text that already fits', () => {
    expect(truncateToWidth(context, 'abc', 100)).toBe('abc');
  });

  it('truncates with an ellipsis and stays within the budget', () => {
    const result = truncateToWidth(context, 'a-very-long-directory-name', 10 * CHARACTER_WIDTH);
    expect(result).not.toBeNull();
    expect(result!.endsWith('…')).toBe(true);
    expect(result!.length * CHARACTER_WIDTH).toBeLessThanOrEqual(10 * CHARACTER_WIDTH);
  });

  it('returns just an ellipsis when only that fits', () => {
    expect(truncateToWidth(context, 'abcdef', CHARACTER_WIDTH)).toBe('…');
  });

  it('returns null when nothing fits at all', () => {
    expect(truncateToWidth(context, 'abc', 3)).toBeNull();
    expect(truncateToWidth(context, 'abc', 0)).toBeNull();
  });
});

describe('textColorFor', () => {
  it('uses light text on the dark palette', () => {
    for (const color of FALLBACK_THEME.palette) {
      expect(textColorFor(color)).toBe('light');
    }
  });

  it('uses dark text on a light background', () => {
    expect(textColorFor('#ffffff')).toBe('dark');
    expect(textColorFor('#eeeeee')).toBe('dark');
  });

  it('accepts three-digit hex', () => {
    expect(textColorFor('#fff')).toBe('dark');
    expect(textColorFor('#000')).toBe('light');
  });

  it('falls back to light text for a colour format it cannot parse', () => {
    // A CSS variable could hold oklch() or a named colour. Light text is correct for every dark
    // theme and merely imperfect for a hypothetical light one, which beats shipping a colour parser.
    expect(textColorFor('oklch(0.7 0.1 250)')).toBe('light');
    expect(textColorFor('rebeccapurple')).toBe('light');
  });

  it('judges saturated blue as dark, which a naive brightness average gets wrong', () => {
    expect(textColorFor('#0000ff')).toBe('light');
  });
});

describe('drawTreemap', () => {
  it('fills a rectangle for every visible tile', () => {
    const { context, calls } = recordingContext();
    const tiles = [tile({ id: 1, x: 0 }), tile({ id: 2, x: 200 }), tile({ id: 3, x: 400 })];
    drawTreemap(context, 600, 120, { ...options, tiles });

    // One background fill plus one per tile.
    expect(calls.filter((call) => call.kind === 'fillRect')).toHaveLength(4);
  });

  it('skips tiles with no area', () => {
    const { context, calls } = recordingContext();
    drawTreemap(context, 100, 100, {
      ...options,
      tiles: [tile({ width: 0 }), tile({ id: 2, height: 0 })],
    });

    expect(calls.filter((call) => call.kind === 'fillRect')).toHaveLength(1);
    expect(calls.some((call) => call.kind === 'fillText')).toBe(false);
  });

  it('labels a tile large enough to read', () => {
    const { context, calls } = recordingContext();
    drawTreemap(context, 300, 200, { ...options, tiles: [tile({ width: 200, height: 120 })] });

    const texts = calls.filter((call) => call.kind === 'fillText').map((call) => call.text);
    expect(texts[0]).toBe('Downloads');
    expect(texts[1]).toContain('50%');
  });

  it('draws no label on a tile too small to hold one', () => {
    // Slivers of text are worse than none: they add visual noise and cannot be read.
    const { context, calls } = recordingContext();
    drawTreemap(context, 300, 200, {
      ...options,
      tiles: [tile({ width: MIN_LABEL_WIDTH - 1, height: 100 })],
    });
    expect(calls.some((call) => call.kind === 'fillText')).toBe(false);

    const short = recordingContext();
    drawTreemap(short.context, 300, 200, {
      ...options,
      tiles: [tile({ width: 200, height: MIN_LABEL_HEIGHT - 1 })],
    });
    expect(short.calls.some((call) => call.kind === 'fillText')).toBe(false);
  });

  it('omits the second line when the tile is short', () => {
    const { context, calls } = recordingContext();
    drawTreemap(context, 300, 200, {
      ...options,
      tiles: [tile({ width: 200, height: MIN_DETAIL_HEIGHT - 1 })],
    });

    const texts = calls.filter((call) => call.kind === 'fillText');
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toBe('Downloads');
  });

  it('marks a partial total as a lower bound rather than stating it as fact', () => {
    const { context, calls } = recordingContext();
    drawTreemap(context, 300, 200, {
      ...options,
      tiles: [tile({ flags: NodeFlags.Directory | NodeFlags.Partial })],
    });

    const detail = calls.filter((call) => call.kind === 'fillText')[1]!;
    expect(detail.text).toMatch(/^≥ /);
  });

  it('does not mark the aggregated tail as partial', () => {
    const { context, calls } = recordingContext();
    drawTreemap(context, 300, 200, {
      ...options,
      tiles: [
        tile({
          id: OTHER_TILE_ID,
          name: 'Other (12 items)',
          flags: NodeFlags.Partial,
          groupedCount: 12,
        }),
      ],
    });

    const detail = calls.filter((call) => call.kind === 'fillText')[1]!;
    expect(detail.text?.startsWith('≥')).toBe(false);
  });

  it('outlines a link instead of filling it solid', () => {
    // A link's own size is a few bytes while its target may be enormous; a solid tile would imply
    // the space is accounted for here.
    const { context, calls } = recordingContext();
    drawTreemap(context, 300, 200, {
      ...options,
      tiles: [tile({ flags: NodeFlags.Symlink })],
    });

    expect(calls.some((call) => call.kind === 'strokeRect')).toBe(true);
  });

  it('outlines the selected tile', () => {
    const { context, calls } = recordingContext();
    drawTreemap(context, 300, 200, { ...options, selectedId: 1, tiles: [tile({ id: 1 })] });
    expect(calls.some((call) => call.kind === 'strokeRect')).toBe(true);
  });

  it('clears before painting so a shrinking layout leaves no residue', () => {
    const { context, calls } = recordingContext();
    drawTreemap(context, 300, 200, { ...options, tiles: [tile()] });
    expect(calls[0]!.kind).toBe('clearRect');
  });
});

describe('tile colours', () => {
  it('gives the same folder the same colour every time', () => {
    // Stability is the point: a person learns to recognise the big blue block as their videos.
    const first = tileColor(tile({ name: 'Videos' }), FALLBACK_THEME);
    const second = tileColor(tile({ id: 99, name: 'Videos', x: 50 }), FALLBACK_THEME);
    expect(first).toBe(second);
  });

  it('does not depend on position or size', () => {
    const a = tileColor(tile({ name: 'Downloads', x: 0, width: 10 }), FALLBACK_THEME);
    const b = tileColor(tile({ name: 'Downloads', x: 500, width: 900 }), FALLBACK_THEME);
    expect(a).toBe(b);
  });

  it('separates similar names into different buckets', () => {
    const names = ['Videos', 'Videos 2', 'Documents', 'Downloads', 'Desktop'];
    const colors = new Set(names.map((name) => tileColor(tile({ name }), FALLBACK_THEME)));
    // Not a guarantee for arbitrary input, but these are the names that actually collide in a home
    // directory, and they must not all come out the same colour.
    expect(colors.size).toBeGreaterThan(3);
  });

  it('gives the aggregated tail a neutral colour', () => {
    expect(tileColor(tile({ id: OTHER_TILE_ID }), FALLBACK_THEME)).toBe(FALLBACK_THEME.neutral);
  });

  it('hashes deterministically and stays in range', () => {
    expect(hashName('Videos')).toBe(hashName('Videos'));
    expect(hashName('Videos')).not.toBe(hashName('videos'));
    for (const name of ['', 'a', 'Ω±≈ß', '日本語', 'x'.repeat(500)]) {
      const hash = hashName(name);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });
});
