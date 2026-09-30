import type { DesktopBridge } from '../shared/protocol.ts';

declare global {
  interface Window {
    /**
     * The only capability the renderer has. Installed by the preload script through
     * `contextBridge`; there is no `require`, no `process`, and no `ipcRenderer` here.
     */
    readonly storageVisualizer: DesktopBridge;
  }
}
