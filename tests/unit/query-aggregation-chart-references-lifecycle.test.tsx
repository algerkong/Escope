import { fireEvent, render, screen, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuery, createSnapshot } from '../../src/domain/query';
import { parseQueryResult } from '../../src/domain/query-result';
import { readAggregationPage } from '../../src/domain/query-aggregations';
import { AggregationChart, type AggregationChartScope } from '../../src/features/query/charts/AggregationChart';
import { QueryResults } from '../../src/features/query/QueryResults';
import type { ExecutionEntry, ExecutionPage } from '../../src/features/query/useQueryExecutions';
import { i18n } from '../../src/locales';
import { enQueryAggregationCharts as text } from '../../src/locales/query-aggregation-charts';

const GROUP = { terms: { field: 'kind' }, aggs: { total: { sum: { field: 'amount' } }, mean: { avg: { field: 'duration' } } } };
const DSL = JSON.stringify({ aggs: { first: GROUP, other: GROUP } });
const response = (key = 'original', value = 100) => JSON.stringify({
  hits: { total: 0, hits: [] },
  aggregations: {
    first: { buckets: [{ key, doc_count: 10, total: { value }, mean: { value: 50 } }] },
    other: { buckets: [{ key, doc_count: 10, total: { value }, mean: { value: 50 } }] },
  },
});
const fetchSpy = vi.fn();

function page(rawResponse = response()): ExecutionPage {
  const parsed = parseQueryResult(rawResponse);
  if (!parsed.ok) throw new Error('valid fixture');
  return { rawResponse, summary: parsed.summary, partial: false, cursor: '[1]' };
}

function fixture() {
  const query = { ...createQuery('connection1'), index: 'events-*', dsl: DSL };
  const snapshot = createSnapshot(query, 'request1', new Date('2026-10-15T00:00:00Z'));
  const first = page();
  const entry: ExecutionEntry = {
    state: { status: 'success', snapshot, rawResponse: first.rawResponse }, endpoint: 'https://executed.test',
    rawResponse: first.rawResponse, parsed: { ok: true, summary: first.summary }, pages: [first],
    pitId: 'unchanged-pit', continuing: false, continuationError: null,
  };
  const actions = { onRun: vi.fn(), onCancel: vi.fn(), onLoadMore: vi.fn(), onViewChange: vi.fn(), onLayoutChange: vi.fn() };
  const wrap = (next: Partial<ComponentProps<typeof QueryResults>> = {}) => <I18nextProvider i18n={i18n}>
    <QueryResults query={query} entry={entry} available stale={false} endpointChanged={false} {...actions} {...next} />
  </I18nextProvider>;
  return { ...render(wrap()), wrap, query, snapshot, entry, first, actions };
}

async function openChart(openView = true) {
  if (openView) fireEvent.click(screen.getByRole('button', { name: 'Aggregations' }));
  fireEvent.click(screen.getByRole('button', { name: text.open }));
  await screen.findByRole('img');
}
function add(axis = 'left', raw = '5.00', apply = true) {
  fireEvent.click(screen.getByRole('button', { name: text.referenceAdd }));
  fireEvent.change(screen.getByRole('combobox', { name: text.referenceAxis }), { target: { value: axis } });
  fireEvent.change(screen.getByRole('textbox', { name: text.referenceValue }), { target: { value: raw } });
  if (apply) fireEvent.click(screen.getByRole('button', { name: text.referenceApply }));
}
function noReferences(root: HTMLElement) {
  expect(root.querySelectorAll('.qac-reference-row, .qac-reference-line')).toHaveLength(0);
  expect(screen.queryByRole('dialog')).toBeNull();
}
function noActions(actions: ReturnType<typeof fixture>['actions']) {
  for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();
}

