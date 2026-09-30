/**
 * Bounded fan-out over an index range.
 *
 * The naive form of this — `await Promise.all(entries.map(stat))` — is explicitly wrong for
 * a filesystem scanner. A directory with two hundred thousand entries would issue two
 * hundred thousand concurrent syscalls, exhaust file descriptors, and hold every result in
 * memory at once.
 *
 * Instead a fixed number of workers share a cursor. Concurrency is capped by `limit` no
 * matter how large the directory is, and `Promise.all` here is over the *workers*, a small
 * constant, rather than over the work.
 */
export async function forEachWithLimit(
  count: number,
  limit: number,
  worker: (index: number) => Promise<void>,
): Promise<void> {
  if (count <= 0) return;

  const workerCount = Math.min(Math.max(1, limit), count);
  let cursor = 0;

  const runners: Promise<void>[] = [];
  for (let slot = 0; slot < workerCount; slot += 1) {
    runners.push(
      (async () => {
        for (;;) {
          const index = cursor;
          if (index >= count) return;
          cursor += 1;
          await worker(index);
        }
      })(),
    );
  }

  await Promise.all(runners);
}
