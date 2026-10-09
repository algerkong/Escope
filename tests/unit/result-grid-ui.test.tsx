import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_RESULT_GRID_STATE, type ResultGridRow, type ResultGridState } from '../../src/domain/result-grid';
import { parseQueryResult } from '../../src/domain/query-result';
import { QueryResultGrid } from '../../src/features/query/QueryResultGrid';
import { i18n } from '../../src/locales';
import { enLive, zhLive } from '../../src/locales/query-live';
import { enResultGrid, zhResultGrid } from '../../src/locales/result-grid';

// Namespaces are registered by `locales/index.ts`; these tests register them locally so no shared
// setup has to change for the grid feature.
i18n.addResourceBundle('zh-CN', 'resultGrid', zhResultGrid);
i18n.addResourceBundle('en-US', 'resultGrid', enResultGrid);
i18n.addResourceBundle('zh-CN', 'queryLive', zhLive);
i18n.addResourceBundle('en-US', 'queryLive', enLive);

const HIT_COUNT = 120;
const FIELD_NAMES = ['n', 's', 'flag', 'obj', 'tags', '_index', '_id'] as const;
const WITHOUT_S = FIELD_NAMES.filter((name) => name !== 's');

/** Exact values around 2^53, so any float rounding would change the expected order. */
function receivedValue(index: number): string {
  return index % 2 === 0
    ? (9007199254740992n + BigInt(index) / 2n).toString()
    : (-9007199254740992n - BigInt(index)).toString();
}

const N_FIRST = receivedValue(0);
const N_MIN = receivedValue(119);
const N_MAX = receivedValue(118);

function buildRows(): ResultGridRow[] {
  const hits = Array.from({ length: HIT_COUNT }, (_, index) =>
    `{"_index":"logs-1","_id":"id-${index}","_source":{"n":${receivedValue(index)},"s":"row-${index}",` +
    `"flag":${index % 2 === 0},"obj":{"i":${index}},"tags":[${index}],"_index":"shadow-${index}","_id":"shadow-id-${index}"}}`).join(',');
  const parsed = parseQueryResult(`{"hits":{"hits":[${hits}]}}`);
  if (!parsed.ok) throw new Error('grid fixture must parse as a search response');
  return parsed.summary.hits.map((hit, index) => ({ hit, pageIndex: 0, position: index }));
}

const rows = buildRows();

function Harness({ rows: gridRows, fieldNames = FIELD_NAMES, initial = INITIAL_RESULT_GRID_STATE, executionKey = 'first', onDocument, onChange }: {
  rows: readonly ResultGridRow[];
  fieldNames?: readonly string[];
  initial?: ResultGridState;
  executionKey?: string;
  onDocument?: (row: ResultGridRow) => void;
  onChange?: (next: ResultGridState) => void;
}) {
  const [state, setState] = useState<ResultGridState>(initial);
  const handleChange = (next: ResultGridState) => {
    onChange?.(next);
    setState(next);
  };
  return <I18nextProvider i18n={i18n}>
    <QueryResultGrid rows={gridRows} fieldNames={fieldNames} state={state} onStateChange={handleChange}
      onDocument={onDocument ?? (() => {})} executionKey={executionKey} />
    <output data-testid="grid-state">{JSON.stringify(state)}</output>
  </I18nextProvider>;
}

const headerIds = (): (string | null)[] => [...document.querySelectorAll('thead th')].map((th) => th.getAttribute('data-column-id'));
const bodyRows = (): Element[] => [...document.querySelectorAll('tbody tr')];
const cellTexts = (row: Element): string[] => [...row.querySelectorAll('td')].map((td) => td.textContent ?? '');
const cellOf = (row: Element, columnId: string): string => cellTexts(row)[headerIds().indexOf(columnId)] ?? '';
const readState = (): ResultGridState => JSON.parse(screen.getByTestId('grid-state').textContent ?? '{}') as ResultGridState;
const sortButton = (label: string) => screen.getByRole('button', { name: `Sort by ${label}` });

const fetchSpy = vi.fn();
beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  fetchSpy.mockClear();
  vi.unstubAllGlobals();
});

