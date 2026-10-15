import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyChartDefinitions } from '../../src/domain/chart-definitions';
import { createQuery, createSnapshot } from '../../src/domain/query';
import { parseQueryResult } from '../../src/domain/query-result';
import { QueryResults } from '../../src/features/query/QueryResults';
import type { ChartDefinitionsController } from '../../src/features/query/useChartDefinitions';
import type { ExecutionEntry } from '../../src/features/query/useQueryExecutions';
import { i18n } from '../../src/locales';
import { enChartDefinitions } from '../../src/locales/chart-definitions';

beforeEach(async () => { await i18n.changeLanguage('en-US'); });

function setup(terms: Record<string, unknown> = { field: 'kind', size: 40 }) {
  const query = { ...createQuery('connection1'), index: 'original-*',
    dsl: JSON.stringify({ aggs: { kinds: { terms, aggs: { mean: { avg: { field: 'actual_amount' } } } } } }) };
  const snapshot = createSnapshot(query, 'executed1', new Date('2026-10-15T00:00:00Z'));
  const rawResponse = '{"hits":{"total":1,"hits":[]},"aggregations":{"kinds":{"buckets":[{"key":"unpersisted-result","doc_count":1,"mean":{"value":42}}]}}}';
  const parsed = parseQueryResult(rawResponse);
  if (!parsed.ok) throw new Error('valid query fixture');
  const entry: ExecutionEntry = {
    state: { status: 'success', snapshot, rawResponse }, parsed,
    endpoint: 'https://original.test', rawResponse, pages: [{ rawResponse, summary: parsed.summary, partial: false, cursor: '[1]' }],
    pitId: 'pit-not-saved', continuing: false, continuationError: null,
  };
  const controller = {
    status: 'ready' as const, entries: [], record: { revision: 0, library: emptyChartDefinitions() }, error: null,
    saving: false, reload: vi.fn(), save: vi.fn<ChartDefinitionsController['save']>(async () => true), remove: vi.fn(async () => true),
    importRecord: vi.fn(async () => ({ applied: false, error: null })),
  } satisfies ChartDefinitionsController;
  const callbacks = { onRun: vi.fn(), onCancel: vi.fn(), onLoadMore: vi.fn(), onViewChange: vi.fn() };
  const props = { query, entry, available: true, stale: false, endpointChanged: false, ...callbacks,
    chartDefinitionsController: controller };
  const wrap = (next: Partial<ComponentProps<typeof QueryResults>> = {}) => <I18nextProvider i18n={i18n}>
    <QueryResults {...props} {...next} />
  </I18nextProvider>;
  const view = render(wrap());
  const open = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Aggregations' }));
    fireEvent.click(screen.getByRole('button', { name: i18n.t('queryCharts:saveFromResults') }));
  };
  return { ...view, query, snapshot, entry, controller, callbacks, wrap, open };
}

