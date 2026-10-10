import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHART_LIMITS } from '../../src/domain/query-aggregation-charts';
import { readAggregationPage, type AggregationResult } from '../../src/domain/query-aggregations';
import { createQuery, createSnapshot, type QueryDocument } from '../../src/domain/query';
import { parseQueryResult } from '../../src/domain/query-result';
import { AggregationChart, type AggregationChartScope } from '../../src/features/query/charts/AggregationChart';
import { QueryResults } from '../../src/features/query/QueryResults';
import type { ExecutionEntry, ExecutionPage } from '../../src/features/query/useQueryExecutions';
import { i18n } from '../../src/locales';
import { enQueryAggregationCharts, zhQueryAggregationCharts } from '../../src/locales/query-aggregation-charts';

const TERMS_DSL = '{"size":0,"aggs":{"kinds":{"terms":{"field":"kind","size":250},'
  + '"aggs":{"total":{"sum":{"field":"amount"}}}}}}';
const HISTOGRAM_DSL = '{"size":0,"aggs":{"per":{"date_histogram":{"field":"at","fixed_interval":"1h"}}}}';
const METRIC_DSL = '{"size":0,"aggs":{"amount":{"sum":{"field":"amount"}},"unique":{"cardinality":{"field":"id"}}}}';
const fetchSpy = vi.fn();

function entryOf(dsl: string, aggregations: string, name: string): AggregationResult {
  const response = `{"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},"aggregations":${aggregations}}`;
  const result = readAggregationPage(dsl, response);
  if (!result.ok) throw new Error(`fixture rejected: ${result.code}`);
  const found = result.entries.find((entry) => entry.name === name);
  if (!found) throw new Error(`fixture entry missing: ${name}`);
  return found;
}

function terms(buckets: string, extra = ''): AggregationResult {
  return entryOf(TERMS_DSL, `{"kinds":{"buckets":[${buckets}]${extra}}}`, 'kinds');
}

function histogram(buckets: string): AggregationResult {
  return entryOf(HISTOGRAM_DSL, `{"per":{"buckets":[${buckets}]}}`, 'per');
}

function scopeOf(overrides: Partial<AggregationChartScope> = {}): AggregationChartScope {
  return { target: 'orders-*', page: 1, bounds: null, limited: false, ...overrides };
}

function panel(entry: AggregationResult, overrides: Partial<AggregationChartScope> = {}) {
  const view = render(<I18nextProvider i18n={i18n}><AggregationChart entry={entry} scope={scopeOf(overrides)} /></I18nextProvider>);
  return { ...view, user: userEvent.setup() };
}

const termsList = (prefix: string, count: number, value: number | null = 1) => Array.from({ length: count }, (_, index) =>
  `{"key":"${prefix}-${index}"${value === null ? '' : `,"doc_count":${value}`}}`).join(',');

