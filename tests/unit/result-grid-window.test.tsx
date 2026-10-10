import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataViewFieldFormats } from '../../src/domain/field-formats';
import { createQuery, createSnapshot, type QueryDocument } from '../../src/domain/query';
import { parseQueryResult } from '../../src/domain/query-result';
import { INITIAL_RESULT_GRID_STATE, type ResultGridRow, type ResultGridState } from '../../src/domain/result-grid';
import { QueryResultGrid } from '../../src/features/query/QueryResultGrid';
import { QueryResults } from '../../src/features/query/QueryResults';
import type { ExecutionEntry } from '../../src/features/query/useQueryExecutions';
import { COLUMN_OVERSCAN } from '../../src/features/query/useResultColumnWindow';
import { i18n } from '../../src/locales';

function fixture(columnCount: number, rowCount: number) {
  const fields = Array.from({ length: columnCount }, (_, index) => `field${String(index).padStart(3, '0')}`);
  const value = (field: number, row: number) => (9007199254740993n + BigInt(field * 1000 + row)).toString();
  const raw = `{"hits":{"hits":[${Array.from({ length: rowCount }, (_, row) =>
    `{"_index":"fixture","_id":"same","_source":{${fields.map((field, index) => `"${field}":${value(index, row)}`).join(',')}}}`
  ).join(',')}]}}`;
  const parsed = parseQueryResult(raw);
  if (!parsed.ok) throw new Error('Invalid grid fixture');
  const rows: ResultGridRow[] = parsed.summary.hits.map((hit, index) => ({
    hit, pageIndex: Math.floor(index / 35), position: index % 35,
  }));
  const initial: ResultGridState = {
    ...INITIAL_RESULT_GRID_STATE,
    columnSizing: Object.fromEntries(['meta:index', 'meta:id', ...fields.map((field) => `field:${field}`)].map((id) => [id, 100])),
  };
  return { fields, rows, initial, value, raw, summary: parsed.summary };
}

const wide = fixture(320, 70);
const small = fixture(80, 2);
const onChange = vi.fn();
const onDocument = vi.fn();
const onCompare = vi.fn();
const onFilter = vi.fn();
const onScroll = vi.fn();
const fetchSpy = vi.fn();
const queryAction = vi.fn();

const queries = {
  first: { ...createQuery('fixture-connection'), id: 'first-query', index: 'fixture' },
  second: { ...createQuery('fixture-connection'), id: 'second-query', index: 'fixture' },
};
function entry(query: QueryDocument, request: string): ExecutionEntry {
  return {
    state: { status: 'success', snapshot: createSnapshot(query, request, new Date('2026-10-10T00:00:00.000Z')), rawResponse: small.raw },
    endpoint: 'https://fixture.test', parsed: { ok: true, summary: small.summary }, rawResponse: small.raw,
    pages: [{ rawResponse: small.raw, summary: small.summary, cursor: null, partial: false }],
    pitId: null, continuing: false, continuationError: null,
  };
}
const entries = {
  first: entry(queries.first, 'first-request'), second: entry(queries.second, 'second-request'),
  replaced: entry(queries.first, 'replacement-request'),
};
function ResultsHarness({ id = 'first', replaced = false }: { id?: keyof typeof queries; replaced?: boolean }) {
  const [view, setView] = useState<QueryDocument['resultView']>('table');
  return <I18nextProvider i18n={i18n}>
    <QueryResults query={{ ...queries[id], resultView: view }} entry={replaced ? entries.replaced : entries[id]}
      available stale={false} endpointChanged={false} onViewChange={setView}
      onCancel={queryAction} onRun={queryAction} onLoadMore={queryAction} layout={{
        columnOrder: [], columnSizing: small.initial.columnSizing, columnVisibility: {}, sorting: [],
      }} />
  </I18nextProvider>;
}

function Harness({ data = wide, fields = data.fields, active = true, scrollLeft = 0, formats, filters = false }: {
  data?: typeof wide;
  fields?: readonly string[];
  active?: boolean;
  scrollLeft?: number;
  formats?: DataViewFieldFormats;
  filters?: boolean;
}) {
  const [state, setState] = useState(data.initial);
  return <I18nextProvider i18n={i18n}>
    <QueryResultGrid rows={data.rows} fieldNames={fields} state={state} active={active} executionKey="wide-execution"
      onStateChange={(next) => { onChange(next); setState(next); }}
      onDocument={onDocument} onCompare={onCompare} onFilterCell={filters ? onFilter : undefined}
      scrollPosition={{ left: scrollLeft, top: 17 }} onScrollPositionChange={onScroll} fieldFormats={formats} />
    <output data-testid="grid-state">{JSON.stringify(state)}</output>
  </I18nextProvider>;
}

