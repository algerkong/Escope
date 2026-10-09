/**
 * Read-only document grid: layout state and exact local-sorting helpers.
 *
 * Everything here is pure and framework-free. Sorting never touches the cluster: it re-orders only
 * the documents already received, and numeric order is computed on the verbatim decimal token
 * (sign, digits, decimal exponent) so values beyond `Number.MAX_SAFE_INTEGER`, long decimals and
 * exponents compare exactly without `Number`/`parseFloat` rounding.
 */
import type { ResultColumn, ResultHit } from './query-result';

/** One loaded document, tagged with the page it was received in and its position inside that page. */
export type ResultGridRow = {
  readonly hit: ResultHit;
  readonly pageIndex: number;
  readonly position: number;
};

/** A full grid value, taken from the lossless `ResultColumn.value`. Missing data reads as `null`. */
export interface GridCellValue {
  readonly kind: ResultColumn['value']['kind'];
  readonly text: string;
}

export const NULL_GRID_VALUE: GridCellValue = { kind: 'null', text: '' };

export interface ResultGridSort {
  id: string;
  desc: boolean;
}

/** External grid state, one instance per query/preview, owned by the caller. */
export interface ResultGridState {
  columnOrder: string[];
  columnSizing: Record<string, number>;
  columnVisibility: Record<string, boolean>;
  sorting: ResultGridSort[];
  pageIndex: number;
  rowSelection: Record<string, true>;
}

export const INITIAL_RESULT_GRID_STATE: ResultGridState = {
  columnOrder: [],
  columnSizing: {},
  columnVisibility: {},
  sorting: [],
  pageIndex: 0,
  rowSelection: {},
};

export const ROW_COLUMN_ID = 'meta:row';
export const INDEX_COLUMN_ID = 'meta:index';
export const ID_COLUMN_ID = 'meta:id';
export const FIELD_COLUMN_PREFIX = 'field:';

/** Locked columns stay first: they cannot be dragged, moved in the chooser or hidden. */
export const LOCKED_COLUMN_IDS: readonly string[] = [ROW_COLUMN_ID];

export const RESULT_GRID_PAGE_SIZE = 50;
export const MIN_COLUMN_WIDTH = 64;
export const MAX_COLUMN_WIDTH = 480;
export const ROW_COLUMN_WIDTH = 52;
/** Bound for both the default-width sample and per-field sortability probing. */
export const WIDTH_SAMPLE_ROWS = 50;

export function fieldColumnId(name: string): string {
  return `${FIELD_COLUMN_PREFIX}${name}`;
}

export function fieldNameOfColumnId(columnId: string): string | null {
  return columnId.startsWith(FIELD_COLUMN_PREFIX) ? columnId.slice(FIELD_COLUMN_PREFIX.length) : null;
}

/** The lossless value of one field in one row; a field missing from this hit reads as `null`. */
export function sortValueOf(row: ResultGridRow, field: string): GridCellValue {
  const column = row.hit.columns.find((entry) => entry.name === field);
  return column ? column.value : NULL_GRID_VALUE;
}

/**
 * Mixed-kind order is explicit and stable: numbers, then strings, then booleans (`false` first),
 * then null/missing, then nested objects and arrays compared by their compact text. Ties keep the
 * received row order because the sorted row model falls back to the original row index.
 */
const KIND_RANK: Record<GridCellValue['kind'], number> = {
  number: 0, string: 1, boolean: 2, null: 3, object: 4, array: 5,
};

export function compareGridValues(a: GridCellValue, b: GridCellValue): number {
  const rank = KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (rank !== 0) return rank < 0 ? -1 : 1;
  if (a.kind === 'null') return 0;
  if (a.kind === 'number') return compareDecimalText(a.text, b.text);
  return compareText(a.text, b.text);
}

/** Deterministic UTF-16 code-unit order; no locale data and no ICU version can change it. */
function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

