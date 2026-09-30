import { describe, expect, it } from 'vitest';
import { ROOT_ID } from '../src/model.ts';
import { NodeTable } from '../src/node-table.ts';
import {
  createRandom,
  generateTree,
  loadIntoTable,
  referenceTotals,
  type ReferenceNode,
  type TreeShape,
} from './helpers/random-tree.ts';

/**
 * Property-style checks: the columnar store's incremental aggregation must agree exactly
 * with a naive recursive sum over the same tree, for every node, on every shape.
 *
 * This is the backbone correctness test for the whole product. The store aggregates
 * during traversal by bubbling per-directory deltas up the ancestor chain, which is fast
 * but is not obviously equivalent to "recursively add everything up". These tests are
 * what make that equivalence something we know rather than something we hope.
 */

function assertMatchesReference(table: NodeTable, root: ReferenceNode): void {
  const ids = loadIntoTable(table, root);

  for (const [node, id] of ids) {
    const expected = referenceTotals(node);
    const where = `${node.directory ? 'dir' : 'file'} "${node.name}" (id ${id})`;

    expect(table.totalSizeOf(id), `totalSize of ${where}`).toBe(expected.totalSize);
    expect(table.directSizeOf(id), `directSize of ${where}`).toBe(expected.directSize);
    expect(table.fileCountOf(id), `fileCount of ${where}`).toBe(expected.fileCount);
    expect(table.directoryCountOf(id), `directoryCount of ${where}`).toBe(expected.directoryCount);
  }

  // Parent/child wiring must be consistent with the reference structure too, otherwise
  // matching totals could hide a mis-parented subtree.
  for (const [node, id] of ids) {
    const range = table.childRange(id);
    if (!node.directory) {
      expect(range.count, `file ${node.name} must have no children`).toBe(0);
      continue;
    }
    expect(range.count, `child count of ${node.name}`).toBe(node.children.length);
    node.children.forEach((child, index) => {
      const childId = ids.get(child)!;
      expect(childId).toBe(range.start + index);
      expect(table.parentOf(childId)).toBe(id);
      expect(table.nameOf(childId)).toBe(child.name);
      expect(table.depthOf(childId)).toBe(table.depthOf(id) + 1);
    });
  }
}

const shapes: { label: string; shape: TreeShape }[] = [
  {
    label: 'wide and shallow',
    shape: { maxDepth: 2, maxFanout: 30, directoryChance: 0.2 },
  },
  {
    label: 'narrow and deep',
    shape: { maxDepth: 12, maxFanout: 3, directoryChance: 0.7 },
  },
  {
    label: 'mostly directories',
    shape: { maxDepth: 6, maxFanout: 6, directoryChance: 0.9 },
  },
  {
    label: 'mostly files',
    shape: { maxDepth: 5, maxFanout: 12, directoryChance: 0.1 },
  },
  {
    label: 'awkward Unicode names',
    shape: { maxDepth: 5, maxFanout: 8, directoryChance: 0.4, awkwardNames: true },
  },
];

describe('aggregation matches a naive reference implementation', () => {
  for (const { label, shape } of shapes) {
    it(`agrees on ${label} trees across 25 seeds`, () => {
      for (let seed = 1; seed <= 25; seed += 1) {
        const random = createRandom(seed * 7919);
        const root = generateTree(random, shape);
        const table = new NodeTable({ rootPath: '/scan', initialCapacity: 16 });
        assertMatchesReference(table, root);
      }
    });
  }

  it('agrees on an empty root', () => {
    const table = new NodeTable({ rootPath: '/scan' });
    assertMatchesReference(table, { name: 'root', directory: true, size: 0, children: [] });
  });

  it('agrees on a tree of empty directories with no files anywhere', () => {
    const root: ReferenceNode = {
      name: 'root',
      directory: true,
      size: 0,
      children: [
        { name: 'a', directory: true, size: 0, children: [] },
        {
          name: 'b',
          directory: true,
          size: 0,
          children: [{ name: 'b1', directory: true, size: 0, children: [] }],
        },
      ],
    };
    const table = new NodeTable({ rootPath: '/scan' });
    assertMatchesReference(table, root);
    expect(table.totalSizeOf(ROOT_ID)).toBe(0);
    expect(table.directoryCountOf(ROOT_ID)).toBe(3);
    expect(table.fileCountOf(ROOT_ID)).toBe(0);
  });

  it('agrees on zero-byte files, which must still be counted', () => {
    const root: ReferenceNode = {
      name: 'root',
      directory: true,
      size: 0,
      children: [
        { name: 'empty-a', directory: false, size: 0, children: [] },
        { name: 'empty-b', directory: false, size: 0, children: [] },
      ],
    };
    const table = new NodeTable({ rootPath: '/scan' });
    assertMatchesReference(table, root);
    expect(table.totalSizeOf(ROOT_ID)).toBe(0);
    expect(table.fileCountOf(ROOT_ID)).toBe(2);
  });

  it('keeps byte sums exact at multi-terabyte scale', () => {
    // Sizes are held in Float64, which represents integers exactly up to 2^53 bytes
    // (9 PB). This checks the arithmetic does not drift at realistic drive sizes.
    const table = new NodeTable({ rootPath: 'D:\\' });
    const oddTerabyte = 1_099_511_627_777; // 2^40 + 1
    const dirs = table.addChildren(
      ROOT_ID,
      Array.from({ length: 8 }, (_unused, index) => ({
        name: `vol-${index}`,
        directory: true,
        size: 0,
      })),
    );
    for (let index = 0; index < 8; index += 1) {
      table.addChildren(dirs + index, [{ name: 'blob.bin', directory: false, size: oddTerabyte }]);
    }

    expect(table.totalSizeOf(ROOT_ID)).toBe(oddTerabyte * 8);
    expect(Number.isSafeInteger(table.totalSizeOf(ROOT_ID))).toBe(true);
  });
});