beforeEach(async () => { await i18n.changeLanguage('en-US'); vi.stubGlobal('fetch', fetchSpy); });
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('aggregation chart panel', () => {
  it('draws one bar per plottable returned term, keeps a real zero and lists the skipped bucket', async () => {
    const view = panel(terms('{"key":"a","doc_count":3},{"key":"b"},{"key":"c","doc_count":0}'));
    const chart = await view.findByRole('img');
    expect(chart).toHaveAttribute('aria-label', 'Bar chart of doc_count for aggregation kinds: 2 of 3 returned buckets, orders-*, received page 1');
    expect(view.container.querySelectorAll('.qac-bar')).toHaveLength(2);
    expect(view.container.querySelectorAll('.qac-bar')[1]).toHaveAttribute('height', '0');
    expect(view.container.querySelectorAll('.qac-tick')).not.toHaveLength(0);
    expect(screen.getByText(enQueryAggregationCharts.notice_termsScope)).toBeVisible();
    expect(screen.getByText('1 returned values are not plotted', { exact: false })).toBeVisible();
    expect(view.container.querySelector('.qac-skipped code')).toHaveTextContent('"b"');
    expect(screen.getByText(enQueryAggregationCharts.reason_missing)).toBeVisible();
    expect(screen.queryByRole('img', { name: /Line chart/ })).toBeNull();
  });

  it('annotates the frozen target, page, measure and verbatim bounds without reparsing them', async () => {
    panel(terms('{"key":"a","doc_count":1}'), {
      target: 'logs-2026', page: 3, limited: true,
      bounds: { resolvedAt: '2026-10-10T00:00:00.000Z', from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' },
    });
    expect(await screen.findByRole('img')).toBeVisible();
    expect(screen.getByText('logs-2026')).toBeVisible();
    expect(screen.getByText('Page 3')).toBeVisible();
    expect(screen.getByText('2026-10-01T00:00:00.000Z')).toBeVisible();
    expect(screen.getByText('2026-10-02T00:00:00.000Z')).toBeVisible();
    expect(screen.getByText(enQueryAggregationCharts.pageLimits)).toBeVisible();
  });

  it('re-plots an explicitly selected metric without querying, paging or changing the result view', async () => {
    const view = panel(terms('{"key":"a","doc_count":3,"total":{"value":2.5}},{"key":"b","doc_count":1,"total":{"value":null}}'));
    await view.findByRole('img');
    await view.user.selectOptions(screen.getByRole('combobox', { name: 'Plotted measure' }), 'total');
    expect(screen.getByRole('combobox', { name: 'Plotted measure' })).toHaveValue('total');
    expect(within(screen.getByRole('list', { name: 'Chart scope' })).getByText('total (sum)')).toBeVisible();
    expect(view.container.querySelectorAll('.qac-bar')).toHaveLength(1);
    expect(screen.getByText(enQueryAggregationCharts.reason_null)).toBeVisible();
    expect(screen.getByText(enQueryAggregationCharts.displayOnly)).toBeVisible();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('breaks the line where a bucket value was not returned instead of dropping it to zero', async () => {
    const view = panel(histogram('{"key":0,"doc_count":1},{"key":3600000},{"key":7200000,"doc_count":3}'));
    const chart = await view.findByRole('img');
    expect(chart.getAttribute('aria-label'))
      .toBe('Line chart of doc_count across aggregation per: 2 of 3 returned bucket starts, orders-*, received page 1');
    expect(view.container.querySelectorAll('.qac-line')).toHaveLength(2);
    expect(view.container.querySelectorAll('.qac-marker')).toHaveLength(2);
    expect(screen.getByText(enQueryAggregationCharts.notice_sparseSeries)).toBeVisible();
    expect(screen.getByText(enQueryAggregationCharts.notice_bucketStarts)).toBeVisible();
    expect(view.container.querySelector('.qac-line')?.getAttribute('d')).not.toContain('NaN');
  });

  it('refuses an over-budget entry as a whole and leaves the bucket table as the complete list', () => {
    const view = panel(terms(termsList('k', CHART_LIMITS.buckets + 1)));
    expect(screen.getByText(enQueryAggregationCharts.error_tooManyBuckets.replace('{{limit}}', '200').replace('{{buckets}}', '201')))
      .toBeVisible();
    expect(view.container.querySelector('.qac-svg')).toBeNull();
    expect(view.queryByRole('img')).toBeNull();
  });

  it('draws nothing instead of zeros when no returned value can be plotted', () => {
    const view = panel(terms('{"key":"a"},{"key":"b"}'));
    expect(screen.getByText(enQueryAggregationCharts.error_noPlottableValues)).toBeVisible();
    expect(screen.getByText('2 returned values are not plotted', { exact: false })).toBeVisible();
    expect(view.container.querySelectorAll('.qac-bar')).toHaveLength(0);
    expect(view.queryByRole('img')).toBeNull();
  });

  it('flags a plotted double that is not the returned token and keeps the token in the tooltip', async () => {
    const view = panel(terms('{"key":"a","doc_count":1,"total":{"value":9007199254740993}}'));
    await view.findByRole('img');
    await view.user.selectOptions(screen.getByRole('combobox', { name: 'Plotted measure' }), 'total');
    expect(screen.getByText('1 plotted values cannot be represented exactly as a double; tooltips and the table keep the original tokens.')).toBeVisible();
    const bar = view.container.querySelector('.qac-bar');
    expect(bar).toHaveAttribute('data-precise', 'false');
    expect(bar?.querySelector('title')).toHaveTextContent('9007199254740993 plotted as 9007199254740992');
  });

  it('keeps a single metric value as its original token without loading the drawing library', () => {
    const view = panel(entryOf(METRIC_DSL, '{"amount":{"value":9007199254740993},"unique":{"value":7}}', 'amount'));
    expect(view.container.querySelector('.qac-single code')).toHaveTextContent('9007199254740993');
    expect(screen.getByText(enQueryAggregationCharts.plottedAs.replace('{{raw}}', '9007199254740993').replace('{{value}}', '9007199254740992'))).toBeVisible();
    expect(view.queryByRole('img')).toBeNull();
    expect(view.container.querySelector('.qac-svg')).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Plotted measure' })).toBeNull();
    expect(view.getByRole('group')).toHaveAttribute('aria-label', 'Single value amount from orders-*, received page 1');
    expect(screen.getByRole('list', { name: 'Chart scope' })).toHaveTextContent('amount (sum)');
  });

  it('marks an approximate measure and does not plot an unsupported entry', () => {
    const approximate = panel(entryOf(METRIC_DSL, '{"amount":{"value":2},"unique":{"value":7}}', 'unique'));
    expect(screen.getByText(enQueryAggregationCharts.notice_approximate)).toBeVisible();
    expect(approximate.container.querySelector('.qac-single code')).toHaveTextContent('7');
    approximate.unmount();
    const unsupported = panel(entryOf('{"size":0,"aggs":{"p":{"percentiles":{"field":"n"}}}}', '{"p":{"values":{"1.0":2}}}', 'p'));
    expect(screen.getByText(enQueryAggregationCharts.error_unplottable)).toBeVisible();
    expect(unsupported.queryByRole('img')).toBeNull();
  });

  it('summarises skipped values beyond the inline limit without hiding their count', () => {
    const view = panel(terms(termsList('k', CHART_LIMITS.listedSkipped + 2, null)));
    expect(view.container.querySelectorAll('.qac-skipped li')).toHaveLength(CHART_LIMITS.listedSkipped + 1);
    expect(screen.getByText(enQueryAggregationCharts.skippedMore.replace('{{count}}', '2'))).toBeVisible();
    expect(screen.getByText('12 returned values are not plotted', { exact: false })).toBeVisible();
  });

  it('renders hostile bucket text as text and never as markup', async () => {
    const view = panel(terms('{"key":"<img src=x>","doc_count":1}'));
    await view.findByRole('img');
    expect(view.container.querySelector('image,script,iframe,a,foreignObject')).toBeNull();
    expect(screen.getAllByText('"<img src=x>"').length).toBeGreaterThan(0);
    expect(view.container.querySelector('.qac-bar title')).toHaveTextContent('"<img src=x>": 1');
  });

  it('switches language without redrawing from another source and keeps both locales in sync', async () => {
    const view = panel(terms('{"key":"a","doc_count":1}'));
    await view.findByRole('img');
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', '条形图：聚合 kinds 的 doc_count，1 / 1 个已返回桶，orders-*，第 1 个接收页');
    expect(screen.getByText(zhQueryAggregationCharts.notice_termsScope)).toBeVisible();
    expect(screen.getByRole('combobox', { name: '绘图度量' })).toHaveValue('doc_count');
    expect(Object.keys(zhQueryAggregationCharts).sort()).toEqual(Object.keys(enQueryAggregationCharts).sort());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

const PAGE_DSL = '{"size":0,"aggs":{"kinds":{"terms":{"field":"kind","size":5}}}}';

function body(aggregations: string) {
  return `{"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},"hits":{"total":0,"hits":[]},"aggregations":${aggregations}}`;
}

function page(rawResponse: string): ExecutionPage {
  const parsed = parseQueryResult(rawResponse);
  if (!parsed.ok) throw new Error('valid fixture required');
  return { rawResponse, summary: parsed.summary, partial: false, cursor: '[1]' };
}

function fixture(rawPages: string[] = [body('{"kinds":{"buckets":[{"key":"a","doc_count":3},{"key":"b","doc_count":1}]}}')]) {
  const query: QueryDocument = { ...createQuery('c1'), index: 'orders-*', dsl: PAGE_DSL };
  const snapshot = createSnapshot(query, 'request-1', new Date('2026-10-10T00:00:00Z'));
  const pages = rawPages.map(page);
  const last = pages.at(-1)!;
  const entry: ExecutionEntry = {
    state: { status: 'success', snapshot, rawResponse: last.rawResponse },
    parsed: { ok: true, summary: last.summary }, endpoint: 'https://executed.test', rawResponse: last.rawResponse,
    pages, pitId: 'fixture-pit', continuing: false, continuationError: null,
  };
  return { query, entry, snapshot, pages };
}

function setup(f = fixture()) {
  const onRun = vi.fn();
  const onCancel = vi.fn();
  const onLoadMore = vi.fn();
  const onViewChange = vi.fn();
  const onLayoutChange = vi.fn();
  const props = { ...f, available: true, stale: false, endpointChanged: false, onRun, onCancel, onLoadMore, onViewChange, onLayoutChange };
  const wrap = (next: Partial<Parameters<typeof QueryResults>[0]> = {}) => <I18nextProvider i18n={i18n}>
    <QueryResults {...props} {...next} />
  </I18nextProvider>;
  const view = render(wrap());
  const user = userEvent.setup();
  return { ...view, user, wrap, f, onRun, onCancel, onLoadMore, onViewChange, onLayoutChange };
}

const region = () => screen.getByRole('region', { name: 'Aggregations' });
const a = () => within(region());
const chartScope = () => within(a().getByRole('list', { name: 'Chart scope' }));

describe('aggregation view chart integration', () => {
  it('mounts a chart only after an explicit open and keeps the bucket table and view state untouched', async () => {
    const f = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Aggregations' }));
    expect(a().queryByRole('button', { name: 'Show chart' })).not.toBeNull();
    expect(a().queryByRole('list', { name: 'Chart scope' })).toBeNull();
    expect(a().queryByRole('img')).toBeNull();
    await f.user.click(a().getByRole('button', { name: 'Show chart' }));
    expect(await a().findByRole('img')).toBeVisible();
    expect(a().getByRole('button', { name: 'Hide chart' })).toHaveAttribute('aria-pressed', 'true');
    expect(a().getAllByRole('row').length).toBeGreaterThan(1);
    expect(a().getByText(enQueryAggregationCharts.displayOnly)).toBeVisible();
    expect(f.onRun).not.toHaveBeenCalled();
    expect(f.onLoadMore).not.toHaveBeenCalled();
    expect(f.onCancel).not.toHaveBeenCalled();
    expect(f.onViewChange).not.toHaveBeenCalled();
    expect(f.onLayoutChange).not.toHaveBeenCalled();
    await f.user.click(a().getByRole('button', { name: 'Hide chart' }));
    expect(a().queryByRole('img')).toBeNull();
  });

  it('closes with the aggregation view on a replacement snapshot, on leaving and on another result view', async () => {
    const f = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Aggregations' }));
    await f.user.click(a().getByRole('button', { name: 'Show chart' }));
    expect(await a().findByRole('img')).toBeVisible();
    f.rerender(f.wrap({ active: false }));
    expect(screen.queryByRole('region', { name: 'Aggregations' })).toBeNull();
    f.rerender(f.wrap({ active: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Aggregations' }));
    expect(a().queryByRole('img')).toBeNull();
    expect(a().getByRole('button', { name: 'Show chart' })).not.toBeNull();
    await f.user.click(a().getByRole('button', { name: 'Show chart' }));
    expect(await a().findByRole('img')).toBeVisible();
    // A reused request id is still a new snapshot identity, so the session chart is dropped.
    f.rerender(f.wrap(fixture([body('{"kinds":{"buckets":[{"key":"z","doc_count":9}]}}')])));
    expect(screen.queryByRole('region', { name: 'Aggregations' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Aggregations' }));
    expect(a().queryByRole('img')).toBeNull();
    expect(a().getByLabelText('key, bucket 1')).toHaveTextContent('"z"');
  });

  it('keeps plotting the selected page when another arrives and reopens closed for the new one', async () => {
    const f = setup(fixture([body('{"kinds":{"buckets":[{"key":"a","doc_count":3}]}}')]));
    fireEvent.click(screen.getByRole('button', { name: 'Aggregations' }));
    await f.user.click(a().getByRole('button', { name: 'Show chart' }));
    expect((await a().findByRole('img')).getAttribute('aria-label')).toContain('1 of 1 returned buckets');
    const continued = body('{"kinds":{"buckets":[{"key":"b","doc_count":4},{"key":"c","doc_count":5}]}}');
    f.rerender(f.wrap({ entry: { ...f.f.entry, pages: [f.f.pages[0]!, page(continued)] } }));
    expect((await a().findByRole('img')).getAttribute('aria-label')).toContain('1 of 1 returned buckets');
    expect(chartScope().getByText('Page 1')).toBeVisible();
    await f.user.selectOptions(a().getByRole('combobox', { name: 'Received page' }), '1');
    expect(a().queryByRole('img')).toBeNull();
    expect(a().getByRole('button', { name: 'Show chart' })).toHaveAttribute('aria-pressed', 'false');
    await f.user.click(a().getByRole('button', { name: 'Show chart' }));
    expect((await a().findByRole('img')).getAttribute('aria-label')).toContain('2 of 2 returned buckets');
    expect(chartScope().getByText('Page 2')).toBeVisible();
    expect(f.onLoadMore).not.toHaveBeenCalled();
    expect(f.onRun).not.toHaveBeenCalled();
    expect(f.onViewChange).not.toHaveBeenCalled();
  });

  it('does not offer a chart for a locked index preview or a different query identity', () => {
    const f = setup();
    f.rerender(f.wrap({ kind: 'preview' }));
    expect(screen.queryByRole('button', { name: 'Aggregations' })).toBeNull();
    f.rerender(f.wrap({ query: { ...f.f.query, id: 'other-query' } }));
    expect(screen.queryByRole('button', { name: 'Aggregations' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show chart' })).toBeNull();
  });
});
