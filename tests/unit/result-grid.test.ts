import { describe, expect, it } from 'vitest';
import { parseQueryResult } from '../../src/domain/query-result';
import {
  ID_COLUMN_ID, INDEX_COLUMN_ID, INITIAL_RESULT_GRID_STATE, LOCKED_COLUMN_IDS, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH,
  NULL_GRID_VALUE, RESULT_GRID_PAGE_SIZE, ROW_COLUMN_ID,
  activeSorting, canSortField, clampColumnWidth, clampPageIndex, compareDecimalText, compareGridValues, cycleSorting,
  estimateColumnWidth, fieldColumnId, fieldNameOfColumnId, moveColumn, pageCountOf, parseDecimalToken,
  reconcileColumnOrder, reorderColumns, restoreColumnWidth, sanitizeColumnSizing, sortValueOf, visualTextUnits,
  type GridCellValue, type ResultGridRow,
} from '../../src/domain/result-grid';

const number = (text: string): GridCellValue => ({ kind: 'number', text });
const string = (text: string): GridCellValue => ({ kind: 'string', text });
const boolean = (text: string): GridCellValue => ({ kind: 'boolean', text });
const complex = (kind: 'object' | 'array', text: string): GridCellValue => ({ kind, text });

describe('result grid column identity', () => {
  it('namespaces source fields so metadata and identical source spellings stay distinct', () => {
    expect(fieldColumnId('_index')).toBe('field:_index');
    expect(fieldColumnId('_index')).not.toBe(INDEX_COLUMN_ID);
    expect(fieldColumnId('_id')).not.toBe(ID_COLUMN_ID);
    expect(fieldNameOfColumnId('field:_index')).toBe('_index');
    expect(fieldNameOfColumnId('meta:index')).toBeNull();
    expect(fieldNameOfColumnId('field:')).toBe('');
    expect(LOCKED_COLUMN_IDS).toEqual([ROW_COLUMN_ID]);
    expect(INITIAL_RESULT_GRID_STATE).toEqual({ columnOrder: [], columnSizing: {}, columnVisibility: {}, sorting: [], pageIndex: 0, rowSelection: {} });
  });
});

