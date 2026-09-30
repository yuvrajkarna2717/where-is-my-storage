import { formatBytes, formatPercent } from '@sv/core';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useDevicePixelRatio, useElementSize } from '../hooks.ts';
import { OTHER_TILE_ID, type TreemapRow } from '../types.ts';
import { FALLBACK_THEME, readCanvasTheme, type CanvasTheme } from './colors.ts';
import { drawTreemap } from './draw.ts';
import { hitTest, layoutTreemap, tileInDirection, type Tile } from './layout.ts';

/**
 * The storage map.
 *
 * Rendered to a canvas rather than to DOM elements. A directory can hold a hundred thousand
 * entries, and while aggregation keeps the *drawn* tile count in the dozens, DOM tiles would still
 * mean layout and paint work proportional to the number of elements on every hover and every
 * resize. One canvas means one element and a redraw measured in fractions of a millisecond.
 *
 * The cost of that choice is accessibility: a canvas is invisible to assistive technology. It is
 * paid here rather than hand-waved. Alongside the canvas sits a real listbox with one option per
 * visible tile, which owns the focus, drives keyboard navigation, and announces the selection. It
 * is positioned off-screen rather than hidden, because `display: none` would remove it from the
 * accessibility tree too.
 */

export interface TreemapProps {
  readonly rows: readonly TreemapRow[];
  /** Drill into a directory. Never called for files or for the aggregated tail. */
  readonly onOpen: (row: TreemapRow) => void;
  readonly onSelect?: (row: TreemapRow | null) => void;
  readonly selectedId?: number | null;
  readonly emptyMessage?: string;
  readonly label?: string;
}

interface Hover {
  readonly tile: Tile;
  readonly x: number;
  readonly y: number;
}

const formatValue = (bytes: number): string => formatBytes(bytes);
const formatShare = (fraction: number): string => formatPercent(fraction);

