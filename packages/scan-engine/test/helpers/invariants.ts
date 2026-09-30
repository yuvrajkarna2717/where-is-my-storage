import { NO_NODE, NodeFlags, ROOT_ID, hasFlag, type NodeTable } from '@sv/core';
import { expect } from 'vitest';

/**
 * Re-derives every aggregate from the tree structure and checks it against what the store
 * recorded.
 *
 * The scanner aggregates incrementally, bubbling each directory's delta up the ancestor
 * chain as the walk proceeds. That is fast, but it means a total can be wrong in ways a
 * simple "did the scan finish" assertion would never notice. Recomputing bottom-up catches
 * exactly those mistakes, and it holds for a cancelled scan too: a half-finished tree still
 * has to add up.
 */
export function assertTableInvariants(table: NodeTable): void {
  const recomputedTotal = new Float64Array(table.count);
  const recomputedFiles = new Uint32Array(table.count);
  const recomputedDirectories = new Uint32Array(table.count);

  // Children always have a higher index than their parent, because a listing is appended
  // after the directory that produced it. Walking backwards therefore visits every child
  // before its parent, with no recursion and no explicit ordering pass.
  for (let id = table.count - 1; id >= 0; id -= 1) {
    if (!table.isDirectory(id)) {
      expect(table.childRange(id).count, `file ${id} must report no children`).toBe(0);
      expect(table.directSizeOf(id), `file ${id} must have no direct size`).toBe(0);
      recomputedTotal[id] = table.totalSizeOf(id);
      continue;
    }

    const { start, count } = table.childRange(id);

    if (count <= 0) {
      // Either never listed, or listed and genuinely empty. Both mean zero contents.
      expect(table.totalSizeOf(id), `empty/unlisted directory ${id} must total zero`).toBe(0);
      expect(table.fileCountOf(id)).toBe(0);
      expect(table.directoryCountOf(id)).toBe(0);
      continue;
    }

    let directSize = 0;
    let total = 0;
    let files = 0;
    let directories = 0;

    for (let child = start; child < start + count; child += 1) {
      expect(table.parentOf(child), `child ${child} must point back at ${id}`).toBe(id);
      expect(table.depthOf(child), `depth of ${child}`).toBe(table.depthOf(id) + 1);

      total += recomputedTotal[child]!;
      if (table.isDirectory(child)) {
        directories += 1 + recomputedDirectories[child]!;
        files += recomputedFiles[child]!;
      } else {
        directSize += table.totalSizeOf(child);
        files += 1;
      }
    }

    recomputedTotal[id] = total;
    recomputedFiles[id] = files;
    recomputedDirectories[id] = directories;

    expect(table.totalSizeOf(id), `totalSize of ${table.pathOf(id)}`).toBe(total);
    expect(table.directSizeOf(id), `directSize of ${table.pathOf(id)}`).toBe(directSize);
    expect(table.fileCountOf(id), `fileCount of ${table.pathOf(id)}`).toBe(files);
    expect(table.directoryCountOf(id), `directoryCount of ${table.pathOf(id)}`).toBe(directories);
  }

  // Structural sanity: the root is the only node without a parent, and every node reaches it.
  expect(table.parentOf(ROOT_ID)).toBe(NO_NODE);
  for (let id = 1; id < table.count; id += 1) {
    expect(table.parentOf(id)).toBeGreaterThanOrEqual(0);
    expect(table.parentOf(id)).toBeLessThan(id);
  }

  // A partial flag must never stop partway up the tree: if a total is a lower bound, every
  // total that contains it is a lower bound too.
  for (let id = 0; id < table.count; id += 1) {
    if (!hasFlag(table.flagsOf(id), NodeFlags.Partial)) continue;
    const parent = table.parentOf(id);
    if (parent === NO_NODE) continue;
    expect(
      hasFlag(table.flagsOf(parent), NodeFlags.Partial),
      `partial flag on ${table.pathOf(id)} must propagate to its parent`,
    ).toBe(true);
  }
}
