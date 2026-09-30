import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Network APIs are banned repo-wide, not merely discouraged.
 *
 * The product promise is that filesystem information never leaves the machine.
 * Lint is the cheapest of several gates for that promise (Task 19 adds a build
 * artifact scan and a zero-network end-to-end test). If a future feature ever
 * legitimately needs the network, it must disable this rule explicitly at the
 * call site, which makes the exception visible in review.
 */
const bannedNetworkGlobals = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'Request',
  'Response',
].map((name) => ({
  name,
  message:
    'Network access is banned: filesystem data must never leave the machine. See docs/privacy.md.',
}));

const bannedNetworkModules = [
  'http',
  'https',
  'http2',
  'net',
  'dgram',
  'tls',
  'node:http',
  'node:https',
  'node:http2',
  'node:net',
  'node:dgram',
  'node:tls',
].map((name) => ({
  name,
  message:
    'Network access is banned: filesystem data must never leave the machine. See docs/privacy.md.',
}));

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/build/**',
      '**/release/**',
      '**/coverage/**',
      '**/.vite/**',
      '**/*.generated.ts',
      // Deliberately-broken fixtures for the boundary rules. Not part of any program.
      'tools/boundary-fixtures/**',
    ],
  },

  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
      'no-restricted-globals': ['error', ...bannedNetworkGlobals],
      'no-restricted-imports': ['error', { paths: bannedNetworkModules }],
      'prefer-const': 'error',
      'no-var': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // The columnar store and the scanner both deal in raw numeric arrays where
      // `number` is genuinely the right type; template-expression strictness there
      // produces noise without catching bugs.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },

  // Tooling, benchmarks and CLIs are allowed to write to stdout: that is their output.
  {
    files: ['tools/**/*.ts', '**/*.config.ts', '**/src/cli/**/*.ts', '**/bench/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  // Plain JS config files are not part of a TypeScript program.
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // CommonJS config files (dependency-cruiser, electron-builder) need CJS scope.
  // Declared inline rather than pulling in the `globals` package for six names.
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        module: 'writable',
        exports: 'writable',
        require: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
    rules: {
      // `require` is the whole point of a .cjs file.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
