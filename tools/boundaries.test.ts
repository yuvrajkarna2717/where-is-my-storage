import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Proves the architectural boundaries are real.
 *
 * Two directions are checked:
 *   1. the actual repository has zero boundary violations;
 *   2. every rule fires when it is broken, verified against a fixture tree that
 *      breaks each one on purpose (tools/boundary-fixtures).
 *
 * Without (2), a typo in a rule's regex would silently disable it and the repo
 * would still report "no violations found".
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const depcruiseBin = join(
  repoRoot,
  'node_modules',
  'dependency-cruiser',
  'bin',
  'dependency-cruiser.mjs',
);

interface CruiseViolation {
  rule: { name: string; severity: string };
  from: string;
  to: string;
}

interface CruiseResult {
  modules: unknown[];
  summary: {
    error: number;
    warn: number;
    info: number;
    violations: CruiseViolation[];
  };
}

/**
 * Runs the dependency-cruiser CLI the same way `pnpm boundaries` does, but asking for
 * JSON. Invoked through `process.execPath` rather than the .bin shim so it behaves
 * identically on Windows, macOS and Linux.
 */
function cruise(targets: string[], configPath: string): CruiseResult {
  const stdout = execFileSync(
    process.execPath,
    [depcruiseBin, ...targets, '--config', configPath, '--output-type', 'json'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      // A non-zero exit code is expected whenever violations exist, which is the
      // normal case for the fixture tree. The JSON on stdout is what we assert on.
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return JSON.parse(stdout) as CruiseResult;
}

function cruiseAllowingViolations(targets: string[], configPath: string): CruiseResult {
  try {
    return cruise(targets, configPath);
  } catch (error: unknown) {
    const withStdout = error as { stdout?: string };
    if (typeof withStdout.stdout === 'string' && withStdout.stdout.length > 0) {
      return JSON.parse(withStdout.stdout) as CruiseResult;
    }
    throw error;
  }
}

/**
 * Rules that cannot be exercised by a source-only fixture tree. Each needs real
 * installed packages to trigger, so they are covered by the repository cruise
 * instead once the relevant dependencies exist.
 */
const notFixtureCoverable = new Set([
  // Requires electron in node_modules; exercised for real from Task 4 onward.
  'electron-stays-in-the-desktop-shell',
  // These three classify *installed* npm dependencies, which fixtures have none of.
  'not-to-dev-dep',
  'no-undeclared-dependencies',
  'no-duplicate-dep-types',
]);

describe('architectural boundaries', () => {
  it('the repository itself has no boundary violations', () => {
    const result = cruise(['packages', 'apps'], '.dependency-cruiser.cjs');

    expect(result.summary.violations).toEqual([]);
    expect(result.summary.error).toBe(0);
    // Guards against the cruise silently matching nothing, which would make the
    // "no violations" result meaningless.
    expect(result.modules.length).toBeGreaterThan(0);
  });

  it('every rule fires when the fixture tree breaks it', () => {
    const result = cruiseAllowingViolations(
      ['tools/boundary-fixtures/packages', 'tools/boundary-fixtures/apps'],
      'tools/boundary-fixtures/.dependency-cruiser.cjs',
    );

    const triggered = new Set(result.summary.violations.map((violation) => violation.rule.name));

    const { buildForbidden } = createRequire(import.meta.url)('./boundary-rules.cjs') as {
      buildForbidden: (prefix?: string) => { name: string }[];
    };
    const expected = new Set(
      buildForbidden('')
        .map((rule) => rule.name)
        .filter((name) => !notFixtureCoverable.has(name)),
    );

    expect([...triggered].sort()).toEqual([...expected].sort());
  });

  it('reports every violation at error severity so CI cannot pass with warnings', () => {
    const result = cruiseAllowingViolations(
      ['tools/boundary-fixtures/packages', 'tools/boundary-fixtures/apps'],
      'tools/boundary-fixtures/.dependency-cruiser.cjs',
    );

    expect(result.summary.violations.length).toBeGreaterThan(0);
    for (const violation of result.summary.violations) {
      expect(violation.rule.severity).toBe('error');
    }
  });
});
