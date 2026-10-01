/**
 * A worker entry that dies the moment it is given work.
 *
 * Used to prove that a crashed worker costs one directory rather than the whole scan. A real crash
 * is hard to provoke on demand — the worker body only ever calls `readdir` and `lstat` — so the
 * failure is staged here instead, at exactly the point where it hurts most: after the pool has
 * handed over a request and is waiting for the reply.
 */
import { parentPort } from 'node:worker_threads';

parentPort?.on('message', () => {
  process.exit(7);
});