beforeEach(async () => { await i18n.changeLanguage('en-US'); vi.stubGlobal('fetch', fetchSpy); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('reference execution and page lifecycle', () => {
  it('retains the chosen page and its references across PIT continuation and current draft edits without mutating any source', async () => {
    const f = fixture();
    const before = JSON.stringify({ query: f.query, snapshot: f.snapshot, entry: f.entry });
    await openChart();
    fireEvent.click(screen.getByRole('switch', { name: text.dualToggle }));
    add('right', '25.000');
    const geometry = f.container.querySelector('.qac-reference-line')?.outerHTML;
    const continued = { ...f.entry, pages: [f.first, page(response('later', 900))] };
    f.rerender(f.wrap({
      entry: continued, stale: true,
      query: { ...f.query, dsl: '{"query":{"match_all":{}}}', index: 'draft-*' },
    }));
    expect(screen.getByRole('img')).toHaveAccessibleName(/events-\*, received page 1/);
    expect(screen.getByRole('listitem', { name: 'Reference 1' })).toHaveTextContent('25.000');
    expect(f.container.querySelector('.qac-reference-line')?.outerHTML).toBe(geometry);
    expect(JSON.stringify({ query: f.query, snapshot: f.snapshot, entry: f.entry })).toBe(before);
    expect(continued.pitId).toBe('unchanged-pit');
    noActions(f.actions);
  });

  it('clears applied lines and an unfinished editor on a selected page change, with no reuse on returning', async () => {
    const f = fixture();
    const extended = { ...f.entry, pages: [f.first, page(response('later', 900))] };
    f.rerender(f.wrap({ entry: extended }));
    await openChart();
    add();
    add('left', '7.00', false);
    fireEvent.change(screen.getByRole('combobox', { name: 'Received page', hidden: true }), { target: { value: '1' } });
    noReferences(f.container);
    await openChart(false);
    noReferences(f.container);
    expect(screen.getByRole('img')).toHaveAccessibleName(/received page 2/);
    fireEvent.change(screen.getByRole('combobox', { name: 'Received page' }), { target: { value: '0' } });
    await openChart(false);
    noReferences(f.container);
    noActions(f.actions);
  });

  it('clears on switching aggregations even when their bucket and measure names are identical', async () => {
    const f = fixture();
    await openChart();
    add();
    const selector = screen.getByRole('combobox', { name: 'Aggregation' });
    fireEvent.change(selector, { target: { value: 'other' } });
    noReferences(f.container);
    await openChart(false);
    noReferences(f.container);
    fireEvent.change(selector, { target: { value: 'first' } });
    await openChart(false);
    noReferences(f.container);
    noActions(f.actions);
  });

  it.each(['new identity', 'connection', 'endpoint', 'target'] as const)('clears on an execution source change: %s', async (change) => {
    const f = fixture();
    await openChart();
    add();
    add('left', '7', false);
    if (change === 'endpoint') {
      f.rerender(f.wrap({ entry: { ...f.entry, endpoint: 'https://different.test' } }));
      await openChart(false);
    } else {
      const query = { ...f.query, ...(change === 'connection' ? { connectionId: 'connection2' }
        : change === 'target' ? { index: 'different-*' } : {}) };
      // Even identical request ID, time and contents do not make a new snapshot object the old execution.
      const snapshot = createSnapshot(query, f.snapshot.requestId, new Date(f.snapshot.startedAt));
      f.rerender(f.wrap({ entry: { ...f.entry, state: { status: 'success', snapshot, rawResponse: f.first.rawResponse } } }));
      await openChart();
    }
    noReferences(f.container);
    noActions(f.actions);
  });

  it('discards applied and unsubmitted references when the same page slot receives a different page object', async () => {
    const f = fixture();
    await openChart();
    add();
    add('left', '7', false);
    f.rerender(f.wrap({ entry: { ...f.entry, pages: [page(response('replacement'))] } }));
    noReferences(f.container);
    expect(screen.getByRole('img')).toBeVisible();
    noActions(f.actions);
  });

  it.each(['close', 'inactive', 'view'] as const)('drops all reference state on %s and does not restore it on reopening', async (action) => {
    const f = fixture();
    await openChart();
    add();
    if (action === 'close') {
      fireEvent.click(screen.getByRole('button', { name: text.close }));
      await openChart(false);
    } else if (action === 'inactive') {
      f.rerender(f.wrap({ active: false }));
      f.rerender(f.wrap({ active: true }));
      await openChart();
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Table' }));
      expect(f.actions.onViewChange).toHaveBeenCalledExactlyOnceWith('table');
      f.actions.onViewChange.mockClear();
      await openChart();
    }
    noReferences(f.container);
    noActions(f.actions);
  });

  it('clears both axes on either measure change, overlay off/on, or a refused pair; no reference silently changes axes', async () => {
    const f = fixture();
    await openChart();
    fireEvent.click(screen.getByRole('switch', { name: text.dualToggle }));
    add('left', '5');
    add('right', '50');
    fireEvent.change(screen.getByRole('combobox', { name: text.measureRight }), { target: { value: 'mean' } });
    noReferences(f.container);
    add('right', '25');
    fireEvent.change(screen.getByRole('combobox', { name: text.measure }), { target: { value: 'total' } });
    noReferences(f.container);
    add('left', '50');
    fireEvent.click(screen.getByRole('switch', { name: text.dualToggle }));
    noReferences(f.container);
    add('left', '50');
    fireEvent.click(screen.getByRole('switch', { name: text.dualToggle }));
    noReferences(f.container);
    add('left', '50');
    fireEvent.change(screen.getByRole('combobox', { name: text.measure }), { target: { value: 'doc_count' } });
    expect(screen.getByText(text.error_secondarySame)).toBeVisible();
    noReferences(f.container);
    fireEvent.change(screen.getByRole('combobox', { name: text.measure }), { target: { value: 'total' } });
    await screen.findByRole('img');
    noReferences(f.container);
    noActions(f.actions);
  });

  it('also keys a standalone chart session by its displayed frozen target and received page', async () => {
    const parsed = readAggregationPage(DSL, response());
    if (!parsed.ok) throw new Error('valid fixture');
    const entry = parsed.entries[0]!;
    const wrap = (scope: AggregationChartScope) => <I18nextProvider i18n={i18n}>
      <AggregationChart entry={entry} scope={scope} />
    </I18nextProvider>;
    const scope = { target: 'events-*', page: 1, bounds: null, limited: false };
    const view = render(wrap(scope));
    await screen.findByRole('img');
    add();
    view.rerender(wrap({ ...scope, page: 2 }));
    noReferences(view.container);
    add();
    view.rerender(wrap({ ...scope, page: 2, target: 'other-*' }));
    noReferences(view.container);
  });

  it('offers no reference control for a single-value chart', async () => {
    const parsed = readAggregationPage('{"aggs":{"one":{"sum":{"field":"amount"}}}}', '{"aggregations":{"one":{"value":1}}}');
    if (!parsed.ok) throw new Error('valid fixture');
    render(<I18nextProvider i18n={i18n}>
      <AggregationChart entry={parsed.entries[0]!} scope={{ target: 'events', page: 1, bounds: null, limited: false }} />
    </I18nextProvider>);
    expect(within(screen.getByRole('group')).getByText('1')).toBeVisible();
    expect(screen.queryByRole('button', { name: text.referenceAdd })).toBeNull();
  });
});
