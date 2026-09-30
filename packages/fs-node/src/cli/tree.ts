import {
  ROOT_ID,
  formatBytes,
  formatPercent,
  fractionOf,
  type NodeId,
  type NodeTable,
} from '@sv/core';

/**
 * Renders a scanned tree as indented text with proportional bars.
 *
 * The flat "largest things at the top level" list answers *what* is big; this answers *where*,
 * which is the question that actually leads somewhere. It is the same shape as the treemap, drawn
 * with box characters, and it is the whole product in a terminal.
 *
 * Returns lines rather than printing them, so the layout decisions — which branches are worth
 * expanding, how the tail is summarised, how names are truncated — are testable without capturing
 * stdout.
 */

export interface TreeOptions {
  /** Levels below the root to expand. */
  readonly maxDepth?: number;
  /** Children shown per directory before the rest are summarised. */
  readonly maxChildren?: number;
  /**
   * Hide entries below this share of the scan root.
   *
   * Without a floor, a deep tree is mostly noise: the point of the view is the handful of places
   * where the space actually went.
   */
  readonly minShare?: number;
  readonly totalWidth?: number;
  readonly barWidth?: number;
}

const DEFAULTS = {
  maxDepth: 3,
  maxChildren: 6,
  minShare: 0.005,
  totalWidth: 100,
  barWidth: 18,
} as const;

/** Eighth-width blocks, so a bar can show a fraction of a character rather than jumping. */
const PARTIAL_BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

export function renderBar(fraction: number, width: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0 || width <= 0) return '';
  const eighths = Math.round(Math.min(fraction, 1) * width * 8);
  const full = Math.floor(eighths / 8);
  const remainder = eighths % 8;
  // A non-zero share always shows something, even if it rounds below one eighth.
  const bar = '█'.repeat(full) + PARTIAL_BLOCKS[remainder]!;
  return bar.length === 0 ? '▏' : bar;
}

/** Shortens from the middle, keeping the start and the extension visible. */
function fit(text: string, width: number): string {
  if (width <= 1) return '';
  if (text.length <= width) return text;
  const head = Math.ceil((width - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (width - 1 - head))}`;
}

export function renderTree(table: NodeTable, options: TreeOptions = {}): string[] {
  const maxDepth = options.maxDepth ?? DEFAULTS.maxDepth;
  const maxChildren = options.maxChildren ?? DEFAULTS.maxChildren;
  const minShare = options.minShare ?? DEFAULTS.minShare;
  const totalWidth = options.totalWidth ?? DEFAULTS.totalWidth;
  const barWidth = options.barWidth ?? DEFAULTS.barWidth;

  const rootTotal = table.totalSizeOf(ROOT_ID);
  // size (10) + gap + percent (6) + gap + bar + gaps
  const nameWidth = Math.max(16, totalWidth - barWidth - 22);

  const line = (prefix: string, name: string, bytes: number, directory: boolean): string => {
    const share = fractionOf(bytes, rootTotal);
    const label = fit(`${prefix}${name}${directory ? table.separator : ''}`, nameWidth);
    return (
      `${label.padEnd(nameWidth)} ${formatBytes(bytes).padStart(10)} ` +
      `${formatPercent(share).padStart(6)}  ${renderBar(share, barWidth)}`
    );
  };

  const lines: string[] = [line('', table.rootPath, rootTotal, false)];

  /**
   * Walked with an explicit stack, like the scanner itself. A real tree can be thousands of levels
   * deep, and this is a debugging tool that must not fall over on exactly the filesystem that
   * needed debugging.
   */
  type Frame =
    | {
        readonly kind: 'node';
        readonly id: NodeId;
        readonly depth: number;
        /** Box-drawing prefix inherited from ancestors. */
        readonly prefix: string;
        readonly isLast: boolean;
      }
    | {
        /**
         * Emitted after a directory's visible children, summarising the rest. It is a stack frame
         * rather than a line written up front precisely so it lands *below* the siblings it stands
         * in for: pushed first, so it pops last.
         */
        readonly kind: 'summary';
        readonly prefix: string;
        readonly count: number;
        readonly bytes: number;
      };

  const stack: Frame[] = [];

  const pushChildren = (parent: NodeId, depth: number, prefix: string): void => {
    if (depth > maxDepth) return;

    const ordered = table.sortedChildIds(parent, { by: 'size', order: 'desc' });
    const visible: NodeId[] = [];
    let hiddenBytes = 0;
    let hiddenCount = 0;

    for (const id of ordered) {
      const bytes = table.totalSizeOf(id);
      if (visible.length < maxChildren && fractionOf(bytes, rootTotal) >= minShare) {
        visible.push(id);
      } else {
        hiddenBytes += bytes;
        hiddenCount += 1;
      }
    }

    // Summarised rather than dropped: a reader must be able to tell that the visible rows do not
    // account for everything.
    if (hiddenCount > 0) {
      stack.push({ kind: 'summary', prefix, count: hiddenCount, bytes: hiddenBytes });
    }

    // Reversed, because a stack pops in reverse and the largest should print first.
    for (let index = visible.length - 1; index >= 0; index -= 1) {
      stack.push({
        kind: 'node',
        id: visible[index]!,
        depth,
        prefix,
        isLast: index === visible.length - 1 && hiddenCount === 0,
      });
    }
  };

  pushChildren(ROOT_ID, 1, '');

  while (stack.length > 0) {
    const frame = stack.pop()!;

    if (frame.kind === 'summary') {
      lines.push(line(`${frame.prefix}└─ `, `… and ${frame.count} smaller`, frame.bytes, false));
      continue;
    }

    const connector = frame.isLast ? '└─ ' : '├─ ';
    lines.push(
      line(
        frame.prefix + connector,
        table.nameOf(frame.id),
        table.totalSizeOf(frame.id),
        table.isDirectory(frame.id),
      ),
    );

    if (table.isDirectory(frame.id) && table.childRange(frame.id).count > 0) {
      pushChildren(frame.id, frame.depth + 1, frame.prefix + (frame.isLast ? '   ' : '│  '));
    }
  }

  return lines;
}