const viewport = () => document.querySelector<HTMLDivElement>('.rg-scroll')!;
const table = () => document.querySelector<HTMLTableElement>('.rg-table')!;
const bodyRows = () => [...table().tBodies[0]!.rows];
const headerIds = () => [...table().querySelectorAll<HTMLElement>('th[data-column-id]')].map((node) => node.dataset.columnId!);
const fieldCell = (field: number, row = 0) => bodyRows()[row]!
  .querySelector<HTMLElement>(`td[data-column-id="field:field${String(field).padStart(3, '0')}"] .rg-cell`);
const state = () => JSON.parse(screen.getByTestId('grid-state').textContent!) as ResultGridState;
const offsetOf = (field: number) => 52 + (field + 2) * 100;
function scrollToField(field: number) {
  fireEvent.scroll(viewport(), { target: { scrollLeft: offsetOf(field) } });
}
function selectionChanged() {
  fireEvent(document, new Event('selectionchange'));
}

// Only geometry is substituted: the real Virtualizer, Table, dnd-kit and scroll listeners run.
// These deterministic CSS-pixel fixtures are not native layout or performance measurements.
let viewportWidth = 640;
const observers = new Set<GeometryObserver>();
class GeometryObserver {
  elements = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) { observers.add(this); }
  observe(element: Element) { this.elements.add(element); }
  unobserve(element: Element) { this.elements.delete(element); }
  disconnect() { this.elements.clear(); observers.delete(this); }
}
function resizeViewport(width: number) {
  viewportWidth = width;
  act(() => {
    for (const observer of observers) {
      if (!observer.elements.has(viewport())) continue;
      observer.callback([{
        target: viewport(), borderBoxSize: [{ inlineSize: width, blockSize: 320 }],
      } as unknown as ResizeObserverEntry], observer as unknown as ResizeObserver);
    }
  });
}
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON: () => ({}) };
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  [onChange, onDocument, onCompare, onFilter, onScroll, fetchSpy, queryAction].forEach((spy) => spy.mockClear());
  viewportWidth = 640;
  observers.clear();
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubGlobal('ResizeObserver', GeometryObserver);
  for (const property of ['offsetWidth', 'clientWidth'] as const) {
    vi.spyOn(HTMLElement.prototype, property, 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('rg-scroll') ? viewportWidth : 0;
    });
  }
  for (const property of ['offsetHeight', 'clientHeight'] as const) {
    vi.spyOn(HTMLElement.prototype, property, 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('rg-scroll') ? 320 : 0;
    });
  }
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('rg-scroll') ? Number.parseFloat(this.querySelector<HTMLTableElement>('table')?.style.width ?? '0') : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('rg-scroll')) return rect(0, 0, viewportWidth, 320);
    const header = this.closest<HTMLTableCellElement>('th');
    if (header) {
      const columns = [...header.closest('table')!.querySelectorAll<HTMLTableColElement>('col')];
      const sizes = columns.map((column) => Number.parseFloat(column.style.width));
      return rect(sizes.slice(0, header.cellIndex).reduce((sum, size) => sum + size, 0) - viewport().scrollLeft,
        0, sizes[header.cellIndex] ?? 0, 32);
    }
    return rect(0, 0, 0, 0);
  });
});
afterEach(() => {
  document.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
});

