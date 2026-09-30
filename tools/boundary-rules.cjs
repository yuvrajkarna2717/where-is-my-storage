/**
 * Single source of truth for the architectural boundary rules.
 *
 * The rules are path-based, so the only honest way to prove they actually fire is
 * to run them against a tree that deliberately violates them. Rather than keeping
 * a second, drifting copy of the rules for that purpose, the whole rule set is
 * generated from a path prefix:
 *
 *   buildForbidden('')                        -> the real repository  (.dependency-cruiser.cjs)
 *   buildForbidden('tools/boundary-fixtures/') -> the violating fixtures (tools/boundary-fixtures/)
 *
 * `tools/boundaries.test.ts` asserts the real tree is clean and that every rule
 * below is triggered by its fixture. A rule that stops working fails a test.
 */

/** Packages that must run unchanged in a browser, a web worker and Node. */
const PORTABLE = 'core|scan-engine|analysis|entitlements|ui|fs-web';

/**
 * @param {string} prefix posix-style path prefix, '' for the real repository.
 * @returns {import('dependency-cruiser').IForbiddenRuleType[]}
 */
function buildForbidden(prefix = '') {
  /** Anchor a repo-relative pattern, shifted by the fixture prefix. */
  const at = (pattern) => `^${prefix}${pattern}`;

  return [
    {
      name: 'no-circular',
      comment:
        'Circular dependencies make initialisation order load-bearing and break tree shaking.',
      severity: 'error',
      from: { path: at('(packages|apps)/') },
      to: { circular: true },
    },

    {
      name: 'core-is-a-leaf',
      comment:
        '@sv/core is the shared vocabulary. It must not depend on any other workspace package, ' +
        'otherwise every consumer inherits that dependency transitively.',
      severity: 'error',
      from: { path: at('packages/core/') },
      to: { path: at('packages/(?!core/)') },
    },
    {
      name: 'scan-engine-depends-only-on-core',
      comment:
        'The traversal orchestrator reaches filesystems only through FileSystemProvider. If it ' +
        'imported fs-node or fs-web directly the provider seam would be fiction, and a native ' +
        'Rust provider could not be dropped in later without rewriting the engine.',
      severity: 'error',
      from: { path: at('packages/scan-engine/') },
      to: { path: at('packages/(?!core/|scan-engine/)') },
    },
    {
      name: 'analysis-depends-only-on-core',
      severity: 'error',
      from: { path: at('packages/analysis/') },
      to: { path: at('packages/(?!core/|analysis/)') },
    },
    {
      name: 'ui-consumes-normalized-data-only',
      comment:
        'The visualisation layer must not know where its data came from. It reads the normalized ' +
        'model from @sv/core and nothing platform-specific.',
      severity: 'error',
      from: { path: at('packages/ui/') },
      to: { path: at('packages/(fs-node|fs-web|store-sqlite|scan-engine|entitlements)/') },
    },

    {
      name: 'entitlements-is-quarantined',
      comment:
        'Licensing must never contaminate the storage engine. Only the app shells may read ' +
        'entitlements, so the scanner keeps working even if this package is deleted outright.',
      severity: 'error',
      from: { path: at('packages/') },
      to: { path: at('packages/entitlements/') },
    },
    {
      name: 'entitlements-is-a-leaf',
      comment: 'Licensing must not reach into the storage model either.',
      severity: 'error',
      from: { path: at('packages/entitlements/') },
      to: { path: at('packages/(?!entitlements/)') },
    },

    {
      name: 'portable-packages-have-no-node-builtins',
      comment:
        'These packages ship to the browser. A Node builtin here would break the web app and ' +
        'quietly couple the shared model to one platform.',
      severity: 'error',
      from: { path: at(`packages/(${PORTABLE})/`) },
      to: { dependencyTypes: ['core'] },
    },

    {
      name: 'packages-never-depend-on-apps',
      severity: 'error',
      from: { path: at('packages/') },
      to: { path: at('apps/') },
    },
    {
      name: 'electron-stays-in-the-desktop-shell',
      comment:
        'Only apps/desktop may import electron. A shared package that did so could not be ' +
        'reused by the web app or tested outside Electron.',
      severity: 'error',
      from: { path: at('(packages/|apps/web/)') },
      to: { path: 'node_modules/electron/' },
    },

    {
      name: 'renderer-has-no-filesystem-reach',
      comment:
        'Electron security: the renderer reaches the filesystem only through the validated IPC ' +
        'command set, never by importing a provider or the SQLite store.',
      severity: 'error',
      from: { path: at('apps/desktop/src/renderer/') },
      to: { path: at('packages/(fs-node|store-sqlite)/') },
    },
    {
      name: 'renderer-has-no-node-builtins',
      comment: 'The renderer runs sandboxed, with nodeIntegration disabled.',
      severity: 'error',
      from: { path: at('apps/desktop/src/renderer/') },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'web-app-has-no-node-filesystem',
      severity: 'error',
      from: { path: at('apps/web/') },
      to: { path: at('packages/(fs-node|store-sqlite)/') },
    },

    {
      name: 'not-to-dev-dep',
      comment:
        'Shipped code must not import a devDependency. Two documented exceptions: build ' +
        'config files, which are not shipped at all, and `electron` itself, which is a ' +
        'devDependency by convention because the Electron runtime provides it as a builtin ' +
        'rather than resolving it from node_modules.',
      severity: 'error',
      from: {
        path: at('(packages|apps)/'),
        pathNot: '(/test/|\\.test\\.ts$|/bench/|\\.config\\.ts$)',
      },
      to: {
        dependencyTypes: ['npm-dev'],
        dependencyTypesNot: ['type-only'],
        pathNot: 'node_modules/electron/',
      },
    },
    {
      name: 'no-undeclared-dependencies',
      comment:
        'Every import must be declared in the importing package.json. Without this a package ' +
        'works only because a sibling happened to install something.',
      severity: 'error',
      from: { path: at('(packages|apps)/') },
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
    {
      name: 'not-to-unresolvable',
      comment: 'An import that does not resolve is either a typo or a missing dependency.',
      severity: 'error',
      from: { path: at('(packages|apps)/') },
      to: { couldNotResolve: true },
    },
    {
      name: 'no-duplicate-dep-types',
      severity: 'error',
      from: { path: at('(packages|apps)/') },
      to: { moreThanOneDependencyType: true, dependencyTypesNot: ['type-only'] },
    },
  ];
}

/** Resolution and traversal options shared by the real cruise and the fixture cruise. */
const sharedOptions = {
  doNotFollow: { path: ['node_modules'] },
  tsConfig: { fileName: 'tsconfig.json' },
  tsPreCompilationDeps: true,
  enhancedResolveOptions: {
    exportsFields: ['exports'],
    conditionNames: ['import', 'module', 'node', 'default', 'types'],
    mainFields: ['module', 'main', 'types'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'],
  },
  reporterOptions: {
    text: { highlightFocused: true },
    dot: { collapsePattern: 'node_modules/(?:@[^/]+/[^/]+|[^/]+)' },
  },
};

module.exports = { buildForbidden, sharedOptions, PORTABLE };
