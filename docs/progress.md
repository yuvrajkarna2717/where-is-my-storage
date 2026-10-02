# Progress

The record of what is built, what was measured, and what was decided against. Forward-looking work
is in [roadmap.md](roadmap.md); the reasoning behind the structure is in
[architecture.md](architecture.md).

This document exists because three of the decisions below reverse an assumption in the original
plan. A plan that was quietly edited to match the outcome teaches nobody anything, so the
assumption, the measurement and the conclusion are all kept.

## Where the project stands

The **walking skeleton is complete and runs end to end**: pick a drive, watch the treemap fill in
while the scan is still running, click into folders, navigate back out. There is also a terminal
client that does the same job without a window.

|                    |                                                                   |
| ------------------ | ----------------------------------------------------------------- |
| Tasks complete     | 6 of 24                                                           |
| Source             | ~6,400 lines across 8 packages and 2 apps                         |
| Tests              | 407 (405 passing, 2 skipped as platform-specific)                 |
| Verification gates | type-check ×4, lint, boundary rules, format, tests, app self-test |
| Commits            | `f0d73d8`, `3f3bfab`, `58b4950`                                   |

Four packages are deliberate placeholders — `fs-web`, `store-sqlite`, `analysis`, `entitlements`
are five lines each. They exist from Task 1 so the dependency graph, the type-check split and the
boundary rules are enforceable before the code arrives, rather than being retrofitted around it.

## Completed tasks

### Task 1 — foundation

pnpm workspace, four type-check programs, ESLint with a repo-wide network ban, 15 architectural
boundary rules, CI across Windows, macOS and Linux.

The boundary rules are generated from a path prefix by `tools/boundary-rules.cjs`, which lets the
same rule set run twice: once against the real repository, and once against a tree of deliberate
violations in `tools/boundary-fixtures/`. `tools/boundaries.test.ts` asserts the repository is clean
**and** that every non-exempt rule is actually triggered by its fixture. A rule that silently stops
matching fails a test instead of passing forever.

### Task 2 — storage model

`@sv/core`: columnar node table, incremental aggregation, four percentage framings, byte and count
formatting, path handling, and a hand-rolled WTF-8 codec.

**Measured: 86 MB per million nodes, against 369 MB for the equivalent object tree** — 4.3× less,
with identical totals, built at 2.9M nodes/s. A nested `{ name, children: [] }` tree cannot hold a
million files in a desktop memory budget; parallel typed arrays can.

The WTF-8 codec is hand-written rather than `TextEncoder` because the portable packages compile
under `types: []`, where `TextEncoder` is not declared. It also preserves unpaired surrogates, so
Windows filenames that are not valid UTF-16 round-trip losslessly instead of being replaced with
`U+FFFD`.

### Task 3 — scanner

`@sv/scan-engine` (traversal, no filesystem code at all), `@sv/fs-node` (the Node provider), and the
`pnpm scan` CLI.

Verified against `C:\Windows`: 234k entries, 52 permission errors absorbed without aborting, totals
flagged as a lower bound exactly where they are one. The frontier is an explicit LIFO array, so a
ten-thousand-level directory chain is a longer loop rather than a blown stack, and there is a test
at that depth.

Progress estimation uses bytes discovered against bytes known in use on the volume, and reports
`null` when there is no honest denominator. The obvious alternative — directories listed over
directories discovered — moves _backwards_ whenever a large folder is opened.

### Task 4 — desktop shell

Hardened Electron app: sandboxed renderer with no Node access, `contextIsolation` on, a
seven-command validated IPC surface, and the scanner isolated in a `utilityProcess` so a traversal
defect cannot take the window down with it.

`pnpm desktop:selftest` boots the real application, drives a scan through the actual IPC path,
clicks through the real renderer, and exits with a status code. **29 of 29 checks pass**, including a
screenshot. It is the only gate that can catch wiring faults — a preload that fails to load, a
sandbox blocking something needed, a `utilityProcess` that cannot be forked — none of which any unit
test can see.

### Task 5 — the map

`@sv/ui`: canvas treemap, breadcrumbs, volume picker, progress panel, wired into the desktop app
with drill-down. Accessibility through an off-screen `role="listbox"` mirror of the tiles, which is
also what lets the self-test drive the real UI.

### Task 6 — worker pool, and a result that went the other way

