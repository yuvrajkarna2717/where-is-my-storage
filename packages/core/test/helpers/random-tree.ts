// A package's own tests import its source relatively: pnpm only links a package into
// node_modules when something declares it as a dependency, and @sv/core does not depend
// on itself.
import type { NodeId } from '../../src/model.ts';
import type { NodeTable } from '../../src/node-table.ts';

/**
 * Deterministic random trees plus a naive reference implementation, used to check the
 * columnar store's aggregation against an obviously-correct recursive one.
 *
 * Hand-rolled rather than pulling in a property-testing library: a seeded generator and
 * a recursive sum are about forty lines, and the dependency budget for this product is
 * tight enough that forty lines wins.
 */

/** mulberry32: small, fast, and reproducible across platforms and Node versions. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ReferenceNode {
  name: string;
  directory: boolean;
  /** Apparent size for files; always 0 for directories. */
  size: number;
  children: ReferenceNode[];
}

export interface ReferenceTotals {
  totalSize: number;
  directSize: number;
  fileCount: number;
  directoryCount: number;
}

/** The obviously-correct implementation the store is compared against. */
export function referenceTotals(node: ReferenceNode): ReferenceTotals {
  if (!node.directory) {
    return { totalSize: node.size, directSize: 0, fileCount: 0, directoryCount: 0 };
  }

  let totalSize = 0;
  let directSize = 0;
  let fileCount = 0;
  let directoryCount = 0;

  for (const child of node.children) {
    const childTotals = referenceTotals(child);
    totalSize += childTotals.totalSize;
    if (child.directory) {
      directoryCount += 1;
      directoryCount += childTotals.directoryCount;
      fileCount += childTotals.fileCount;
    } else {
      fileCount += 1;
      directSize += child.size;
    }
  }

  return { totalSize, directSize, fileCount, directoryCount };
}

export interface TreeShape {
  readonly maxDepth: number;
  readonly maxFanout: number;
  /** Probability that a generated entry is a directory. */
  readonly directoryChance: number;
  /** Include names that exercise Unicode, spaces and surrogate pairs. */
  readonly awkwardNames?: boolean;
}

const AWKWARD_NAMES = [
  'café', // NFC
  'cafe\u0301', // NFD: same grapheme, different bytes
  'файл',
  '日本語のファイル',
  'emoji 🎬 clip',
  'two  spaces',
  'trailing space ',
  "quote'name",
  'Ω±≈ß',
];

export function generateTree(random: () => number, shape: TreeShape, depth = 0): ReferenceNode {
  const fanout = depth >= shape.maxDepth ? 0 : Math.floor(random() * (shape.maxFanout + 1));
  const children: ReferenceNode[] = [];

  for (let index = 0; index < fanout; index += 1) {
    const isDirectory = depth < shape.maxDepth && random() < shape.directoryChance;
    const awkward = shape.awkwardNames === true && random() < 0.25;
    const name = awkward
      ? `${AWKWARD_NAMES[Math.floor(random() * AWKWARD_NAMES.length)]!}-${index}`
      : `${isDirectory ? 'dir' : 'file'}-${depth}-${index}`;

    if (isDirectory) {
      const child = generateTree(random, shape, depth + 1);
      child.name = name;
      child.directory = true;
      child.size = 0;
      children.push(child);
    } else {
      // A long tail of small files with occasional large ones, which is what real
      // filesystems look like and what the treemap has to cope with.
      const size =
        random() < 0.05 ? Math.floor(random() * 5_000_000_000) : Math.floor(random() * 4096);
      children.push({ name, directory: false, size, children: [] });
    }
  }

  return { name: 'root', directory: true, size: 0, children };
}

/**
 * Loads a reference tree into a NodeTable one directory listing at a time, which is
 * exactly how the scanner feeds it, and returns the id assigned to every node.
 */
export function loadIntoTable(table: NodeTable, root: ReferenceNode): Map<ReferenceNode, NodeId> {
  const ids = new Map<ReferenceNode, NodeId>();
  ids.set(root, 0);

  const pending: ReferenceNode[] = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    const parentId = ids.get(node)!;

    const firstChild = table.addChildren(
      parentId,
      node.children.map((child) => ({
        name: child.name,
        directory: child.directory,
        size: child.size,
      })),
    );

    node.children.forEach((child, index) => {
      const childId = firstChild + index;
      ids.set(child, childId);
      if (child.directory) pending.push(child);
    });
  }

  return ids;
}
