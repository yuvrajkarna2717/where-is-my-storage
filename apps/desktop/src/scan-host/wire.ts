import type {
  CommandName,
  CommandRequest,
  CommandResponse,
  DesktopEvent,
} from '../shared/protocol.ts';

/**
 * The message shapes carried over the `MessagePort` between the main process and the scan
 * host.
 *
 * Distinct from the renderer protocol on purpose. By the time a request reaches here it has
 * already been validated, and the host is trusted code talking to trusted code, so this
 * layer only needs correlation ids and a way to push events. Keeping them separate also
 * means the renderer's contract can change without touching the internal transport.
 */

/** Commands the scan host answers. `pickDirectory` is a main-process concern. */
export type HostCommandName = Exclude<CommandName, 'pickDirectory'>;

export interface HostRequestMessage {
  readonly kind: 'request';
  /** Correlates a reply with its caller. */
  readonly id: number;
  readonly request: CommandRequest;
}

export interface HostResponseMessage {
  readonly kind: 'response';
  readonly id: number;
  readonly response: CommandResponse;
}

export interface HostEventMessage {
  readonly kind: 'event';
  readonly event: DesktopEvent;
}

/** Sent once the host has installed its handlers, so main knows it is safe to send work. */
export interface HostReadyMessage {
  readonly kind: 'ready';
}

/** Sent when the host is about to stop, so main can distinguish shutdown from a crash. */
export interface HostClosingMessage {
  readonly kind: 'closing';
}

export type MainToHostMessage = HostRequestMessage | { readonly kind: 'shutdown' };

export type HostToMainMessage =
  HostResponseMessage | HostEventMessage | HostReadyMessage | HostClosingMessage;