describe('loaded result column window', () => {
  it('bounds mounted columns and cells while keeping 50 rows, the full width and logical ARIA indexes', () => {
    render(<Harness />);
    expect(table()).toHaveAttribute('data-column-window', 'true');
    expect(table()).toHaveAttribute('aria-colcount', '323');
    expect(bodyRows()).toHaveLength(50);
    expect(headerIds().length).toBeLessThanOrEqual(Math.ceil(viewportWidth / 100) + 1 + COLUMN_OVERSCAN * 2);
    expect(table().querySelectorAll('tbody td[data-column-id]').length).toBe(50 * headerIds().length);
    expect(fieldCell(150)).toBeNull();
    expect(fieldCell(0)).toHaveTextContent(wide.value(0, 0));
    const totalSize = 52 + 322 * 100;
    expect(table().style.width).toBe(`${totalSize}px`);
    expect([...table().querySelectorAll('col')].reduce((sum, col) => sum + Number.parseFloat(col.style.width), 0)).toBe(totalSize);
    expect(table().querySelectorAll('.rg-column-spacer')).toHaveLength(51);
    expect(table().querySelector('.rg-column-spacer')).toHaveAttribute('aria-hidden', 'true');
    scrollToField(150);
    expect(fieldCell(0)).toBeNull();
    expect(fieldCell(150)).toHaveTextContent(wide.value(150, 0));
    expect(fieldCell(150)?.parentElement).toHaveAttribute('aria-colindex', '154');
    for (const row of bodyRows()) {
      expect([...row.querySelectorAll<HTMLElement>('td[data-column-id]')].map((cell) => cell.dataset.columnId)).toEqual(headerIds());
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('restores a far horizontal offset, reacts to viewport width, and clamps after columns disappear', () => {
    const view = render(<Harness scrollLeft={offsetOf(250)} />);
    expect(viewport().scrollTop).toBe(17);
    expect(fieldCell(250)).toHaveTextContent(wide.value(250, 0));
    const count = headerIds().length;
    resizeViewport(280);
    expect(headerIds().length).toBeLessThan(count);
    expect(fieldCell(250)).not.toBeNull();
    view.rerender(<Harness fields={wide.fields.slice(0, 2)} />);
    expect(table()).not.toHaveAttribute('data-column-window');
    expect(headerIds()).toHaveLength(5);
    expect(table().style.width).toBe('452px');
    expect(viewport().scrollLeft).toBe(172);
    expect(state().columnSizing['field:field250']).toBe(100);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps an unmeasured or temporarily hidden viewport bounded, then restores its actual range', () => {
    viewportWidth = 0;
    render(<Harness scrollLeft={offsetOf(250)} />);
    expect(headerIds()).toHaveLength(8);
    expect(bodyRows()).toHaveLength(50);
    expect(table().style.width).toBe('32252px');
    resizeViewport(640);
    expect(fieldCell(250)).toHaveTextContent(wide.value(250, 0));
    expect(fieldCell(0)).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps live scroll when appended fields cross the 24/25 visible-column threshold', () => {
    const data = fixture(22, 2);
    const view = render(<Harness data={data} fields={data.fields.slice(0, 21)} />);
    expect(table()).toHaveAttribute('aria-colcount', '24');
    expect(table()).not.toHaveAttribute('data-column-window');
    expect(headerIds()).toHaveLength(24);
    scrollToField(12);
    view.rerender(<Harness data={data} />);
    expect(table()).toHaveAttribute('aria-colcount', '25');
    expect(table()).toHaveAttribute('data-column-window', 'true');
    expect(fieldCell(12)).not.toBeNull();
    expect(fieldCell(0)).toBeNull();
    expect(viewport().scrollLeft).toBe(offsetOf(12));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('re-estimates width and range after keyboard/mouse sizing, auto-fit and hidden-column reset', () => {
    render(<Harness data={small} />);
    scrollToField(60);
    const separator = screen.getByRole('separator', { name: 'Resize column field060' });
    fireEvent.keyDown(separator, { key: 'End' });
    expect(separator).toHaveAttribute('aria-valuenow', '480');
    expect(table().style.width).toBe('8632px');
    expect(fieldCell(65)).toBeNull();
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(table().style.width).toBe('8216px');
    expect(fieldCell(65)).not.toBeNull();
    fireEvent.mouseDown(separator, { button: 0, clientX: 100 });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 140 });
    fireEvent.mouseUp(document, { clientX: 140 });
    expect(separator).toHaveAttribute('aria-valuenow', '104');
    fireEvent.doubleClick(separator);
    expect(state().columnSizing['field:field060']).toBeUndefined();
    expect(state().sorting).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show column field060' }));
    expect(fieldCell(60)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Move field061 right' }));
    expect(state().columnOrder.indexOf('field:field061')).toBeGreaterThan(state().columnOrder.indexOf('field:field062'));
    fireEvent.click(screen.getByRole('button', { name: 'Reset layout' }));
    expect(state()).toMatchObject({ columnOrder: [], columnSizing: {}, columnVisibility: {}, sorting: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps exact local sorting, real received-row selection, comparison and cell actions across the window', () => {
    render(<Harness filters />);
    fireEvent.click(bodyRows()[0]!);
    fireEvent.click(bodyRows()[1]!, { ctrlKey: true });
    scrollToField(150);
    fireEvent.click(screen.getByRole('button', { name: 'Sort by field150' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sort by field150' }));
    expect(bodyRows()[0]).toHaveAttribute('data-selection-id', '1:34');
    expect(fieldCell(150)).toHaveTextContent(wide.value(150, 69));
    expect(state().rowSelection).toEqual({ '0:0': true, '0:1': true });
    expect(screen.getByRole('status', { name: /Sorted by field150, descending, within 70 loaded rows/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Compare two selected documents' }));
    expect(onCompare).toHaveBeenLastCalledWith([wide.rows[0], wide.rows[1]]);
    fireEvent.doubleClick(fieldCell(150)!);
    expect(onDocument).toHaveBeenLastCalledWith(wide.rows[69]);
    fireEvent.click(bodyRows()[0]!.querySelector('td[data-column-id="field:field150"] button')!);
    expect(onFilter).toHaveBeenLastCalledWith(wide.rows[69], 'field150');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(viewport().scrollLeft).toBe(offsetOf(150));
    expect(viewport().scrollTop).toBe(0);
    expect(bodyRows().some((row) => row.dataset.selectionId === '0:0' && row.getAttribute('aria-selected') === 'true')).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('retains a focused control and logical keyboard neighbours without mounting the intervening columns', async () => {
    const user = userEvent.setup();
    render(<Harness data={small} filters />);
    const separator = screen.getByRole('separator', { name: 'Resize column field005' });
    act(() => separator.focus());
    scrollToField(65);
    expect(separator).toHaveFocus();
    expect(fieldCell(20)).toBeNull();
    expect(headerIds().length).toBeLessThan(24);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Reorder column field006' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Reorder column field007' })).toBeInTheDocument();
    await user.tab({ shift: true });
    expect(separator).toHaveFocus();
    const lastFilter = bodyRows()[0]!.querySelector<HTMLButtonElement>('td[data-column-id="field:field079"] button')!;
    act(() => lastFilter.focus());
    await user.tab();
    expect(bodyRows()[1]!.querySelector('td[data-column-id="meta:id"] button')).toHaveFocus();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([false, true])('retains native selection endpoints and copies omitted logical columns with original values (formatted=%s)', (formatted) => {
    const formats: DataViewFieldFormats | undefined = formatted
      ? { version: 1, entries: [{ field: 'field000', format: { kind: 'number', grouping: true } }] } : undefined;
    render(<Harness data={small} formats={formats} />);
    const first = fieldCell(0)!;
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(first);
    selection.addRange(range);
    selectionChanged();
    scrollToField(65);
    expect(first).toBeInTheDocument();
    expect(fieldCell(20)).toBeNull();
    const last = fieldCell(65)!;
    range.setEnd(last.firstChild!, last.textContent!.length);
    selectionChanged();
    const clipboardData = { setData: vi.fn() };
    fireEvent.copy(last, { clipboardData });
    expect(clipboardData.setData).toHaveBeenLastCalledWith('text/plain',
      Array.from({ length: 66 }, (_, field) => small.value(field, 0)).join('\t'));
    selection.removeAllRanges();
    selectionChanged();
    expect(first).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('copies a multi-row native range in the visible reordered column order, without restoring hidden columns', () => {
    const order = ['meta:row', ...[...small.fields].reverse().map((field) => `field:${field}`), 'meta:index', 'meta:id'];
    const data = { ...small, initial: {
      ...small.initial, columnOrder: order, columnVisibility: { 'field:field070': false },
    } };
    render(<Harness data={data} />);
    const first = fieldCell(77)!;
    const range = document.createRange();
    range.selectNodeContents(first);
    document.getSelection()!.addRange(range);
    selectionChanged();
    fireEvent.scroll(viewport(), { target: { scrollLeft: 7400 } });
    const last = fieldCell(2, 1)!;
    range.setEnd(last.firstChild!, last.textContent!.length);
    selectionChanged();
    const clipboardData = { setData: vi.fn() };
    fireEvent.copy(last, { clipboardData });
    const rowOne = [...small.fields.keys()].reverse().filter((field) => field <= 77 && field !== 70)
      .map((field) => small.value(field, 0));
    const rowTwo = [...small.fields.keys()].reverse().filter((field) => field >= 2 && field !== 70)
      .map((field) => small.value(field, 1));
    expect(clipboardData.setData).toHaveBeenLastCalledWith('text/plain',
      [...rowOne, 'fixture', 'same'].join('\t') + '\n' + ['2', ...rowTwo].join('\t'));
    expect(state().columnVisibility['field:field070']).toBe(false);
  });

  it('leaves an ordinary partial unformatted selection to the native clipboard', () => {
    render(<Harness data={small} />);
    const text = fieldCell(0)!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 3);
    range.setEnd(text, 8);
    document.getSelection()!.addRange(range);
    selectionChanged();
    const clipboardData = { setData: vi.fn() };
    expect(fireEvent.copy(text.parentElement!, { clipboardData })).toBe(true);
    expect(clipboardData.setData).not.toHaveBeenCalled();
  });

  it('uses the actual dnd-kit keyboard sensor to reorder a windowed header without changing row identity or sort', async () => {
    const user = userEvent.setup();
    render(<Harness data={small} />);
    const handle = screen.getByRole('button', { name: 'Reorder column field004' });
    act(() => handle.focus());
    await user.keyboard('[Space][ArrowRight][Space]');
    expect(state().columnOrder.indexOf('field:field004')).toBeGreaterThan(state().columnOrder.indexOf('field:field005'));
    expect(state().sorting).toEqual([]);
    expect(state().rowSelection).toEqual({});
    expect(fieldCell(4)).toHaveTextContent(small.value(4, 0));
    expect(fieldCell(5)).toHaveTextContent(small.value(5, 0));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('retains the active drag column across a distant scroll and releases transient columns on leaving the surface', async () => {
    const user = userEvent.setup();
    const view = render(<Harness data={small} />);
    const handle = screen.getByRole('button', { name: 'Reorder column field004' });
    act(() => handle.focus());
    await user.keyboard('[Space]');
    scrollToField(65);
    expect(handle.closest('th')).toHaveAttribute('data-dragging', 'true');
    expect(fieldCell(4)).not.toBeNull();
    expect(fieldCell(30)).toBeNull();
    expect(headerIds().length).toBeLessThan(24);
    await user.keyboard('[Escape]');
    expect(state().columnOrder).toEqual([]);
    expect(handle.closest('th')).not.toHaveAttribute('data-dragging');
    view.rerender(<Harness data={small} active={false} />);
    expect(fieldCell(4)).toBeNull();
    expect(fieldCell(65)).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps per-query and JSON scroll/selection while opening actual original details and comparison from distant cells', async () => {
    const user = userEvent.setup();
    const view = render(<ResultsHarness />);
    scrollToField(65);
    fireEvent.click(bodyRows()[0]!);
    fireEvent.click(bodyRows()[1]!, { ctrlKey: true });
    fireEvent.doubleClick(fieldCell(65, 1)!);
    await user.click(within(screen.getByRole('dialog', { name: 'Document same' })).getByRole('button', { name: 'JSON' }));
    expect(screen.getByRole('dialog', { name: 'Document same' })).toHaveTextContent(`"field065": ${small.value(65, 1)}`);
    await user.keyboard('{Escape}');
    fireEvent.click(screen.getByRole('button', { name: 'Compare two selected documents' }));
    expect(screen.getByLabelText('Left value: _source / field000')).toHaveTextContent(small.value(0, 0));
    expect(screen.getByLabelText('Right value: _source / field000')).toHaveTextContent(small.value(0, 1));
    await user.keyboard('{Escape}');
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    expect(viewport().scrollLeft).toBe(offsetOf(65));
    expect(fieldCell(65)).toHaveTextContent(small.value(65, 0));
    expect(screen.getByRole('button', { name: 'Compare two selected documents' })).toBeEnabled();
    view.rerender(<ResultsHarness id="second" />);
    expect(viewport().scrollLeft).toBe(0);
    expect(screen.getByRole('button', { name: 'Compare two selected documents' })).toBeDisabled();
    scrollToField(10);
    view.rerender(<ResultsHarness />);
    expect(viewport().scrollLeft).toBe(offsetOf(65));
    expect(screen.getByRole('button', { name: 'Compare two selected documents' })).toBeEnabled();
    expect(queryAction).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('starts a replacement execution at its own scroll origin without losing column preferences', () => {
    const view = render(<ResultsHarness />);
    scrollToField(65);
    fireEvent.click(bodyRows()[0]!);
    view.rerender(<ResultsHarness replaced />);
    expect(viewport().scrollLeft).toBe(0);
    expect(fieldCell(0)).not.toBeNull();
    expect(fieldCell(65)).toBeNull();
    expect(table().style.width).toBe('8252px');
    expect(screen.getByRole('button', { name: 'Compare two selected documents' })).toBeDisabled();
    expect(document.querySelectorAll('tr[aria-selected="true"]')).toHaveLength(0);
    expect(queryAction).not.toHaveBeenCalled();
  });
});
