/**
 * Scan host entry point: an Electron `utilityProcess`.
 *
 * Why the scanner does not live in the main process. A full disk scan is millions of
 * syscalls and tens of megabytes of typed arrays. Running that alongside window management
 * makes menus and dialogs stutter, and a defect in traversal would take the whole
 * application down with it. Out here, the worst case is a dead child process that the main
 * process notices and reports.
 *
 * The storage model lives in this process and never crosses a boundary whole. The renderer
 * asks for a page of rows and gets a few kilobytes back.
 */
// Type-only, so nothing from Electron is required at runtime here. It is what declares
// `process.parentPort`, which Electron adds to the Node process object inside a utilityProcess.
import type { MessagePortMain } from 'electron';
import { dispatchToSession } from './dispatch.ts';
import { ScanSession } from './session.ts';
import type { HostToMainMessage, MainToHostMessage } from './wire.ts';

const parentPort = process.parentPort;

function fail(message: string): never {
  // No console here: the utility process's stdout is piped to the main process, and a bare
  // write would interleave with structured logging. Throwing is visible as an exit code.
  throw new Error(`scan host: ${message}`);
}

if (parentPort === undefined) {
  fail('started outside an Electron utilityProcess');
}

parentPort.once('message', (initial) => {
  const port: MessagePortMain | undefined = initial.ports[0];
  if (port === undefined) fail('parent did not transfer a MessagePort');

  const send = (message: HostToMainMessage): void => {
    port.postMessage(message);
  };

  const session = new ScanSession({
    onProgress: (payload) => {
      send({ kind: 'event', event: { type: 'scanProgress', payload } });
    },
    onFinished: (payload) => {
      send({ kind: 'event', event: { type: 'scanFinished', payload } });
    },
  });

  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    send({ kind: 'closing' });
    // Disposing cancels any running scan and waits for in-flight listings to settle, so the
    // process does not exit with filesystem work still outstanding.
    await session.dispose();
    port.close();
    process.exit(0);
  };

  port.on('message', (incoming) => {
    const message = incoming.data as MainToHostMessage;

    if (message.kind === 'shutdown') {
      void shutdown();
      return;
    }

    void dispatchToSession(session, message.request).then(
      (response) => {
        send({ kind: 'response', id: message.id, response });
      },
      (error: unknown) => {
        // dispatchToSession is written not to reject; this is the belt to its braces, because
        // a lost reply would hang the renderer's promise forever.
        send({
          kind: 'response',
          id: message.id,
          response: {
            ok: false,
            code: 'internal',
            message: error instanceof Error ? error.message : 'unknown scan host failure',
          },
        });
      },
    );
  });

  port.start();
  send({ kind: 'ready' });
});
