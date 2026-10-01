import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import {
  FileSystemAccessError,
  type CancellationSignal,
  type FileSystemProvider,
  type ListDirectoryResult,
  type ProviderCapabilities,
  type ScanRootInfo,
  type VolumeInfo,
} from '@sv/scan-engine';
import { NodeFileSystemProvider } from './node-provider.ts';
import {
  createCancelFlag,
  setCancelled,
  type CancelFlag,
  type ListDirectoryRequest,
  type ListDirectoryResponse,
  type WorkerInit,
} from './worker/protocol.ts';

/**
 * A pool of worker threads doing synchronous filesystem calls.
 *
 * **Not the default, because it did not turn out to be faster.** This was built on a reasonable
 * theory: Node dispatches asynchronous filesystem calls to a libuv thread pool of four threads by
 * default, so no matter how many listings are outstanding only four syscalls are ever really in
 * flight, and raising the engine's concurrency past that just deepens a queue. Worker threads each
 * have their own execution context, so N workers should mean N genuinely concurrent syscalls, with
 * synchronous calls inside each one avoiding a promise, a microtask and a callback per entry.
 *
 * `bench/provider.bench.ts` measured it over a warm scan of `C:\Windows` — 53k directories, 181k
 * files — and the theory holds only for the part it predicted. Listings alone, with nothing else
 * running, the pool is 10-17% faster. Through the whole engine, with the tree actually being built,
 * the lead vanishes: 2.84s at best against 2.94s for the single-threaded provider, inside the
 * run-to-run spread, with a worse median.
 *
 * The reason is that the work does not leave the main thread, it changes shape. Every listing comes
 * back as a structured clone, so the main thread stops calling `lstat` and starts deserialising a
 * few hundred thousand objects instead — while still building the tree. Fewer than eight workers is
 * consistently *slower* than no workers at all, which is the same observation from the other
 * direction: the per-message cost is on the order of the per-directory syscall cost.
 *
 * It is kept, opt-in, for three reasons. It is the only standing proof that the
 * `FileSystemProvider` seam tolerates an implementation that does not share the caller's thread,
 * which is exactly what the native provider in the plan will be. The measurement is one machine and
 * one warm NTFS tree, and a `--provider workers` flag is what lets a bug report test the other
 * hypothesis instead of arguing about it. And the fix suggested by the finding — handing listings
 * over as one transferable buffer rather than an array of objects — reuses all of this.
 *
 * Volume enumeration and root description are delegated to the simple provider. They happen once per
 * scan, so there is nothing to gain from parallelising them and a real cost to having two
 * implementations of the same answer.
 */

/** Leaves a core for the main thread and the UI; more than eight saturates any consumer disk. */
export const DEFAULT_WORKER_COUNT = Math.min(Math.max(availableParallelism() - 1, 1), 8);

/** How often the engine's cancellation signal is mirrored into the shared flag. */
const DEFAULT_CANCEL_POLL_MS = 5;

export interface WorkerFileSystemProviderOptions {
  /**
   * Path to the worker entry module.
   *
   * Required rather than defaulted, because the correct path depends on who bundled the code: the
   * Node CLI points at `worker/entry.ts` through `import.meta.url`, while the Electron build supplies
   * a path that electron-vite emitted for a separate chunk. Guessing here would work in exactly one
   * of those and fail confusingly in the other.
   */
  readonly workerEntry: string | URL;
  readonly workerCount?: number;
  readonly platform?: string;
  readonly cancelPollMs?: number;
}

interface PooledWorker {
  readonly worker: Worker;
  busy: boolean;
}

interface QueuedRequest {
  readonly id: number;
  readonly path: string;
  readonly resolve: (response: ListDirectoryResponse) => void;
}

export class WorkerFileSystemProvider implements FileSystemProvider {
  readonly capabilities: ProviderCapabilities = {
    name: 'node-worker-pool',
    enumeratesVolumes: true,
    reportsCapacity: true,
    detectsSymlinks: true,
    reportsModificationTime: true,
    listsIncrementally: true,
  };

