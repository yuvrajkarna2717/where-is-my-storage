import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_TILES,
  DEFAULT_MIN_TILES,
  EMPTY_LAYOUT,
  hitTest,
  layoutTreemap,
  tileInDirection,
  type Tile,
} from '../src/treemap/layout.ts';
import { OTHER_TILE_ID, type TreemapRow } from '../src/types.ts';

/**
 * The treemap's geometry.
 *
 * These are the assertions that matter for whether the visualisation tells the truth: area must be
 * proportional to bytes, tiles must not overlap or escape their canvas, and the long tail must be
 * aggregated rather than drawn as slivers. All of it is pure, so it is checked here rather than in a
 * component test — which could not verify any of it anyway, since jsdom has no canvas.
 */

function row(id: number, name: string, value: number, directory = true): TreemapRow {
  return { id, name, totalSize: value, directory, flags: directory ? 1 : 0 };
}

const area = (tile: Tile): number => tile.width * tile.height;

function overlaps(a: Tile, b: Tile): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe('proportionality', () => {
  it('gives each tile an area proportional to its bytes', () => {
    const rows = [row(1, 'a', 500), row(2, 'b', 300), row(3, 'c', 150), row(4, 'd', 50)];
    const layout = layoutTreemap(rows, { width: 800, height: 600, gap: 0, round: false });

    const canvasArea = 800 * 600;
    expect(layout.total).toBe(1_000);

    for (const tile of layout.tiles) {
      // Exact, not approximate: squarify preserves area, and with rounding disabled there is no
      // pixel snapping to blur it.
      expect(area(tile) / canvasArea).toBeCloseTo(tile.value / layout.total, 9);
    }
  });

  it('fills the whole canvas when there is no gap', () => {
    const rows = [row(1, 'a', 7), row(2, 'b', 11), row(3, 'c', 3), row(4, 'd', 29)];
    const layout = layoutTreemap(rows, { width: 640, height: 480, gap: 0, round: false });

    const covered = layout.tiles.reduce((sum, tile) => sum + area(tile), 0);
    expect(covered).toBeCloseTo(640 * 480, 6);
  });

  it('keeps proportions at petabyte scale', () => {
    // Sizes are Float64 and exact to 9 PB; the layout must not lose that in its arithmetic.
    const rows = [row(1, 'huge', 4_000_000_000_000_000), row(2, 'small', 1_000_000_000_000_000)];
    const layout = layoutTreemap(rows, { width: 500, height: 500, gap: 0, round: false });

    const [first, second] = layout.tiles;
    expect(area(first!) / area(second!)).toBeCloseTo(4, 6);
  });

  it('shares the canvas equally between equal values', () => {
    const rows = [row(1, 'a', 100), row(2, 'b', 100), row(3, 'c', 100), row(4, 'd', 100)];
    const layout = layoutTreemap(rows, { width: 400, height: 400, gap: 0, round: false });

    for (const tile of layout.tiles) expect(area(tile)).toBeCloseTo(40_000, 6);
  });
});

