import Table from 'cli-table3';
import type { Io } from './io.js';

/**
 * Table rendering.
 *
 * cli-table3 is used specifically because it measures column widths with
 * `string-width`, which is ANSI- and East-Asian-width aware. That matters here:
 * cells contain the ₹ symbol and colour escapes for P&L, and a naive width
 * calculation misaligns every column below the first coloured row.
 */

export interface Column<T> {
  header: string;
  /** Rendered cell content. Colour is allowed; widths account for it. */
  value: (row: T, io: Io) => string;
  align?: 'left' | 'right' | 'center';
}

export interface TableOptions {
  /** Omit borders and padding for a denser view. */
  compact?: boolean;
  /** Shown instead of the table when there are no rows. */
  empty?: string;
}

export function renderTable<T>(
  io: Io,
  rows: readonly T[],
  columns: Array<Column<T>>,
  opts: TableOptions = {},
): string {
  if (rows.length === 0) {
    return io.dim(opts.empty ?? 'Nothing to show.');
  }

  const table = new Table({
    head: columns.map((column) => io.bold(column.header)),
    colAligns: columns.map((column) => column.align ?? 'left'),
    style: {
      head: [],
      border: [],
      compact: opts.compact ?? false,
      'padding-left': 1,
      'padding-right': 1,
    },
    chars: opts.compact ? COMPACT_CHARS : ROUNDED_CHARS,
  });

  for (const row of rows) {
    table.push(columns.map((column) => column.value(row, io)));
  }

  return table.toString();
}

/** Print a table, or the equivalent JSON when --json is active. */
export function printTable<T>(
  io: Io,
  rows: readonly T[],
  columns: Array<Column<T>>,
  jsonValue: unknown,
  opts: TableOptions = {},
): void {
  if (io.json) {
    io.writeJson(jsonValue);
    return;
  }
  io.line(renderTable(io, rows, columns, opts));
}

const ROUNDED_CHARS = {
  top: '─',
  'top-mid': '┬',
  'top-left': '╭',
  'top-right': '╮',
  bottom: '─',
  'bottom-mid': '┴',
  'bottom-left': '╰',
  'bottom-right': '╯',
  left: '│',
  'left-mid': '├',
  mid: '─',
  'mid-mid': '┼',
  right: '│',
  'right-mid': '┤',
  middle: '│',
} as const;

const COMPACT_CHARS = {
  top: '',
  'top-mid': '',
  'top-left': '',
  'top-right': '',
  bottom: '',
  'bottom-mid': '',
  'bottom-left': '',
  'bottom-right': '',
  left: '',
  'left-mid': '',
  mid: '',
  'mid-mid': '',
  right: '',
  'right-mid': '',
  middle: '  ',
} as const;

/** A borderless key/value block, for detail views. */
export function renderKeyValue(io: Io, entries: Array<[string, string]>): string {
  const width = Math.max(...entries.map(([key]) => key.length));
  return entries
    .map(([key, value]) => `  ${io.dim(key.padEnd(width))}  ${value}`)
    .join('\n');
}

/** A section heading. */
export function heading(io: Io, text: string): string {
  return `\n${io.bold(text)}`;
}
