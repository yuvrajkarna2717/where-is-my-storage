import type { BreadcrumbItem } from './types.ts';

/**
 * Breadcrumb collapsing.
 *
 * A path can be forty levels deep, and a breadcrumb bar that wraps onto four lines stops being
 * navigation and becomes noise. The rule is to keep the root and the tail: where you started and
 * where you are now are what orient a person, while the middle is exactly what they are least
 * likely to want to jump back to.
 *
 * Pure, because "where am I" is the thing most worth getting right and it should be verifiable
 * without a browser.
 */
export const COLLAPSE_MARKER_ID = -2;

export interface CollapsedBreadcrumbs {
  /** Items to render in order. The marker, if present, has id `COLLAPSE_MARKER_ID`. */
  readonly items: readonly BreadcrumbItem[];
  /** How many real entries the marker stands in for. */
  readonly hiddenCount: number;
}

export function collapseBreadcrumbs(
  trail: readonly BreadcrumbItem[],
  maxVisible = 5,
): CollapsedBreadcrumbs {
  // Two visible entries plus a marker is the smallest arrangement that still says
  // "root ... here", so anything tighter is treated as no collapsing at all.
  if (maxVisible < 3 || trail.length <= maxVisible) {
    return { items: trail, hiddenCount: 0 };
  }

  const tailCount = maxVisible - 2;
  const head = trail[0]!;
  const tail = trail.slice(trail.length - tailCount);
  const hiddenCount = trail.length - 1 - tailCount;

  return {
    items: [head, { id: COLLAPSE_MARKER_ID, label: '…', totalSize: 0 }, ...tail],
    hiddenCount,
  };
}
