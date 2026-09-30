import { NodeFlags, hasFlag } from '@sv/core';
import { OTHER_TILE_ID } from '../types.ts';
import type { Tile } from './layout.ts';

/**
 * Tile colouring.
 *
 * Two goals, in order. Colours must be **stable**: the same folder keeps the same colour across
 * renders and across scans, so a person learns to recognise the big blue block as their videos
 * rather than re-reading labels every time. And they must be **calm**: a storage tool is looked at
 * while slightly anxious about running out of space, and a carnival of saturated rectangles does
 * not help.
 *
 * Stability comes from hashing the name rather than using the index, because index-based colouring
 * reshuffles every time a folder grows past its neighbour. The palette is read from CSS custom
 * properties so themes stay in the stylesheet, where the rest of the theming lives — a canvas
 * cannot inherit CSS, so this is the bridge.
 */

export interface CanvasTheme {
  readonly background: string;
  readonly text: string;
  readonly textMuted: string;
  readonly border: string;
  readonly accent: string;
  readonly neutral: string;
  readonly palette: readonly string[];
}

/** Used when no stylesheet has been applied yet, and as the shape of the contract. */
export const FALLBACK_THEME: CanvasTheme = {
  background: '#12131a',
  text: '#e6e8f0',
  textMuted: '#9aa0b4',
  border: '#2b2f3f',
  accent: '#6ea8fe',
  neutral: '#3a3f52',
  palette: [
    '#4a6fa5',
    '#5b8c7b',
    '#8a6a9d',
    '#a5794a',
    '#4a8ca5',
    '#7d8c5b',
    '#a55a6a',
    '#5a6aa5',
    '#8c7b5b',
    '#5b7d8c',
  ],
};

const PALETTE_SIZE = FALLBACK_THEME.palette.length;

function readVariable(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = styles.getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

/** Reads the theme from an element's computed custom properties. */
export function readCanvasTheme(element: Element): CanvasTheme {
  const styles = getComputedStyle(element);
  const palette: string[] = [];
  for (let index = 0; index < PALETTE_SIZE; index += 1) {
    palette.push(
      readVariable(styles, `--tile-${String(index + 1)}`, FALLBACK_THEME.palette[index]!),
    );
  }

  return {
    background: readVariable(styles, '--surface', FALLBACK_THEME.background),
    text: readVariable(styles, '--text', FALLBACK_THEME.text),
    textMuted: readVariable(styles, '--text-muted', FALLBACK_THEME.textMuted),
    border: readVariable(styles, '--border', FALLBACK_THEME.border),
    accent: readVariable(styles, '--accent', FALLBACK_THEME.accent),
    neutral: readVariable(styles, '--tile-neutral', FALLBACK_THEME.neutral),
    palette,
  };
}

/**
 * FNV-1a over the name's code units.
 *
 * Any stable hash would do; this one is three lines, has no dependencies, and spreads similar
 * names ("Videos" and "Videos 2") into different buckets, which is exactly what is wanted when
 * neighbouring folders have similar names.
 */
export function hashName(name: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function tileColor(tile: Tile, theme: CanvasTheme): string {
  // The aggregated tail is not a thing on disk, so it gets a neutral colour rather than competing
  // for attention with real directories.
  if (tile.id === OTHER_TILE_ID) return theme.neutral;
  return theme.palette[hashName(tile.name) % theme.palette.length] ?? theme.neutral;
}

/** True when a tile's total is a lower bound, so the renderer can mark it. */
export function isTilePartial(tile: Tile): boolean {
  return hasFlag(tile.flags, NodeFlags.Partial);
}

/** True for a link, which is recorded but never traversed. */
export function isTileLink(tile: Tile): boolean {
  return hasFlag(tile.flags, NodeFlags.Symlink) || hasFlag(tile.flags, NodeFlags.Reparse);
}
