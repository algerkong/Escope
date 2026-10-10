import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadMock } = vi.hoisted(() => ({ loadMock: vi.fn() }));

vi.mock('../../src/features/query/charts/chart-loader', () => ({
  loadAggregationChart: () => loadMock(),
}));

const { AggregationChart } = await import('../../src/features/query/charts/AggregationChart');
const { readAggregationPage } = await import('../../src/domain/query-aggregations');
const { i18n } = await import('../../src/locales');
const { enQueryAggregationCharts } = await import('../../src/locales/query-aggregation-charts');

const TERMS_DSL = '{"size":0,"aggs":{"kinds":{"terms":{"field":"kind"}}}}';
const METRIC_DSL = '{"size":0,"aggs":{"amount":{"sum":{"field":"a"}}}}';

function entryOf(dsl: string, aggregations: string, name: string) {
  const result = readAggregationPage(dsl, `{"aggregations":${aggregations}}`);
  if (!result.ok) throw new Error(`fixture rejected: ${result.code}`);
  const found = result.entries.find((entry) => entry.name === name);
  if (!found) throw new Error(`fixture entry missing: ${name}`);
  return found;
}

function renderChart(dsl: string, aggregations: string, name: string) {
  return render(<I18nextProvider i18n={i18n}>
    <AggregationChart entry={entryOf(dsl, aggregations, name)}
      scope={{ target: 'orders-*', page: 1, bounds: null, limited: false }} />
  </I18nextProvider>);
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  loadMock.mockReset();
});

describe('aggregation chart runtime loading', () => {
  it('reports a rejected chart library instead of silently falling back or claiming zero', async () => {
    loadMock.mockRejectedValue(new Error('chunk unavailable'));
    const view = renderChart(TERMS_DSL, '{"kinds":{"buckets":[{"key":"a","doc_count":3},{"key":"b","doc_count":1}]}}', 'kinds');
    expect(await screen.findByRole('alert')).toHaveTextContent(enQueryAggregationCharts.loadFailed);
    expect(view.container.querySelector('.qac-state')).toBeNull();
    expect(view.container.querySelector('.qac-svg, .qac-bar, .qac-line')).toBeNull();
    expect(screen.queryByText(enQueryAggregationCharts.error_noPlottableValues)).toBeNull();
    expect(loadMock).toHaveBeenCalledTimes(1);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('alert')).toBeVisible();
  });

  it('reports a thrown loader failure and keeps the refusal separate from the plotted values', async () => {
    loadMock.mockImplementation(() => { throw new Error('module blocked'); });
    const view = renderChart(TERMS_DSL, '{"kinds":{"buckets":[{"key":"a","doc_count":3}]}}', 'kinds');
    expect(await screen.findByRole('alert')).toHaveTextContent(enQueryAggregationCharts.loadFailed);
    expect(view.container.querySelector('.qac-state')).toBeNull();
    expect(screen.getByText(enQueryAggregationCharts.notice_termsScope)).toBeVisible();
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it('never loads the drawing library for a single value', () => {
    const view = renderChart(METRIC_DSL, '{"amount":{"value":42}}', 'amount');
    expect(view.container.querySelector('.qac-single code')).toHaveTextContent('42');
    expect(loadMock).not.toHaveBeenCalled();
  });
});
