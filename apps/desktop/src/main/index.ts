import { BrowserWindow, app } from 'electron';
import type { DesktopEvent } from '../shared/protocol.ts';
import { ScanHostClient } from './scan-host-client.ts';
import { forwardEventToRenderer, registerCommandRouter } from './router.ts';
import { hardenApplication, hardenSession } from './security.ts';
import { runSelfTest } from './selftest.ts';
import { createMainWindow, rendererOrigin } from './window.ts';

/**
 * Main process: window management, the validated command channel, and the lifecycle of the
 * scan host. Deliberately thin — it reads no directories and holds no storage model.
 */

const isSelfTest = process.argv.includes('--selftest');

let mainWindow: BrowserWindow | null = null;
let releaseRouter: (() => void) | null = null;

/** Only populated during a self-test run; the running application keeps no event history. */
const collectedEvents: DesktopEvent[] = [];

const host = new ScanHostClient({
  onEvent: (event) => {
    if (isSelfTest) collectedEvents.push(event);
    forwardEventToRenderer(mainWindow, event);
  },
  onLog: (line) => {
    process.stdout.write(`${line}\n`);
  },
});

if (!hardenApplication()) {
  // A second instance: `hardenApplication` has already asked the app to quit.
} else {
  app.on('second-instance', () => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('window-all-closed', () => {
    // No lingering scan after the window closes. A storage tool that kept reading the disk
    // after you dismissed it would be indefensible.
    void host.stop().finally(() => {
      app.quit();
    });
  });

  app.on('before-quit', () => {
    releaseRouter?.();
    releaseRouter = null;
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });

  app.whenReady().then(
    async () => {
      hardenSession({
        rendererOrigin: rendererOrigin(),
        onBlockedRequest: (url) => {
          // Worth being loud about: this should never happen in a build of this product.
          process.stderr.write(`blocked network request: ${url}\n`);
        },
      });

      releaseRouter = registerCommandRouter({ host, getWindow: () => mainWindow });
      // The self-test shows its window: an offscreen window is not guaranteed to be composited,
      // and the run captures a screenshot to prove the interface actually paints.
      mainWindow = createMainWindow();

      if (!isSelfTest) return;

      let passed = false;
      try {
        await host.ensureStarted();
        passed = await runSelfTest({ host, window: mainWindow, events: collectedEvents });
      } catch (error) {
        process.stderr.write(
          `self-test crashed: ${error instanceof Error ? (error.stack ?? error.message) : 'unknown'}\n`,
        );
      } finally {
        await host.stop();
        releaseRouter?.();
        releaseRouter = null;
      }
      app.exit(passed ? 0 : 1);
    },
    (error: unknown) => {
      process.stderr.write(
        `failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`,
      );
      app.exit(1);
    },
  );
}
