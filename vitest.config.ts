import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests live in a `test/` directory beside each package's `src/`, which keeps the
    // shipped source tree clean and lets the platform type-check split (agnostic /
    // node / dom) stay unambiguous about which files are allowed which globals.
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'tools/**/*.test.ts'],
    environment: 'node',
    // Boundary and filesystem tests shell out and touch temp directories; a generous
    // but finite timeout keeps a hung syscall from stalling CI forever.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