  readonly #metadata: NodeFileSystemProvider;
  readonly #workerEntry: string | URL;
  readonly #workerCount: number;
  readonly #platform: string;
  readonly #cancelPollMs: number;
  readonly #cancelFlag: CancelFlag = createCancelFlag();

  readonly #workers: PooledWorker[] = [];
  readonly #waiting: QueuedRequest[] = [];
  readonly #pending = new Map<
    number,
    { resolve: (r: ListDirectoryResponse) => void; worker: PooledWorker }
  >();

  #nextId = 1;
  #signal: CancellationSignal | null = null;
  #mirrorTimer: NodeJS.Timeout | null = null;
  #disposed = false;

  constructor(options: WorkerFileSystemProviderOptions) {
    this.#workerEntry = options.workerEntry;
    this.#workerCount = Math.max(1, Math.trunc(options.workerCount ?? DEFAULT_WORKER_COUNT));
    this.#platform = options.platform ?? process.platform;
    this.#cancelPollMs = Math.max(1, options.cancelPollMs ?? DEFAULT_CANCEL_POLL_MS);
    this.#metadata = new NodeFileSystemProvider({ platform: this.#platform });
  }

  /** Workers currently alive. Exposed so teardown can be asserted rather than assumed. */
  get workerCount(): number {
    return this.#workers.length;
  }

  listVolumes(): Promise<readonly VolumeInfo[]> {
    return this.#metadata.listVolumes();
  }

  describeRoot(path: string): Promise<ScanRootInfo> {
    return this.#metadata.describeRoot(path);
  }

  async listDirectory(path: string, signal?: CancellationSignal): Promise<ListDirectoryResult> {
    if (this.#disposed) {
      throw new FileSystemAccessError('ioError', path, 'the worker pool has been disposed');
    }

    this.#ensureWorkers();
    this.#trackSignal(signal);

    const response = await this.#dispatch(path);
    if (!response.ok) {
      throw new FileSystemAccessError(response.code, response.path, response.detail);
    }

    return response.issues.length > 0
      ? { entries: response.entries, entryIssues: response.issues }
      : { entries: response.entries };
  }

  /** Terminates every worker and settles anything outstanding. Safe to call twice. */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;

    // Tell the workers to stop mid-listing, so terminate does not have to interrupt a long
    // synchronous loop.
    setCancelled(this.#cancelFlag.view, true);
    this.#stopMirror();

    // Nobody may be left awaiting a reply that will never come.
    for (const [id, entry] of this.#pending) {
      entry.resolve(this.#disposedResponse(id));
    }
    this.#pending.clear();
    for (const queued of this.#waiting) {
      queued.resolve(this.#disposedResponse(queued.id));
    }
    this.#waiting.length = 0;

    const workers = [...this.#workers];
    this.#workers.length = 0;
    await Promise.all(workers.map((pooled) => pooled.worker.terminate()));
  }

  #disposedResponse(id: number): ListDirectoryResponse {
    return {
      id,
      ok: false,
      code: 'ioError',
      path: '',
      detail: 'the worker pool has been disposed',
    };
  }

  #ensureWorkers(): void {
    while (this.#workers.length < this.#workerCount) {
      this.#workers.push(this.#spawn());
    }
  }

  #spawn(): PooledWorker {
    const init: WorkerInit = {
      cancelBuffer: this.#cancelFlag.buffer,
      platform: this.#platform,
    };

    const worker = new Worker(this.#workerEntry, {
      workerData: init,
      // A worker must never hold the process open on its own.
      stdout: false,
      stderr: false,
    });
    const pooled: PooledWorker = { worker, busy: false };

    worker.on('message', (response: ListDirectoryResponse) => {
      const entry = this.#pending.get(response.id);
      this.#pending.delete(response.id);
      pooled.busy = false;
      // Released only once this worker is genuinely idle; `#drain` may hand it more work below, which
      // takes the reference again.
      worker.unref();
      entry?.resolve(response);
      this.#drain();
    });

