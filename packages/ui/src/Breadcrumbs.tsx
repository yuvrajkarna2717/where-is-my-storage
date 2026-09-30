import { formatBytes } from '@sv/core';
import { COLLAPSE_MARKER_ID, collapseBreadcrumbs } from './breadcrumbs.ts';
import type { BreadcrumbItem } from './types.ts';

export interface BreadcrumbsProps {
  /** Root first, current location last. */
  readonly trail: readonly BreadcrumbItem[];
  readonly onNavigate: (id: number) => void;
  readonly maxVisible?: number;
}

/**
 * Where you are, and one click back to anywhere above you.
 *
 * The final entry is text rather than a button: it is the current location, so offering to navigate
 * to it would be a control that does nothing. The collapse marker is likewise inert — it stands in
 * for levels that were hidden, and guessing which one a click meant would be worse than not
 * offering.
 */
export function Breadcrumbs(props: BreadcrumbsProps): React.JSX.Element {
  const { items, hiddenCount } = collapseBreadcrumbs(props.trail, props.maxVisible ?? 5);

  return (
    <nav className="breadcrumbs" aria-label="Location">
      <ol>
        {items.map((item, index) => {
          const isCurrent = index === items.length - 1;
          const isMarker = item.id === COLLAPSE_MARKER_ID;

          return (
            <li key={isMarker ? 'collapsed' : item.id}>
              {isMarker ? (
                <span
                  className="breadcrumbs__collapsed"
                  title={`${String(hiddenCount)} more levels`}
                >
                  {item.label}
                </span>
              ) : isCurrent ? (
                <span className="breadcrumbs__current" aria-current="page">
                  {item.label}
                </span>
              ) : (
                <button
                  type="button"
                  className="breadcrumbs__link"
                  onClick={() => {
                    props.onNavigate(item.id);
                  }}
                  title={`${item.label} · ${formatBytes(item.totalSize)}`}
                >
                  {item.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