describe('result grid interaction', () => {
  it('keeps persistent row selection by document identity through sort, pagination and column actions', async () => {
    const user = userEvent.setup();
    render(<Harness rows={rows} />);
    const first = bodyRows()[0] as HTMLElement;
    await user.click(first);
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(readState().rowSelection).toEqual({ '0:0': true });
    expect(screen.getByText('1 row selected')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(document.querySelectorAll('tbody tr[aria-selected="true"]')).toHaveLength(0);
    expect(readState().rowSelection).toEqual({ '0:0': true });
    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(bodyRows()[0]).toHaveAttribute('aria-selected', 'true');
    await user.click(sortButton('n'));
    expect(readState().rowSelection).toEqual({ '0:0': true });
    expect(document.querySelectorAll('tbody tr[aria-selected="true"]')).toHaveLength(0);
    fireEvent.mouseDown(bodyRows()[0] as Element, { button: 0, buttons: 1 });
    fireEvent.mouseMove(bodyRows()[2] as Element, { buttons: 1 });
    fireEvent.mouseUp(document);
    expect(readState().rowSelection).toEqual({ '0:119': true, '0:117': true, '0:115': true });
    expect(screen.getByText('3 rows selected')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Columns' }));
    await user.click(screen.getByRole('checkbox', { name: 'Show column n' }));
    await user.keyboard('{Escape}');
    expect(Object.keys(readState().rowSelection)).toHaveLength(3);
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize column s' }), { key: 'ArrowRight' });
    expect(Object.keys(readState().rowSelection)).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Clear row selection' }));
    expect(readState().rowSelection).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('retains selection when rows append but clears it for a new execution without resetting column preferences', async () => {
    const user = userEvent.setup();
    const initial = { ...INITIAL_RESULT_GRID_STATE, columnSizing: { 'field:n': 150 } };
    const view = render(<Harness rows={rows.slice(0, 10)} initial={initial} />);
    await user.click(bodyRows()[2] as HTMLElement);
    expect(readState().rowSelection).toEqual({ '0:2': true });
    view.rerender(<Harness rows={rows} initial={initial} />);
    expect(bodyRows()[2]).toHaveAttribute('aria-selected', 'true');
    view.rerender(<Harness rows={rows} initial={initial} executionKey="next" />);
    expect(readState().rowSelection).toEqual({});
    expect(readState().columnSizing).toEqual({ 'field:n': 150 });
    expect(screen.queryByText('1 row selected')).not.toBeInTheDocument();
  });

  it('can clear a sort after the sorted column is hidden without changing the layout', async () => {
    const user = userEvent.setup();
    render(<Harness rows={rows} />);
    await user.click(sortButton('n'));
    await user.click(screen.getByRole('button', { name: 'Columns' }));
    await user.click(screen.getByRole('checkbox', { name: 'Show column n' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Sort by n' })).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Sorted by n, ascending, within 120 loaded rows' })).toHaveTextContent('Local sort · 120 rows');
    await user.click(screen.getByRole('button', { name: 'Clear sorting' }));
    expect(readState().sorting).toEqual([]);
    expect(readState().columnVisibility['field:n']).toBe(false);
    expect(cellOf(bodyRows()[0] as Element, 'meta:id')).toBe('id-0');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('cycles the sort header asc/desc/none over every loaded row with exact huge numbers', async () => {
    const user = userEvent.setup();
    const onDocument = vi.fn();
    render(<Harness rows={rows} onDocument={onDocument} />);

    expect(bodyRows()).toHaveLength(50);
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    expect(cellOf(bodyRows()[0] as Element, 'field:n')).toBe(N_FIRST);
    const header = () => document.querySelector('th[data-column-id="field:n"]');
    expect(header()).not.toHaveAttribute('aria-sort');

    await user.click(sortButton('n'));
    expect(header()).toHaveAttribute('aria-sort', 'ascending');
    expect(screen.getByRole('status', { name: 'Sorted by n, ascending, within 120 loaded rows' })).toHaveTextContent('Local sort · 120 rows');
    // The minimum sits at received index 119, i.e. behind page 3 in the received order.
    expect(cellOf(bodyRows()[0] as Element, 'field:n')).toBe(N_MIN);
    expect(cellOf(bodyRows()[49] as Element, 'field:n')).toBe(receivedValue(21));

    await user.click(sortButton('n'));
    expect(header()).toHaveAttribute('aria-sort', 'descending');
    expect(cellOf(bodyRows()[0] as Element, 'field:n')).toBe(N_MAX);

    await user.click(sortButton('n'));
    expect(header()).not.toHaveAttribute('aria-sort');
    expect(cellOf(bodyRows()[0] as Element, 'field:n')).toBe(N_FIRST);
    expect(screen.queryByRole('status', { name: 'Sorted by n, ascending, within 120 loaded rows' })).toBeNull();

    expect(onDocument).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('pages the loaded rows in place without requesting more data', async () => {
    const user = userEvent.setup();
    render(<Harness rows={rows} />);
    expect(cellOf(bodyRows()[0] as Element, 'meta:row')).toBe('1');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
    expect(cellOf(bodyRows()[0] as Element, 'meta:row')).toBe('51');
    expect(cellOf(bodyRows()[0] as Element, 'field:n')).toBe(receivedValue(50));
    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(readState().pageIndex).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns to page one when sorting and ignores IME on a resize handle', async () => {
    const user = userEvent.setup();
    render(<Harness rows={rows} />);
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await user.click(sortButton('n'));
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    const separator = screen.getByRole('separator', { name: 'Resize column n' });
    const width = separator.getAttribute('aria-valuenow');
    fireEvent.keyDown(separator, { key: 'End', keyCode: 229 });
    expect(separator).toHaveAttribute('aria-valuenow', width);
  });

  it('moves across a temporarily missing column without a visible no-op', async () => {
    const user = userEvent.setup();
    render(<Harness rows={rows} initial={{
      ...INITIAL_RESULT_GRID_STATE,
      columnOrder: ['meta:row', 'meta:index', 'meta:id', 'field:n', 'field:missing', 'field:s'],
    }} />);
    await user.click(screen.getByRole('button', { name: 'Columns' }));
    await user.click(screen.getByRole('button', { name: 'Move n right' }));
    expect(headerIds().indexOf('field:n')).toBeGreaterThan(headerIds().indexOf('field:s'));
    expect(readState().columnOrder).toContain('field:missing');
  });

  it('does not claim an active sort for a column that became complex-only', () => {
    const initial = { ...INITIAL_RESULT_GRID_STATE, sorting: [{ id: 'field:obj', desc: false }] };
    render(<Harness rows={rows} initial={initial} />);
    expect(document.querySelector('th[data-column-id="field:obj"]')).not.toHaveAttribute('aria-sort');
    expect(screen.queryByText(/Sorted by obj/)).not.toBeInTheDocument();
    expect(readState().sorting).toEqual(initial.sorting);
  });

  it('manages visibility, position and layout reset from the column chooser', async () => {
    const user = userEvent.setup();
    render(<Harness rows={rows} />);
    await user.click(screen.getByRole('button', { name: 'Columns' }));
    const dialog = screen.getByRole('dialog');

    // Metadata labels stay distinct from source fields using the same spelling.
    expect(within(dialog).getByText('Row number')).toBeInTheDocument();
    expect(within(dialog).getByText('Index (_index)')).toBeInTheDocument();
    expect(within(dialog).getByText('Document ID (_id)')).toBeInTheDocument();
    expect(within(dialog).getAllByText('Source field')).toHaveLength(FIELD_NAMES.length);
    expect(within(dialog).getByText('_index')).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'Show column Row number' })).toBeDisabled();

    await user.click(within(dialog).getByRole('checkbox', { name: 'Show column n' }));
    expect(document.querySelector('th[data-column-id="field:n"]')).toBeNull();
    expect(readState().columnVisibility['field:n']).toBe(false);

    const before = headerIds();
    await user.click(within(dialog).getByRole('button', { name: 'Move s right' }));
    const after = headerIds();
    expect(after.indexOf('field:flag')).toBe(before.indexOf('field:s'));
    expect(after.indexOf('field:s')).toBe(before.indexOf('field:flag'));

    await user.click(within(dialog).getByRole('button', { name: 'Reset layout' }));
    expect(headerIds().slice(0, 5)).toEqual(['meta:row', 'meta:index', 'meta:id', 'field:n', 'field:s']);
    expect(readState()).toMatchObject({ columnOrder: [], columnSizing: {}, columnVisibility: {} });
  });

  it('applies externally controlled order, width and sorting on first render', () => {
    const initial: ResultGridState = {
      ...INITIAL_RESULT_GRID_STATE,
      columnOrder: ['field:s', 'meta:row', 'field:n'],
      columnSizing: { 'field:s': 180 },
      sorting: [{ id: 'field:n', desc: true }],
      pageIndex: 1,
    };
    render(<Harness rows={rows} initial={initial} />);

    expect(headerIds().slice(0, 4)).toEqual(['meta:row', 'field:s', 'field:n', 'meta:index']);
    expect(document.querySelector('th[data-column-id="field:s"] [role="separator"]')).toHaveAttribute('aria-valuenow', '180');
    expect(document.querySelector('th[data-column-id="field:n"]')).toHaveAttribute('aria-sort', 'descending');
    expect(readState()).toEqual(initial);
  });

  it('keeps preferences applied while hiding a column, then preserves them through a resize', async () => {
    const user = userEvent.setup();
    const initial: ResultGridState = {
      ...INITIAL_RESULT_GRID_STATE,
      columnOrder: ['field:s', 'meta:row', 'field:n'],
      columnSizing: { 'field:s': 180 },
      sorting: [{ id: 'field:n', desc: true }],
      pageIndex: 1,
    };
    render(<Harness rows={rows} initial={initial} />);
    expect(document.querySelector('th[data-column-id="field:s"] [role="separator"]')).toHaveAttribute('aria-valuenow', '180');
    expect(document.querySelector('th[data-column-id="field:n"]')).toHaveAttribute('aria-sort', 'descending');

    await user.click(screen.getByRole('button', { name: 'Columns' }));
    await user.click(screen.getByRole('checkbox', { name: 'Show column flag' }));
    const afterHide = readState();
    expect(afterHide.columnOrder).toEqual(['field:s', 'meta:row', 'field:n']);
    expect(afterHide.columnSizing).toEqual({ 'field:s': 180 });
    expect(afterHide.sorting).toEqual([{ id: 'field:n', desc: true }]);
    expect(afterHide.pageIndex).toBe(1);
    expect(afterHide.columnVisibility['field:flag']).toBe(false);

    await user.keyboard('{Escape}');
    const separator = screen.getByRole('separator', { name: 'Resize column s' });
    separator.focus();
    await user.keyboard('{ArrowRight}');
    const afterResize = readState();
    expect(afterResize.columnSizing['field:s']).toBe(192);
    expect(afterResize.columnOrder).toEqual(['field:s', 'meta:row', 'field:n']);
    expect(afterResize.sorting).toEqual([{ id: 'field:n', desc: true }]);
    expect(afterResize.columnVisibility['field:flag']).toBe(false);
    // resizing never touched sorting or ordering
    expect(document.querySelector('th[data-column-id="field:n"]')).toHaveAttribute('aria-sort', 'descending');
  });

  it('resizes with keyboard bounds and auto-fits on double-click without sorting', async () => {
    const user = userEvent.setup();
    render(<Harness rows={rows} initial={{ ...INITIAL_RESULT_GRID_STATE, sorting: [{ id: 'field:n', desc: false }] }} />);
    const separator = screen.getByRole('separator', { name: 'Resize column s' });
    const auto = Number(separator.getAttribute('aria-valuenow'));

    separator.focus();
    await user.keyboard('{ArrowRight}');
    expect(Number(separator.getAttribute('aria-valuenow'))).toBe(auto + 12);
    await user.keyboard('{Home}');
    expect(separator).toHaveAttribute('aria-valuenow', '64');
    expect(separator).toHaveAttribute('aria-valuemin', '64');
    expect(separator).toHaveAttribute('aria-valuemax', '480');
    await user.keyboard('{End}');
    expect(separator).toHaveAttribute('aria-valuenow', '480');

    fireEvent.doubleClick(separator);
    expect(Number(separator.getAttribute('aria-valuenow'))).toBe(auto);
    expect(readState().columnSizing['field:s']).toBeUndefined();

    expect(document.querySelector('th[data-column-id="field:n"]')).toHaveAttribute('aria-sort', 'ascending');
    expect(headerIds()[3]).toBe('field:n');
  });

  it('resizes through the actual mouse handler without changing sort or order', () => {
    render(<Harness rows={rows} />);
    const separator = screen.getByRole('separator', { name: 'Resize column n' });
    const before = Number(separator.getAttribute('aria-valuenow'));
    fireEvent.mouseDown(separator, { clientX: 100, button: 0 });
    fireEvent.mouseMove(document, { clientX: 140 });
    fireEvent.mouseUp(document, { clientX: 140 });
    expect(separator).toHaveAttribute('aria-valuenow', String(before + 40));
    expect(readState().sorting).toEqual([]);
    expect(headerIds().slice(0, 4)).toEqual(['meta:row', 'meta:index', 'meta:id', 'field:n']);
  });

  it('sorts full strings even when their bounded cell previews are identical', async () => {
    const user = userEvent.setup();
    const prefix = 'x'.repeat(180);
    const parsed = parseQueryResult(`{"hits":{"hits":[{"_id":"later","_source":{"n":"${prefix}b"}},`
      + `{"_id":"earlier","_source":{"n":"${prefix}a"}}]}}`);
    if (!parsed.ok) throw new Error('valid fixture required');
    const longRows = parsed.summary.hits.map((hit, position) => ({ hit, position, pageIndex: 0 }));
    render(<Harness rows={longRows} fieldNames={['n']} />);
    await user.click(sortButton('n'));
    expect(cellOf(bodyRows()[0] as Element, 'meta:id')).toBe('earlier');
  });

  it('exposes real drag handles for movable columns, with a locked row number', () => {
    render(<Harness rows={rows} />);
    const handle = screen.getByRole('button', { name: 'Reorder column n' });
    expect(handle).toHaveAttribute('aria-roledescription', 'sortable');
    expect(document.querySelector('th[data-column-id="meta:row"] button[aria-label^="Reorder"]')).toBeNull();
    expect(screen.getByText(/Press space or enter to lift the column/)).toBeInTheDocument();
  });

  it('disables complex-only sorting explicitly and keeps simple kinds sortable', () => {
    render(<Harness rows={rows} />);
    const objectSort = screen.getByRole('button', { name: 'Sort by obj' });
    expect(objectSort).toBeDisabled();
    expect(objectSort).toHaveAttribute('title', 'Not sortable in this grid');
    expect(document.querySelector('th[data-column-id="field:obj"]')).not.toHaveAttribute('aria-sort');
    expect(screen.getByRole('button', { name: 'Sort by tags' })).toBeDisabled();
    expect(sortButton('flag')).toBeEnabled();
    expect(sortButton('_index')).toBeEnabled();
  });

  it('states the loaded-row scope of sorting in the header tooltip and status', async () => {
    const user = userEvent.setup();
    render(<Harness rows={rows} />);
    expect(sortButton('n')).toHaveAttribute('title',
      'Sorting scope: 120 loaded rows.');
    await user.click(sortButton('n'));
    const status = screen.getByRole('status', { name: 'Sorted by n, ascending, within 120 loaded rows' });
    expect(status).toHaveAttribute('title',
      'Sorted by n, ascending, within 120 loaded rows');
    expect(status).toHaveTextContent('Local sort · 120 rows');
  });

  it('switches its controls and status copy to Chinese with the app language', async () => {
    const user = userEvent.setup();
    await i18n.changeLanguage('zh-CN');
    render(<Harness rows={rows} />);
    expect(screen.getByRole('button', { name: '列' })).toBeInTheDocument();
    expect(screen.getByText('已加载 120 行')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '按 n 排序' }));
    expect(screen.getByRole('status', { name: '已按 n 升序排序，范围为本表已加载的 120 行' }))
      .toHaveTextContent('本地排序 · 120 行');
    expect(document.querySelector('th[data-column-id="field:n"]')).toHaveAttribute('aria-sort', 'ascending');
  });

  it('opens a document only through its explicit action', async () => {
    const user = userEvent.setup();
    const onDocument = vi.fn();
    render(<Harness rows={rows} onDocument={onDocument} />);
    await user.click(screen.getByRole('button', { name: 'Document id-0' }));
    expect(onDocument).toHaveBeenCalledTimes(1);
    expect(readState().rowSelection).toEqual({});
    expect(onDocument.mock.calls[0]?.[0]).toMatchObject({ pageIndex: 0, position: 0 });
    fireEvent.doubleClick(bodyRows()[1] as Element);
    expect(onDocument).toHaveBeenCalledTimes(2);
    await user.click(sortButton('n'));
    expect(onDocument).toHaveBeenCalledTimes(2);
  });

  it('returns to the first page when the execution changes and keeps every preference', async () => {
    const user = userEvent.setup();
    const initial: ResultGridState = { ...INITIAL_RESULT_GRID_STATE, columnSizing: { 'field:n': 150 } };
    const view = render(<Harness rows={rows} initial={initial} executionKey="first" />);
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
    view.rerender(<Harness rows={rows} initial={initial} executionKey="second" />);
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    const state = readState();
    expect(state.pageIndex).toBe(0);
    expect(state.columnSizing).toEqual({ 'field:n': 150 });
  });

  it('keeps order and width when a field disappears temporarily and restores them later', async () => {
    const initial: ResultGridState = {
      ...INITIAL_RESULT_GRID_STATE,
      columnOrder: ['field:s', 'meta:row'],
      columnSizing: { 'field:s': 200 },
      sorting: [{ id: 'field:s', desc: false }],
    };
    const view = render(<Harness rows={rows} initial={initial} fieldNames={WITHOUT_S} />);
    expect(document.querySelector('th[data-column-id="field:s"]')).toBeNull();
    expect(readState()).toEqual(initial);

    view.rerender(<Harness rows={rows} initial={initial} fieldNames={FIELD_NAMES} />);
    expect(headerIds().slice(0, 2)).toEqual(['meta:row', 'field:s']);
    expect(document.querySelector('th[data-column-id="field:s"] [role="separator"]')).toHaveAttribute('aria-valuenow', '200');
    expect(document.querySelector('th[data-column-id="field:s"]')).toHaveAttribute('aria-sort', 'ascending');
    expect(readState()).toEqual(initial);
  });
});