describe('geometry', () => {
  it('orders tiles largest first', () => {
    const rows = [row(1, 'small', 10), row(2, 'big', 1_000), row(3, 'medium', 100)];
    const layout = layoutTreemap(rows, { width: 600, height: 400 });

    expect(layout.tiles.map((tile) => tile.name)).toEqual(['big', 'medium', 'small']);
  });

  it('never overlaps tiles', () => {
    const rows = Array.from({ length: 24 }, (_unused, index) =>
      row(index + 1, `dir-${index}`, 1_000 - index * 30),
    );
    const layout = layoutTreemap(rows, { width: 900, height: 500, gap: 0 });

    for (let i = 0; i < layout.tiles.length; i += 1) {
      for (let j = i + 1; j < layout.tiles.length; j += 1) {
        expect(
          overlaps(layout.tiles[i]!, layout.tiles[j]!),
          `${layout.tiles[i]!.name} overlaps ${layout.tiles[j]!.name}`,
        ).toBe(false);
      }
    }
  });

  it('keeps every tile inside the canvas', () => {
    const rows = Array.from({ length: 40 }, (_unused, index) =>
      row(index + 1, `dir-${index}`, (index + 1) * 17),
    );
    const layout = layoutTreemap(rows, { width: 733, height: 411 });

    for (const tile of layout.tiles) {
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.y).toBeGreaterThanOrEqual(0);
      expect(tile.x + tile.width).toBeLessThanOrEqual(733);
      expect(tile.y + tile.height).toBeLessThanOrEqual(411);
    }
  });

  it('gives a lone entry the whole canvas', () => {
    const layout = layoutTreemap([row(1, 'only', 42)], { width: 300, height: 200, gap: 0 });

    expect(layout.tiles).toHaveLength(1);
    expect(layout.tiles[0]).toMatchObject({ x: 0, y: 0, width: 300, height: 200, share: 1 });
  });

  it('snaps to whole pixels by default', () => {
    const rows = [row(1, 'a', 7), row(2, 'b', 13), row(3, 'c', 29)];
    for (const tile of layoutTreemap(rows, { width: 501, height: 337 }).tiles) {
      expect(Number.isInteger(tile.x)).toBe(true);
      expect(Number.isInteger(tile.y)).toBe(true);
      expect(Number.isInteger(tile.width)).toBe(true);
      expect(Number.isInteger(tile.height)).toBe(true);
    }
  });

  it('is deterministic, breaking ties by id', () => {
    const rows = [row(3, 'c', 100), row(1, 'a', 100), row(2, 'b', 100)];
    const first = layoutTreemap(rows, { width: 400, height: 300 });
    const second = layoutTreemap([...rows].reverse(), { width: 400, height: 300 });

    // Same set of rows in a different order must produce the same picture, or a folder would appear
    // to move about between renders.
    expect(first.tiles.map((tile) => tile.id)).toEqual(second.tiles.map((tile) => tile.id));
    expect(first.tiles.map((tile) => tile.id)).toEqual([1, 2, 3]);
  });
});

describe('empty and degenerate input', () => {
  it('returns nothing for no rows', () => {
    expect(layoutTreemap([], { width: 500, height: 500 })).toEqual(EMPTY_LAYOUT);
  });

  it('returns nothing when the canvas has no area', () => {
    const rows = [row(1, 'a', 100)];
    expect(layoutTreemap(rows, { width: 0, height: 500 })).toEqual(EMPTY_LAYOUT);
    expect(layoutTreemap(rows, { width: 500, height: 0 })).toEqual(EMPTY_LAYOUT);
    expect(layoutTreemap(rows, { width: -10, height: 10 })).toEqual(EMPTY_LAYOUT);
  });

  it('counts zero-byte entries instead of drawing them', () => {
    // An empty folder is real and the tree view lists it, but it has no area to occupy. Reporting
    // the count lets the UI say so rather than appearing to lose it.
    const rows = [row(1, 'full', 100), row(2, 'empty', 0), row(3, 'also-empty', 0)];
    const layout = layoutTreemap(rows, { width: 400, height: 400 });

    expect(layout.tiles).toHaveLength(1);
    expect(layout.omittedZeroCount).toBe(2);
    expect(layout.total).toBe(100);
  });

  it('returns nothing drawable when everything is zero bytes', () => {
    const layout = layoutTreemap([row(1, 'a', 0), row(2, 'b', 0)], { width: 400, height: 400 });

    expect(layout.tiles).toEqual([]);
    expect(layout.omittedZeroCount).toBe(2);
  });
});

