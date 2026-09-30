import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';
import { OTHER_TILE_ID, type TreemapRow } from '../types.ts';

/**
 * Treemap layout: the pure geometry behind the visualisation.
 *
 * Kept entirely free of React and of the canvas so the behaviour that actually matters — tiles
 * are proportional, ordered largest first, and the long tail is aggregated rather than drawn as
 * unreadable slivers — is testable without a rendering environment. That is not a convenience:
 * jsdom has no canvas implementation, so a component test could not verify any of it.
 *
 * The squarified tiling comes from d3-hierarchy. Squarify is a subtle algorithm whose whole
 * purpose is keeping tiles close to square, and a hand-rolled version that is slightly wrong
 * produces a layout that looks broken without being obviously incorrect. Ten kilobytes for proven
 * geometry is a good trade.
 */

/** Below this many square pixels a tile carries no readable information. */
export const DEFAULT_MIN_TILE_AREA = 260;

/** Always show at least this many tiles, even in a directory of ten thousand equal files. */
export const DEFAULT_MIN_TILES = 12;

/** Upper bound on drawn tiles, so a huge directory cannot cost an unbounded amount of work. */
export const DEFAULT_MAX_TILES = 160;

export const DEFAULT_TILE_GAP = 2;

/*
 * A note on sliver shapes, and why there is no second layout pass.
 *
 * Area is all that is knowable before layout, and a tile with adequate area could in principle come
 * out as a one-pixel hairline. A corrective second pass was built and then removed, because
 * measurement did not support it: across power-law, realistic and minimal size distributions at five
 * canvas aspect ratios from 300x300 to 2400x1300, the number of individually-placed tiles thinner
 * than five pixels was zero in every case except a three-entry folder at an extreme aspect ratio,
 * where exactly one appeared — and folding a single entry into "Other (1 item)" hides its name,
 * which is worse than a hairline the tooltip can still identify.
 *
 * What the same measurements did show is that the aggregated tail itself can round to zero width
 * when it is negligible beside a dominant entry. Such a tile is simply not drawn (`drawTreemap`
 * skips it) and cannot be hit, which is the correct outcome for something that genuinely holds
 * almost nothing.
 *
 * Task 13 owns treemap polish and should revisit this with these numbers rather than re-deriving
 * them.
 */

export interface TreemapLayoutOptions {
  readonly width: number;
  readonly height: number;
  readonly minTileArea?: number;
  readonly minTiles?: number;
  readonly maxTiles?: number;
  readonly gap?: number;
  /**
   * Snap coordinates to whole pixels. On by default, because a rectangle on a half pixel renders
   * with a blurred edge. Turning it off gives exactly proportional areas, which is what the
   * proportionality tests assert and what smooth animation will want in Task 13.
   */
  readonly round?: boolean;
}

export interface Tile {
  /** Real node id, or `OTHER_TILE_ID` for the aggregated tail. */
  readonly id: number;
  readonly name: string;
  readonly value: number;
  readonly directory: boolean;
  readonly flags: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Share of the laid-out total, as a fraction in [0, 1]. */
  readonly share: number;
  /** Rows folded into this tile: 1 for a real row, more for the tail. */
  readonly groupedCount: number;
}

export interface TreemapLayout {
  readonly tiles: readonly Tile[];
  /** Sum of the values that were laid out. */
  readonly total: number;
  /** Rows with no bytes, which cannot be drawn proportionally. */
  readonly omittedZeroCount: number;
  /** Rows folded into the aggregated tail. */
  readonly groupedCount: number;
}

export const EMPTY_LAYOUT: TreemapLayout = {
  tiles: [],
  total: 0,
  omittedZeroCount: 0,
  groupedCount: 0,
};

