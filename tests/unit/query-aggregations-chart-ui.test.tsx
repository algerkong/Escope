import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuery, createSnapshot } from '../../src/domain/query';
import { parseQueryResult } from '../../src/domain/query-result';
import { QueryResults } from '../../src/features/query/QueryResults';
import type { ExecutionEntry, ExecutionPage } from '../../src/features/query/useQueryExecutions';
import { i18n } from '../../src/locales';
import { enQueryAggregationCharts } from '../../src/locales/query-aggregation-charts';

const TERMS_DSL = JSON.stringify({
  size: 0,
  aggs: {
    genres: {
      terms: { field: 'genre' },
      aggs: {
        avg_rating: { avg: { field: 'rating' } },
      },
    },
  },
});

const TERMS_RESPONSE = JSON.stringify({
  timed_out: false,
  _shards: { total: 1, successful: 1, failed: 0 },
  hits: { total: 100, hits: [] },
  aggregations: {
    genres: {
      doc_count_error_upper_bound: 0,
      sum_other_doc_count: 5,
      buckets: [
        { key: 'Sci-Fi', doc_count: 50, avg_rating: { value: 4.8 } },
        { key: 'Drama', doc_count: 30, avg_rating: { value: 4.2 } },
      ],
    },
  },
});

const HISTOGRAM_DSL = JSON.stringify({
  size: 0,
  aggs: {
    by_date: {
      date_histogram: { field: 'timestamp', calendar_interval: '1d' },
    },
  },
});

const HISTOGRAM_RESPONSE = JSON.stringify({
  timed_out: false,
  _shards: { total: 1, successful: 1, failed: 0 },
  hits: { total: 50, hits: [] },
  aggregations: {
    by_date: {
      buckets: [
        { key: 1609459200000, key_as_string: '2021-01-01', doc_count: 20 },
        { key: 1609545600000, key_as_string: '2021-01-02', doc_count: 30 },
      ],
    },
  },
});

function setupWithFixture(dsl: string, rawResponse: string) {
  const query = { ...createQuery('c1'), index: 'items', dsl };
  const snapshot = createSnapshot(query, 'req-chart', new Date('2026-10-10T00:00:00Z'));
  const parsed = parseQueryResult(rawResponse);
  if (!parsed.ok) throw new Error('valid fixture required');
  const page: ExecutionPage = { rawResponse, summary: parsed.summary, partial: false, cursor: '[1]' };
  const entry: ExecutionEntry = {
    state: { status: 'success', snapshot, rawResponse },
    parsed: { ok: true, summary: parsed.summary },
    endpoint: 'https://test.es',
    rawResponse,
    pages: [page],
    pitId: 'pit-chart',
    continuing: false,
    continuationError: null,
  };

  const props = {
    query,
    entry,
    snapshot,
    available: true,
    stale: false,
    endpointChanged: false,
    onRun: () => {},
    onCancel: () => {},
    onLoadMore: () => {},
    onViewChange: () => {},
    onLayoutChange: () => {},
  };

  const user = userEvent.setup();
  const view = render(
    <I18nextProvider i18n={i18n}>
      <QueryResults {...props} />
    </I18nextProvider>,
  );
  return { ...view, user };
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US');
});