A pool of worker threads running synchronous `readdir`/`lstat`, with cancellation through a
`SharedArrayBuffer` and recovery from a crashed worker that costs one directory rather than the
scan. 25 tests pin it to byte-identical results against the single-threaded provider.

**It is not the default, because it measured slower end to end.** Full numbers and method in
[architecture.md](architecture.md#the-worker-pool-is-not-the-default-because-it-is-not-faster).

## Decisions that went against the plan

### The worker pool is not the default

The plan had Task 6 replacing the single-threaded provider's internals with a worker pool. The
theory was sound — Node dispatches async filesystem calls to a four-thread libuv pool, so a
"concurrent" scan is really four syscalls deep no matter how many are outstanding.

`pnpm bench:providers` over a warm `C:\Windows` (52,993 directories, 180,966 files, five reps per
cell, whole matrix interleaved) shows the theory holds only for the part it predicted. Raw listing
throughput is **10–17% better**. Through the whole engine it is **not better at all**: 2.84s at best
against 2.94s single-threaded, inside the 1.2–2.1× run-to-run spread and with a worse median.

The listing work leaves the main thread, but an equivalent amount of structured-clone
deserialisation arrives on it — and that thread is still the one building the tree. Four workers
being consistently _slower_ than none (0.73–0.97×) says the same thing from the other side: the
per-message cost is on the order of the per-directory syscall cost.

So the CLI default is `--provider simple`, the desktop scan host keeps the single-threaded provider,
and the pool stays reachable behind a flag. It is kept rather than deleted because it is the only
standing proof that the `FileSystemProvider` seam tolerates an implementation off the caller's
thread — which is exactly what a native provider will be.

### No sliver aggregation pass in the treemap

Built, measured, removed. Across power-law, realistic and minimal distributions at five aspect
ratios from 300×300 to 2400×1300, the number of individually-placed tiles under 5 px was **zero
everywhere** except a three-entry folder at an extreme ratio, which produced exactly one. Folding
that single entry into `Other (1 item)` hides its name, which is worse than a hairline a tooltip can
still identify. The measurements are asserted in `packages/ui/test/layout.test.ts` so the treemap
polish task starts from evidence rather than re-deriving them.

### No mtime-based incremental rescan

Silently incorrect, not merely imprecise: changing a file's size does not change its parent
directory's modification time. A rescan that trusted mtime would report stale totals with full
confidence, which is worse for a tool whose entire value is a trustworthy number.

### Hand-written IPC validators instead of a schema library

Seven commands of primitive fields. The limits that actually matter — maximum page size, NUL-byte
rejection, a bound on key counts — are not natural schema constructs, and this is the one security
boundary in the application. One file that can be read in a sitting beat a dependency plus
`.refine()` calls. Worth revisiting if payloads ever become nested or recursive.

### No auto-updater in v1

An updater that phones home would undercut the only promise the product makes.

## Verification

```bash
pnpm check              # type-check x4, lint, boundaries, format, tests
pnpm desktop:selftest   # boot the real app and drive it
pnpm bench:core         # storage model memory and throughput
pnpm bench:providers    # single-threaded vs worker pool
```

Current state: 407 tests across 20 files, 101 modules and 234 dependencies cruised with no boundary
violations, 29/29 self-test checks.

## Known gaps

These are understood and unfixed, listed so they are not rediscovered as surprises.

- **CI has never actually run.** The workflow is written and has three-platform matrices for both
  jobs, but there is no remote yet, so it has never executed. Everything has only ever been verified
  on Windows.
- **Windows junctions are reported as generic symlinks.** Node does not expose the reparse tag, so a
  junction, a mount point and a symlink are indistinguishable. They are correctly _not followed_, so
  totals are right; only the labelling is coarse.
- **Hardlinks are not deduplicated.** A file with several hardlinks is counted once per path, which
  overstates directories like `WinSxS`. Needs inode/file-index tracking.
- **Volume metadata is modest.** Drive letters and capacity, but no volume labels and no
  removable/network classification.
- **Allocated-on-disk size is not reported.** v1 reports apparent size. Node exposes `blocks` on
  Unix with no Windows equivalent, so this needs platform-specific work.
- **Query results are re-sorted per page request.** Fine for directories a person browses, not for
  a directory with a hundred thousand entries.
