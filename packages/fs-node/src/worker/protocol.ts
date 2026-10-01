import type { DirectoryEntry, ScanIssue, ScanIssueCode } from '@sv/scan-engine';

/**
 * The contract between the worker pool and its workers.
 *
 * Cancellation travels through a `SharedArrayBuffer` rather than a message. A worker reading a
 * directory with two hundred thousand entries is inside a synchronous loop and will not process its
 * message queue until it finishes, so a "stop" message would arrive far too late. A shared flag is
 * visible immediately, and the worker checks it between entries.
 */

/** One Int32 is all the state cancellation needs. */
export const CANCEL_BUFFER_BYTES = 4;

const CANCEL_INDEX = 0;

export interface CancelFlag {
  readonly buffer: SharedArrayBuffer;
  readonly view: Int32Array;
}

export function createCancelFlag(): CancelFlag {
  const buffer = new SharedArrayBuffer(CANCEL_BUFFER_BYTES);
  return { buffer, view: new Int32Array(buffer) };
}

export function setCancelled(view: Int32Array, cancelled: boolean): void {
  // Atomics rather than a plain write: without them there is no guarantee the worker's thread ever
  // observes the change.
  Atomics.store(view, CANCEL_INDEX, cancelled ? 1 : 0);
}

export function isCancelled(view: Int32Array): boolean {
  return Atomics.load(view, CANCEL_INDEX) === 1;
}

/** Passed to each worker as `workerData`. */
export interface WorkerInit {
  readonly cancelBuffer: SharedArrayBuffer;
  /** Overridable so tests can exercise the Windows long-path branch elsewhere. */
  readonly platform: string;
}

export interface ListDirectoryRequest {
  /** Correlates the reply. Unique per pool, not per worker. */
  readonly id: number;
  readonly path: string;
}

export type ListDirectoryResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly entries: readonly DirectoryEntry[];
      readonly issues: readonly ScanIssue[];
      /** True when the shared flag was set partway through, so the listing is incomplete. */
      readonly cancelled: boolean;
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly code: ScanIssueCode;
      readonly path: string;
      readonly detail: string | undefined;
    };
