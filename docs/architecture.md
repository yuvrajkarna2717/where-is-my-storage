# Architecture

## Layering

```
                       Storage Visualizer
                              │
              ┌───────────────┴───────────────┐
              │                               │
             WEB                           DESKTOP
     browser filesystem APIs       Electron + Node scanner
              │                               │
              └───────────────┬───────────────┘
                              │
                     shared storage model   (@sv/core)
                     shared scan engine     (@sv/scan-engine)
                     shared analysis        (@sv/analysis)
                     shared visualization   (@sv/ui)
```

The visualization layer never learns where its data came from. It reads the normalized model
from `@sv/core` and nothing platform-specific. That is enforced, not merely intended: see
`tools/boundary-rules.cjs`.

### Dependency direction

| Package            | May depend on         | Notes                                             |
| ------------------ | --------------------- | ------------------------------------------------- |
| `@sv/core`         | nothing               | Shared vocabulary; must stay a leaf               |
| `@sv/scan-engine`  | `core`                | Reaches filesystems only via `FileSystemProvider` |
| `@sv/analysis`     | `core`                |                                                   |
| `@sv/fs-node`      | `core`, `scan-engine` | Node only                                         |
| `@sv/fs-web`       | `core`, `scan-engine` | Browser only                                      |
| `@sv/store-sqlite` | `core`                | Node only                                         |
| `@sv/ui`           | `core`, `analysis`    | Must not know about providers or persistence      |
| `@sv/entitlements` | nothing               | Only the app shells may import it                 |

`core`, `scan-engine`, `analysis`, `entitlements`, `ui` and `fs-web` are **portable**: they may
not import Node builtins, because they ship to the browser.

## Four type-check programs, not one

`pnpm typecheck` runs TypeScript four times with different `lib`/`types`:

- `tsconfig.agnostic.json` — `lib: ES2023`, `types: []`. Used for `core`, `scan-engine`,
  `analysis`, `entitlements`. With no ambient types at all, these packages cannot reach for
  `node:*`, `document`, `window`, or even `console` without failing the build. This is what keeps
  the shared model genuinely portable between the Electron scan host, a Node CLI, a web worker
  and a browser main thread.
- `tsconfig.node.json` — `types: ["node"]`. Filesystem providers, SQLite store, tooling, benches
  and non-DOM tests.
- `tsconfig.desktop.json` — the Electron main process, preload and scan host. Separate from the
  Node program so Electron's _global_ type augmentation stays contained: importing `electron`
  anywhere in a program declares `process.parentPort` for every file in it, and if the shared
  packages shared that program they would compile as though Electron were always present.
- `tsconfig.dom.json` — DOM libs, `types: []` so `@types/node` cannot leak in. Shared UI,
  browser providers, the web app and the Electron renderer.

Tests live in `test/` beside each package's `src/`, which keeps the shipped source tree clean and
makes it unambiguous which program a file belongs to.

## Desktop shell

### Process topology

```
Renderer  ──contextBridge, validated IPC──▶  Main (thin broker)
React, sandboxed, no Node                          │ MessagePort
                                                   ▼
                                    utilityProcess: scan host
                                    columnar store, SQLite
                                                   │
                                                   ▼
                                    worker_threads pool
                                    readdirSync + lstatSync
```

The scanner runs in a `utilityProcess`, not the main process, so Node-heavy work never blocks
window management and a scanner crash cannot take down the app. The renderer's only capability
is a narrow, validated command set; it never receives the whole tree, only paged query results.

### The command surface

`apps/desktop/src/shared/protocol.ts` is the entire contract, and it is compiled under both the
desktop and DOM type-check programs so it cannot acquire a platform dependency. Two rules shape it:

- **The renderer never holds a filesystem path as a capability.** It may _display_ paths, but
  every command that acts refers to a node by id. A compromised renderer cannot ask for an
  arbitrary path to be read; it can only name something the scan already found. `startScan` is the
  single exception, and exists only to forward the user's own directory-picker choice.
- **Failures cross as data, not as thrown errors.** A rejected `ipcMain.handle` serialises a
  privileged stack trace into the renderer, which is both an information leak and useless to a
  user. Commands return `{ ok: false, code, message }`.