describe('saving an executed aggregation through the merged library', () => {
  it('uses frozen execution fields, target and requested size and requires literal review', async () => {
    const f = setup();
    f.rerender(f.wrap({ query: { ...f.query, index: 'edited-*', dsl: '{"aggs":{"other":{"sum":{"field":"wrong"}}}}' }, stale: true }));
    f.open();
    const dialog = screen.getByRole('dialog');
    const preview = within(dialog).getByLabelText(enChartDefinitions.resultDefinition);
    expect(preview).toHaveTextContent('"index": "original-*"');
    expect(preview).toHaveTextContent('"size": "40"');
    expect(preview).toHaveTextContent('"field": "actual_amount"');
    expect(preview).not.toHaveTextContent('unpersisted-result');
    const save = within(dialog).getByRole('button', { name: enChartDefinitions.saveAction });
    expect(save).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: enChartDefinitions.resultReviewed }));
    fireEvent.click(save);
    await waitFor(() => expect(f.controller.save).toHaveBeenCalledTimes(1));
    const saved = f.controller.save.mock.calls[0]?.[0];
    expect(saved).toMatchObject({ connectionId: 'connection1', index: 'original-*',
      draft: { group: { size: '40' }, metrics: [{ name: 'mean', field: 'actual_amount' }] } });
    expect(JSON.stringify(saved)).not.toMatch(/original\.test|unpersisted-result|pit-not-saved|executed1/);
    for (const callback of Object.values(f.callbacks)) expect(callback).not.toHaveBeenCalled();
  });

  it('keeps the selected primary measure, but does not save reference lines, a second series or any results', async () => {
    const f = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Aggregations' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show chart' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Plotted measure' }), { target: { value: 'mean' } });
    fireEvent.click(screen.getByRole('switch', { name: i18n.t('queryAggregationCharts:dualToggle') }));
    expect(screen.getByRole('combobox', { name: 'Right axis measure' })).toHaveValue('doc_count');
    await screen.findByRole('img');
    fireEvent.click(screen.getByRole('button', { name: 'Add reference line' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Reference axis' }), { target: { value: 'left' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Reference value' }), { target: { value: '12.34567' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply reference line' }));
    expect(screen.getByRole('listitem', { name: 'Reference 1' })).toHaveTextContent('12.34567');
    fireEvent.click(screen.getByRole('button', { name: i18n.t('queryCharts:saveFromResults') }));
    expect(screen.getByLabelText(enChartDefinitions.resultDefinition)).toHaveTextContent('"measure": "mean"');
    expect(screen.getByLabelText(enChartDefinitions.resultDefinition)).not.toHaveTextContent('secondary');
    expect(screen.getByLabelText(enChartDefinitions.resultDefinition)).not.toHaveTextContent('12.34567');
    expect(f.controller.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: enChartDefinitions.resultReviewed }));
    fireEvent.click(screen.getByRole('button', { name: enChartDefinitions.saveAction }));
    await waitFor(() => expect(f.controller.save).toHaveBeenCalledTimes(1));
    expect(f.controller.save.mock.calls[0]![0]).toMatchObject({ measure: 'mean' });
    expect(f.controller.save.mock.calls[0]![0]).not.toHaveProperty('secondary');
    expect(JSON.stringify(f.controller.save.mock.calls[0]![0])).not.toMatch(/reference|12\.34567/);
    for (const callback of Object.values(f.callbacks)) expect(callback).not.toHaveBeenCalled();
  });

  it('invalidates literal review when the name changes and blocks a conflicted library', () => {
    const f = setup();
    f.open();
    fireEvent.click(screen.getByRole('checkbox', { name: enChartDefinitions.resultReviewed }));
    fireEvent.change(screen.getByRole('textbox', { name: enChartDefinitions.name }), { target: { value: 'Changed' } });
    expect(screen.getByRole('checkbox', { name: enChartDefinitions.resultReviewed })).not.toBeChecked();
    expect(screen.getByRole('button', { name: enChartDefinitions.saveAction })).toBeDisabled();
    f.rerender(f.wrap({ chartDefinitionsController: { ...f.controller, error: 'chartDefinitionConflict' } }));
    expect(screen.getByRole('checkbox', { name: enChartDefinitions.resultReviewed })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(enChartDefinitions.exchangeConflict);
    expect(f.controller.save).not.toHaveBeenCalled();
  });

  it('closes the captured dialog on a new snapshot even when the request ID is reused', () => {
    const f = setup();
    f.open();
    expect(screen.getByRole('dialog')).toBeVisible();
    const snapshot = createSnapshot(f.query, f.snapshot.requestId, new Date('2026-10-15T01:00:00Z'));
    f.rerender(f.wrap({ entry: { ...f.entry, state: { status: 'success', snapshot, rawResponse: f.entry.rawResponse! } } }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(f.controller.save).not.toHaveBeenCalled();
  });

  it('refuses lossy reconstruction instead of dropping manual aggregation options', () => {
    const f = setup({ field: 'kind', size: 40, order: { _count: 'asc' } });
    f.open();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(enChartDefinitions.resultUnsupported)).toBeVisible();
    expect(f.controller.save).not.toHaveBeenCalled();
  });
});