interface LayoutDatum {
  readonly row: TreemapRow | null;
  readonly name: string;
  readonly value: number;
  readonly groupedCount: number;
  readonly children?: readonly LayoutDatum[];
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * Decides how many of the largest rows to draw individually.
 *
 * Area is known before layout: squarify preserves area exactly, so a row's area is its share of
 * the total multiplied by the available pixels, whatever shape it ends up. That makes the tail
 * cut-off predictable rather than something discovered after laying out.
 */
/** Exactly what the tail decision needs, rather than a derived type that drifts with the options. */
interface KeepOptions {
  readonly width: number;
  readonly height: number;
  readonly minTileArea: number;
  readonly minTiles: number;
  readonly maxTiles: number;
}

function tilesToKeep(sorted: readonly TreemapRow[], total: number, options: KeepOptions): number {
  const available = options.width * options.height;
  let readable = sorted.length;

  for (let index = 0; index < sorted.length; index += 1) {
    const area = (sorted[index]!.totalSize / total) * available;
    if (area < options.minTileArea) {
      readable = index;
      break;
    }
  }

  // The floor matters: in a directory of ten thousand similar files every tile is below the
  // readable threshold, and folding all of them into one "Other" tile would answer the user's
  // question with a shrug. Showing the largest dozen is always more useful.
  return clamp(readable, Math.min(options.minTiles, sorted.length), options.maxTiles);
}

export function layoutTreemap(
  rows: readonly TreemapRow[],
  options: TreemapLayoutOptions,
): TreemapLayout {
  const width = options.round === false ? options.width : Math.floor(options.width);
  const height = options.round === false ? options.height : Math.floor(options.height);
  if (width <= 0 || height <= 0) return EMPTY_LAYOUT;

  const resolved = {
    width,
    height,
    minTileArea: options.minTileArea ?? DEFAULT_MIN_TILE_AREA,
    minTiles: options.minTiles ?? DEFAULT_MIN_TILES,
    maxTiles: options.maxTiles ?? DEFAULT_MAX_TILES,
  };

  // A zero-byte entry has no area to occupy. It is still real, and the directory tree lists it;
  // reporting the count here lets the UI say so rather than silently losing it.
  const sized = rows.filter((row) => row.totalSize > 0);
  const omittedZeroCount = rows.length - sized.length;
  if (sized.length === 0) return { ...EMPTY_LAYOUT, omittedZeroCount };

  // Largest first, with ties broken by id so the layout is reproducible across renders.
  const sorted = [...sized].sort(
    (left, right) => right.totalSize - left.totalSize || left.id - right.id,
  );
  const total = sorted.reduce((sum, row) => sum + row.totalSize, 0);

  const keep = tilesToKeep(sorted, total, resolved);
  const gap = options.gap ?? DEFAULT_TILE_GAP;

  const leaves: LayoutDatum[] = sorted.slice(0, keep).map((row) => ({
    row,
    name: row.name,
    value: row.totalSize,
    groupedCount: 1,
  }));

  const tail = sorted.slice(keep);
  if (tail.length > 0) {
    const tailValue = tail.reduce((sum, row) => sum + row.totalSize, 0);
    if (tailValue > 0) {
      leaves.push({
        row: null,
        name: tail.length === 1 ? tail[0]!.name : `Other (${String(tail.length)} items)`,
        value: tailValue,
        groupedCount: tail.length,
      });
    }
  }

  const root = hierarchy<LayoutDatum>(
    { row: null, name: '', value: 0, groupedCount: 0, children: leaves },
    (datum) => (datum.children === undefined ? null : [...datum.children]),
  )
    .sum((datum) => datum.value)
    .sort((left, right) => (right.value ?? 0) - (left.value ?? 0));

  // The return value is the same object, but typed as rectangular: `treemap()` is what adds the
  // x0/y0/x1/y1 coordinates, so the input type genuinely does not have them yet.
  const positioned = treemap<LayoutDatum>()
    .tile(treemapSquarify)
    .size([width, height])
    .paddingInner(gap)
    .round(options.round ?? true)(root);

  const tiles: Tile[] = positioned.leaves().map((leaf) => {
    const datum = leaf.data;
    const row = datum.row;
    return {
      id: row?.id ?? OTHER_TILE_ID,
      name: datum.name,
      value: datum.value,
      directory: row?.directory ?? false,
      flags: row?.flags ?? 0,
      x: leaf.x0,
      y: leaf.y0,
      width: Math.max(0, leaf.x1 - leaf.x0),
      height: Math.max(0, leaf.y1 - leaf.y0),
      share: datum.value / total,
      groupedCount: datum.groupedCount,
    };
  });

  return {
    tiles,
    total,
    omittedZeroCount,
    groupedCount: tail.length,
  };
}

/**
 * The tile at a point, or null.
 *
 * A linear scan is the right answer here: aggregation caps the tile count at
 * `DEFAULT_MAX_TILES`, so this is a few dozen comparisons and a spatial index would be more code
 * for no measurable gain.
 */
export function hitTest(tiles: readonly Tile[], x: number, y: number): Tile | null {
  for (const tile of tiles) {
    if (x >= tile.x && x < tile.x + tile.width && y >= tile.y && y < tile.y + tile.height) {
      return tile;
    }
  }
  return null;
}

/**
 * The tile nearest a point in a given direction, for keyboard navigation.
 *
 * Treemap tiles are not a grid, so "the next tile to the right" has to be chosen geometrically:
 * among tiles whose centre lies in that direction, take the closest, weighting movement along the
 * requested axis so focus does not jump across the layout.
 */
export function tileInDirection(
  tiles: readonly Tile[],
  from: Tile,
  direction: 'left' | 'right' | 'up' | 'down',
): Tile | null {
  const fromX = from.x + from.width / 2;
  const fromY = from.y + from.height / 2;

  let best: Tile | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const tile of tiles) {
    if (tile === from || tile.id === from.id) continue;
    const dx = tile.x + tile.width / 2 - fromX;
    const dy = tile.y + tile.height / 2 - fromY;

    const alignedWithDirection =
      direction === 'left'
        ? dx < 0
        : direction === 'right'
          ? dx > 0
          : direction === 'up'
            ? dy < 0
            : dy > 0;
    if (!alignedWithDirection) continue;

    // Movement perpendicular to the requested direction is penalised, which keeps a rightward
    // press from landing on a tile that is mostly below.
    const horizontal = direction === 'left' || direction === 'right';
    const distance = horizontal ? Math.abs(dx) + Math.abs(dy) * 2 : Math.abs(dy) + Math.abs(dx) * 2;

    if (distance < bestDistance) {
      bestDistance = distance;
      best = tile;
    }
  }

  return best;
}
