import type { CommandRequest, CommandResponse } from '../shared/protocol.ts';
import type { ScanSession } from './session.ts';

/**
 * Turns a validated request into a response.
 *
 * Separated from the process plumbing so the whole command surface can be exercised against
 * a real temporary directory in a unit test, with no Electron and no child process.
 *
 * Nothing here throws. A rejected promise crossing back to the main process and on to the
 * renderer would carry a stack trace from a privileged process, which is both an information
 * leak and useless to a user. Failures become data.
 */
export async function dispatchToSession(
  session: ScanSession,
  request: CommandRequest,
): Promise<CommandResponse> {
  try {
    switch (request.command) {
      case 'listVolumes':
        return { ok: true, value: { volumes: await session.listVolumes() } };

      case 'startScan':
        return { ok: true, value: await session.start(request.payload.path) };

      case 'cancelScan':
        return { ok: true, value: { cancelled: session.cancel(request.payload.scanId) } };

      case 'queryStatus':
        return { ok: true, value: session.status() };

      case 'queryNode':
        return { ok: true, value: session.node(request.payload.nodeId) };

      case 'queryChildren':
        return { ok: true, value: session.children(request.payload) };

      case 'pickDirectory':
        // Showing a dialog needs a window, so the main process answers this one itself. If it
        // ever arrives here, the routing is wrong and saying so plainly beats guessing.
        return {
          ok: false,
          code: 'internal',
          message: 'pickDirectory is handled by the main process, not the scan host',
        };
    }
  } catch (error) {
    return {
      ok: false,
      code: 'scanFailed',
      message: error instanceof Error ? error.message : 'unknown scan host failure',
    };
  }
}