describe('tail aggregation', () => {
  it('folds unreadably small entries into one labelled tile', () => {
    const rows = [
      row(1, 'big', 1_000_000),
      ...Array.from({ length: 300 }, (_unused, index) => row(index + 2, `tiny-${index}`, 10)),
    ];
    const layout = layoutTreemap(rows, { width: 600, height: 400 });

    const other = layout.tiles.find((tile) => tile.id === OTHER_TILE_ID);
    expect(other).toBeDefined();
    expect(other!.name).toMatch(/^Other \(\d+ items\)$/);
    expect(other!.groupedCount).toBeGreaterThan(1);
    // Aggregating must not lose bytes.
    expect(layout.tiles.reduce((sum, tile) => sum + tile.value, 0)).toBe(layout.total);
  });

  it('never leaves only an "Other" tile, however uniform the folder', () => {
    // Ten thousand similar files would otherwise all fall below the readable threshold and collapse
    // into a single tile, which answers the user's question with a shrug.
    const rows = Array.from({ length: 10_000 }, (_unused, index) =>
      row(index + 1, `f-${index}`, 1_000),
    );
    const layout = layoutTreemap(rows, { width: 800, height: 600 });

    expect(layout.tiles.length).toBeGreaterThanOrEqual(DEFAULT_MIN_TILES);
    expect(layout.tiles.filter((tile) => tile.id !== OTHER_TILE_ID).length).toBeGreaterThanOrEqual(
      DEFAULT_MIN_TILES,
    );
  });

  it('caps the number of drawn tiles', () => {
    const rows = Array.from({ length: 5_000 }, (_unused, index) =>
      row(index + 1, `f-${index}`, 1_000_000 - index),
    );
    const layout = layoutTreemap(rows, { width: 4_000, height: 3_000 });

    // +1 for the aggregated tail.
    expect(layout.tiles.length).toBeLessThanOrEqual(DEFAULT_MAX_TILES + 1);
  });

  it('does not aggregate a single leftover entry into "Other"', () => {
    // One item behind an "Other (1 items)" label would be worse than just naming it.
    const rows = [row(1, 'big', 1_000_000), row(2, 'named', 5)];
    const layout = layoutTreemap(rows, { width: 300, height: 200, minTiles: 1 });

    expect(layout.tiles.map((tile) => tile.name)).toContain('named');
    expect(layout.tiles.some((tile) => tile.name.startsWith('Other'))).toBe(false);
  });

  it('keeps tiles readably shaped across aspect ratios, without a corrective pass', () => {
    /*
     * The area threshold is the only sliver defence, and this is the evidence that it is enough. A
     * power-law distribution — which is what a real directory looks like — is laid out at five very
     * different canvas shapes, and no individually-placed tile comes out thinner than five pixels.
     *
     * The aggregated tail is exempt: when it is negligible beside a dominant entry it can round to
     * zero width, which is the honest outcome for something that holds almost nothing, and
     * `drawTreemap` skips it.
     */
    const rows = Array.from({ length: 200 }, (_unused, index) =>
      row(index + 1, `r-${index}`, Math.round(10_000_000 / (index + 1) ** 2) + 1),
    );

    for (const [width, height] of [
      [1_470, 700],
      [400, 900],
      [1_800, 200],
      [300, 300],
      [2_400, 1_300],
    ] as const) {
      const layout = layoutTreemap(rows, { width, height, minTiles: 1 });
      const hairlines = layout.tiles.filter(
        (tile) => tile.id !== OTHER_TILE_ID && Math.min(tile.width, tile.height) < 5,
      );
      expect(
        hairlines.map((tile) => `${tile.name} ${tile.width}x${tile.height}`),
        `at ${width}x${height}`,
      ).toEqual([]);
    }
  });

  it('aggregates nothing when every entry is readable', () => {
    const rows = [row(1, 'a', 400), row(2, 'b', 300), row(3, 'c', 300)];
    const layout = layoutTreemap(rows, { width: 900, height: 600 });

    expect(layout.groupedCount).toBe(0);
    expect(layout.tiles.some((tile) => tile.id === OTHER_TILE_ID)).toBe(false);
  });
});