interface DecimalParts {
  /** -1, 0 (exact zero) or 1. */
  readonly sign: -1 | 0 | 1;
  /** Significant integer digits without leading zeros; `'0'` for zero. */
  readonly digits: string;
  /** Power of ten applied to `digits`; `BigInt` so huge exponents never become a float. */
  readonly exponent: bigint;
}

const DECIMAL_TOKEN = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/** Parses a JSON number token without ever converting it to a float. */
export function parseDecimalToken(text: string): DecimalParts | null {
  const match = DECIMAL_TOKEN.exec(text.trim());
  if (match === null) return null;
  const sign = match[1] ?? '';
  const int = match[2] ?? '';
  const fraction = match[3] ?? '';
  const rawExponent = match[4];
  if (int === '' && fraction === '') return null;
  const digits = (int + fraction).replace(/^0+/, '');
  if (digits === '') return { sign: 0, digits: '0', exponent: 0n };
  const exponent = (rawExponent === undefined ? 0n : BigInt(rawExponent)) - BigInt(fraction.length);
  return { sign: sign === '-' ? -1 : 1, digits, exponent };
}

/**
 * Exact decimal comparison of verbatim number tokens. Values are compared by sign, then by decimal
 * magnitude (`digits.length + exponent`, a `BigInt`), then digit by digit with the shorter side
 * treated as zero-padded. Unparsable input (impossible for a JSON number) falls back to text order.
 */
export function compareDecimalText(a: string, b: string): number {
  const left = parseDecimalToken(a);
  const right = parseDecimalToken(b);
  if (left === null || right === null) return compareText(a, b);
  if (left.sign !== right.sign) return left.sign < right.sign ? -1 : 1;
  if (left.sign === 0) return 0;
  const difference = compareMagnitude(left, right);
  return left.sign < 0 ? -difference : difference;
}

function compareMagnitude(a: DecimalParts, b: DecimalParts): number {
  const magnitudeA = BigInt(a.digits.length) + a.exponent;
  const magnitudeB = BigInt(b.digits.length) + b.exponent;
  if (magnitudeA !== magnitudeB) return magnitudeA < magnitudeB ? -1 : 1;
  const length = Math.max(a.digits.length, b.digits.length);
  for (let index = 0; index < length; index += 1) {
    const digitA = index < a.digits.length ? a.digits.charCodeAt(index) : 48;
    const digitB = index < b.digits.length ? b.digits.charCodeAt(index) : 48;
    if (digitA !== digitB) return digitA < digitB ? -1 : 1;
  }
  return 0;
}

/**
 * Merges stored order with the columns found in the current execution: locked columns stay first,
 * stored positions win, new columns append in discovery order, and ids no page currently carries are
 * preserved at the end so a temporarily missing field never loses its place or width.
 */