    worker.on('error', (error: Error) => {
      this.#retire(pooled, error.message);
    });

    worker.on('exit', (code) => {
      if (this.#disposed || code === 0) return;
      this.#retire(pooled, `worker exited with code ${code}`);
    });

    /*
     * Idle workers must not hold the process open, or a CLI would appear to hang after printing its
     * results. But an *unreferenced* worker does not keep the event loop alive while a reply is in
     * flight either — and since a scan is driven entirely by those replies, unreferencing
     * unconditionally makes the process exit before the first one arrives, silently producing no
     * output at all.
     *
     * So the reference is held exactly while a worker has work: taken in `#send`, released when the
     * reply lands.
     */
    worker.unref();
    return pooled;
  }

  /**
   * Removes a worker that died and answers whatever it was holding.
   *
   * A crashed worker must not cost the whole scan. Its request is reported as an I/O issue for that
   * one directory, and a replacement is spawned on the next listing so throughput recovers.
   */
  #retire(pooled: PooledWorker, reason: string): void {
    const index = this.#workers.indexOf(pooled);
    if (index >= 0) this.#workers.splice(index, 1);

    for (const [id, entry] of this.#pending) {
      if (entry.worker !== pooled) continue;
      this.#pending.delete(id);
      entry.resolve({ id, ok: false, code: 'ioError', path: '', detail: reason });
    }

    void pooled.worker.terminate();
    if (!this.#disposed) this.#drain();
  }

  #dispatch(path: string): Promise<ListDirectoryResponse> {
    return new Promise((resolve) => {
      const id = this.#nextId;
      this.#nextId += 1;

      const idle = this.#workers.find((pooled) => !pooled.busy);
      if (idle === undefined) {
        // The engine bounds its own concurrency, but it need not match the worker count, so a short
        // queue here is normal rather than a problem.
        this.#waiting.push({ id, path, resolve });
        return;
      }
      this.#send(idle, { id, path, resolve });
    });
  }

  #send(pooled: PooledWorker, request: QueuedRequest): void {
    pooled.busy = true;
    this.#pending.set(request.id, { resolve: request.resolve, worker: pooled });
    // Keeps the event loop alive until this worker answers.
    pooled.worker.ref();
    const message: ListDirectoryRequest = { id: request.id, path: request.path };
    pooled.worker.postMessage(message);
  }

  #drain(): void {
    while (this.#waiting.length > 0) {
      const idle = this.#workers.find((pooled) => !pooled.busy);
      if (idle === undefined) break;
      this.#send(idle, this.#waiting.shift()!);
    }

    if (this.#pending.size === 0 && this.#waiting.length === 0) this.#stopMirror();
  }

  /**
   * Keeps the shared cancel flag in step with the engine's signal.
   *
   * The flag is written on every dispatch, which is what resets it when a new scan begins. The timer
   * exists for the case a dispatch cannot cover: a listing already running when the user cancels. A
   * worker inside a synchronous loop over a huge directory would otherwise keep going until it
   * finished, so the flag has to change underneath it.
   */
  #trackSignal(signal: CancellationSignal | undefined): void {
    this.#signal = signal ?? null;
    setCancelled(this.#cancelFlag.view, signal?.aborted ?? false);

    if (signal === undefined || this.#mirrorTimer !== null) return;

    this.#mirrorTimer = setInterval(() => {
      const current = this.#signal;
      if (current !== null) setCancelled(this.#cancelFlag.view, current.aborted);
      if (this.#pending.size === 0 && this.#waiting.length === 0) this.#stopMirror();
    }, this.#cancelPollMs);

    // Must not keep the process alive after a scan finishes.
    this.#mirrorTimer.unref();
  }

  #stopMirror(): void {
    if (this.#mirrorTimer === null) return;
    clearInterval(this.#mirrorTimer);
    this.#mirrorTimer = null;
  }
}
