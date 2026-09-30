import { contextBridge, ipcRenderer } from 'electron';
import {
  COMMAND_CHANNEL,
  EVENT_CHANNEL,
  type CommandName,
  type CommandPayloads,
  type CommandResponse,
  type DesktopBridge,
  type DesktopEvent,
} from '../shared/protocol.ts';

/**
 * The entire capability surface of the renderer.
 *
 * `ipcRenderer` is deliberately *not* exposed. Handing it over would let renderer code invoke
 * any channel the main process happens to register, now or in future, which turns every later
 * feature into a potential hole. Two functions are exposed instead: send a named command, and
 * subscribe to events.
 *
 * `subscribe` returns an unsubscribe function rather than offering an `off` method, because it
 * makes the listener impossible to leak by accident: the only way to register one is to receive
 * the means to remove it.
 */
const bridge: DesktopBridge = {
  invoke<K extends CommandName>(
    command: K,
    payload: CommandPayloads[K],
  ): Promise<CommandResponse<K>> {
    // Rebuilt as a plain envelope so nothing extra from the caller's object travels, and the
    // main process validates it again regardless.
    return ipcRenderer.invoke(COMMAND_CHANNEL, { command, payload }) as Promise<CommandResponse<K>>;
  },

  subscribe(listener: (event: DesktopEvent) => void): () => void {
    const handler = (_event: unknown, payload: DesktopEvent): void => {
      listener(payload);
    };
    ipcRenderer.on(EVENT_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNEL, handler);
    };
  },
};

contextBridge.exposeInMainWorld('storageVisualizer', bridge);
