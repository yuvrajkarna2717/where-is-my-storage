# Roadmap

What is left, in the order it is meant to land. Completed work is recorded in
[progress.md](progress.md).

The ordering principle is the brief's priority list, and it is worth restating because it decides
every trade-off below:

> correctness → privacy → security → responsiveness → performance → cross-platform reliability →
> user experience → application size → advanced features

Performance sits fifth. That is why Task 6 shipped a measurement and a default that does not use
the faster-sounding option, and it is why the tasks below put correctness on three platforms ahead
of making anything quicker.

## Status of the numbering

Task numbers referenced from source comments are firm — code points at them, so they cannot drift
without something failing. Those are Tasks 1–7, 9, 10, 11, 13, 16, 18, 19 and 20.

The remaining slots (8, 12, 14, 15, 17, 21–24) are not referenced anywhere in the code. The work in
them is listed below under **Unassigned work** by the stage it belongs to, rather than given invented
numbers that would silently replace the approved plan. Worth pinning down before Stage 4 starts.

## Stage 2 — scanner depth and correctness

### Task 7 — platform hardening — next

The scanner currently works correctly on Windows and is only _assumed_ correct elsewhere. This task
makes that an assertion.

- Windows: permission handling through ACLs rather than POSIX bits, which do not apply. The existing
  permissions test is `skipIf(isWindows)` precisely because of this gap.
- Volume labels, and removable / network / virtual classification. `packages/fs-node/src/volumes.ts`
  defers all of it here by name.
- macOS and Linux mount-table parsing, so pseudo-filesystems are listed but not offered as scan
  targets.
- Junction and reparse-point identification on Windows, closing the "generic symlink" gap.
- Hardlink deduplication, which currently overstates directories like `WinSxS`.

Run the test suite on macOS and Linux for the first time. Two tests are currently skipped as
platform-specific and have never executed.

### Task 8 — unassigned

