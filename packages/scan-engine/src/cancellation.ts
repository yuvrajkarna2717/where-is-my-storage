/**
 * Minimal structural view of a cancellation signal.
 *
 * A real `AbortSignal` satisfies this shape, so callers pass `controller.signal` directly.
 * The engine deliberately does not reference the `AbortSignal` global: this package
 * compiles with no ambient types at all so it can run unchanged in Node, in an Electron
 * utility process, in a web worker and on a browser main thread. Declaring the global
 * ambiently here would also collide with `lib.dom` wherever the DOM types are loaded.
 *
 * Only `aborted` is needed, because the engine polls between directory listings rather
 * than subscribing. Polling has no listener to leak and no timer to clear, which is
 * exactly what a scanner that must tear down cleanly wants. It also lets Task 6 back this
 * interface with a `SharedArrayBuffer` flag that worker threads can observe without any
 * message passing.
 */
export interface CancellationSignal {
  readonly aborted: boolean;
}

/** A signal that is never aborted, so callers need no null checks. */
export const NEVER_CANCELLED: CancellationSignal = { aborted: false };
