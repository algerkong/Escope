import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readAggregationPage } from '../../src/domain/query-aggregations';
import { createQuery, createSnapshot } from '../../src/domain/query';
import { parseQueryResult } from '../../src/domain/query-result';
import { AggregationChart } from '../../src/features/query/charts/AggregationChart';
import { QueryResults } from '../../src/features/query/QueryResults';
import type { ExecutionEntry, ExecutionPage } from '../../src/features/query/useQueryExecutions';
import { i18n } from '../../src/locales';
import { enQueryAggregationCharts, zhQueryAggregationCharts } from '../../src/locales/query-aggregation-charts';

const DSL = '{"aggs":{"kinds":{"terms":{"field":"kind"},"aggs":{"total":{"sum":{"field":"amount"}}}}}}';
const TWO = '{"key":"a","doc_count":1,"total":{"value":400000}},{"key":"b","doc_count":3,"total":{"value":800000}}';
const fetchSpy = vi.fn();
const body = (buckets: string) => '{"hits":{"total":0,"hits":[]},"aggregations":{"kinds":'
  + `{"doc_count_error_upper_bound":0,"sum_other_doc_count":5,"buckets":[${buckets}]}}}`;

function panel(buckets = TWO) {
  const parsed = readAggregationPage(DSL, body(buckets));
  if (!parsed.ok || !parsed.entries[0]) throw new Error('valid aggregation fixture');
  return render(<I18nextProvider i18n={i18n}>
    <AggregationChart entry={parsed.entries[0]} scope={{ target: 'events-*', page: 1, limited: false, bounds: null }} />
  </I18nextProvider>);
}

const primary = (root: HTMLElement) => [...root.querySelectorAll('.qac-bar:not(.qac-bar-secondary)')];
const secondary = (root: HTMLElement) => [...root.querySelectorAll('.qac-bar-secondary')];
const numeric = (element: Element, name: string) => Number(element.getAttribute(name));
const valueGeometry = (elements: Element[]) => elements.map((element) => [numeric(element, 'y'), numeric(element, 'height')]);
const allGeometry = (root: HTMLElement) => [...root.querySelectorAll('.qac-bar')].map((element) =>
  ['x', 'y', 'width', 'height'].map((name) => numeric(element, name)));
const toggle = () => fireEvent.click(screen.getByRole('switch', { name: enQueryAggregationCharts.dualToggle }));

beforeEach(async () => { await i18n.changeLanguage('en-US'); vi.stubGlobal('fetch', fetchSpy); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); fetchSpy.mockClear(); vi.unstubAllGlobals(); });