Three checks run before any work happens: the sender must be the main frame of our own window
(`ipcMain.handle` is process-wide, so a subframe would otherwise reach it), the request must
validate, and the command must be routed to the process that owns it.

### Why the scan host connection has no request timeouts

A timeout would have to exceed the slowest legitimate operation — describing a root on a sleeping
network drive takes many seconds — and one set that high protects against nothing, while a shorter
one fails healthy scans. Instead the host's _exit_ settles outstanding work: every pending caller
is answered with `notReady` the moment the process goes away, so no promise is abandoned and the
next command starts a fresh host.

### Verifying it works: `--selftest`

`pnpm desktop:selftest` boots the real application and drives a scan through the actual IPC path,
then exits with a status code. It exists because the interesting failures in an Electron
application are wiring failures — a preload that does not load, a sandbox that blocks something
needed, a `utilityProcess` that cannot be forked from a packaged bundle, a `MessagePort`
transferred too early. None of those appear in a unit test and all of them appear here.

Among its 23 checks: the renderer reports from inside its own sandbox that `require`, `module`,
`process` and `global` are all absent and that the exposed bridge has exactly two members; a scan
of a fixture returns a byte-exact total; cancellation settles in well under 100 ms; and the window
is captured to a PNG so a person can confirm the interface actually paints. It runs in CI on all
three platforms, under `xvfb` on Linux.

## Core data model

A nested `StorageNode` tree with `children: StorageNode[]` cannot hold a million files at
acceptable memory cost. Instead the model is a **columnar store of parallel typed arrays**, where
the array index _is_ the node id:

```
parent      Int32Array     -1 for the root
childStart  Int32Array     children are contiguous: readdir yields them all at once
childCount  Int32Array
nameOffset  Uint32Array    offset into a single shared UTF-8 name blob
nameLength  Uint16Array
totalSize   Float64Array   whole subtree, exact integers to 9 PB
directSize  Float64Array   files immediately inside this directory
allocSize   Float64Array   reserved for the later on-disk-size setting
fileCount   Uint32Array
dirCount    Uint32Array
mtimeMs     Float64Array
depth       Uint8Array
flags       Uint8Array     dir | symlink | reparse | accessDenied | partial | dedupedHardlink
names       Uint8Array     one growable blob; each name stored once
```

Full paths are never stored per node; they are reconstructed by walking `parent`. That is the
single biggest memory saving.

**Measured budget: exactly 53 bytes of columns per node, plus the WTF-8 encoded name.** With
representative 15–19 character names that is roughly 71 bytes per node, so about 71 MB per million
entries. `packages/core/test/node-table.memory.test.ts` pins that relationship and
`pnpm bench:core` reports it alongside real process memory.

Percentages are derived, never stored, and the UI labels all four framings distinctly:
`ofCurrentView`, `ofParent`, `ofScanRoot`, `ofVolumeCapacity`.

## Scanner

`@sv/scan-engine` owns traversal and contains no filesystem code at all. It drives a
`FileSystemProvider`, folds listings into the storage model, and reports progress and failures.

Three properties are treated as requirements rather than goals:

- **It cannot blow the stack.** The frontier is an explicit last-in-first-out array, not
  recursion. A ten-thousand-level chain is just a longer loop, and there is a test for exactly
  that depth.
- **It cannot be derailed by one bad entry.** Every failure is classified into a small taxonomy
  (`accessDenied`, `vanished`, `tooLong`, `tooDeep`, `invalidName`, `locked`, `unsupported`,
  `ioError`, `notADirectory`), counted in full, sampled with a bounded number of example paths,
  and attributed to the affected subtree via the `Partial` flag so its totals read as a lower
  bound.
- **It yields useful numbers immediately.** The first listing reveals the whole top level, and
  aggregates only ever rise. `onTableReady` hands the live model to the caller before traversal
  starts, which is what makes progressive results possible at all.

Depth-first was chosen over breadth-first deliberately: the frontier stays proportional to depth
rather than to the widest level of the tree, and directories that are physically near each other
are read close together in time, which matters on a spinning disk.

Progress estimation uses bytes seen against bytes known to be in use on the volume, and reports
`null` when there is no honest denominator. The obvious alternative — listed directories over
discovered directories — moves _backwards_ whenever a large folder is opened, and a progress bar
that retreats is worse than none.

