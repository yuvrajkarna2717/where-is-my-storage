/**
 * Memory and throughput benchmark for the columnar store.
 *
 * Run with `pnpm bench:core`. This deliberately builds the same tree twice: once into the
 * columnar store and once as the nested object graph the brief originally suggested, so
 * the architectural claim rests on a measurement taken on this machine rather than on an
 * assertion. It also doubles as proof that Node executes the package source directly,
 * with no build step and no transpiler dependency.
 *
 * Measurement notes. Typed arrays are allocated outside the V8 object heap, so
 * `heapUsed` alone understates the columnar store to the point of reporting a negative
 * delta. Resident set size is the metric that counts both shapes fairly, and
 * `arrayBuffers` / `heapUsed` are reported alongside it to show where the bytes actually
 * live. The two builds are measured in sequence with the first structure released in
 * between, so neither measurement includes the other.
 */
import { NodeFlags, NodeTable, ROOT_ID, formatBytes, formatCount } from '../src/index.ts';

const NODE_TARGET = Number(process.env['SV_BENCH_NODES'] ?? 1_000_000);
const FILES_PER_DIRECTORY = 12;
const SUBDIRECTORIES_PER_DIRECTORY = 2;
const FIXED_MTIME = Date.UTC(2026, 8, 30);

interface ObjectNode {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size: number;
  totalSize: number;
  fileCount: number;
  directoryCount: number;
  parent: ObjectNode | null;
  children: ObjectNode[];
}

interface Sample {
  rss: number;
  heapUsed: number;
  arrayBuffers: number;
}

function makeName(index: number): string {
  return `document-${String(index).padStart(6, '0')}`;
}

function collectGarbage(): void {
  const maybeGc = (globalThis as { gc?: () => void }).gc;
  if (typeof maybeGc === 'function') {
    maybeGc();
    maybeGc();
    maybeGc();
  }
}

function sample(): Sample {
  collectGarbage();
  const usage = process.memoryUsage();
  return { rss: usage.rss, heapUsed: usage.heapUsed, arrayBuffers: usage.arrayBuffers };
}

function buildColumnar(target: number): { table: NodeTable; millis: number } {
  const started = performance.now();
  const table = new NodeTable({ rootPath: 'C:\\bench' });

  // An index cursor rather than Array.prototype.shift(). shift() is O(n) on a growing
  // array, which turns a breadth-first walk into O(n^2); the same trap applies to the
  // real scanner's directory frontier.
  const frontier: number[] = [ROOT_ID];
  let cursor = 0;
  let created = 1;
  let counter = 0;

  while (created < target && cursor < frontier.length) {
    const parent = frontier[cursor]!;
    cursor += 1;
    table.beginChildren(parent);

    for (let index = 0; index < FILES_PER_DIRECTORY && created < target; index += 1) {
      counter += 1;
      table.pushChild(`${makeName(counter)}.bin`, NodeFlags.None, counter * 37, FIXED_MTIME);
      created += 1;
    }
    for (let index = 0; index < SUBDIRECTORIES_PER_DIRECTORY && created < target; index += 1) {
      counter += 1;
      frontier.push(table.pushChild(makeName(counter), NodeFlags.Directory, 0, FIXED_MTIME));
      created += 1;
    }

    table.endChildren();
  }

  return { table, millis: performance.now() - started };
}

function buildObjectTree(target: number): { root: ObjectNode; millis: number } {
  const started = performance.now();
  const root: ObjectNode = {
    name: 'bench',
    path: 'C:\\bench',
    type: 'directory',
    size: 0,
    totalSize: 0,
    fileCount: 0,
    directoryCount: 0,
    parent: null,
    children: [],
  };

  const frontier: ObjectNode[] = [root];
  let cursor = 0;
  let created = 1;
  let counter = 0;

  while (created < target && cursor < frontier.length) {
    const parent = frontier[cursor]!;
    cursor += 1;

    for (let index = 0; index < FILES_PER_DIRECTORY && created < target; index += 1) {
      counter += 1;
      const name = `${makeName(counter)}.bin`;
      const size = counter * 37;
      const child: ObjectNode = {
        name,
        // The naive shape typically stores a full path per node, which is the single
        // largest avoidable cost and most of why this comparison is lopsided.
        path: `${parent.path}\\${name}`,
        type: 'file',
        size,
        totalSize: size,
        fileCount: 0,
        directoryCount: 0,
        parent,
        children: [],
      };
      parent.children.push(child);
      for (let node: ObjectNode | null = parent; node !== null; node = node.parent) {
        node.totalSize += size;
        node.fileCount += 1;
      }
      created += 1;
    }

    for (let index = 0; index < SUBDIRECTORIES_PER_DIRECTORY && created < target; index += 1) {
      counter += 1;
      const name = makeName(counter);
      const child: ObjectNode = {
        name,
        path: `${parent.path}\\${name}`,
        type: 'directory',
        size: 0,
        totalSize: 0,
        fileCount: 0,
        directoryCount: 0,
        parent,
        children: [],
      };
      parent.children.push(child);
      for (let node: ObjectNode | null = parent; node !== null; node = node.parent) {
        node.directoryCount += 1;
      }
      frontier.push(child);
      created += 1;
    }
  }

  return { root, millis: performance.now() - started };
}

