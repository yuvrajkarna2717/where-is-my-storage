import {
  MessageChannelMain,
  utilityProcess,
  type MessagePortMain,
  type UtilityProcess,
} from 'electron';
import type { HostToMainMessage, MainToHostMessage } from '../scan-host/wire.ts';
import type {
  CommandName,
  CommandRequest,
  CommandResponse,
  DesktopEvent,
} from '../shared/protocol.ts';
import scanHostPath from '../scan-host/index?modulePath';

/**
 * The main process's half of the scan host connection.
 *
 * Responsibilities: spawn the utility process, hand it one end of a `MessageChannelMain`,
 * correlate replies with callers, forward events, and survive the host dying.
 *
 * Requests are not given timeouts. A timeout here would have to be longer than the slowest
 * legitimate operation — describing a root on a sleeping network drive can take many seconds —
 * and a timeout set that high protects against nothing while a shorter one would fail healthy
 * scans. Instead, the host's exit is what settles outstanding work: every pending caller is
 * answered with `notReady` the moment the process goes away, so no promise is ever abandoned.
 */

const READY_TIMEOUT_MS = 15_000;
const SHUTDOWN_GRACE_MS = 2_000;

export interface ScanHostClientOptions {
  readonly onEvent: (event: DesktopEvent) => void;
  readonly onLog?: (line: string) => void;
}

export class ScanHostClient {
  readonly #options: ScanHostClientOptions;
  readonly #pending = new Map<number, (response: CommandResponse) => void>();

  #child: UtilityProcess | null = null;
  #port: MessagePortMain | null = null;
  #ready: Promise<void> | null = null;
  #nextId = 1;
  #stopping = false;

  constructor(options: ScanHostClientOptions) {
    this.#options = options;
  }

  get isRunning(): boolean {
    return this.#child !== null;
  }

  async ensureStarted(): Promise<void> {
    this.#ready ??= this.#spawn();
    try {
      await this.#ready;
    } catch (error) {
      // A failed start must not be cached, or every later attempt would replay the failure.
      this.#ready = null;
      throw error;
    }
  }

  /**
   * Sends a command and resolves with its reply.
   *
   * Generic over the command so the result type is the one that command actually returns.
   * Without this, every caller would receive the union of all result shapes and have to cast,
   * and a cast at a process boundary is precisely where a mistake goes unnoticed.
   */
  async send<K extends CommandName>(
    request: Extract<CommandRequest, { command: K }>,
  ): Promise<CommandResponse<K>> {
    try {
      await this.ensureStarted();
    } catch (error) {
      return {
        ok: false,
        code: 'notReady',
        message: error instanceof Error ? error.message : 'scan host failed to start',
      };
    }

    const port = this.#port;
    if (port === null) {
      return { ok: false, code: 'notReady', message: 'scan host is not connected' };
    }

    const id = this.#nextId;
    this.#nextId += 1;

    return new Promise<CommandResponse<K>>((resolve) => {
      // The pending map is keyed by correlation id and cannot be typed per command. The cast is
      // sound because the host always answers the command it was handed, and the id is unique.
      this.#pending.set(id, resolve as (response: CommandResponse) => void);
      const message: MainToHostMessage = { kind: 'request', id, request };
      port.postMessage(message);
    });
  }

  async stop(): Promise<void> {
    const child = this.#child;
    const port = this.#port;
    this.#stopping = true;

    if (child === null) {
      this.#reset();
      return;
    }

    if (port !== null) {
      const message: MainToHostMessage = { kind: 'shutdown' };
      port.postMessage(message);
    }

    // Give the host a moment to cancel its scan and release file handles, then insist. Leaving
    // a scanning process behind after the window closes would be exactly the "background
    // scanning you did not ask for" the product promises not to do.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, SHUTDOWN_GRACE_MS);

      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    this.#reset();
  }

  #spawn(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#stopping = false;

      const child = utilityProcess.fork(scanHostPath, [], {
        serviceName: 'storage-visualizer-scan-host',
        stdio: 'pipe',
      });
      const channel = new MessageChannelMain();

      this.#child = child;
      this.#port = channel.port2;

      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        if (error === undefined) resolve();
        else reject(error);
      };

      const readyTimer = setTimeout(() => {
        finish(new Error('scan host did not report ready in time'));
        child.kill();
      }, READY_TIMEOUT_MS);

      child.stdout?.on('data', (chunk: Buffer) => {
        this.#options.onLog?.(`[scan-host] ${chunk.toString('utf8').trimEnd()}`);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        this.#options.onLog?.(`[scan-host:err] ${chunk.toString('utf8').trimEnd()}`);
      });

      child.once('spawn', () => {
        // Transferring the port only after 'spawn' avoids relying on Electron buffering a
        // message that carries a transferable.
        child.postMessage({ kind: 'init' }, [channel.port1]);
      });

      child.once('exit', (code) => {
        const unexpected = !this.#stopping;
        this.#answerPendingWithHostGone();
        this.#reset();

        if (unexpected) {
          this.#options.onLog?.(`[scan-host] exited unexpectedly with code ${code}`);
        }
        finish(new Error(`scan host exited with code ${code} before becoming ready`));
      });

      channel.port2.on('message', (event) => {
        const message = event.data as HostToMainMessage;
        switch (message.kind) {
          case 'ready':
            finish();
            return;
          case 'response': {
            const resolvePending = this.#pending.get(message.id);
            this.#pending.delete(message.id);
            resolvePending?.(message.response);
            return;
          }
          case 'event':
            this.#options.onEvent(message.event);
            return;
          case 'closing':
            return;
        }
      });
      channel.port2.start();
    });
  }

  /**
   * Settles every outstanding request so no caller is left waiting on a process that no longer
   * exists. The next command will start a fresh host.
   */
  #answerPendingWithHostGone(): void {
    const response: CommandResponse = {
      ok: false,
      code: 'notReady',
      message: 'the scan host stopped; the next request will start a new one',
    };
    for (const resolvePending of this.#pending.values()) resolvePending(response);
    this.#pending.clear();
  }

  #reset(): void {
    this.#port?.close();
    this.#port = null;
    this.#child = null;
    this.#ready = null;
  }
}
