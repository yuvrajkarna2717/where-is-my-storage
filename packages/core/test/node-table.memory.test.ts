import { describe, expect, it } from 'vitest';
import { ROOT_ID } from '../src/model.ts';
import { NodeTable } from '../src/node-table.ts';

/**
 * Guards the memory budget that justifies the columnar design.
 *
 * These assertions read the store's own byte accounting rather than `process.memoryUsage`,
 * because heap measurements depend on when the garbage collector last ran and would make
 * CI flaky. The accounting is exact: it is computed from capacity multiplied by the
 * element widths actually allocated. `pnpm bench:core` reports real process memory
 * alongside these numbers so the two can be compared.
 */

/** Realistic name length; a 16-character name is about average on a real disk. */
function makeName(index: number): string {
  return `document-${String(index).padStart(6, '0')}`;
}

function buildTree(nodeTarget: number): NodeTable {
  const table = new NodeTable({ rootPath: 'C:\\bench' });
  const pending: number[] = [ROOT_ID];
  let created = 1;
  let counter = 0;

  while (created < nodeTarget && pending.length > 0) {
    const parent = pending.shift()!;
    const entries: { name: string; directory: boolean; size: number }[] = [];

    for (let index = 0; index < 12 && created + entries.length < nodeTarget; index += 1) {
      entries.push({ name: `${makeName(counter++)}.bin`, directory: false, size: counter * 37 });
    }
    for (let index = 0; index < 2 && created + entries.length < nodeTarget; index += 1) {
      entries.push({ name: makeName(counter++), directory: true, size: 0 });
    }

    const first = table.addChildren(parent, entries);
    entries.forEach((entry, index) => {
      if (entry.directory) pending.push(first + index);
    });
    created += entries.length;
  }

  return table;
}

describe('memory budget', () => {
  it('costs exactly 53 bytes of columns per node', () => {
    // parent 4 + childStart 4 + childCount 4 + nameOffset 4 + nameLength 2
    // + totalSize 8 + directSize 8 + fileCount 4 + dirCount 4 + mtimeMs 8
    // + depth 2 + flags 1
    const table = new NodeTable({ rootPath: '/' });
    const stats = table.stats();
    expect(stats.columnBytes / stats.capacity).toBe(53);
  });

  it('costs exactly 53 bytes plus the encoded name, and nothing else', () => {
    const table = buildTree(200_000);
    expect(table.count).toBe(200_000);

    table.compact();
    const stats = table.stats();

    expect(stats.columnBytes).toBe(200_000 * 53);
    // Names are the only other cost, and each is stored exactly once.
    expect(stats.nameBytes).toBe(stats.nameCapacity);

    // Pinning the relationship rather than a round number: the per-node cost is a
    // constant plus whatever the names happen to weigh, so a threshold would silently
    // encode an assumption about name length instead of testing the design.
    const expectedPerNode = 53 + stats.nameBytes / stats.nodeCount;
    expect(stats.bytesPerNode).toBeCloseTo(expectedPerNode, 6);

    // These fixtures use 15-19 character names, which is representative of a real disk.
    expect(stats.bytesPerNode).toBeLessThan(80);
  });

  it('bounds growth headroom instead of letting it scale with the tree', () => {
    // Doubling capacity forever would mean the final reallocation briefly holds ~2.5x
    // the steady-state footprint. Above the threshold, growth is additive.
    const table = buildTree(200_000);
    const beforeCompaction = table.stats();

    expect(beforeCompaction.capacity).toBeGreaterThanOrEqual(200_000);
    expect(beforeCompaction.bytesPerNode).toBeLessThan(100);
  });

  it('never stores a path, only names', () => {
    // Paths are reconstructed on demand. Storing them would dominate every other cost:
    // a deep path is hundreds of bytes and is mostly a copy of its parent's path.
    const table = new NodeTable({ rootPath: '/very/long/root/path/that/repeats' });
    let current = ROOT_ID;
    for (let depth = 0; depth < 50; depth += 1) {
      current = table.addChildren(current, [
        { name: `a-directory-with-a-long-name-${depth}`, directory: true, size: 0 },
      ]);
    }

    const stats = table.stats();
    const fullPathLength = table.pathOf(current).length;

    expect(fullPathLength).toBeGreaterThan(1_000);
    // 51 names of ~30 bytes is far less than 51 paths averaging ~500 bytes.
    expect(stats.nameBytes).toBeLessThan(fullPathLength * 2);
  });
});
