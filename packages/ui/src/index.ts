// @sv/ui — the shared visualisation layer.
//
// Nothing here knows where its data came from. Components take view models defined in `types.ts`,
// which are structural subsets of the desktop IPC row types, so the Electron renderer can pass its
// rows straight through and the browser application will be able to do the same. That is the whole
// point of the split: one treemap, one set of formatting decisions, two surfaces.

export { Breadcrumbs, type BreadcrumbsProps } from './Breadcrumbs.tsx';
export { ScanProgressPanel, type ScanProgressPanelProps } from './ScanProgress.tsx';
export { VolumePicker, type VolumePickerProps } from './VolumePicker.tsx';

export {
  COLLAPSE_MARKER_ID,
  collapseBreadcrumbs,
  type CollapsedBreadcrumbs,
} from './breadcrumbs.ts';

export { useDevicePixelRatio, useElementSize, useLatest, type ElementSize } from './hooks.ts';

export {
  OTHER_TILE_ID,
  type BreadcrumbItem,
  type ScanProgressView,
  type TreemapRow,
  type VolumeCard,
} from './types.ts';

export { Treemap, type TreemapProps } from './treemap/Treemap.tsx';

export {
  FALLBACK_THEME,
  hashName,
  isTileLink,
  isTilePartial,
  readCanvasTheme,
  tileColor,
  type CanvasTheme,
} from './treemap/colors.ts';

export {
  MIN_DETAIL_HEIGHT,
  MIN_LABEL_HEIGHT,
  MIN_LABEL_WIDTH,
  drawTreemap,
  textColorFor,
  truncateToWidth,
  type DrawTreemapOptions,
  type TreemapContext,
} from './treemap/draw.ts';

export {
  DEFAULT_MAX_TILES,
  DEFAULT_MIN_TILES,
  DEFAULT_MIN_TILE_AREA,
  DEFAULT_TILE_GAP,
  EMPTY_LAYOUT,
  hitTest,
  layoutTreemap,
  tileInDirection,
  type Tile,
  type TreemapLayout,
  type TreemapLayoutOptions,
} from './treemap/layout.ts';