See [Unassigned work](#unassigned-work).

### Task 9 — benchmarks and the native-provider decision

Decide from measurements whether a Rust scanner is warranted. Task 6 has already answered part of
this, and narrowed it usefully: threads are not the constraint, per-listing hand-off cost is. So the
question for this task is not "is native faster at syscalls" but "does a native provider avoid the
hand-off", which it would, by writing into shared memory directly.

Two candidate changes, in increasing order of disruption:

1. **Transferable buffers.** Hand a listing over as one `ArrayBuffer` of packed names, sizes and
   flags instead of an array of objects, so the structured-clone cost goes to zero. Needs a columnar
   intake path on the engine side — a real change to the `FileSystemProvider` contract. This is the
   direct consequence of the Task 6 finding and should be measured before anything native.
2. **Native provider.** Only if (1) measured insufficient. The brief's constraint stands: it must
   drop in behind `FileSystemProvider` without the engine knowing, and the pure-Node provider must
   remain a working fallback.

The Windows ceiling worth knowing: `readdir` discards size information the OS already returned,
forcing one `lstat` per file. WizTree avoids that by parsing the NTFS master file table, which needs
elevation and is Windows-only — a trade-off this product has not agreed to.

## Stage 3 — persistence and scale

### Task 10 — SQLite persistence

`@sv/store-sqlite` with `better-sqlite3`. Scan snapshots, compact rollups, settings.

The decided shape is **one snapshot blob plus a compact rollup table**, not a row per node. A
million-row insert per scan would dominate the scan itself, and nothing in the product queries
individual nodes across scans. This is also the first native module in the tree, which is why
`electron.vite.config.ts` already keeps real npm dependencies external.

### Task 11 — query performance

Cache child orderings instead of re-sorting on every page request. `ScanSession.children` points
here by name. Today's behaviour is fine for directories a person browses and wrong for a directory
with a hundred thousand entries.

### Task 12 — unassigned

See [Unassigned work](#unassigned-work).

### Task 13 — treemap polish

Owns the visual quality of the map. Should start from the sliver measurements already asserted in
`packages/ui/test/layout.test.ts` rather than re-deriving them, and from the recorded decision that a
second aggregation pass was built, measured and removed.

## Stage 4 — features

### Task 16 — analysis

`@sv/analysis`: file-type classification, developer storage rules (`node_modules`, build caches,
container layers), largest files, duplicate detection.

Duplicate detection is the one item here that needs a privacy-shaped design rather than just an
algorithm: content hashing contradicts "determining that a 10 GB file occupies 10 GB must not cost
10 GB of I/O". Size-and-name candidate grouping first, hashing only on explicit user request and
only within a candidate set.

### Task 18 — web application

`@sv/fs-web` and `apps/web`. The decided posture is **universal with degraded fallback**: the File
System Access API where it exists (Chromium only), `webkitdirectory` everywhere else, and the UI
saying plainly which one is in use.

`webkitdirectory` cannot list incrementally — it produces one flat list of every entry up front — so
`ProviderCapabilities.listsIncrementally` already exists for the UI to be honest about it rather than
showing a progress bar that means nothing.

Playwright arrives here. It was deliberately not added in Task 5, where jsdom has no canvas and so
could not have verified a single thing about the treemap, and where the Electron self-test already
covers the real render → click → IPC → re-render loop. Here, real Chromium and WebKit are genuinely
needed.

### Tasks 14, 15, 17 — unassigned

See [Unassigned work](#unassigned-work).

## Stage 5 — product and release

### Task 19 — privacy and security hardening

The gates [privacy.md](privacy.md) already promises and schedules here:

- Content Security Policy `default-src 'self'; connect-src 'none'` in production builds.
- Session-level request blocking for every non-local scheme.
- A build artifact scan that fails if a network API appears in any bundle.
- An end-to-end test that fails if any network request is attempted during a full scan.

The ESLint network ban is in place today, but lint only sees source. These close the gap between
"we did not write a `fetch`" and "a `fetch` cannot happen".

### Task 20 — entitlements

`@sv/entitlements`, the $2.99 one-time purchase. Quarantined by a boundary rule that forbids any
package depending on it, so the scanner keeps working if the package is deleted outright. That rule
exists and is tested already.

No auto-updater, and no licence check that needs a server — both would undercut the product's only
promise.

### Tasks 21–24 — unassigned

See [Unassigned work](#unassigned-work).

## Unassigned work

Required by the brief, not currently pinned to a task number in the code. Each needs placing before
its stage starts.

| Work                                                                                               | Belongs in             |
| -------------------------------------------------------------------------------------------------- | ---------------------- |
| Accessibility: full keyboard navigation, screen-reader verification, reduced-motion, contrast      | Stage 4                |
| Settings and preference persistence, including apparent vs allocated size                          | Stage 3, after Task 10 |
| File operations: reveal in explorer, move to trash, with confirmation proportional to blast radius | Stage 4                |
| Scan history and comparison between two snapshots                                                  | Stage 3, after Task 10 |
| Internationalisation and locale-aware formatting beyond the current `en-US`                        | Stage 4                |
| Packaging, code signing and notarisation for three platforms                                       | Stage 5                |
| First-run onboarding and the permission prompts macOS requires for full disk access                | Stage 5                |
| Crash and error reporting that reports no filesystem information                                   | Stage 5                |
| Performance budgets enforced in CI rather than measured by hand                                    | Stage 5                |

## Immediate next steps

1. **Push to a remote and let CI run for the first time.** It has three-platform matrices for both
   jobs and has never executed. This is the cheapest remaining source of information about the
   project, and two platforms are entirely unverified.
2. **Decide the transferable-buffer question** (Task 9, item 1) or explicitly defer it. The Task 6
   finding is fresh and the design follows from it directly.
3. **Task 7**, platform hardening, which is the largest correctness gap and sits above performance
   in the priority order.