Cancellation is polled between listings through a minimal `{ aborted: boolean }` interface that a
real `AbortSignal` satisfies structurally. Polling has no listener to leak and no timer to clear,
and the same interface is backed by a `SharedArrayBuffer` flag for the worker pool, which reads it
without any message passing.

### Baseline throughput

Single-threaded `readdir` + `lstat`, measured on Windows with an NVMe SSD:

| Target                | Entries  | Time   | Rate              |
| --------------------- | -------- | ------ | ----------------- |
| `C:\Windows` (cold)   | 233,949  | 13.3 s | ~17,600 entries/s |
| `C:\Windows` (warm)   | ~233,900 | 2.9 s  | ~79,500 entries/s |
| `C:\Windows\System32` | 22,555   | 1.5 s  | ~15,000 entries/s |

The known ceiling for portable Node on Windows is that `readdir` discards the size information the
OS already returned, forcing one `lstat` per file; tools like WizTree avoid that entirely by
parsing the NTFS master file table, which needs elevation and is Windows-only.

One optimisation is already in place: plain directories are not `lstat`-ed at all, since their
kind comes from the directory listing and their size is by definition the aggregate of their
contents. The cost is an unknown modification time for directories, which nothing in the product
reads.

### The worker pool is not the default, because it is not faster

`WorkerFileSystemProvider` exists and works, and the single-threaded `NodeFileSystemProvider`
remains the default. That is the opposite of what the plan expected, so the measurement is recorded
here rather than left as folklore.

The theory was sound. Node dispatches asynchronous filesystem calls to a libuv thread pool of four
threads by default, so a "concurrent" scan is really four syscalls deep no matter how many listings
are outstanding, and raising the engine's concurrency past that only deepens a queue. Worker threads
each have their own execution context, so eight workers should mean eight genuinely concurrent
syscalls.

`packages/fs-node/bench/provider.bench.ts` measures it two ways against a warm `C:\Windows` (52,993
directories, 180,966 files), five reps per cell, the whole concurrency × provider matrix interleaved
in alternating order, with a forced collection between runs. Best-of-five, worker startup charged
separately:

| Engine concurrency | Listings only, best         | Full scan, best             |
| ------------------ | --------------------------- | --------------------------- |
| 8                  | workers(12) **1.17×**       | simple (workers 0.81–1.00×) |
| 16                 | simple (workers 0.78–1.00×) | simple (workers 0.86–1.00×) |
| 32                 | workers(12) **1.10×**       | workers(12) 1.04×           |
| 64                 | workers(12) 1.04×           | simple (workers 0.82–0.94×) |

Replaying listings with nothing else running, the pool is 10–17% faster — the theory holds for the
part it predicted. Through the whole engine, with the tree actually being built, the lead
disappears: 2.84 s at best against 2.94 s single-threaded, inside the 1.2–2.1× run-to-run spread,
and with a worse median (4.46 s against 3.17 s).

The reason is that the work does not leave the main thread, it changes shape. Every listing comes
back as a structured clone, so the main thread stops calling `lstat` and starts deserialising a few
hundred thousand objects instead — while still doing all the tree building. Two details corroborate
this rather than leaving it a guess:

- **Four workers is consistently slower than no workers** (0.73–0.97×). If threads were the
  constraint, four would still beat one.
- **This tree averages 3.4 files per directory**, so each listing is roughly one `readdir` plus
  three `lstat`s. A per-message cost on that order is not a rounding error.

Two measurement traps were worth more than the numbers themselves. Charging worker startup to
throughput made the pool look 4–10× slower on small trees, when it is really a flat ~150 ms for
eight threads. And sweeping configurations in nested loops made the single-threaded provider look
like it degraded monotonically with concurrency — 3.7 s, 4.4 s, 8.5 s — which was not concurrency at
all but GC pressure from scan tables accumulating over the run, charged to whichever cell happened
to go last.

What would actually help is implied by the finding: hand a listing over as one transferable
`ArrayBuffer` of packed names and sizes instead of an array of objects, so the clone cost goes to
zero. That needs a columnar intake path on the engine side, so it is deferred to the performance
task rather than bolted on here. The pool stays opt-in in the meantime, for three reasons: it is the
only standing proof that the `FileSystemProvider` seam tolerates an implementation off the caller's
thread, which is exactly what a native provider will be; the measurement is one machine and one warm
NTFS tree, and `--provider workers` is what lets a bug report test the other hypothesis instead of
arguing about it; and the transferable-buffer fix reuses all of its cancellation, pooling and
crash-recovery machinery.