describe('hitTest', () => {
  const layout = layoutTreemap([row(1, 'a', 600), row(2, 'b', 400)], {
    width: 400,
    height: 200,
    gap: 0,
  });

  it('finds the tile under a point', () => {
    const first = layout.tiles[0]!;
    const inside = hitTest(layout.tiles, first.x + first.width / 2, first.y + first.height / 2);
    expect(inside?.id).toBe(first.id);
  });

  it('treats the top-left corner as inside and the bottom-right as outside', () => {
    // Half-open intervals mean adjacent tiles never both claim the same pixel.
    const first = layout.tiles[0]!;
    expect(hitTest(layout.tiles, first.x, first.y)?.id).toBe(first.id);
    expect(hitTest(layout.tiles, first.x + first.width, first.y)?.id).not.toBe(first.id);
  });

  it('returns null outside the canvas', () => {
    expect(hitTest(layout.tiles, -5, 10)).toBeNull();
    expect(hitTest(layout.tiles, 10, -5)).toBeNull();
    expect(hitTest(layout.tiles, 10_000, 10_000)).toBeNull();
  });

  it('returns null when there are no tiles', () => {
    expect(hitTest([], 10, 10)).toBeNull();
  });
});

describe('tileInDirection', () => {
  /*
   * Four equal values in a square do not produce a 2x2 grid. Squarify lays them out as three
   * stacked tiles 300 wide plus one 100-wide column on the right:
   *
   *   +-----------+---+
   *   |     a     |   |
   *   +-----------+ d |
   *   |     b     |   |
   *   +-----------+   |
   *   |     c     |   |
   *   +-----------+---+
   *
   * That matters for what "the tile to my right" can reasonably mean, and it is why directional
   * navigation is not reversible: from `a` the only thing to the right is `d`, but from `d` the
   * nearest thing to the left is `b`, because `b` is the tile actually beside it. Insisting on
   * reversibility would mean ignoring alignment, which is worse.
   */
  const tiles = layoutTreemap(
    [row(1, 'a', 250), row(2, 'b', 250), row(3, 'c', 250), row(4, 'd', 250)],
    { width: 400, height: 400, gap: 0, round: false },
  ).tiles;

  const byName = (name: string): Tile => {
    const tile = tiles.find((candidate) => candidate.name === name);
    if (tile === undefined) throw new Error(`no tile named ${name}`);
    return tile;
  };

  it('moves to a neighbour in each available direction', () => {
    const a = byName('a');
    expect(tileInDirection(tiles, a, 'right')?.name).toBe('d');
    expect(tileInDirection(tiles, a, 'down')?.name).toBe('b');
  });

  it('returns null when there is nothing in that direction', () => {
    const a = byName('a');
    expect(tileInDirection(tiles, a, 'left')).toBeNull();
    expect(tileInDirection(tiles, a, 'up')).toBeNull();
  });

  it('prefers the neighbour aligned with the current tile', () => {
    // From the tall right-hand column, "left" should land on the tile actually beside it rather
    // than on the topmost one.
    expect(tileInDirection(tiles, byName('d'), 'left')?.name).toBe('b');
  });

  it('always returns a tile that lies in the requested direction', () => {
    for (const tile of tiles) {
      const centreX = tile.x + tile.width / 2;
      const centreY = tile.y + tile.height / 2;

      const right = tileInDirection(tiles, tile, 'right');
      if (right !== null) expect(right.x + right.width / 2).toBeGreaterThan(centreX);

      const down = tileInDirection(tiles, tile, 'down');
      if (down !== null) expect(down.y + down.height / 2).toBeGreaterThan(centreY);
    }
  });

  it('never returns the tile it started from', () => {
    for (const tile of tiles) {
      for (const direction of ['left', 'right', 'up', 'down'] as const) {
        expect(tileInDirection(tiles, tile, direction)?.id).not.toBe(tile.id);
      }
    }
  });

  it('returns null when there is nowhere to go', () => {
    const single = layoutTreemap([row(1, 'only', 10)], { width: 100, height: 100 }).tiles;
    expect(tileInDirection(single, single[0]!, 'right')).toBeNull();
  });
});
