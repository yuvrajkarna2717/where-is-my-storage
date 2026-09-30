import type {
  CommandName,
  CommandPayloads,
  CommandResults,
  DesktopEvent,
} from '../shared/protocol.ts';

/**
 * Thin wrapper over the exposed bridge.
 *
 * The wire protocol reports failure as data rather than as a rejected promise, which is right
 * for a process boundary but tedious at every call site. This converts that back into an
 * exception for the UI, while keeping the error code available so a caller can distinguish
 * "no scan is running" from "the scan host died".
 */
export class CommandFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CommandFailure';
    this.code = code;
  }
}

export async function invoke<K extends CommandName>(
  command: K,
  payload: CommandPayloads[K],
): Promise<CommandResults[K]> {
  const response = await window.storageVisualizer.invoke(command, payload);
  if (!response.ok) throw new CommandFailure(response.code, response.message);
  return response.value;
}

export function subscribe(listener: (event: DesktopEvent) => void): () => void {
  return window.storageVisualizer.subscribe(listener);
}
