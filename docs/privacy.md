# Privacy

> Your storage stays on your computer.
>
> We don't upload your files, paths, or storage data.

This document records exactly what that means and, more importantly, the mechanisms that make it
true. The intent is that the claim is verifiable, not merely stated.

## What is never transmitted

Nothing derived from your filesystem leaves the machine. Specifically not: file names, file paths,
directory structures, file sizes, file contents, drive or volume information, storage statistics,
scan results, hashes, or activity derived from any of these.

There is no cloud storage, no upload endpoint, no remote database, and no server involved in
scanning or analysis. The scanner does not require internet connectivity: disconnect the network
and every storage feature keeps working.

## How it is enforced

Enforcement is layered, so no single mistake can break the promise silently.

| Mechanism                                                                                                                    | Status       |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------ |
| No network code in the product at all                                                                                        | Enforced now |
| ESLint bans `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `Request`, `Response` repo-wide                           | Enforced now |
| ESLint bans Node networking modules (`node:http`, `node:https`, `node:net`, `node:dgram`, `node:tls`, `node:http2`)          | Enforced now |
| Renderer cannot reach the filesystem: boundary rules forbid it importing any provider, the SQLite store, or any Node builtin | Enforced now |
| Electron renderer runs sandboxed with `contextIsolation`, `nodeIntegration: false`                                           | Task 4       |
| Content Security Policy `default-src 'self'; connect-src 'none'` in production builds                                        | Task 19      |
| Session-level request blocking for every non-local scheme                                                                    | Task 19      |
| Build artifact scan that fails if a network API appears in a bundle                                                          | Task 19      |
| End-to-end test that fails if any network request is attempted during a full scan                                            | Task 19      |

An exception to the lint rules requires an explicit inline disable, which makes it visible in code
review rather than buried in a diff.

## Data stored locally

The desktop application stores scan snapshots, aggregate rollups and settings in a SQLite database
under the OS user-data directory. This never leaves the machine, is never synchronised, and can be
cleared from within the application. Scan databases are git-ignored, because a snapshot describes a
real filesystem.

The web application keeps its snapshot in memory only. Closing the tab discards it.

## Analytics

There are none. If any are ever added, they will be optional, off by default, contain no
filesystem information whatsoever, and live entirely outside the scanner.

## Licensing

The desktop application will eventually be a paid one-time purchase. Licensing is deliberately
quarantined from the storage engine: an architectural rule forbids any core, scanner, provider,
analysis or persistence package from importing `@sv/entitlements`. The scanner must keep working
with that package deleted outright, and there is a test for that.