const bytes = (value: number): string => formatBytes(value, { locale: 'en-US' });
const count = (value: number): string => formatCount(value, 'en-US');

function row(label: string, value: string): void {
  console.log(`  ${label.padEnd(30)} ${value}`);
}

console.log(`\nColumnar store benchmark — target ${count(NODE_TARGET)} nodes`);
if (typeof (globalThis as { gc?: () => void }).gc !== 'function') {
  console.log('  (run with --expose-gc for reliable memory numbers)');
}

// ---------------------------------------------------------------- columnar measurement

const columnarBefore = sample();

// Scoped so the only surviving reference to the table is `columnarTable`, which is
// released before the object tree is measured.
let columnarTable: NodeTable | null;
let columnarMillis: number;
{
  const result = buildColumnar(NODE_TARGET);
  columnarTable = result.table;
  columnarMillis = result.millis;
}

const beforeCompaction = columnarTable.stats();
columnarTable.compact();
const columnarStats = columnarTable.stats();
const columnarAfter = sample();

const samplePath = columnarTable.pathOf(columnarTable.count - 1);
const columnarTotal = columnarStats.totalSize;
const columnarRss = columnarAfter.rss - columnarBefore.rss;
const columnarBuffers = columnarAfter.arrayBuffers - columnarBefore.arrayBuffers;
const columnarHeap = columnarAfter.heapUsed - columnarBefore.heapUsed;

console.log('\nColumnar NodeTable');
row('nodes', count(columnarStats.nodeCount));
row('files', count(columnarStats.fileCount));
row('directories', count(columnarStats.directoryCount));
row('aggregate size', bytes(columnarStats.totalSize));
row('build time', `${columnarMillis.toFixed(0)} ms`);
row(
  'throughput',
  `${count(Math.round(columnarStats.nodeCount / (columnarMillis / 1000)))} nodes/s`,
);
row('columns (accounted)', bytes(columnarStats.columnBytes));
row('names (accounted)', bytes(columnarStats.nameBytes));
row('bytes/node (accounted)', columnarStats.bytesPerNode.toFixed(1));
row('bytes/node before compact', beforeCompaction.bytesPerNode.toFixed(1));
row('rss delta (measured)', bytes(columnarRss));
row('  of which arrayBuffers', bytes(columnarBuffers));
row('  of which object heap', bytes(columnarHeap));
row('bytes/node (measured rss)', (columnarRss / columnarStats.nodeCount).toFixed(1));
row('sample deepest path', `${samplePath.slice(0, 58)}${samplePath.length > 58 ? '…' : ''}`);

// Dropping the reference is the entire point: the object-tree measurement must not include
// the columnar store's 86 MB. The assignment is "useless" only to a reader who ignores the
// garbage collector.
// eslint-disable-next-line no-useless-assignment
columnarTable = null;
collectGarbage();

// ------------------------------------------------------------- object tree measurement

const objectBefore = sample();
const objectBuild = buildObjectTree(NODE_TARGET);
const objectAfter = sample();

const objectRss = objectAfter.rss - objectBefore.rss;
const objectHeap = objectAfter.heapUsed - objectBefore.heapUsed;

console.log('\nNested object tree (the shape the brief suggested)');
row('build time', `${objectBuild.millis.toFixed(0)} ms`);
row('aggregate size', bytes(objectBuild.root.totalSize));
row('rss delta (measured)', bytes(objectRss));
row('  of which object heap', bytes(objectHeap));
row('bytes/node (measured rss)', (objectRss / NODE_TARGET).toFixed(1));

console.log('\nComparison');
row('memory ratio', `${(objectRss / Math.max(columnarRss, 1)).toFixed(1)}x for objects`);
row('totals agree', String(objectBuild.root.totalSize === columnarTotal));
console.log('');
