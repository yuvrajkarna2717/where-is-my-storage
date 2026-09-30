import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  COMMAND_CHANNEL,
  EVENT_CHANNEL,
  type CommandResponse,
  type DesktopEvent,
} from '../shared/protocol.ts';
import type { ScanHostClient } from './scan-host-client.ts';
import { CommandValidationError, validateCommandRequest } from './validate.ts';

/**
 * The single entry point from the renderer into everything privileged.
 *
 * Three checks happen before any work is done, in this order:
 *
 * 1. **Is the sender ours?** Only the top-level frame of our own window is accepted. A
 *    subframe or any other `webContents` is refused, so an injected iframe cannot reach the
 *    filesystem even though it shares the process.
 * 2. **Is the request well formed?** `validateCommandRequest` rebuilds the payload from
 *    checked values; the renderer's object is never forwarded.
 * 3. **Is the command routed correctly?** The directory picker needs a window, so it is
 *    answered here. Everything else goes to the scan host, which is the only code that
 *    touches the disk.
 */

export interface CommandRouterOptions {
  readonly host: ScanHostClient;
  readonly getWindow: () => BrowserWindow | null;
}

/**
 * Only the main frame of our own window may issue commands.
 *
 * Without this, any `webContents` in the application — a subframe, a devtools extension page —
 * could invoke the channel, because `ipcMain.handle` is process-wide, not window-scoped.
 */
function isTrustedSender(event: IpcMainInvokeEvent, window: BrowserWindow | null): boolean {
  if (window === null || window.isDestroyed()) return false;
  if (event.sender !== window.webContents) return false;
  return event.senderFrame === event.sender.mainFrame;
}

async function pickDirectory(window: BrowserWindow): Promise<CommandResponse<'pickDirectory'>> {
  const result = await dialog.showOpenDialog(window, {
    title: 'Choose a folder to analyse',
    buttonLabel: 'Analyse',
    // `dontAddToRecent` keeps the user's choice out of the operating system's recent-items
    // list. Small thing, but this product should not leave traces of what was analysed.
    properties: ['openDirectory', 'dontAddToRecent'],
  });

  const chosen = result.canceled ? null : (result.filePaths[0] ?? null);
  return { ok: true, value: { path: chosen } };
}

export function registerCommandRouter(options: CommandRouterOptions): () => void {
  const handler = async (event: IpcMainInvokeEvent, raw: unknown): Promise<CommandResponse> => {
    const window = options.getWindow();

    if (!isTrustedSender(event, window)) {
      return { ok: false, code: 'invalidRequest', message: 'request came from an untrusted frame' };
    }

    let request;
    try {
      request = validateCommandRequest(raw);
    } catch (error) {
      if (error instanceof CommandValidationError) {
        return { ok: false, code: error.code, message: error.message };
      }
      return { ok: false, code: 'invalidRequest', message: 'request could not be validated' };
    }

    if (request.command === 'pickDirectory') {
      // `window` is non-null here: isTrustedSender already established that.
      return pickDirectory(window!);
    }

    return options.host.send(request);
  };

  ipcMain.handle(COMMAND_CHANNEL, handler);
  return () => {
    ipcMain.removeHandler(COMMAND_CHANNEL);
  };
}

/** Pushes a scan-host event to the renderer, if there is still one listening. */
export function forwardEventToRenderer(window: BrowserWindow | null, event: DesktopEvent): void {
  if (window === null || window.isDestroyed()) return;
  window.webContents.send(EVENT_CHANNEL, event);
}
