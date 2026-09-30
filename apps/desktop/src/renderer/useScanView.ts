import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  NodeDetailResult,
  NodeRow,
  ScanProgressEvent,
  StatusSnapshot,
  VolumeSummary,
} from '../shared/protocol.ts';
import { CommandFailure, invoke, subscribe } from './bridge.ts';

/**
 * All of the renderer's state and every command it issues, in one place.
 *
 * Kept out of the components because the tricky parts are not visual. Navigation and scanning
 * happen concurrently: a person can drill into a folder while it is still being read, so the view
 * has to refresh itself as the scan progresses without losing where they are, and a slow response
 * for a folder they have already navigated away from must not overwrite the one they are looking at.
 */

/** Minimum gap between live refreshes while a scan is running. */
const LIVE_REFRESH_MS = 400;

/** One page is plenty for a treemap, which aggregates the tail anyway. */
const PAGE_SIZE = 500;

export interface ScanView {
  readonly volumes: readonly VolumeSummary[];
  readonly status: StatusSnapshot | null;
  readonly progress: ScanProgressEvent | null;
  readonly node: NodeDetailResult | null;
  readonly rows: readonly NodeRow[];
  readonly selectedId: number | null;
  readonly error: string | null;
  readonly busy: boolean;
  readonly scanning: boolean;
  readonly canGoUp: boolean;

  readonly startScan: (path: string) => Promise<void>;
  readonly chooseFolder: () => Promise<void>;
  readonly cancelScan: () => Promise<void>;
  readonly open: (nodeId: number) => void;
  readonly goUp: () => void;
  readonly select: (nodeId: number | null) => void;
  readonly dismissError: () => void;
}

function describeError(error: unknown): string {
  if (error instanceof CommandFailure) return error.message;
  return error instanceof Error ? error.message : 'Something went wrong';
}

export function useScanView(): ScanView {
  const [volumes, setVolumes] = useState<readonly VolumeSummary[]>([]);
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const [progress, setProgress] = useState<ScanProgressEvent | null>(null);
  const [nodeId, setNodeId] = useState(0);
  const [node, setNode] = useState<NodeDetailResult | null>(null);
  const [rows, setRows] = useState<readonly NodeRow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Guards against a stale response winning.
   *
   * Drilling twice quickly issues two pairs of requests; if the first pair resolves last, the user
   * would end up looking at the folder they left. Every load takes a ticket and only the newest one
   * is allowed to write.
   */
  const loadTicket = useRef(0);
  const lastLiveRefresh = useRef(0);

  const loadNode = useCallback(async (targetId: number): Promise<void> => {
    loadTicket.current += 1;
    const ticket = loadTicket.current;

    const [detail, page] = await Promise.all([
      invoke('queryNode', { nodeId: targetId }),
      invoke('queryChildren', {
        nodeId: targetId,
        sort: 'size',
        order: 'desc',
        offset: 0,
        limit: PAGE_SIZE,
      }),
    ]);

    if (ticket !== loadTicket.current) return;
    setNode(detail);
    setRows(page.rows);
  }, []);

  const refreshStatus = useCallback(async (): Promise<void> => {
    setStatus(await invoke('queryStatus', {}));
  }, []);

  // Initial load: drives and whatever scan may already be in memory from a previous window.
  useEffect(() => {
    void (async () => {
      try {
        const [volumeResult] = await Promise.all([
          invoke('listVolumes', {}),
          refreshStatus(),
          loadNode(0),
        ]);
        setVolumes(volumeResult.volumes);
      } catch (caught) {
        setError(describeError(caught));
      }
    })();
  }, [loadNode, refreshStatus]);

  // Whenever the location changes, load it.
  useEffect(() => {
    void loadNode(nodeId).catch((caught: unknown) => {
      setError(describeError(caught));
    });
  }, [loadNode, nodeId]);

  useEffect(() => {
    return subscribe((event) => {
      if (event.type === 'scanProgress') {
        setProgress(event.payload);

        // Ten refreshes a second would put a page of rows on the IPC channel for no visible gain.
        const now = Date.now();
        if (now - lastLiveRefresh.current < LIVE_REFRESH_MS) return;
        lastLiveRefresh.current = now;
        void loadNode(nodeId).catch(() => undefined);
        return;
      }

      setProgress(null);
      void refreshStatus().catch(() => undefined);
      void loadNode(nodeId).catch(() => undefined);
    });
  }, [loadNode, nodeId, refreshStatus]);

  const startScan = useCallback(
    async (path: string): Promise<void> => {
      setBusy(true);
      setError(null);
      setRows([]);
      setNode(null);
      setSelectedId(null);
      // A new scan means new node ids, so any previous location is meaningless.
      setNodeId(0);
      try {
        await invoke('startScan', { path });
        await refreshStatus();
      } catch (caught) {
        setError(describeError(caught));
      } finally {
        setBusy(false);
      }
    },
    [refreshStatus],
  );

  const chooseFolder = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const picked = await invoke('pickDirectory', {});
      if (picked.path !== null) await startScan(picked.path);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [startScan]);

  const cancelScan = useCallback(async (): Promise<void> => {
    const scanId = status?.scanId;
    if (scanId === null || scanId === undefined) return;
    try {
      await invoke('cancelScan', { scanId });
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [status?.scanId]);

  const open = useCallback((targetId: number): void => {
    setSelectedId(null);
    setNodeId(targetId);
  }, []);

  const goUp = useCallback((): void => {
    const parentId = node?.node.parentId;
    if (parentId === null || parentId === undefined) return;
    setSelectedId(null);
    setNodeId(parentId);
  }, [node?.node.parentId]);

  return {
    volumes,
    status,
    progress,
    node,
    rows,
    selectedId,
    error,
    busy,
    scanning: status?.phase === 'scanning',
    canGoUp: node?.node.parentId !== null && node?.node.parentId !== undefined,
    startScan,
    chooseFolder,
    cancelScan,
    open,
    goUp,
    select: setSelectedId,
    dismissError: () => {
      setError(null);
    },
  };
}