describe('column order reconciliation', () => {
  it('keeps stored order, appends new columns and preserves temporarily missing ones', () => {
    const discovered = ['meta:row', 'meta:index', 'meta:id', 'field:b', 'field:c'];
    expect(reconcileColumnOrder(['field:b', 'meta:row', 'field:gone'], discovered))
      .toEqual(['meta:row', 'field:b', 'field:gone', 'meta:index', 'meta:id', 'field:c']);
    expect(reconcileColumnOrder(['field:b', 'field:gone'], discovered))
      .toEqual(['meta:row', 'field:b', 'field:gone', 'meta:index', 'meta:id', 'field:c']);
  });

  it('drops duplicates without reordering', () => {
    expect(reconcileColumnOrder(['a', 'a', 'b'], ['b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('moves columns one slot and hops over locked columns', () => {
    const order = ['meta:row', 'a', 'b', 'c'];
    expect(moveColumn(order, 'c', -1)).toEqual(['meta:row', 'a', 'c', 'b']);
    expect(moveColumn(order, 'a', -1)).toEqual(['meta:row', 'a', 'b', 'c']);
    expect(moveColumn(order, 'a', 1)).toEqual(['meta:row', 'b', 'a', 'c']);
    expect(moveColumn(order, 'c', 1)).toEqual(order);
    expect(moveColumn(order, 'meta:row', 1)).toEqual(order);
  });

  it('reorders by drag position while keeping locked columns in place', () => {
    const order = ['meta:row', 'a', 'b', 'c', 'd'];
    expect(reorderColumns(order, 'd', 'a')).toEqual(['meta:row', 'd', 'a', 'b', 'c']);
    expect(reorderColumns(order, 'a', 'd')).toEqual(['meta:row', 'b', 'c', 'd', 'a']);
    expect(reorderColumns(order, 'meta:row', 'd')).toEqual(order);
    expect(reorderColumns(order, 'a', 'a')).toEqual(order);
    expect(reorderColumns(order, 'a', 'missing')).toEqual(order);
  });
});

describe('local sort state', () => {
  it('cycles a column none, ascending, descending, none', () => {
    let sorting = cycleSorting([], 'field:amount');
    expect(sorting).toEqual([{ id: 'field:amount', desc: false }]);
    sorting = cycleSorting(sorting, 'field:amount');
    expect(sorting).toEqual([{ id: 'field:amount', desc: true }]);
    sorting = cycleSorting(sorting, 'field:amount');
    expect(sorting).toEqual([]);
  });

  it('prunes sort entries whose column no longer exists without touching the rest', () => {
    const sorting = [{ id: 'field:gone', desc: true }, { id: 'meta:id', desc: false }];
    expect(activeSorting(sorting, ['meta:row', 'meta:id'])).toEqual([{ id: 'meta:id', desc: false }]);
    expect(activeSorting(sorting, ['field:gone'])).toEqual([{ id: 'field:gone', desc: true }]);
  });
});

describe('exact numeric comparison on verbatim tokens', () => {
  it('orders integers beyond Number.MAX_SAFE_INTEGER without rounding', () => {
    expect(compareDecimalText('9007199254740992', '9007199254740993')).toBe(-1);
    expect(compareDecimalText('9007199254740993', '9007199254740992')).toBe(1);
    expect(Number('9007199254740993') === Number('9007199254740992')).toBe(true); // why the token matters
    const tokens = ['9007199254740993', '9007199254740992', '-9007199254740993', '-9007199254740992'];
    const sorted = tokens.slice().sort(compareDecimalText);
    expect(sorted).toEqual(['-9007199254740993', '-9007199254740992', '9007199254740992', '9007199254740993']);
  });

  it('orders long decimals and exponents exactly', () => {
    expect(compareDecimalText('0.10000000000000000000001', '0.1')).toBe(1);
    expect(compareDecimalText('1.1000000000000001', '1.1')).toBe(1);
    expect(compareDecimalText('1e3', '999.999')).toBe(1);
    expect(compareDecimalText('9.9999999999999999999e2', '1e3')).toBe(-1);
    expect(compareDecimalText('1e-3', '0.001')).toBe(0);
    expect(compareDecimalText('1E+3', '1e3')).toBe(0);
    expect(compareDecimalText('1e1000000', '1e999999')).toBe(1);
    expect(compareDecimalText('1e1000000', '-1e1000000')).toBe(1);
    expect(compareDecimalText('-1e1000000', '-1e999999')).toBe(-1);
  });

  it('treats signed zero, padding and leading zeros as equal', () => {
    expect(compareDecimalText('-0', '0')).toBe(0);
    expect(compareDecimalText('0.0', '0e10')).toBe(0);
    expect(compareDecimalText('000123', '123.0')).toBe(0);
    expect(compareDecimalText('12.30', '12.3')).toBe(0);
    expect(compareDecimalText('90', '9e1')).toBe(0);
  });

  it('parses tokens without floats and rejects non numbers', () => {
    expect(parseDecimalToken('9007199254740993')).toEqual({ sign: 1, digits: '9007199254740993', exponent: 0n });
    expect(parseDecimalToken('-1.25e2')).toEqual({ sign: -1, digits: '125', exponent: 0n });
    expect(parseDecimalToken('0.001')).toEqual({ sign: 1, digits: '1', exponent: -3n });
    expect(parseDecimalToken('0')).toEqual({ sign: 0, digits: '0', exponent: 0n });
    expect(parseDecimalToken('NaN')).toBeNull();
    expect(parseDecimalToken('Infinity')).toBeNull();
    expect(parseDecimalToken('')).toBeNull();
    expect(parseDecimalToken('1e')).toBeNull();
    expect(compareDecimalText('12a', '12b')).toBe(-1); // unparsable falls back to deterministic text order
  });
});

describe('mixed-kind comparison stays explicit and stable', () => {
  it('orders kinds by rank and keeps text order deterministic', () => {
    expect(compareGridValues(number('1'), string('1'))).toBe(-1);
    expect(compareGridValues(string('1'), boolean('false'))).toBe(-1);
    expect(compareGridValues(boolean('false'), boolean('true'))).toBe(-1);
    expect(compareGridValues(boolean('true'), NULL_GRID_VALUE)).toBe(-1);
    expect(compareGridValues(NULL_GRID_VALUE, NULL_GRID_VALUE)).toBe(0);
    expect(compareGridValues(NULL_GRID_VALUE, { kind: 'null', text: 'null' })).toBe(0);
    expect(compareGridValues(complex('object', '{"a":1}'), complex('array', '[1]'))).toBe(-1);
    expect(compareGridValues(string('Apple'), string('apple'))).toBe(-1);
    expect(compareGridValues(string('a'), string('a'))).toBe(0);
    expect(compareGridValues(number('10'), number('9'))).toBe(1);
  });
});

describe('sortability probe', () => {
  it('enables sorting only when a scalar value exists', () => {
    expect(canSortField([number('1'), NULL_GRID_VALUE])).toBe(true);
    expect(canSortField([string('x')])).toBe(true);
    expect(canSortField([boolean('true')])).toBe(true);
    expect(canSortField([NULL_GRID_VALUE, complex('object', '{}')])).toBe(false);
    expect(canSortField([complex('array', '[]')])).toBe(false);
    expect(canSortField([])).toBe(false);
  });

  it('reads missing fields as null and keeps lossless values', () => {
    const parsed = parseQueryResult('{"hits":{"hits":[{"_index":"logs","_id":"a","_source":{"n":9007199254740993,"s":"x","nested":{"a":1}}}]}}');
    if (!parsed.ok) throw new Error('expected a parsed response');
    const hit = parsed.summary.hits[0];
    if (hit === undefined) throw new Error('expected one hit');
    const row: ResultGridRow = { hit, pageIndex: 0, position: 0 };
    expect(sortValueOf(row, 'n')).toEqual({ kind: 'number', text: '9007199254740993' });
    expect(sortValueOf(row, 's')).toEqual({ kind: 'string', text: 'x' });
    expect(sortValueOf(row, 'nested')).toEqual({ kind: 'object', text: '{"a":1}' });
    expect(sortValueOf(row, 'missing')).toEqual(NULL_GRID_VALUE);
  });
});

describe('adaptive widths, bounds and paging', () => {
  it('widens for the header or the widest sample and clamps to the resize bounds', () => {
    expect(estimateColumnWidth('a', [])).toBeGreaterThan(MIN_COLUMN_WIDTH);
    expect(estimateColumnWidth('a', ['b'])).toBe(estimateColumnWidth('a', []));
    expect(estimateColumnWidth('header', [])).toBeGreaterThanOrEqual(6 * 7.4 + 64);
    const wide = estimateColumnWidth('id', ['9007199254740993-long-token']);
    expect(wide).toBeGreaterThan(MIN_COLUMN_WIDTH);
    expect(estimateColumnWidth('x', ['y'.repeat(500)])).toBe(MAX_COLUMN_WIDTH);
    expect(estimateColumnWidth('字段名称', ['值'])).toBeGreaterThanOrEqual(estimateColumnWidth('ab', ['z']));
  });

  it('counts CJK glyphs as two units', () => {
    expect(visualTextUnits('ab')).toBe(2);
    expect(visualTextUnits('中文')).toBe(4);
    expect(clampColumnWidth(10)).toBe(MIN_COLUMN_WIDTH);
    expect(clampColumnWidth(10_000)).toBe(MAX_COLUMN_WIDTH);
    expect(clampColumnWidth(Number.NaN)).toBe(MIN_COLUMN_WIDTH);
    expect(clampColumnWidth(120.4)).toBe(120);
  });

  it('sanitizes committed widths and restores the adaptive default', () => {
    expect(sanitizeColumnSizing({ a: 5, b: 900, c: 200 })).toEqual({ a: MIN_COLUMN_WIDTH, b: MAX_COLUMN_WIDTH, c: 200 });
    const sizing = { a: 120, b: 220 };
    expect(restoreColumnWidth(sizing, 'a')).toEqual({ b: 220 });
    expect(sizing).toEqual({ a: 120, b: 220 });
  });

  it('derives page count and clamps the page index', () => {
    expect(RESULT_GRID_PAGE_SIZE).toBe(50);
    expect(pageCountOf(0)).toBe(1);
    expect(pageCountOf(50)).toBe(1);
    expect(pageCountOf(51)).toBe(2);
    expect(pageCountOf(120)).toBe(3);
    expect(clampPageIndex(-4, 120)).toBe(0);
    expect(clampPageIndex(2, 120)).toBe(2);
    expect(clampPageIndex(9, 120)).toBe(2);
    expect(clampPageIndex(Number.NaN, 120)).toBe(0);
  });
});
