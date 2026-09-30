import { join } from 'node:path';
import { BrowserWindow, app } from 'electron';
import { secureWebPreferences } from './security-policy.ts';
import { hardenWindow, type SecurityContext } from './security.ts';

/** Dev server origin when running under `electron-vite dev`, null in a packaged build. */
export function rendererOrigin(): string | null {
  const url = process.env['ELECTRON_RENDERER_URL'];
  if (url === undefined || url.length === 0) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export interface CreateWindowOptions {
  /** Build the window without showing it, for the self-test. */
  readonly headless?: boolean;
}

export function createMainWindow(options: CreateWindowOptions = {}): BrowserWindow {
  const context: SecurityContext = { rendererOrigin: rendererOrigin() };

  const window = new BrowserWindow({
    width: 1_280,
    height: 840,
    minWidth: 720,
    minHeight: 520,
    // Shown only once the first frame is painted, so launch never flashes a white rectangle.
    show: false,
    backgroundColor: '#12131a',
    title: 'Storage Visualizer',
    autoHideMenuBar: true,
    webPreferences: {
      // electron-vite emits CommonJS here because a sandboxed preload cannot be an ES module.
      preload: join(__dirname, '../preload/index.js'),
      ...secureWebPreferences({ packaged: app.isPackaged }),
    },
  });

  hardenWindow(window, context);

  if (options.headless !== true) {
    window.once('ready-to-show', () => {
      window.show();
    });
  }

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl !== undefined && devUrl.length > 0) {
    void window.loadURL(devUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}
