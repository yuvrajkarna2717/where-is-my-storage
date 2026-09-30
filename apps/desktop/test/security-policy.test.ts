import { describe, expect, it } from 'vitest';
import {
  ALLOWED_SCHEMES,
  PRODUCTION_CSP,
  developmentCsp,
  isExternalLinkAllowed,
  isRequestAllowed,
  secureWebPreferences,
} from '../src/main/security-policy.ts';

/**
 * The security posture, pinned.
 *
 * `--selftest` proves the renderer really has no Node access by asking it from inside the
 * sandbox. These tests do the complementary job: they assert the *decisions* the window and
 * session are built from, so a well-meaning change to one flag fails here instead of quietly
 * weakening the application.
 */

describe('window security options', () => {
  it('locks down the renderer', () => {
    const preferences = secureWebPreferences({ packaged: true });

    expect(preferences.sandbox).toBe(true);
    expect(preferences.contextIsolation).toBe(true);
    expect(preferences.nodeIntegration).toBe(false);
    expect(preferences.nodeIntegrationInWorker).toBe(false);
    expect(preferences.nodeIntegrationInSubFrames).toBe(false);
    expect(preferences.webSecurity).toBe(true);
    expect(preferences.allowRunningInsecureContent).toBe(false);
    expect(preferences.experimentalFeatures).toBe(false);
    expect(preferences.webviewTag).toBe(false);
    // Spellcheck has historically fetched dictionaries over the network, and this product has
    // no text input to check.
    expect(preferences.spellcheck).toBe(false);
  });

  it('keeps developer tools out of a packaged build but available in development', () => {
    expect(secureWebPreferences({ packaged: true }).devTools).toBe(false);
    expect(secureWebPreferences({ packaged: false }).devTools).toBe(true);
  });
});

describe('content security policy', () => {
  it('forbids outbound connections in production', () => {
    // The single most important directive in this application.
    expect(PRODUCTION_CSP).toContain("connect-src 'none'");
    expect(PRODUCTION_CSP).toContain("default-src 'self'");
    expect(PRODUCTION_CSP).toContain("script-src 'self'");
    expect(PRODUCTION_CSP).toContain("object-src 'none'");
    expect(PRODUCTION_CSP).toContain("frame-ancestors 'none'");
    expect(PRODUCTION_CSP).toContain("base-uri 'none'");
  });

  it('never allows eval or remote scripts in production', () => {
    expect(PRODUCTION_CSP).not.toContain('unsafe-eval');
    expect(PRODUCTION_CSP).not.toMatch(/script-src[^;]*https?:/);
  });

  it('relaxes only as far as the dev server needs', () => {
    const csp = developmentCsp('http://localhost:5173');
    expect(csp).toContain('http://localhost:5173');
    expect(csp).toContain('ws://localhost:5173');
    // Even in development nothing else is reachable.
    expect(csp).not.toContain('*');
    expect(csp).toContain("object-src 'none'");
  });
});

describe('request filtering', () => {
  const production = { rendererOrigin: null };
  const development = { rendererOrigin: 'http://localhost:5173' };

  it('allows the schemes the application itself uses', () => {
    for (const scheme of ALLOWED_SCHEMES) {
      expect(isRequestAllowed(`${scheme}//example/thing`, production)).toBe(true);
    }
  });

  it.each([
    'https://telemetry.example.com/collect',
    'http://example.com/',
    'ws://example.com/socket',
    'wss://example.com/socket',
    'ftp://example.com/file',
  ])('blocks %s in a packaged build', (url) => {
    expect(isRequestAllowed(url, production)).toBe(false);
  });

  it('allows the dev server and its HMR socket, and nothing else on that host', () => {
    expect(isRequestAllowed('http://localhost:5173/src/main.tsx', development)).toBe(true);
    expect(isRequestAllowed('ws://localhost:5173/', development)).toBe(true);
    // A different port is a different origin, so it stays blocked.
    expect(isRequestAllowed('http://localhost:9999/', development)).toBe(false);
    expect(isRequestAllowed('https://example.com/', development)).toBe(false);
  });

  it('blocks a URL it cannot parse', () => {
    expect(isRequestAllowed('not a url', production)).toBe(false);
    expect(isRequestAllowed('', production)).toBe(false);
  });
});

describe('external links', () => {
  it('opens nothing by default', () => {
    // An allowlist rather than "any https URL": otherwise a compromised renderer could ask the
    // operating system to open a URL with data in its query string, which is exfiltration by
    // another route.
    expect(isExternalLinkAllowed('https://example.com')).toBe(false);
    expect(isExternalLinkAllowed('https://storage-visualizer.example/help')).toBe(false);
  });
});