describe('terms dual-axis chart UI', () => {
  it('uses paired bars, independent axes and unchanged primary value geometry', async () => {
    const view = panel();
    await screen.findByRole('img');
    const before = valueGeometry(primary(view.container));
    const widthBefore = numeric(primary(view.container)[0]!, 'width');
    toggle();
    const chart = screen.getByRole('img', { name: /Dual-axis bar chart/ });
    expect(primary(view.container)).toHaveLength(2);
    expect(secondary(view.container)).toHaveLength(2);
    expect(valueGeometry(primary(view.container))).toEqual(before);
    expect(numeric(primary(view.container)[0]!, 'width')).toBeLessThan(widthBefore);
    primary(view.container).forEach((left, index) => {
      const right = secondary(view.container)[index]!;
      expect(numeric(left, 'x') + numeric(left, 'width')).toBeLessThan(numeric(right, 'x'));
      expect(right.getAttribute('data-row')).toBe(left.getAttribute('data-row'));
    });
    expect(within(chart).getByText('Left axis: doc_count')).toBeInTheDocument();
    expect(within(chart).getByText('Right axis: total (sum)')).toBeInTheDocument();
    expect(chart.querySelector('[data-axis="left"]')?.textContent).toContain('3');
    expect(chart.querySelector('[data-axis="right"]')?.textContent).toContain('800000');
    expect(secondary(view.container)[0]?.querySelector('title')).toHaveTextContent('total (sum) "a": 400000');
    expect(screen.getByText(enQueryAggregationCharts.axesIndependent)).toBeVisible();
    const shared = screen.getByRole('list', { name: enQueryAggregationCharts.noticesSharedTerms });
    expect(within(shared).getByText(enQueryAggregationCharts.notice_omittedBuckets)).toBeVisible();
    expect(within(shared).getByText(enQueryAggregationCharts.notice_termsScope)).toBeVisible();
  });

  it('keeps unplotted rows separate by axis and never fills gaps with zero', async () => {
    const view = panel('{"key":"a","total":{"value":5}},{"key":"b","doc_count":2,"total":{"value":null}},'
      + '{"key":"c","doc_count":0,"total":{"value":0}}');
    await screen.findByRole('img');
    toggle();
    expect(primary(view.container).map((bar) => bar.getAttribute('data-row'))).toEqual(['2', '3']);
    expect(secondary(view.container).map((bar) => bar.getAttribute('data-row'))).toEqual(['1', '3']);
    expect(primary(view.container)[1]).toHaveAttribute('height', '0');
    expect(secondary(view.container)[1]).toHaveAttribute('height', '0');
    const skipped = view.container.querySelectorAll('.qac-skipped');
    expect(skipped).toHaveLength(2);
    expect(skipped[0]).toHaveTextContent('left axis');
    expect(skipped[1]).toHaveTextContent('right axis');
  });

  it('refuses both charts when the second measure has no values and restores one only when explicitly disabled', async () => {
    panel('{"key":"a","doc_count":1}');
    await screen.findByRole('img');
    toggle();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText(enQueryAggregationCharts.error_secondaryNoValues)).toBeVisible();
    toggle();
    expect(await screen.findByRole('img', { name: /Bar chart of doc_count/ })).toBeVisible();
  });

  it('does not emit NaN geometry when two finite secondary values overflow the axis span', async () => {
    panel('{"key":"a","doc_count":1,"total":{"value":-1e308}},{"key":"b","doc_count":2,"total":{"value":1e308}}');
    await screen.findByRole('img');
    toggle();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText(enQueryAggregationCharts.error_secondaryDomainOutOfRange)).toBeVisible();
  });

  it('renders every permitted pair, bounds labels and keeps geometry identical after a locale change', async () => {
    const view = panel(Array.from({ length: 200 }, (_, index) =>
      `{"key":"category-${index}","doc_count":${index},"total":{"value":${index * 1000}}}`).join(','));
    await screen.findByRole('img');
    toggle();
    expect(primary(view.container)).toHaveLength(200);
    expect(secondary(view.container)).toHaveLength(200);
    const labels = [...view.container.querySelectorAll('.qac-tick')].filter((item) => !item.closest('[data-axis]'));
    expect(labels).toHaveLength(12);
    const before = allGeometry(view.container);
    expect(before.flat().every(Number.isFinite)).toBe(true);
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(allGeometry(view.container)).toEqual(before);
    expect(screen.getByRole('switch', { name: zhQueryAggregationCharts.dualToggle })).toBeChecked();
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('200 / 200');
  });
});

describe('terms dual-axis execution lifecycle', () => {
  it('keeps the selected received page and closes on a new snapshot without invoking result actions', async () => {
    const query = { ...createQuery('connection1'), index: 'events-*', dsl: DSL };
    const snapshot = createSnapshot(query, 'request1', new Date('2026-10-15T00:00:00Z'));
    const page = (rawResponse: string): ExecutionPage => {
      const parsed = parseQueryResult(rawResponse);
      if (!parsed.ok) throw new Error('valid response fixture');
      return { rawResponse, summary: parsed.summary, partial: false, cursor: '[1]' };
    };
    const first = page(body(TWO));
    const entry: ExecutionEntry = { state: { status: 'success', snapshot, rawResponse: first.rawResponse },
      endpoint: 'https://fixture.test', rawResponse: first.rawResponse, parsed: { ok: true, summary: first.summary },
      pages: [first], pitId: 'fixture', continuing: false, continuationError: null };
    const actions = { onRun: vi.fn(), onCancel: vi.fn(), onLoadMore: vi.fn(), onViewChange: vi.fn(), onLayoutChange: vi.fn() };
    const wrap = (value = entry) => <I18nextProvider i18n={i18n}>
      <QueryResults query={query} entry={value} available stale={false} endpointChanged={false} {...actions} />
    </I18nextProvider>;
    const view = render(wrap());
    fireEvent.click(screen.getByRole('button', { name: 'Aggregations' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show chart' }));
    await screen.findByRole('img');
    toggle();
    const extended = { ...entry, pages: [first, page(body('{"key":"later","doc_count":7,"total":{"value":30}}'))] };
    view.rerender(wrap(extended));
    expect(screen.getByRole('img', { name: /Dual-axis bar chart/ }).getAttribute('aria-label')).toContain('2 of 2');
    fireEvent.change(screen.getByRole('combobox', { name: 'Received page' }), { target: { value: '1' } });
    expect(screen.queryByRole('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show chart' }));
    await screen.findByRole('img');
    toggle();
    const next = createSnapshot(query, snapshot.requestId, new Date('2026-10-15T01:00:00Z'));
    view.rerender(wrap({ ...extended, state: { status: 'success', snapshot: next, rawResponse: first.rawResponse } }));
    expect(screen.queryByRole('img')).toBeNull();
    for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();
  });
});
