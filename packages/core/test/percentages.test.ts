import { describe, expect, it } from 'vitest';
import { formatPercent } from '../src/format.ts';
import { ROOT_ID } from '../src/model.ts';
import { NodeTable } from '../src/node-table.ts';
import { fractionOf, percentagesFor } from '../src/percentages.ts';

const GB = 1_000_000_000;
const TB = 1_000_000_000_000;

/**
 * The worked example from the product brief:
 *   C:\ capacity 1 TB, Users 380 GB, of which Yuvraj is 350 GB.
 */
function briefExample(): { table: NodeTable; users: number; yuvraj: number } {
  const table = new NodeTable({ rootPath: 'C:\\' });
  const top = table.addChildren(ROOT_ID, [
    { name: 'Users', directory: true, size: 0 },
    { name: 'Program Files', directory: true, size: 0 },
    { name: 'Windows', directory: true, size: 0 },
  ]);
  const users = top;
  const programFiles = top + 1;
  const windows = top + 2;

  const usersChildren = table.addChildren(users, [
    { name: 'Yuvraj', directory: true, size: 0 },
    { name: 'Public', directory: true, size: 0 },
  ]);
  const yuvraj = usersChildren;
  const publicDir = usersChildren + 1;

  table.addChildren(yuvraj, [{ name: 'profile.bin', directory: false, size: 350 * GB }]);
  table.addChildren(publicDir, [{ name: 'shared.bin', directory: false, size: 30 * GB }]);
  table.addChildren(programFiles, [{ name: 'apps.bin', directory: false, size: 165 * GB }]);
  table.addChildren(windows, [{ name: 'winsxs.bin', directory: false, size: 120 * GB }]);

  return { table, users, yuvraj };
}

describe('fractionOf', () => {
  it('returns 0 rather than NaN or Infinity for an empty denominator', () => {
    // A zero-size or not-yet-scanned parent must not leak NaN into layout arithmetic:
    // that produces invisible or infinitely large treemap tiles.
    expect(fractionOf(100, 0)).toBe(0);
    expect(fractionOf(0, 0)).toBe(0);
    expect(fractionOf(100, -5)).toBe(0);
    expect(fractionOf(Number.NaN, 100)).toBe(0);
    expect(fractionOf(100, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('divides normally otherwise', () => {
    expect(fractionOf(1, 4)).toBe(0.25);
  });
});

describe('percentagesFor', () => {
  it('reports the four framings separately for the brief example', () => {
    const { table, users, yuvraj } = briefExample();

    expect(table.totalSizeOf(users)).toBe(380 * GB);
    expect(table.totalSizeOf(yuvraj)).toBe(350 * GB);
    expect(table.totalSizeOf(ROOT_ID)).toBe(665 * GB);

    const percentages = percentagesFor(table, yuvraj, {
      viewId: users,
      volumeCapacityBytes: TB,
    });

    expect(percentages.ofParent).toBeCloseTo(350 / 380, 12);
    expect(percentages.ofCurrentView).toBeCloseTo(350 / 380, 12);
    expect(percentages.ofScanRoot).toBeCloseTo(350 / 665, 12);
    expect(percentages.ofVolumeCapacity).toBeCloseTo(0.35, 12);

    // The brief's own numbers, rendered.
    expect(formatPercent(percentages.ofParent, { locale: 'en-US' })).toBe('92.1%');
    expect(formatPercent(percentages.ofVolumeCapacity!, { locale: 'en-US' })).toBe('35%');
  });

  it('distinguishes "share of the view" from "share of the parent"', () => {
    // These two are equal only when the view happens to be the parent. Conflating them
    // is one of the easiest ways for a storage tool to mislead.
    const { table, users, yuvraj } = briefExample();

    const viewedFromRoot = percentagesFor(table, yuvraj, { viewId: ROOT_ID });
    expect(viewedFromRoot.ofParent).toBeCloseTo(350 / 380, 12);
    expect(viewedFromRoot.ofCurrentView).toBeCloseTo(350 / 665, 12);
    expect(viewedFromRoot.ofParent).not.toBeCloseTo(viewedFromRoot.ofCurrentView, 3);

    const viewedFromUsers = percentagesFor(table, yuvraj, { viewId: users });
    expect(viewedFromUsers.ofCurrentView).toBeCloseTo(viewedFromUsers.ofParent, 12);
  });

  it('treats the root as the whole of itself', () => {
    const { table } = briefExample();
    const percentages = percentagesFor(table, ROOT_ID, { volumeCapacityBytes: TB });

    // Reporting 0 here would read as "this accounts for nothing", the opposite of true.
    expect(percentages.ofParent).toBe(1);
    expect(percentages.ofCurrentView).toBe(1);
    expect(percentages.ofScanRoot).toBe(1);
    expect(percentages.ofVolumeCapacity).toBeCloseTo(0.665, 12);
  });

  it('reports the node itself as 100% of the current view', () => {
    const { table, users } = briefExample();
    expect(percentagesFor(table, users, { viewId: users }).ofCurrentView).toBe(1);
  });

  it('returns null capacity share when capacity is unknown', () => {
    const { table, yuvraj } = briefExample();
    expect(percentagesFor(table, yuvraj).ofVolumeCapacity).toBeNull();
    expect(
      percentagesFor(table, yuvraj, { volumeCapacityBytes: null }).ofVolumeCapacity,
    ).toBeNull();
    // A capacity of zero is unusable rather than unknown, so it degrades to 0.
    expect(percentagesFor(table, yuvraj, { volumeCapacityBytes: 0 }).ofVolumeCapacity).toBe(0);
  });

  it('handles zero-size directories and a wholly empty scan', () => {
    const table = new NodeTable({ rootPath: '/' });
    const empty = table.addChildren(ROOT_ID, [{ name: 'empty', directory: true, size: 0 }]);
    table.addChildren(empty, []);

    const percentages = percentagesFor(table, empty, { volumeCapacityBytes: TB });
    expect(percentages.ofParent).toBe(0);
    expect(percentages.ofCurrentView).toBe(0);
    expect(percentages.ofScanRoot).toBe(0);
    expect(percentages.ofVolumeCapacity).toBe(0);
  });

  it('gives a single child 100% of its parent', () => {
    const table = new NodeTable({ rootPath: '/' });
    const only = table.addChildren(ROOT_ID, [{ name: 'only.bin', directory: false, size: 42 }]);
    expect(percentagesFor(table, only).ofParent).toBe(1);
    expect(percentagesFor(table, only).ofScanRoot).toBe(1);
  });

  it('defaults the view to the scan root', () => {
    const { table, yuvraj } = briefExample();
    expect(percentagesFor(table, yuvraj).ofCurrentView).toBeCloseTo(
      percentagesFor(table, yuvraj, { viewId: ROOT_ID }).ofCurrentView,
      12,
    );
  });
});
