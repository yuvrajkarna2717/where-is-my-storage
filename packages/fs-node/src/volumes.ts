import { readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { VolumeInfo } from '@sv/scan-engine';
import { toPlatformPath } from './long-paths.ts';

/**
 * Volume discovery.
 *
 * Task 3 keeps this deliberately modest: enough to offer the user real, correct choices on
 * all three platforms using nothing but documented Node APIs. Volume *labels*, removable
 * and network classification, and mount-table parsing arrive in Task 7, where the
 * platform-specific work belongs. Nothing here shells out to another process or touches the
 * network.
 */

interface CapacityReading {
  totalBytes: number | null;
  freeBytes: number | null;
  usedBytes: number | null;
}

/**
 * Capacity for the filesystem containing `path`, via `statfs`.
 *
 * `bavail` rather than `bfree` is the free figure: `bfree` includes blocks reserved for
 * root that a normal user cannot actually use, so reporting it would overstate free space.
 * Used space is derived from `bfree` though, because that is what the filesystem really
 * holds.
 */
export async function readCapacity(path: string): Promise<CapacityReading> {
  try {
    const stats = await statfs(toPlatformPath(path));
    const blockSize = Number(stats.bsize);
    return {
      totalBytes: Number(stats.blocks) * blockSize,
      freeBytes: Number(stats.bavail) * blockSize,
      usedBytes: (Number(stats.blocks) - Number(stats.bfree)) * blockSize,
    };
  } catch {
    // Capacity is informational. A volume that cannot report it is still scannable, so
    // this must not be an error.
    return { totalBytes: null, freeBytes: null, usedBytes: null };
  }
}

async function isReadableDirectory(path: string): Promise<boolean> {
  try {
    const stats = await stat(toPlatformPath(path));
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function windowsVolumes(): Promise<VolumeInfo[]> {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

  // 26 independent probes, which is a fixed bound rather than a function of any input.
  const probes = await Promise.all(
    letters.map(async (letter) => {
      const rootPath = `${letter}:\\`;
      if (!(await isReadableDirectory(rootPath))) return null;
      const capacity = await readCapacity(rootPath);
      const volume: VolumeInfo = {
        id: `${letter}:`,
        label: `${letter}:\\`,
        rootPath,
        kind: 'unknown',
        ...capacity,
        readOnly: false,
        scannable: true,
      };
      return volume;
    }),
  );

  return probes.filter((volume): volume is VolumeInfo => volume !== null);
}

async function listMountedChildren(parent: string): Promise<string[]> {
  try {
    const entries = await readdir(toPlatformPath(parent), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(parent, entry.name));
  } catch {
    return [];
  }
}

async function posixVolumes(platform: string): Promise<VolumeInfo[]> {
  const volumes: VolumeInfo[] = [];

  const rootCapacity = await readCapacity('/');
  volumes.push({
    id: '/',
    label: platform === 'darwin' ? 'Macintosh HD' : 'Filesystem root',
    rootPath: '/',
    kind: 'fixed',
    ...rootCapacity,
    readOnly: false,
    scannable: true,
  });

  // /Volumes on macOS, /media and /mnt on Linux, are where additional filesystems appear.
  const mountParents = platform === 'darwin' ? ['/Volumes'] : ['/media', '/mnt'];
  for (const parent of mountParents) {
    for (const mountPath of await listMountedChildren(parent)) {
      const capacity = await readCapacity(mountPath);
      // On macOS the startup disk is also visible under /Volumes; a volume whose capacity
      // matches the root's is almost certainly that same filesystem, and listing it twice
      // would double-count it in the UI.
      const duplicatesRoot =
        capacity.totalBytes !== null && capacity.totalBytes === rootCapacity.totalBytes;

      volumes.push({
        id: mountPath,
        label: mountPath.slice(mountPath.lastIndexOf('/') + 1),
        rootPath: mountPath,
        kind: platform === 'darwin' ? 'removable' : 'unknown',
        ...capacity,
        readOnly: false,
        scannable: !duplicatesRoot,
        ...(duplicatesRoot ? { note: 'Appears to be the startup volume, already listed' } : {}),
      });
    }
  }

  return volumes;
}

/** Volumes the user could choose to scan on this machine. */
export async function listNodeVolumes(platform: string = process.platform): Promise<VolumeInfo[]> {
  return platform === 'win32' ? windowsVolumes() : posixVolumes(platform);
}