export function reconcileColumnOrder(order: readonly string[], discovered: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of LOCKED_COLUMN_IDS) {
    if (discovered.includes(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  for (const id of order) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  for (const id of discovered) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

/** Moves one column one slot in `delta` direction, hopping over locked columns such as the row number. */
export function moveColumn(
  order: readonly string[],
  id: string,
  delta: -1 | 1,
  locked: readonly string[] = LOCKED_COLUMN_IDS,
): string[] {
  const lockedSet = new Set(locked);
  if (lockedSet.has(id)) return [...order];
  const movable = order.filter((columnId) => !lockedSet.has(columnId));
  const from = movable.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= movable.length) return [...order];
  const a = movable[from];
  const b = movable[to];
  if (a === undefined || b === undefined) return [...order];
  movable[from] = b;
  movable[to] = a;
  return mergeMovable(order, movable, lockedSet);
}

/** Drag-and-drop reorder: `active` takes the slot of `over` among movable columns. */
export function reorderColumns(
  order: readonly string[],
  activeId: string,
  overId: string,
  locked: readonly string[] = LOCKED_COLUMN_IDS,
): string[] {
  const lockedSet = new Set(locked);
  if (activeId === overId || lockedSet.has(activeId) || lockedSet.has(overId)) return [...order];
  const movable = order.filter((columnId) => !lockedSet.has(columnId));
  const from = movable.indexOf(activeId);
  const to = movable.indexOf(overId);
  if (from < 0 || to < 0) return [...order];
  const moved = movable.splice(from, 1)[0];
  if (moved === undefined) return [...order];
  movable.splice(to, 0, moved);
  return mergeMovable(order, movable, lockedSet);
}

function mergeMovable(order: readonly string[], movable: readonly string[], lockedSet: Set<string>): string[] {
  const result = [...order];
  let next = 0;
  for (let index = 0; index < order.length; index += 1) {
    const id = order[index];
    if (id === undefined || lockedSet.has(id)) continue;
    const replacement = movable[next];
    next += 1;
    if (replacement !== undefined) result[index] = replacement;
  }
  return result;
}

/** One sorted column, cycling none → ascending → descending → none. */
export function cycleSorting(sorting: readonly ResultGridSort[], id: string): ResultGridSort[] {
  const current = sorting.find((entry) => entry.id === id);
  if (current === undefined) return [{ id, desc: false }];
  if (!current.desc) return [{ id, desc: true }];
  return [];
}

/** Drops sort entries whose column no longer exists in this execution; stored state is untouched. */
export function activeSorting(sorting: readonly ResultGridSort[], discovered: readonly string[]): ResultGridSort[] {
  const known = new Set(discovered);
  return sorting.filter((entry) => known.has(entry.id));
}

/** Sorting is offered only where it can actually change the order. */
export function canSortField(values: readonly GridCellValue[]): boolean {
  return values.some((value) => value.kind === 'number' || value.kind === 'string' || value.kind === 'boolean');
}

export function clampColumnWidth(width: number): number {
  if (!Number.isFinite(width)) return MIN_COLUMN_WIDTH;
  return Math.min(Math.max(Math.round(width), MIN_COLUMN_WIDTH), MAX_COLUMN_WIDTH);
}

/** Clamps committed widths into the resizer bounds; TanStack commits raw pointer deltas. */
export function sanitizeColumnSizing(sizing: Record<string, number>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [id, width] of Object.entries(sizing)) result[id] = clampColumnWidth(width);
  return result;
}

/** Drops an explicit width so the column returns to its adaptive default (double-click auto-fit). */
export function restoreColumnWidth(sizing: Record<string, number>, id: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [columnId, width] of Object.entries(sizing)) {
    if (columnId !== id) result[columnId] = width;
  }
  return result;
}

/** Approximate rendered width in half-width character units; CJK and full-width glyphs count twice. */
export function visualTextUnits(text: string): number {
  let units = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    units += code !== undefined && code > 0xff ? 2 : 1;
  }
  return units;
}

const CHARACTER_WIDTH = 7.4;
const CELL_CHROME = 26;
// Drag grip, sort indicator, gaps and padding must fit before the header text is measured.
const HEADER_CHROME = 64;
const MAX_SAMPLE_UNITS = 120;

/** Adaptive default width from the header and a bounded value sample, floored/capped by the resizer bounds. */
export function estimateColumnWidth(header: string, samples: readonly string[]): number {
  let widest = (visualTextUnits(header) + HEADER_CHROME / CHARACTER_WIDTH) * CHARACTER_WIDTH;
  for (const sample of samples) {
    const units = Math.min(visualTextUnits(sample), MAX_SAMPLE_UNITS);
    widest = Math.max(widest, units * CHARACTER_WIDTH + CELL_CHROME);
  }
  return clampColumnWidth(Math.ceil(widest));
}

export function pageCountOf(rowCount: number, pageSize: number = RESULT_GRID_PAGE_SIZE): number {
  if (rowCount <= 0) return 1;
  return Math.max(1, Math.ceil(rowCount / pageSize));
}

export function clampPageIndex(pageIndex: number, rowCount: number, pageSize: number = RESULT_GRID_PAGE_SIZE): number {
  const last = pageCountOf(rowCount, pageSize) - 1;
  if (!Number.isFinite(pageIndex)) return 0;
  return Math.min(Math.max(Math.trunc(pageIndex), 0), last);
}