Two things in it are load-bearing and non-obvious:

- **Cancellation travels through a `SharedArrayBuffer`, not a message.** A worker reading a
  directory of 200,000 entries is inside a synchronous loop and will not touch its message queue
  until it finishes, so a "stop" message arrives far too late. The shared flag is checked between
  entries.
- **A worker is `ref`'d only while a request is outstanding.** Idle workers must not hold the
  process open, or the CLI appears to hang after printing its results — but an unreferenced worker
  does not keep the event loop alive while a reply is in flight either, and since a scan is driven
  entirely by those replies, unreferencing unconditionally makes the process exit before the first
  one arrives. It printed nothing and exited 0.

## Visualisation

`@sv/ui` holds the shared visual layer and knows nothing about where its data came from. Components
take view models from `packages/ui/src/types.ts`, which are deliberately _structural subsets_ of the
desktop protocol's row types — `TreemapRow.totalSize` is named to match `NodeRow.totalSize` exactly —
so a page of rows from the scan host is already valid input with no mapping layer in between.

### Canvas, not DOM

The treemap paints to a single canvas. Aggregation keeps the drawn tile count in the dozens, but DOM
tiles would still mean layout and paint work proportional to element count on every hover and every
resize. One canvas is one element and a redraw measured in fractions of a millisecond.

The cost is accessibility, and it is paid rather than hand-waved: beside the canvas sits a real
`listbox` with one option per visible tile, which owns the focus, drives arrow-key navigation, and
announces the selection. It is positioned off-screen rather than hidden, because `display: none`
would remove it from the accessibility tree too. It also turns out to be the natural handle for
driving the map in tests.

### What is tested, and how

Layout, hit-testing, breadcrumb collapsing and painting decisions are all pure functions, tested
directly. That is not only convenient: **jsdom has no canvas implementation**, so a component test
could not verify proportional areas, label legibility or tile colouring at all. Painting is checked
against a recording fake context, which can assert the thing that matters most — that a label is
_not_ drawn on a tile too small to hold one. Real rendering is verified by the Electron self-test,
which drives the actual interface and captures a screenshot.

This is why Playwright was not added at this stage, contrary to the plan: the self-test already
drives the real render → click → IPC → re-render loop through the accessible listbox, including
drilling two levels and returning via a breadcrumb. Playwright arrives in Task 18, where real
browser engines (Chromium and WebKit) are genuinely needed.

### Sliver aggregation, measured

Entries whose share would give them less than ~260 px² are folded into an `Other (N items)` tile,
with a floor of twelve individually-drawn tiles so a folder of ten thousand similar files still shows
its largest entries rather than one shrug.

A second corrective pass based on tile _shape_ was built and then removed. Across power-law,
realistic and minimal size distributions at five canvas aspect ratios from 300×300 to 2400×1300, the
number of individually-placed tiles thinner than five pixels was **zero** in every case except a
three-entry folder at an extreme aspect ratio, where exactly one appeared — and folding a single
entry into "Other (1 item)" hides its name, which is worse than a hairline the tooltip can still
identify. The measurements are recorded in `packages/ui/src/treemap/layout.ts` and asserted in
`packages/ui/test/layout.test.ts` so Task 13 starts from evidence.

### Colour

Tile colour is a hash of the name, not of the index. Index-based colouring reshuffles every time one
folder grows past its neighbour; hashing means the big blue block stays the big blue block, and a
person learns to recognise it. The palette lives in CSS custom properties and is read into the canvas
at runtime, so theming stays in the stylesheet where the rest of the theming lives.

## Size semantics

v1 reports **apparent size** (the logical file size), which is what most tools show, is cheap,
and behaves consistently across platforms. The model carries an `allocSize` field for a future
"size on disk" setting; that is deferred because `fs.Stats` exposes `blocks`/`blksize` on Unix but
Node offers no Windows equivalent, so allocated size needs platform-specific work to be correct.

Hardlinks are counted once per scan. Symlinks are recorded but never followed.

## Deviations from the original brief