export function Treemap(props: TreemapProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = useElementSize(containerRef);
  const pixelRatio = useDevicePixelRatio();
  const listboxId = useId();

  const [theme, setTheme] = useState<CanvasTheme>(FALLBACK_THEME);
  const [hover, setHover] = useState<Hover | null>(null);

  const layout = useMemo(
    () => layoutTreemap(props.rows, { width: size.width, height: size.height }),
    [props.rows, size.width, size.height],
  );

  const rowById = useMemo(() => {
    const map = new Map<number, TreemapRow>();
    for (const row of props.rows) map.set(row.id, row);
    return map;
  }, [props.rows]);

  // Read once the element is in the document and its stylesheet has applied. A canvas cannot
  // inherit CSS, so the palette has to be pulled across explicitly.
  useEffect(() => {
    const element = containerRef.current;
    if (element !== null) setTheme(readCanvasTheme(element));
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || size.width <= 0 || size.height <= 0) return;

    canvas.width = Math.round(size.width * pixelRatio);
    canvas.height = Math.round(size.height * pixelRatio);

    const context = canvas.getContext('2d');
    if (context === null) return;

    // One transform for the whole frame, so every coordinate below — and every coordinate used by
    // hit-testing — stays in CSS pixels.
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    drawTreemap(context, size.width, size.height, {
      tiles: layout.tiles,
      theme,
      hoveredId: hover?.tile.id ?? null,
      selectedId: props.selectedId ?? null,
      formatValue,
      formatShare,
    });
  }, [layout, size.width, size.height, pixelRatio, theme, hover, props.selectedId]);

  const rowFor = useCallback(
    (tile: Tile): TreemapRow | null => rowById.get(tile.id) ?? null,
    [rowById],
  );

  const select = useCallback(
    (tile: Tile | null): void => {
      props.onSelect?.(tile === null ? null : rowFor(tile));
    },
    [props, rowFor],
  );

  const open = useCallback(
    (tile: Tile): void => {
      // The aggregated tail is not a place; there is nothing to open.
      if (tile.id === OTHER_TILE_ID) return;
      const row = rowFor(tile);
      if (row !== null && row.directory) props.onOpen(row);
    },
    [props, rowFor],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>): void => {
      const bounds = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      const tile = hitTest(layout.tiles, x, y);
      setHover(tile === null ? null : { tile, x, y });
    },
    [layout.tiles],
  );

  const handlePointerLeave = useCallback((): void => {
    setHover(null);
  }, []);

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>): void => {
      const bounds = event.currentTarget.getBoundingClientRect();
      const tile = hitTest(layout.tiles, event.clientX - bounds.left, event.clientY - bounds.top);
      if (tile === null) return;
      select(tile);
      open(tile);
    },
    [layout.tiles, open, select],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLUListElement>): void => {
      const tiles = layout.tiles;
      if (tiles.length === 0) return;

      const current = tiles.find((tile) => tile.id === props.selectedId) ?? null;

      const direction =
        event.key === 'ArrowLeft'
          ? 'left'
          : event.key === 'ArrowRight'
            ? 'right'
            : event.key === 'ArrowUp'
              ? 'up'
              : event.key === 'ArrowDown'
                ? 'down'
                : null;

      if (direction !== null) {
        event.preventDefault();
        // With nothing selected, the first arrow press lands on the largest tile, which is where a
        // person's attention already is.
        const next =
          current === null ? tiles[0]! : (tileInDirection(tiles, current, direction) ?? current);
        select(next);
        return;
      }

      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (current !== null) open(current);
        return;
      }

      if (event.key === 'Home') {
        event.preventDefault();
        select(tiles[0]!);
      }
    },
    [layout.tiles, open, props.selectedId, select],
  );

  const activeOptionId =
    props.selectedId === null || props.selectedId === undefined
      ? undefined
      : `${listboxId}-tile-${String(props.selectedId)}`;

  const isEmpty = layout.tiles.length === 0;

  return (
    <div className="treemap" ref={containerRef}>
      {isEmpty ? (
        <p className="treemap__empty">
          {props.emptyMessage ??
            (layout.omittedZeroCount > 0
              ? `Nothing here takes up space (${String(layout.omittedZeroCount)} empty entries)`
              : 'Nothing to show yet')}
        </p>
      ) : (
        <canvas
          className="treemap__canvas"
          ref={canvasRef}
          style={{ width: '100%', height: '100%' }}
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
          onClick={handleClick}
          // Decorative as far as assistive technology is concerned: the listbox below carries the
          // real, navigable content.
          aria-hidden="true"
        />
      )}

      {hover !== null && (
        <div
          className="treemap__tooltip"
          role="presentation"
          style={{ left: `${String(hover.x)}px`, top: `${String(hover.y)}px` }}
        >
          <span className="treemap__tooltip-name">{hover.tile.name}</span>
          <span className="treemap__tooltip-detail">
            {formatValue(hover.tile.value)} · {formatShare(hover.tile.share)} of this folder
          </span>
          {hover.tile.groupedCount > 1 && (
            <span className="treemap__tooltip-detail">
              {hover.tile.groupedCount} entries too small to draw separately
            </span>
          )}
        </div>
      )}

      {/* Off-screen rather than hidden: `display: none` would remove it from the accessibility
          tree, which is the one thing it exists for. */}
      <ul
        className="treemap__options"
        id={listboxId}
        role="listbox"
        aria-label={props.label ?? 'Storage map'}
        aria-activedescendant={activeOptionId}
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        {layout.tiles.map((tile) => (
          <li
            key={tile.id}
            id={`${listboxId}-tile-${String(tile.id)}`}
            role="option"
            aria-selected={tile.id === props.selectedId}
            data-tile-id={tile.id}
            data-tile-name={tile.name}
            onClick={() => {
              select(tile);
              open(tile);
            }}
          >
            {tile.name}, {formatValue(tile.value)}, {formatShare(tile.share)}
            {tile.directory ? ', folder' : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}
