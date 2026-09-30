import { app, session, shell, type BrowserWindow } from 'electron';
import {
  PRODUCTION_CSP,
  developmentCsp,
  isExternalLinkAllowed,
  isRequestAllowed,
} from './security-policy.ts';

/**
 * Applies the security policy to the Electron session and to a window.
 *
 * Split from `security-policy.ts` so the decisions are testable without Electron and only the
 * wiring lives here.
 */

export interface SecurityContext {
  /** Vite dev server origin, or null in a packaged build. */
  readonly rendererOrigin: string | null;
  readonly onBlockedRequest?: (url: string) => void;
}

export function hardenSession(context: SecurityContext): void {
  const target = session.defaultSession;

  // Deny by default. This is the mechanism that makes the privacy claim structural rather
  // than a matter of reviewing our own imports.
  target.webRequest.onBeforeRequest(
    { urls: ['*://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      if (isRequestAllowed(details.url, { rendererOrigin: context.rendererOrigin })) {
        callback({ cancel: false });
        return;
      }
      context.onBlockedRequest?.(details.url);
      callback({ cancel: true });
    },
  );

  target.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          context.rendererOrigin === null ? PRODUCTION_CSP : developmentCsp(context.rendererOrigin),
        ],
      },
    });
  });

  // This application needs no camera, microphone, location, notifications or clipboard read.
  // Refusing everything is both correct and one less consent dialog a user has to interpret.
  target.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  target.setPermissionCheckHandler(() => false);
  target.setDevicePermissionHandler(() => false);
}

export function hardenWindow(window: BrowserWindow, context: SecurityContext): void {
  const contents = window.webContents;

  // Nothing in the product opens a window. Anything trying to is either a bug or hostile.
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalLinkAllowed(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // The renderer is a single page. Navigating it away would replace our validated bridge with
  // whatever the new document brings.
  contents.on('will-navigate', (event, url) => {
    const isRendererOrigin =
      context.rendererOrigin !== null && url.startsWith(context.rendererOrigin);
    if (!isRendererOrigin && !url.startsWith('file:')) event.preventDefault();
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  // A renderer crash must not leave a blank window with no explanation.
  contents.on('render-process-gone', (_event, details) => {
    process.stderr.write(`renderer process gone: ${details.reason}\n`);
  });
}

/**
 * Process-level hardening, applied before any window exists.
 *
 * @returns false when another instance already holds the lock, in which case the caller should
 *          stop: two instances would race for the same scan database from Task 10 onward.
 */
export function hardenApplication(): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }

  // Forces the sandbox on every renderer, not just the ones we remember to configure.
  app.enableSandbox();

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  return true;
}
