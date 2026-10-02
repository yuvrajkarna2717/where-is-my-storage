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
  fs-node/          Node filesystem providers (single-threaded, worker pool), volume enumeration
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
pnpm scan --volumes                    # drives, with used / free / capacity
pnpm scan ~ --tree --depth 3           # the hierarchy, with proportional bars
pnpm scan C:\Users\you                 # live top-level breakdown, then statistics
pnpm scan <path> --json                # machine-readable summary
pnpm scan <path> --help
```

`--tree` is the product in a terminal:

```
C:\Users\devyu                                38.7 GB   100%  ██████████████████
├─ AppData\                                     34 GB  88.1%  ███████████████▉
│  ├─ Local\                                  33.1 GB  85.5%  ███████████████▍
│  │  ├─ Docker\                              8.16 GB  24.7%  ████▌
│  │  ├─ Google\                              7.06 GB  21.4%  ███▉
│  │  ├─ Programs\                            5.52 GB  16.7%  ███
│  │  └─ … and 36 smaller                     5.67 GB  14.7%  ██▌
│  └─ Roaming\                                 973 MB   2.5%  ▌
├─ Downloads\                                 3.58 GB   9.3%  █▋
└─ … and 38 smaller                            108 MB   0.3%  ▏
```

Bars and percentages are shares of the scan root, so every row is comparable. Entries too small to
matter are summarised rather than dropped, so the visible rows always account for everything.

Press Ctrl+C mid-scan to cancel: partial results are still reported, and the totals still
reconcile.

Two benchmarks back the choices above with numbers rather than intuition:

```bash
pnpm bench:core                        # storage model: memory per node, build throughput
pnpm bench:providers C:\Windows        # single-threaded vs worker pool, across concurrencies
```

## Status

Under active construction, built in ordered phases. **6 of 24 tasks complete**, and the walking
skeleton runs end to end: pick a drive, watch the treemap fill in while the scan is still running,
click into folders, navigate back out.

| Stage                             | Tasks | State                        |
| --------------------------------- | ----- | ---------------------------- |
| 1 — foundation, walking skeleton  | 1–5   | complete                     |
| 2 — scanner depth and correctness | 6–9   | Task 6 complete, Task 7 next |
| 3 — persistence and scale         | 10–13 | not started                  |
| 4 — features                      | 14–18 | not started                  |
| 5 — product and release           | 19–24 | not started                  |

- **[progress.md](docs/progress.md)** — what is built, what was measured, and the decisions that
  went against the plan, including the three that were reversed by measurement.
- **[roadmap.md](docs/roadmap.md)** — what is left and in what order.
- **[architecture.md](docs/architecture.md)** — why it is shaped this way.

The most recent result is worth stating here because it contradicts the plan: the worker pool built
in Task 6 is **not** the default, because it measured slower end to end. Raw listing throughput
improves 10–17%, but the gain is cancelled by the structured-clone deserialisation it adds to the
main thread — which is still the thread building the tree. It stays available via
`--provider workers`, and 25 tests pin both providers to byte-identical results.
[The measurement and what would actually help](docs/architecture.md#the-worker-pool-is-not-the-default-because-it-is-not-faster).

One honest caveat: **CI has never run.** The workflow covers Windows, macOS and Linux for both the
check and the app self-test, but there was no remote until now, so everything has only ever been
verified on Windows.

## Running the desktop app

```bash
pnpm desktop:dev        # development, with hot reload
pnpm desktop:build      # production build into apps/desktop/out
pnpm desktop:selftest   # boot the real app, verify the whole chain, exit with a status code
```
