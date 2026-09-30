import { useEffect, useRef, useState, type RefObject } from 'react';

export interface ElementSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Tracks an element's content-box size.
 *
 * `ResizeObserver` rather than a window resize listener: the treemap changes size when a side panel
 * opens or a scrollbar appears, neither of which resizes the window. Observing the element itself
 * is both more correct and cheaper, because it fires only when this element actually changed.
 */
export function useElementSize<T extends Element>(ref: RefObject<T | null>): ElementSize {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;

      // contentRect is in CSS pixels, which is the coordinate space the layout and hit-testing
      // both use. devicePixelContentBoxSize would be the physical pixels and must not be mixed in.
      const { width, height } = entry.contentRect;
      setSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    });

    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [ref]);

  return size;
}

/**
 * Current device pixel ratio, kept up to date when the window moves between displays.
 *
 * Without this a window dragged from a Retina display to an external monitor renders the treemap
 * at the wrong resolution until something else forces a redraw.
 */
export function useDevicePixelRatio(): number {
  const [ratio, setRatio] = useState(() => globalThis.devicePixelRatio || 1);

  useEffect(() => {
    let query: MediaQueryList | null = null;
    let cancelled = false;

    const listen = (): void => {
      if (cancelled) return;
      const current = globalThis.devicePixelRatio || 1;
      setRatio(current);
      // The query has to be recreated for each new ratio: it matches one specific value.
      query?.removeEventListener('change', listen);
      query = matchMedia(`(resolution: ${String(current)}dppx)`);
      query.addEventListener('change', listen);
    };

    listen();
    return () => {
      cancelled = true;
      query?.removeEventListener('change', listen);
    };
  }, []);

  return ratio;
}

/** Latest value in a ref, for use inside event handlers that must not be re-bound. */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
