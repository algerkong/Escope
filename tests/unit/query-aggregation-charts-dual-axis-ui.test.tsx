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

const DSL = '{"size":0,"aggs":{"per":{"date_histogram":{"field":"at","fixed_interval":"1h"},'
  + '"aggs":{"total":{"sum":{"field":"amount"}},"uniq":{"cardinality":{"field":"id"}}}}}}';
const TERMS_DSL = '{"size":0,"aggs":{"kinds":{"terms":{"field":"kind"},"aggs":{"total":{"sum":{"field":"a"}}}}}}';
const fetchSpy = vi.fn();

function entryOf(dsl: string, aggregations: string, name: string): AggregationResult {
  const response = `{"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},"aggregations":${aggregations}}`;
  const result = readAggregationPage(dsl, response);
  if (!result.ok) throw new Error(`fixture rejected: ${result.code}`);
  const found = result.entries.find((entry) => entry.name === name);
  if (!found) throw new Error(`fixture entry missing: ${name}`);
  return found;
}

const histogram = (buckets: string) => entryOf(DSL, `{"per":{"buckets":[${buckets}]}}`, 'per');
const terms = (buckets: string) => entryOf(TERMS_DSL, `{"kinds":{"buckets":[${buckets}]}}`, 'kinds');

function panel(entry: AggregationResult, scope: Partial<AggregationChartScope> = {}) {
  const view = render(<I18nextProvider i18n={i18n}>
    <AggregationChart entry={entry} scope={{ target: 'orders-*', page: 1, bounds: null, limited: false, ...scope }} />
  </I18nextProvider>);
  return { ...view, user: userEvent.setup() };
}

const switchBox = () => screen.getByRole('switch', { name: enQueryAggregationCharts.dualToggle });
const leftTicks = (container: HTMLElement) => [...container.querySelectorAll('.qac-axis[data-axis="left"] .qac-tick')]
  .map((node) => node.textContent);
const rightTicks = (container: HTMLElement) => [...container.querySelectorAll('.qac-tick-right')].map((node) => node.textContent);
const primaryCy = (container: HTMLElement) => [...container.querySelectorAll('.qac-marker')]
  .filter((node) => !node.closest('.qac-series-secondary')).map((node) => node.getAttribute('cy'));
const positionLabels = (container: HTMLElement) => [...container.querySelectorAll('text.qac-tick')]
  .filter((node) => !node.closest('.qac-axis')).map((node) => node.textContent);
const notes = (name: string) => within(screen.getByRole('list', { name }));