describe('aggregation chart UI', () => {
  it('shows the merged terms chart while retaining the original bucket table', async () => {
    const { user } = setupWithFixture(TERMS_DSL, TERMS_RESPONSE);

    // Open Aggregations panel
    fireEvent.click(screen.getByRole('button', { name: 'Aggregations' }));

    const region = screen.getByRole('region', { name: 'Aggregations' });
    expect(region).toBeInTheDocument();

    // Defaults to Table view
    expect(within(region).getByRole('table')).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: 'Show chart' })).toHaveAttribute('aria-pressed', 'false');

    // Switch to Chart view
    await user.click(within(region).getByRole('button', { name: 'Show chart' }));
    expect(within(region).getByRole('button', { name: 'Hide chart' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(region).getByRole('table')).toBeInTheDocument();

    // Verify SVG bar chart is rendered
    const barChart = await within(region).findByRole('img', { name: /Bar chart.*genres/ });
    expect(barChart).toBeInTheDocument();

    // Verify terms labels inside SVG
    expect(within(barChart).getByText('"Sci-Fi"')).toBeInTheDocument();
    expect(within(barChart).getByText('"Drama"')).toBeInTheDocument();

    // Verify omitted buckets notice
    expect(within(region).getByText(enQueryAggregationCharts.notice_omittedBuckets)).toBeInTheDocument();

    // Switch back to Table view
    await user.click(within(region).getByRole('button', { name: 'Hide chart' }));
    expect(within(region).queryByRole('img')).toBeNull();
    expect(within(region).getByRole('table')).toBeInTheDocument();
  });

  it('renders date histogram line chart with SVG elements and notices', async () => {
    const { user } = setupWithFixture(HISTOGRAM_DSL, HISTOGRAM_RESPONSE);

    fireEvent.click(screen.getByRole('button', { name: 'Aggregations' }));
    const region = screen.getByRole('region', { name: 'Aggregations' });

    // Switch to Chart
    await user.click(within(region).getByRole('button', { name: 'Show chart' }));

    const lineChart = await within(region).findByRole('img', { name: /Line chart.*by_date/ });
    expect(lineChart).toBeInTheDocument();

    // Check dates rendered on axis
    expect(within(lineChart).getByText('"2021-01-01"')).toBeInTheDocument();
    expect(within(lineChart).getByText('"2021-01-02"')).toBeInTheDocument();

    // Verify explicit disclaimer that no missing buckets or end boundaries are inferred
    expect(
      within(region).getByText(enQueryAggregationCharts.notice_bucketStarts),
    ).toBeInTheDocument();
  });

  it('renders maximize results button and triggers onToggleMaximize callback', async () => {
    const onToggleMaximize = vi.fn();
    const query = { ...createQuery('c1'), index: 'items', dsl: TERMS_DSL };
    const snapshot = createSnapshot(query, 'req-chart', new Date('2026-10-10T00:00:00Z'));
    const parsed = parseQueryResult(TERMS_RESPONSE);
    if (!parsed.ok) throw new Error('valid fixture required');
    const page: ExecutionPage = { rawResponse: TERMS_RESPONSE, summary: parsed.summary, partial: false, cursor: '[1]' };
    const entry: ExecutionEntry = {
      state: { status: 'success', snapshot, rawResponse: TERMS_RESPONSE },
      parsed: { ok: true, summary: parsed.summary },
      endpoint: 'https://test.es',
      rawResponse: TERMS_RESPONSE,
      pages: [page],
      pitId: 'pit-chart',
      continuing: false,
      continuationError: null,
    };

    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <QueryResults
          query={query}
          entry={entry}
          available={true}
          stale={false}
          endpointChanged={false}
          maximized={false}
          onToggleMaximize={onToggleMaximize}
          onRun={() => {}}
          onCancel={() => {}}
          onLoadMore={() => {}}
          onViewChange={() => {}}
          onLayoutChange={() => {}}
        />
      </I18nextProvider>,
    );

    const maxBtn = screen.getByRole('button', { name: /maximize results/i });
    expect(maxBtn).toBeInTheDocument();
    fireEvent.click(maxBtn);
    expect(onToggleMaximize).toHaveBeenCalledTimes(1);

    // When maximized is true, shows Restore button
    rerender(
      <I18nextProvider i18n={i18n}>
        <QueryResults
          query={query}
          entry={entry}
          available={true}
          stale={false}
          endpointChanged={false}
          maximized={true}
          onToggleMaximize={onToggleMaximize}
          onRun={() => {}}
          onCancel={() => {}}
          onLoadMore={() => {}}
          onViewChange={() => {}}
          onLayoutChange={() => {}}
        />
      </I18nextProvider>,
    );

    const restoreBtn = screen.getByRole('button', { name: /restore results/i });
    expect(restoreBtn).toBeInTheDocument();
    fireEvent.click(restoreBtn);
    expect(onToggleMaximize).toHaveBeenCalledTimes(2);
  });
});