Each of these was a deliberate choice against a suggestion in the brief.

1. **Scanner in a `utilityProcess`, not the Electron main process.** Isolates crashes and keeps
   the main process responsive. Tradeoff: one extra process and a `MessagePort` hop.
2. **Columnar typed arrays instead of a nested object tree.** Measured on one million synthetic
   nodes with `pnpm bench:core`: **86 MB** resident for the columnar store against **369 MB** for
   the equivalent object graph, a 4.3x reduction, with both producing byte-identical totals. Build
   throughput is around 2.9M nodes/second. Tradeoff: less ergonomic code, so it is wrapped in a
   tested accessor API and non-null assertions are confined to a single file.
3. **SQLite stores the tree as one snapshot blob, not one row per node.** A million INSERTs is
   slow and bloats the database; a blob write is one statement and reloads into typed arrays
   directly. Long-lived history uses a compact rollup table instead of retaining every file
   forever. Tradeoff: old individual files are not SQL-queryable, which no screen needs.
4. **No mtime-based incremental rescan.** It is silently incorrect: changing a file's size does
   not change its parent directory's mtime, so pruning "unchanged" directories yields wrong
   totals. Correctness outranks speed here. Instead: instant reopen of the last snapshot, clearly
   timestamped, plus an explicit full rescan.
5. **Canvas rendering instead of an SVG/DOM treemap.** Required for smooth interaction at
   thousands of tiles. Tradeoff: accessibility must be built explicitly, via the paired DOM tree
   and an offscreen listbox — canvas alone is invisible to assistive technology.
6. **No auto-updater in v1.** An always-on update channel would undercut "no server dependency".
   A later opt-in, off-by-default update check can be added in isolation.
7. **No TypeScript project references; three flat programs instead.** Project references need
   `composite` declaration emit, but no package in this repo emits JavaScript — packages export
   TypeScript source and the consumer bundles it. Three flat `tsc` invocations are simpler and
   buy the platform isolation described above. Tradeoff: no per-package incremental build cache,
   which is irrelevant at this repo size.
8. **TypeScript 6.0.3, not the current 7.x.** `typescript-eslint@8` declares support for
   `typescript >=4.8.4 <6.1.0`; adopting TypeScript 7 today would mean giving up type-aware
   linting. Revisit when typescript-eslint ships TypeScript 7 support.
9. **Hand-written IPC validation instead of a schema library.** The plan called for Zod. The
   surface is seven commands of primitive fields; the limits that matter are not naturally
   expressible as a schema (a maximum page size, a NUL-byte rejection, a bound on how many keys an
   object may carry); and this is the one security boundary in the application, so being able to
   read all of it in one sitting has real value. Tradeoff: correctness rests on tests rather than a
   library's reputation, so there are 49 of them. Revisit if the protocol gains nested or
   recursive payloads.
10. **`apps/desktop` is a CommonJS package while the rest of the repo is ESM.** Electron requires a
    sandboxed preload script to be CommonJS, and `sandbox: true` is not negotiable. Main, preload
    and the scan host therefore build as CommonJS; the renderer is still ESM, bundled by Vite.
11. **Renderer minification is enabled explicitly.** electron-vite leaves it off by default. The
    unminified renderer was 639 kB; minified it is 228 kB. Shipping a readable copy of React costs
    disk space and parse time at every launch.
12. **vite 7, not vite 8.** `electron-vite@5` declares `vite ^5 || ^6 || ^7`. The repo therefore
    pins vite 7.3.6 and `@vitejs/plugin-react` 5.2.0, which supports the same range.

## Enforcement, not convention

- `tools/boundary-rules.cjs` is the single source of truth for architectural rules. It is a
  function of a path prefix, so the identical rule set can be replayed against
  `tools/boundary-fixtures/`, a tree that breaks every rule on purpose.
- `tools/boundaries.test.ts` asserts the real repository is clean **and** that every rule fires
  against its fixture. A rule whose regex silently stops matching fails a test rather than
  quietly passing.
- pnpm's strict `node_modules` layout means an undeclared workspace import does not resolve at
  all, so the `not-to-unresolvable` rule also enforces "declare what you import".
- ESLint bans network globals and Node networking modules repo-wide. Task 19 adds a build
  artifact scan and a zero-network end-to-end test on top.
