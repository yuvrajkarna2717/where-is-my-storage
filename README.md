# Storage Visualizer

A visual map of where your storage is used. Runs entirely on your machine.

There is one question this product answers well: **where is my storage being used?** Everything
in it supports that question, as a navigable treemap of your filesystem hierarchy.

Two surfaces, one shared storage model:

- **Desktop** (Windows, macOS, Linux) — Electron, native filesystem access, full experience.
- **Web** — analyses folders you explicitly grant access to, in the browser, with no upload.

## The privacy promise

> Your storage stays on your computer.

No cloud storage, no file uploads, no remote database, no server dependency for scanning or
analysis, and no telemetry containing filesystem information. The scanner never needs the
internet; disconnect it and everything still works.

This is enforced architecturally rather than promised in marketing copy — see
[docs/privacy.md](docs/privacy.md) for the specific mechanisms and the tests that prove them.

## Repository layout

```
apps/
  desktop/          Electron shell: main process, preload, scan host, renderer
  web/              Browser application
packages/
  core/             Normalized storage model: columnar node table, aggregation, percentages
  scan-engine/      Platform-agnostic traversal orchestrator + FileSystemProvider seam
  fs-node/          Node filesystem provider (worker pool, volume enumeration)
  fs-web/           Browser providers (File System Access API, webkitdirectory fallback)
  store-sqlite/     Local persistence: scan snapshots, rollups, settings
  analysis/         File types, developer storage, largest files, duplicates
  ui/               Shared React UI: canvas treemap, directory tree, breadcrumbs
  entitlements/     Licensing seam, deliberately quarantined from the storage engine
tools/              Repo tooling, architectural boundary rules and their fixtures
docs/               Architecture and privacy documentation
```

Read [docs/architecture.md](docs/architecture.md) for why the layers are split this way and
which suggestions from the original brief were deliberately not followed.

## Getting started

Requires Node >= 22.12 and pnpm (the version is pinned in `packageManager`).

```bash
pnpm install
pnpm check          # typecheck (3 platform configs) + lint + boundaries + format + tests
```

Individual gates:

| Command             | What it checks                                                   |
| ------------------- | ---------------------------------------------------------------- |
| `pnpm typecheck`    | Three separate TypeScript programs: platform-agnostic, Node, DOM |
| `pnpm lint`         | ESLint, including the repo-wide ban on network APIs              |
| `pnpm boundaries`   | Architectural dependency rules (dependency-cruiser)              |
| `pnpm format:check` | Prettier                                                         |
| `pnpm test`         | Vitest                                                           |

`pnpm boundaries:graph` emits a Graphviz dot graph of the real module graph.

## Trying the scanner

There is no window yet, but the scanner works and can be pointed at a real disk:

```bash
pnpm scan --volumes              # list volumes with used / free / capacity
pnpm scan C:\Users\you           # live top-level breakdown, then full statistics
pnpm scan / --top 20             # macOS and Linux
pnpm scan <path> --json          # machine-readable summary
pnpm scan <path> --help
```

Press Ctrl+C mid-scan to cancel: partial results are still reported, and the totals still
reconcile. `pnpm bench:core` measures the storage model's memory use and throughput.

## Status

Under active construction, built in ordered phases.

- **Task 1 — foundation.** Workspace, three-way type-check split, architectural boundary rules
  with tests proving each rule fires, CI across Windows, macOS and Linux.
- **Task 2 — storage model.** Columnar node table, incremental aggregation, four percentage
  framings, formatting and path handling. Measured at 86 MB per million nodes against 369 MB for
  the equivalent object tree.
- **Task 3 — scanner.** Platform-agnostic traversal engine, the `FileSystemProvider` seam, the
  Node provider, and the `pnpm scan` CLI. Verified against `C:\Windows`: 234k entries, 52
  permission errors absorbed without aborting, totals flagged as a lower bound where they are one.
- **Task 4 — desktop shell.** Hardened Electron app: sandboxed renderer with no Node access, a
  seven-command validated IPC surface, and the scanner isolated in a `utilityProcess`. A
  `--selftest` mode boots the real application and verifies all of it, including a screenshot.

- **Task 5 — the map.** `@sv/ui` with a canvas treemap, breadcrumbs, volume picker and progress
  panel, wired into the desktop app with drill-down. **The walking skeleton is complete**: pick a
  drive, watch results appear while scanning, click into folders, navigate back.

Next: moving the scanner onto a worker pool, then cross-platform hardening.

## Running the desktop app

```bash
pnpm desktop:dev        # development, with hot reload
pnpm desktop:build      # production build into apps/desktop/out
pnpm desktop:selftest   # boot the real app, verify the whole chain, exit with a status code
```
