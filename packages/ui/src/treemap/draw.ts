import { OTHER_TILE_ID } from '../types.ts';
import { isTileLink, isTilePartial, tileColor, type CanvasTheme } from './colors.ts';
import type { Tile } from './layout.ts';

/**
 * Canvas painting for the treemap.
 *
 * Separated from the React component and typed against the narrowest possible slice of the canvas
 * API, so the decisions that carry meaning — when a label is legible enough to draw, what gets
 * truncated, how a partial total is marked — can be tested against a recording fake. The real
 * `CanvasRenderingContext2D` satisfies `TreemapContext` structurally.
 *
 * Everything here works in CSS pixels. Device-pixel scaling is applied once by the component,
 * which keeps the geometry in this file the same geometry that hit-testing uses.
 */

/** The slice of the canvas 2D API this renderer needs. */
export interface TreemapContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  textBaseline: CanvasTextBaseline;
  globalAlpha: number;
  save(): void;
  restore(): void;
  beginPath(): void;
  rect(x: number, y: number, width: number, height: number): void;
  clip(): void;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  strokeRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { readonly width: number };
}

/** Smallest tile that can carry a name without the text overflowing its own rectangle. */
export const MIN_LABEL_WIDTH = 42;
export const MIN_LABEL_HEIGHT = 18;

/** A tile needs this much height before a second line of text earns its place. */
export const MIN_DETAIL_HEIGHT = 40;

const PADDING = 6;
const NAME_FONT = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif';
const DETAIL_FONT = '11px system-ui, -apple-system, "Segoe UI", sans-serif';

export interface DrawTreemapOptions {
  readonly tiles: readonly Tile[];
  readonly theme: CanvasTheme;
  readonly hoveredId: number | null;
  readonly selectedId: number | null;
  readonly formatValue: (bytes: number) => string;
  readonly formatShare: (fraction: number) => string;
}

/**
 * Parses `#rgb` and `#rrggbb`.
 *
 * Only the palette's own format is handled. A CSS variable could in principle hold `oklch()` or a
 * named colour, and rather than embed a colour parser the renderer falls back to light text, which
 * is correct for every dark palette and merely imperfect for a hypothetical light one.
 */
function parseHex(color: string): { r: number; g: number; b: number } | null {
  const value = color.trim();
  if (!value.startsWith('#')) return null;

  const digits = value.slice(1);
  if (digits.length === 3) {
    const [r, g, b] = digits;
    return {
      r: Number.parseInt(`${r!}${r!}`, 16),
      g: Number.parseInt(`${g!}${g!}`, 16),
      b: Number.parseInt(`${b!}${b!}`, 16),
    };
  }
  if (digits.length === 6) {
    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16),
    };
  }
  return null;
}

/**
 * Picks readable text for a background, using WCAG relative luminance rather than a naive
 * brightness average, because the naive version puts dark text on saturated blues where it is
 * genuinely hard to read.
 */
export function textColorFor(background: string): 'light' | 'dark' {
  const rgb = parseHex(background);
  if (rgb === null) return 'light';

  const channel = (raw: number): number => {
    const normalized = raw / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  return luminance > 0.42 ? 'dark' : 'light';
}

/** Shortens text to fit `maxWidth`, appending an ellipsis. Returns null when nothing fits. */
export function truncateToWidth(
  context: TreemapContext,
  text: string,
  maxWidth: number,
): string | null {
  if (maxWidth <= 0) return null;
  if (context.measureText(text).width <= maxWidth) return text;

  const ellipsis = '…';
  if (context.measureText(ellipsis).width > maxWidth) return null;

  // Binary search rather than trimming one character at a time: a long path component in a narrow
  // tile would otherwise cost dozens of text measurements, and this runs for every tile on every
  // frame during a resize.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = text.slice(0, middle) + ellipsis;
    if (context.measureText(candidate).width <= maxWidth) low = middle;
    else high = middle - 1;
  }

  return low === 0 ? ellipsis : text.slice(0, low) + ellipsis;
}

export function drawTreemap(
  context: TreemapContext,
  width: number,
  height: number,
  options: DrawTreemapOptions,
): void {
  const { theme, tiles } = options;

  context.clearRect(0, 0, width, height);
  context.fillStyle = theme.background;
  context.fillRect(0, 0, width, height);
  context.textBaseline = 'top';

  for (const tile of tiles) {
    if (tile.width <= 0 || tile.height <= 0) continue;

    const background = tileColor(tile, theme);
    const hovered = options.hoveredId === tile.id;
    const selected = options.selectedId === tile.id;

    context.globalAlpha = hovered ? 1 : 0.92;
    context.fillStyle = background;
    context.fillRect(tile.x, tile.y, tile.width, tile.height);
    context.globalAlpha = 1;

    // A link is drawn hollow. Its own size is a handful of bytes while its target may be huge, and
    // a solid tile would imply the space is accounted for here.
    if (isTileLink(tile)) {
      context.strokeStyle = theme.background;
      context.lineWidth = 1;
      context.strokeRect(tile.x + 0.5, tile.y + 0.5, tile.width - 1, tile.height - 1);
    }

    if (selected) {
      context.strokeStyle = theme.accent;
      context.lineWidth = 2;
      context.strokeRect(tile.x + 1, tile.y + 1, tile.width - 2, tile.height - 2);
    }

    if (tile.width < MIN_LABEL_WIDTH || tile.height < MIN_LABEL_HEIGHT) continue;

    const foreground = textColorFor(background) === 'dark' ? '#11131a' : theme.text;
    const available = tile.width - PADDING * 2;

    context.save();
    // Clipping guarantees text cannot bleed into a neighbouring tile even if measurement and
    // rendering disagree slightly, which they can with font fallback.
    context.beginPath();
    context.rect(tile.x, tile.y, tile.width, tile.height);
    context.clip();

    context.font = NAME_FONT;
    context.fillStyle = foreground;
    const name = truncateToWidth(context, tile.name, available);
    if (name !== null) {
      context.fillText(name, tile.x + PADDING, tile.y + PADDING);
    }

    if (tile.height >= MIN_DETAIL_HEIGHT) {
      context.font = DETAIL_FONT;
      context.globalAlpha = 0.82;
      const partialMarker = isTilePartial(tile) && tile.id !== OTHER_TILE_ID ? '≥ ' : '';
      const detail = `${partialMarker}${options.formatValue(tile.value)} · ${options.formatShare(tile.share)}`;
      const fitted = truncateToWidth(context, detail, available);
      if (fitted !== null) {
        context.fillText(fitted, tile.x + PADDING, tile.y + PADDING + 16);
      }
      context.globalAlpha = 1;
    }

    context.restore();
  }
}
