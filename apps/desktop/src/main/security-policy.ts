/**
 * The security posture of the desktop application, expressed as data.
 *
 * Deliberately free of any Electron import so it can be asserted in a plain unit test. A
 * policy that is only exercised by launching the app is a policy that silently regresses;
 * these values are the ones the window and session are actually built from, and the tests
 * pin every one of them.
 */

/**
 * `webPreferences` for every window.
 *
 * `sandbox: true` is the load-bearing one, and it has a consequence worth recording: Electron
 * requires sandboxed preload scripts to be CommonJS. That is why `apps/desktop` is not an ESM
 * package while the rest of the repository is.
 */
export function secureWebPreferences(options: { readonly packaged: boolean }): {
  readonly sandbox: true;
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly nodeIntegrationInWorker: false;
  readonly nodeIntegrationInSubFrames: false;
  readonly webSecurity: true;
  readonly allowRunningInsecureContent: false;
  readonly experimentalFeatures: false;
  readonly webviewTag: false;
  readonly spellcheck: false;
  readonly devTools: boolean;
} {
  return {
    // The renderer gets no Node, no module system, and its own isolated context. Everything
    // it can do goes through the validated command channel.
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    // No <webview> and no spellcheck: both are attack surface for features this product does
    // not have. Spellcheck also historically fetched dictionaries over the network.
    webviewTag: false,
    spellcheck: false,
    devTools: !options.packaged,
  };
}

/**
 * Content Security Policy.
 *
 * `connect-src 'none'` is the line that matters: it means the renderer cannot open an HTTP
 * request, a WebSocket or an EventSource even if something in the bundle tried to. Combined
 * with the request filter below, the privacy promise stops depending on our own discipline.
 *
 * `style-src` allows inline styles because React sets element styles directly and the bundler
 * injects a stylesheet; script execution is what CSP is really guarding here, and that stays
 * locked to 'self'.
 */
export const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "media-src 'none'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Development needs the Vite dev server and its HMR socket, so the policy is relaxed exactly
 * as far as that requires and no further. Production never sees this string.
 */
export function developmentCsp(rendererOrigin: string): string {
  return [
    `default-src 'self' ${rendererOrigin}`,
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${rendererOrigin}`,
    `style-src 'self' 'unsafe-inline' ${rendererOrigin}`,
    `img-src 'self' data: ${rendererOrigin}`,
    `font-src 'self' data: ${rendererOrigin}`,
    `connect-src 'self' ${rendererOrigin} ${rendererOrigin.replace(/^http/, 'ws')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** Schemes the application itself needs. Everything else is refused outright. */
export const ALLOWED_SCHEMES = ['file:', 'devtools:', 'blob:', 'data:', 'chrome-extension:'];

/**
 * Decides whether a request may proceed.
 *
 * This is the enforcement behind "nothing about your filesystem leaves your computer". It is
 * a deny-by-default filter on the whole session, not a review of our own source: a dependency
 * that decided to phone home would be stopped here.
 */
export function isRequestAllowed(
  url: string,
  options: { readonly rendererOrigin: string | null },
): boolean {
  let scheme: string;
  let origin: string;
  try {
    const parsed = new URL(url);
    scheme = parsed.protocol;
    origin = parsed.origin;
  } catch {
    // An unparseable URL is not something this application produces.
    return false;
  }

  if (ALLOWED_SCHEMES.includes(scheme)) return true;

  // In development the renderer is served over HTTP by Vite, and only from that exact origin.
  if (options.rendererOrigin !== null && origin === options.rendererOrigin) return true;

  // Vite's HMR socket shares the dev server's host and port.
  if (
    options.rendererOrigin !== null &&
    (scheme === 'ws:' || scheme === 'wss:') &&
    origin === options.rendererOrigin.replace(/^http/, 'ws')
  ) {
    return true;
  }

  return false;
}

/**
 * External links the application may hand to the operating system's browser.
 *
 * An allowlist rather than "any https URL", so a compromised renderer cannot use the shell as
 * an exfiltration channel by asking the OS to open a URL with data in its query string.
 */
export const EXTERNAL_LINK_ALLOWLIST: readonly string[] = [];

export function isExternalLinkAllowed(url: string): boolean {
  return EXTERNAL_LINK_ALLOWLIST.some((allowed) => url === allowed);
}