beforeEach(async () => { await i18n.changeLanguage('en-US'); vi.stubGlobal('fetch', fetchSpy); });
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('dual-axis chart panel', () => {
  it('draws the second measure on its own right axis after an explicit overlay', async () => {
    const view = panel(histogram(
      '{"key":0,"key_as_string":"1970-01-01T00:00:00.000Z","doc_count":1,"total":{"value":400000}},'
      + '{"key":3600000,"doc_count":3,"total":{"value":800000}}',
    ));
    await view.findByRole('img');
    expect(view.container.querySelector('.qac-series-secondary')).toBeNull();
    await view.user.click(switchBox());
    expect(await view.findByRole('img')).toHaveAttribute('aria-label',
      'Dual-axis line chart of aggregation per: doc_count on the left axis (2 of 2 returned bucket starts) '
      + 'and total (sum) on the right axis (2 of 2), orders-*, received page 1');
    expect(view.container.querySelectorAll('.qac-series-secondary .qac-line')).toHaveLength(1);
    expect(view.container.querySelectorAll('.qac-series-secondary .qac-marker')).toHaveLength(2);
    expect(within(screen.getByRole('list', { name: 'Chart scope' })).getAllByText('Left axis measure').length).toBe(1);
    expect(screen.getByText(enQueryAggregationCharts.axesIndependent)).toBeVisible();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('scales each axis from its own returned values instead of normalising one series to the other', async () => {
    const view = panel(histogram(
      '{"key":0,"doc_count":1,"total":{"value":400000}},{"key":3600000,"doc_count":3,"total":{"value":800000}}',
    ));
    await view.findByRole('img');
    const untouched = primaryCy(view.container);
    await view.user.click(switchBox());
    expect(await screen.findByRole('combobox', { name: 'Right axis measure' })).toBeVisible();
    expect(leftTicks(view.container)).toEqual(['0', '0.5', '1', '1.5', '2', '2.5', '3']);
    expect(rightTicks(view.container)).toEqual(['0', '200000', '400000', '600000', '800000']);
    // The left series keeps its own geometry: a second axis never rescales it.
    expect(primaryCy(view.container)).toEqual(untouched);
  });

  it('keeps each measure unplotted list and precision notice separate instead of merging them', async () => {
    const view = panel(histogram(
      '{"key":0,"key_as_string":"1970-01-01T00:00:00.000Z","total":{"value":9007199254740993}},'
      + '{"key":3600000,"doc_count":2,"total":{"value":null}},'
      + '{"key":7200000,"doc_count":4,"total":{"value":9}}',
    ));
    await view.findByRole('img');
    await view.user.click(switchBox());
    expect(await screen.findByRole('combobox', { name: 'Right axis measure' })).toBeVisible();
    expect(notes('Notes for doc_count (left axis)').queryByText(
      '1 plotted values cannot be represented exactly as a double; tooltips and the table keep the original tokens.',
    )).toBeNull();
    expect(notes('Notes for total (sum) (right axis)').getByText(
      '1 plotted values cannot be represented exactly as a double; tooltips and the table keep the original tokens.',
    )).toBeVisible();
    expect(notes('Notes for doc_count (left axis)').queryByText(
      enQueryAggregationCharts.notice_bucketStarts)).toBeNull();
    expect(notes('Notes for the returned bucket starts, shared by both measures')
      .getByText(enQueryAggregationCharts.notice_bucketStarts)).toBeVisible();
    const left = screen.getByText(enQueryAggregationCharts.skippedForAxis
      .replace('{{measure}}', 'doc_count').replace('{{axis}}', 'left axis'));
    const right = screen.getByText(enQueryAggregationCharts.skippedForAxis
      .replace('{{measure}}', 'total (sum)').replace('{{axis}}', 'right axis'));
    expect(within(left.closest('.qac-skipped') as HTMLElement).getByText('"1970-01-01T00:00:00.000Z"')).toBeVisible();
    expect(within(left.closest('.qac-skipped') as HTMLElement).queryByText('7200000')).toBeNull();
    expect(within(right.closest('.qac-skipped') as HTMLElement).getByText('3600000')).toBeVisible();
    // The dashed second series breaks where only its own value was unusable.
    expect(view.container.querySelectorAll('.qac-series-secondary .qac-line')).toHaveLength(2);
    expect(view.container.querySelectorAll('.qac-series-secondary .qac-marker')).toHaveLength(2);
    expect(view.container.querySelectorAll('.qac-marker')).toHaveLength(4);
  });

  it('plots both series at returned positions with verbatim labels and no filled gap', async () => {
    const late = '"1970-01-01T02:00:00.000Z"';
    const early = '"1970-01-01T00:00:00.000Z"';
    const view = panel(histogram(
      `{"key":7200000,"key_as_string":${late},"doc_count":1,"total":{"value":2}},`
      + `{"key":0,"key_as_string":${early},"doc_count":5,"total":{"value":7}}`,
    ));
    await view.findByRole('img');
    await view.user.click(switchBox());
    expect(await screen.findByRole('combobox', { name: 'Right axis measure' })).toBeVisible();
    // Returned order and returned text: the axis only ever shortens for display.
    expect(positionLabels(view.container)).toEqual([
      `${late.slice(0, 19)}…`, `${early.slice(0, 19)}…`,
    ]);
    expect(view.container.querySelector('.qac-marker title')).toHaveTextContent(`${late}: 1`);
    expect(view.container.querySelector('.qac-series-secondary .qac-marker title'))
      .toHaveTextContent(`${late}: 2`);
    expect(within(screen.getByRole('list', { name: 'Chart scope' })).getAllByText('2 of 2 returned buckets')).toHaveLength(2);
  });

  it('refuses the pair when both selectors name the same measure instead of drawing one series', async () => {
    const view = panel(histogram('{"key":0,"doc_count":1,"total":{"value":2}}'));
    await view.findByRole('img');
    await view.user.click(switchBox());
    await view.user.selectOptions(screen.getByRole('combobox', { name: 'Plotted measure' }), 'total');
    expect(await screen.findByText(enQueryAggregationCharts.error_secondarySame)).toBeVisible();
    expect(view.container.querySelector('.qac-svg')).toBeNull();
    expect(view.queryByRole('img')).toBeNull();
  });

  it('refuses the whole plot when only the second measure has nothing plottable', async () => {
    const view = panel(histogram('{"key":0,"doc_count":1},{"key":3600000,"doc_count":3}'));
    await view.findByRole('img');
    await view.user.click(switchBox());
    expect(await screen.findByText(enQueryAggregationCharts.error_secondaryNoValues)).toBeVisible();
    expect(view.container.querySelector('.qac-svg')).toBeNull();
    expect(screen.getByText(enQueryAggregationCharts.skippedForAxis
      .replace('{{measure}}', 'total (sum)').replace('{{axis}}', 'right axis'))).toBeVisible();
    expect(screen.queryByText(enQueryAggregationCharts.skippedForAxis
      .replace('{{measure}}', 'doc_count').replace('{{axis}}', 'left axis'))).toBeNull();
  });

  it('keeps the shared bucket quota: 201 returned buckets still refuse both series', async () => {
    const many = Array.from({ length: CHART_LIMITS.buckets + 1 }, (_, index) =>
      `{"key":${index * 3600000},"doc_count":1,"total":{"value":2}}`).join(',');
    const view = panel(histogram(many));
    expect(await screen.findByText(enQueryAggregationCharts.error_tooManyBuckets
      .replace('{{limit}}', '200').replace('{{buckets}}', '201'))).toBeVisible();
    expect(view.container.querySelector('.qac-svg')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('draws a full 200-bucket pair while listing at most twelve returned labels', async () => {
    const many = Array.from({ length: CHART_LIMITS.buckets }, (_, index) =>
      `{"key":${index * 3600000},"doc_count":1,"total":{"value":2}}`).join(',');
    const view = panel(histogram(many));
    await view.findByRole('img');
    await view.user.click(switchBox());
    expect(await within(screen.getByRole('list', { name: 'Chart scope' }).parentElement!)
      .findAllByText('200 of 200 returned buckets')).toHaveLength(2);
    expect(view.container.querySelectorAll('.qac-marker')).toHaveLength(CHART_LIMITS.buckets * 2);
    expect(positionLabels(view.container)).toHaveLength(CHART_LIMITS.axisLabels);
  });

  it('offers terms overlay but leaves the second measure off until explicitly enabled', () => {
    const view = panel(terms('{"key":"a","doc_count":1,"total":{"value":2}}'));
    expect(view.getByRole('switch', { name: enQueryAggregationCharts.dualToggle })).not.toBeChecked();
    expect(view.container.querySelector('.qac-bar-secondary')).toBeNull();
  });

  it('switches language without redrawing any plotted value', async () => {
    const view = panel(histogram(
      '{"key":0,"doc_count":1,"total":{"value":400000}},{"key":3600000,"doc_count":3,"total":{"value":800000}}',
    ));
    await view.findByRole('img');
    await view.user.click(switchBox());
    expect(await screen.findByRole('combobox', { name: 'Right axis measure' })).toBeVisible();
    const geometry = { cy: primaryCy(view.container), right: rightTicks(view.container) };
    const secondaryCx = [...view.container.querySelectorAll('.qac-series-secondary .qac-marker')]
      .map((node) => node.getAttribute('cx'));
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', zhQueryAggregationCharts.summary_dual
      .replace('{{name}}', 'per').replace('{{primary}}', 'doc_count').replace('{{secondary}}', 'total（sum）')
      .replace('{{plottedPrimary}}', '2').replace('{{plottedSecondary}}', '2').replaceAll('{{buckets}}', '2')
      .replace('{{target}}', 'orders-*').replace('{{page}}', '1'));
    expect(screen.getByRole('combobox', { name: zhQueryAggregationCharts.measureRight })).toBeVisible();
    expect(screen.getByText(zhQueryAggregationCharts.axesIndependent)).toBeVisible();
    expect(screen.getByRole('switch', { name: zhQueryAggregationCharts.dualToggle })).toBeChecked();
    expect(primaryCy(view.container)).toEqual(geometry.cy);
    expect(rightTicks(view.container)).toEqual(geometry.right);
    expect([...view.container.querySelectorAll('.qac-series-secondary .qac-marker')].map((node) => node.getAttribute('cx')))
      .toEqual(secondaryCx);
    expect(Object.keys(zhQueryAggregationCharts).sort()).toEqual(Object.keys(enQueryAggregationCharts).sort());
  });
});

const body = (aggregations: string) => `{"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},`
  + `"hits":{"total":0,"hits":[]},"aggregations":${aggregations}}`;

function page(rawResponse: string): ExecutionPage {
  const parsed = parseQueryResult(rawResponse);
  if (!parsed.ok) throw new Error('valid fixture required');
  return { rawResponse, summary: parsed.summary, partial: false, cursor: '[1]' };
}

function fixture(rawPages: string[]) {
  const query: QueryDocument = { ...createQuery('c1'), index: 'orders-*', dsl: DSL };
  const snapshot = createSnapshot(query, 'request-1', new Date('2026-10-11T00:00:00Z'));
  const pages = rawPages.map(page);
  const last = pages.at(-1)!;
  const entry: ExecutionEntry = {
    state: { status: 'success', snapshot, rawResponse: last.rawResponse },
    parsed: { ok: true, summary: last.summary }, endpoint: 'https://executed.test', rawResponse: last.rawResponse,
    pages, pitId: 'fixture-pit', continuing: false, continuationError: null,
  };
  return { query, entry, snapshot, pages };
}

function setup(f = fixture([body('{"per":{"buckets":[{"key":0,"doc_count":1,"total":{"value":2}}]}}')])) {
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
  return { ...view, user: userEvent.setup(), wrap, f, onRun, onCancel, onLoadMore, onViewChange, onLayoutChange };
}

const region = () => screen.getByRole('region', { name: 'Aggregations' });
const a = () => within(region());

describe('dual-axis chart integration', () => {
  it('overlays a second measure without a single extra request, page load or view change', async () => {
    const f = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Aggregations' }));
    await f.user.click(a().getByRole('button', { name: 'Show chart' }));
    expect(await a().findByRole('img')).toBeVisible();
    await f.user.click(switchBox());
    expect(await a().findByRole('img')).toBeVisible();
    await f.user.selectOptions(a().getByRole('combobox', { name: 'Right axis measure' }), 'uniq');
    expect(screen.getByRole('list', { name: 'Chart scope' })).toHaveTextContent('uniq (cardinality)');
    expect(f.onRun).not.toHaveBeenCalled();
    expect(f.onLoadMore).not.toHaveBeenCalled();
    expect(f.onCancel).not.toHaveBeenCalled();
    expect(f.onViewChange).not.toHaveBeenCalled();
    expect(f.onLayoutChange).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('clears both series when the selected received page changes', async () => {
    const f = setup(fixture([body('{"per":{"buckets":[{"key":0,"doc_count":1,"total":{"value":2}}]}}')]));
    fireEvent.click(screen.getByRole('button', { name: 'Aggregations' }));
    await f.user.click(a().getByRole('button', { name: 'Show chart' }));
    await f.user.click(switchBox());
    expect(await screen.findByRole('combobox', { name: 'Right axis measure' })).toBeVisible();
    // A newer arriving page never replaces the plotted one; the open dual chart keeps page 1.
    f.rerender(f.wrap({
      entry: { ...f.f.entry, pages: [f.f.pages[0]!, page(body('{"per":{"buckets":[{"key":3600000,"doc_count":4,"total":{"value":5}}]}}'))] },
    }));
    expect(a().getByRole('img')).toHaveAccessibleName(/received page 1/);
    await f.user.selectOptions(a().getByRole('combobox', { name: 'Received page' }), '1');
    expect(a().queryByRole('img')).toBeNull();
    expect(a().queryByRole('switch', { name: enQueryAggregationCharts.dualToggle })).toBeNull();
    expect(a().getByRole('button', { name: 'Show chart' })).toHaveAttribute('aria-pressed', 'false');
    await f.user.click(a().getByRole('button', { name: 'Show chart' }));
    expect((await a().findByRole('img')).getAttribute('aria-label')).toContain('Line chart of doc_count');
    // The reopened chart is a fresh single series: the overlay never carries across received pages.
    expect(a().getByRole('switch', { name: enQueryAggregationCharts.dualToggle })).not.toBeChecked();
    expect(region().querySelector('.qac-series-secondary')).toBeNull();
    expect(f.onLoadMore).not.toHaveBeenCalled();
    expect(f.onRun).not.toHaveBeenCalled();
  });

  it('drops the overlay for a replacement snapshot identity', async () => {
    const f = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Aggregations' }));
    await f.user.click(a().getByRole('button', { name: 'Show chart' }));
    await f.user.click(switchBox());
    expect(await screen.findByRole('combobox', { name: 'Right axis measure' })).toBeVisible();
    f.rerender(f.wrap(fixture([body('{"per":{"buckets":[{"key":0,"doc_count":9,"total":{"value":1}}]}}')])));
    expect(screen.queryByRole('region', { name: 'Aggregations' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Aggregations' }));
    expect(a().queryByRole('img')).toBeNull();
    expect(a().queryByRole('switch', { name: enQueryAggregationCharts.dualToggle })).toBeNull();
  });
});
