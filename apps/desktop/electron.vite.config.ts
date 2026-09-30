import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

/**
 * Three builds, three targets.
 *
 * `main` also produces the scan host: `scan-host-client.ts` imports the host entry with
 * electron-vite's `?modulePath` suffix, which makes it a separate bundle and hands back the
 * path to fork. That keeps the utility process working identically under `dev` and in a
 * packaged application, where the output layout differs.
 *
 * The workspace packages are excluded from externalisation because they ship TypeScript source
 * rather than built JavaScript, so they must be bundled. Real npm dependencies stay external,
 * which matters from Task 10 onward when a native module arrives.
 */
const workspacePackages = ['@sv/core', '@sv/scan-engine', '@sv/fs-node', '@sv/ui'];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },

  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      // CommonJS, because Electron requires a sandboxed preload to be CommonJS and the sandbox
      // is not negotiable. This is why apps/desktop is not an ESM package.
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },

  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      // electron-vite leaves minification off by default, on the reasonable assumption that
      // bundle size matters less inside a desktop application. It still matters here: the
      // unminified renderer was 639 kB, and shipping a readable copy of React costs both disk
      // space and parse time at every launch.
      minify: 'esbuild',
      // Source maps are emitted but not referenced from the bundle, so a crash report can be
      // symbolised without the renderer fetching anything.
      sourcemap: 'hidden',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
