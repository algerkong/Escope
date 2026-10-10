import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGGREGATION_LIMITS } from '../../src/domain/query-aggregations';
import { createQuery, createSnapshot, type QueryDocument } from '../../src/domain/query';
import { parseQueryResult } from '../../src/domain/query-result';
import { QueryResults } from '../../src/features/query/QueryResults';
import type { ExecutionEntry, ExecutionPage } from '../../src/features/query/useQueryExecutions';
import { i18n } from '../../src/locales';
import { enQueryAggregations, zhQueryAggregations } from '../../src/locales/query-aggregations';
import { createSessionQueryLibraryService } from '../../src/services/query-library';

const DSL = '{"size":0,"aggs":{"amount":{"sum":{"field":"amount"}},"average":{"avg":{"field":"amount"}},'
  + '"unique":{"cardinality":{"field":"id"}},"values":{"value_count":{"field":"id"}}}}';
const VALUES = '{"amount":{"value":9007199254740993,"value_as_string":"\\u0039e15"},'
  + '"average":{"value":null},"unique":{"value":7},"values":{"value":8}}';
const fetchSpy = vi.fn();

function body(aggregations: string, extra = '', hits = '[]') {
  return `{"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},"hits":{"total":0,"hits":${hits}},`
    + `"aggregations":${aggregations}${extra}}`;
}

function fixture(options: { dsl?: string; rawPages?: string[]; query?: QueryDocument; requestId?: string; partialPages?: number[] } = {}) {
  const query = options.query ?? { ...createQuery('c1'), index: 'orders-*', dsl: options.dsl ?? DSL };
  const snapshot = createSnapshot(query, options.requestId ?? 'request-1', new Date('2026-10-10T00:00:00Z'));
  const pages: ExecutionPage[] = (options.rawPages ?? [body(VALUES)]).map((rawResponse, pageIndex) => {
    const parsed = parseQueryResult(rawResponse);
    if (!parsed.ok) throw new Error('valid fixture required');
    return { rawResponse, summary: parsed.summary, partial: options.partialPages?.includes(pageIndex) ?? false, cursor: '[1]' };
  });
  const last = pages.at(-1)!;
  const entry: ExecutionEntry = {
    state: { status: pages.some(({ partial }) => partial) ? 'partial' : 'success', snapshot, rawResponse: last.rawResponse },
    parsed: { ok: true, summary: last.summary }, endpoint: 'https://executed.test', rawResponse: last.rawResponse,
    pages, pitId: 'fixture-pit', continuing: false, continuationError: null,
  };
  return { query, entry, snapshot };
}

function setup(f = fixture()) {
  const onRun = vi.fn();
  const onCancel = vi.fn();
  const onLoadMore = vi.fn();
  const onViewChange = vi.fn();
  const onLayoutChange = vi.fn();
  const props = {
    ...f, available: true, stale: false, endpointChanged: false, onRun, onCancel, onLoadMore, onViewChange, onLayoutChange,
  };
  const wrap = (next: Partial<Parameters<typeof QueryResults>[0]> = {}) => <I18nextProvider i18n={i18n}>
    <QueryResults {...props} {...next} />
  </I18nextProvider>;
  const view = render(wrap());
  const user = userEvent.setup();
  return { ...view, user, wrap, f, onRun, onCancel, onLoadMore, onViewChange, onLayoutChange };
}

const region = () => screen.getByRole('region', { name: 'Aggregations' });
const a = () => within(region());
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Aggregations' }));
const select = (name: string) => fireEvent.change(a().getByRole('combobox', { name: 'Aggregation' }), { target: { value: name } });

beforeEach(async () => { await i18n.changeLanguage('en-US'); vi.stubGlobal('fetch', fetchSpy); });
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('aggregation result view', () => {
  it('offers an explicit session-local view for size-zero results and preserves precise/null/approximate values', () => {
    const f = setup();
    expect(screen.queryByRole('region', { name: 'Aggregations' })).toBeNull();
    open();
    expect(screen.getByRole('button', { name: 'Aggregations' })).toHaveAttribute('aria-pressed', 'true');
    expect(a().getByLabelText('amount')).toHaveTextContent('9007199254740993');
    expect(a().getByLabelText('amount.value_as_string')).toHaveTextContent('"\\u0039e15"');
    select('average');
    expect(a().getByLabelText('average')).toHaveTextContent('null');
    select('unique');
    expect(a().getByText('Approximate')).toBeVisible();
    select('values');
    expect(a().getByText('Value count, not document count')).toBeVisible();
    expect(f.onViewChange).not.toHaveBeenCalled();
    expect(f.onLayoutChange).not.toHaveBeenCalled();
    expect(f.onRun).not.toHaveBeenCalled();
    expect(f.onLoadMore).not.toHaveBeenCalled();
    expect(f.onCancel).not.toHaveBeenCalled();
  });

  it('copies original metric/definition/response/page tokens and reports clipboard failure', async () => {
    const f = setup();
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    open();
    await f.user.click(a().getByRole('button', { name: 'Copy original value: amount' }));
    expect(clipboard).toHaveBeenLastCalledWith('9007199254740993');
    await f.user.click(a().getByRole('button', { name: 'Copy original value: amount.value_as_string' }));
    expect(clipboard).toHaveBeenLastCalledWith('"\\u0039e15"');
    await f.user.click(a().getByText('Executed aggregation definition', { selector: 'summary' }));
    await f.user.click(await a().findByRole('button', { name: 'Copy executed aggregation definition' }));
    expect(clipboard).toHaveBeenLastCalledWith('{"sum":{"field":"amount"}}');
    await f.user.click(a().getByText('Original aggregation response', { selector: 'summary' }));
    await f.user.click(await a().findByRole('button', { name: 'Copy original aggregation response' }));
    expect(clipboard).toHaveBeenLastCalledWith('{"value":9007199254740993,"value_as_string":"\\u0039e15"}');
    await f.user.click(a().getByRole('button', { name: 'Copy received response' }));
    expect(clipboard).toHaveBeenLastCalledWith(f.f.entry.pages[0]!.rawResponse);
    clipboard.mockRejectedValueOnce(new Error('clipboard unavailable'));
    await f.user.click(a().getByRole('button', { name: 'Copy original value: amount' }));
    expect(await a().findByText(i18n.t('queryLive:copyFailed'))).toBeVisible();
    expect(f.onRun).not.toHaveBeenCalled();
  });

  it('keeps selected received pages independent when more pages arrive, with page-specific partial status', async () => {
    const initial = fixture({ partialPages: [0] });
    const f = setup(initial);
    open();
    expect(a().getByText(enQueryAggregations.partial)).toBeVisible();
    const next = fixture({ query: initial.query, rawPages: [initial.entry.pages[0]!.rawResponse, body('{"amount":{"value":4}}')] });
    const entry: ExecutionEntry = {
      ...next.entry,
      state: { status: 'partial', snapshot: initial.snapshot, rawResponse: next.entry.rawResponse! },
      pages: [initial.entry.pages[0]!, next.entry.pages[1]!],
    };
    f.rerender(f.wrap({ entry }));
    expect(a().getByLabelText('amount')).toHaveTextContent('9007199254740993');
    expect(a().getByText(enQueryAggregations.independentPages)).toBeVisible();
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    await f.user.click(a().getByRole('button', { name: 'Copy received response' }));
    expect(clipboard).toHaveBeenLastCalledWith(initial.entry.pages[0]!.rawResponse);
    await f.user.selectOptions(a().getByRole('combobox', { name: 'Received page' }), '1');
    expect(a().getByLabelText('amount')).toHaveTextContent(/^4$/);
    expect(a().queryByText(enQueryAggregations.partial)).toBeNull();
    expect(screen.getByText(i18n.t('queryLive:partialDetail'))).toBeVisible();
    select('average');
    expect(a().getByText(enQueryAggregations.status_missing)).toBeVisible();
    expect(f.onRun).not.toHaveBeenCalled();
    expect(f.onLoadMore).not.toHaveBeenCalled();
  });

  it('uses the frozen target and executed definition after the editor/connection has changed', async () => {
    const f = setup();
    open();
    f.rerender(f.wrap({ query: { ...f.f.query, dsl: '{"aggs":{"amount":{"cardinality":{}}}}', index: 'new-target', revision: 2 },
      stale: true, endpointChanged: true }));
    expect(a().getByLabelText('amount')).toHaveTextContent('9007199254740993');
    expect(a().queryByText('Approximate')).toBeNull();
    expect(a().queryByText('https://executed.test')).toBeNull();
    await f.user.click(a().getByText('Execution source', { selector: 'summary' }));
    expect(await a().findByText('https://executed.test')).toBeVisible();
    expect(a().getByText('orders-*')).toBeVisible();
    expect(a().getByText('c1')).toBeVisible();
    expect(a().queryByText('new-target')).toBeNull();
    expect(screen.getByText(i18n.t('queryLive:staleResult'))).toBeVisible();
    expect(screen.getByText(i18n.t('queryLive:endpointChanged'))).toBeVisible();
  });

  it('closes on a replacement snapshot even if a request id is reused without an intermediate running state', () => {
    const f = setup();
    open();
    const replacement = fixture({ query: f.f.query, requestId: f.f.snapshot.requestId, rawPages: [body('{"amount":{"value":5}}')] });
    f.rerender(f.wrap(replacement));
    expect(screen.queryByRole('region', { name: 'Aggregations' })).toBeNull();
    open();
    expect(a().getByLabelText('amount')).toHaveTextContent(/^5$/);
  });

  it('closes on leaving the tab/settings and never restores a session view from query persistence', () => {
    const f = setup();
    open();
    f.rerender(f.wrap({ active: false }));
    expect(screen.queryByRole('region', { name: 'Aggregations' })).toBeNull();
    f.rerender(f.wrap({ active: true }));
    expect(screen.queryByRole('region', { name: 'Aggregations' })).toBeNull();
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    expect(screen.queryByRole('region', { name: 'Aggregations' })).toBeNull();
    expect(f.onViewChange).toHaveBeenLastCalledWith('table');
    expect(f.f.query.resultView).toBe('table');
  });

  it.each(['idle', 'running', 'cancelled', 'failed'] as const)('does not show old aggregations in %s state', (status) => {
    const f = setup();
    open();
    const state = status === 'idle' ? { status } : { status, snapshot: f.f.snapshot, code: 'invalidResponse' };
    f.rerender(f.wrap({ entry: { ...f.f.entry, state } }));
    expect(screen.queryByRole('region', { name: 'Aggregations' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Aggregations' })).toBeNull();
  });

  it('does not enable this result interpretation for locked index preview or a different query identity', () => {
    const f = setup();
    f.rerender(f.wrap({ kind: 'preview' }));
    expect(screen.queryByRole('button', { name: 'Aggregations' })).toBeNull();
    f.rerender(f.wrap({ query: { ...f.f.query, id: 'other-query' } }));
    expect(screen.queryByRole('button', { name: 'Aggregations' })).toBeNull();
  });

  it('keeps unsupported/unrequested results as text with raw entry points, never executable markup', async () => {
    const name = '<img src=x>';
    const f = setup(fixture({ dsl: `{"aggs":{"${name}":{"percentiles":{"field":"n"}}}}`,
      rawPages: [body(`{"${name}":{"values":{"1.0":9007199254740993}},"unexpected":{"value":2}}`)] }));
    open();
    expect(a().getByText(enQueryAggregations.status_unsupported)).toBeVisible();
    expect(region().querySelector('img,script,iframe,a')).toBeNull();
    expect(a().queryByLabelText('Original aggregation response')).toBeNull();
    await f.user.click(a().getByText('Original aggregation response', { selector: 'summary' }));
    expect(await a().findByLabelText('Original aggregation response')).toHaveTextContent('9007199254740993');
    select('unexpected');
    expect(a().getByText(enQueryAggregations.status_unrequested)).toBeVisible();
    expect(a().queryByText('Executed aggregation definition')).toBeNull();
    expect(a().queryByLabelText('Original aggregation response')).toBeNull();
  });

  it('keeps absent/null/zero metric values and empty/missing bucket containers distinguishable', () => {
    const f = setup(fixture({ dsl: '{"aggs":{"missing":{"avg":{}},"nil":{"avg":{}},"zero":{"sum":{}},'
      + '"empty":{"terms":{}},"absent":{"terms":{}}}}',
    rawPages: [body('{"missing":{},"nil":{"value":null},"zero":{"value":0},"empty":{"buckets":[]}}')] }));
    open();
    expect(a().getByLabelText('missing')).toHaveTextContent('Not returned');
    expect(a().getByRole('button', { name: 'Copy original value: missing' })).toBeDisabled();
    select('nil'); expect(a().getByLabelText('nil')).toHaveTextContent(/^null$/);
    select('zero'); expect(a().getByLabelText('zero')).toHaveTextContent(/^0$/);
    select('empty'); expect(a().getByText('No buckets returned')).toBeVisible();
    select('absent'); expect(a().getByText(enQueryAggregations.status_missing)).toBeVisible();
    expect(f.onLoadMore).not.toHaveBeenCalled();
  });

  it('paginates exactly 50 received buckets, resets on aggregation/page changes, and copies a whole raw bucket', async () => {
    const bucketList = (name: string) => Array.from({ length: 105 }, (_, n) =>
      `{"key":"${name}-${n}","doc_count":${n},"doc_count_error_upper_bound":-1,"unique":{"value":${n}}}`).join(',');
    const firstBuckets = bucketList('a');
    const f = setup(fixture({
      dsl: '{"aggs":{"a":{"terms":{"size":105},"aggs":{"unique":{"cardinality":{"field":"x"}}}},'
        + '"b":{"terms":{"size":105},"aggs":{"unique":{"cardinality":{"field":"x"}}}}}}',
      rawPages: [body(`{"a":{"sum_other_doc_count":9007199254740993,"buckets":[${firstBuckets}]},`
        + `"b":{"buckets":[${bucketList('b')}]}}`), body(`{"a":{"buckets":[${firstBuckets}]}}`)],
    }));
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    open();
    expect(a().getByText(enQueryAggregations.errorNotReported)).toBeVisible();
    expect(a().getByText(enQueryAggregations.omittedBuckets)).toBeVisible();
    expect(region().querySelectorAll('tbody tr')).toHaveLength(50);
    expect(a().getByText('Approximate')).toBeVisible();
    await f.user.click(a().getByRole('button', { name: 'Next bucket page' }));
    expect(a().getByText('Buckets 51–100 of 105 returned')).toBeVisible();
    await f.user.click(a().getByRole('button', { name: 'Copy original bucket 51' }));
    expect(clipboard).toHaveBeenLastCalledWith('{"key":"a-50","doc_count":50,"doc_count_error_upper_bound":-1,"unique":{"value":50}}');
    select('b');
    expect(a().getByText('Buckets 1–50 of 105 returned')).toBeVisible();
    await f.user.click(a().getByRole('button', { name: 'Next bucket page' }));
    await f.user.click(a().getByRole('button', { name: 'Next bucket page' }));
    expect(region().querySelectorAll('tbody tr')).toHaveLength(5);
    expect(a().getByRole('button', { name: 'Next bucket page' })).toBeDisabled();
    await f.user.selectOptions(a().getByRole('combobox', { name: 'Received page' }), '1');
    expect(a().getByText('Buckets 1–50 of 105 returned')).toBeVisible();
    expect(f.onLoadMore).not.toHaveBeenCalled();
    expect(f.onRun).not.toHaveBeenCalled();
    expect(f.onLayoutChange).not.toHaveBeenCalled();
  });

  it('displays histogram options and literal keys without adding missing time buckets or applying field formats', () => {
    setup(fixture({ dsl: '{"aggs":{"hours":{"date_histogram":{"field":"at","fixed_interval":"1h","time_zone":"+08:00","keyed":true}}}}',
      rawPages: [body('{"hours":{"buckets":{"literal":{"key":0,"key_as_string":"1970","doc_count":0},'
        + '"next":{"key":7200000,"doc_count":1}}}}')] }));
    open();
    expect(a().getByText(enQueryAggregations.histogramScope)).toBeVisible();
    expect(a().getByText('"1h"')).toBeVisible();
    expect(a().getByText('"+08:00"')).toBeVisible();
    expect(a().getByLabelText('key, bucket 1')).toHaveTextContent(/^0$/);
    expect(a().getByLabelText('key, bucket 2')).toHaveTextContent('7200000');
    expect(a().getByLabelText('key_as_string, bucket 2')).toHaveTextContent('Not returned');
    expect(a().getByText('literal')).toBeVisible();
    expect(region().querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('shows per-page scope/failure caveats without exposing inline script text until the raw definition is opened', () => {
    setup(fixture({
      dsl: '{"post_filter":{"term":{"id":1}},"runtime_mappings":{"computed":{"type":"long"}},"aggs":{"n":{"sum":{"script":{"source":"return 7"}}}}}',
      rawPages: [body('{"n":{"value":7}}', ',"terminated_early":true,"_clusters":{"skipped":1}')], partialPages: [0],
    }));
    open();
    expect(a().getByText(enQueryAggregations.notice_postFilter)).toBeVisible();
    expect(a().getByText(enQueryAggregations.notice_runtime)).toBeVisible();
    expect(a().getByText(enQueryAggregations.notice_script)).toBeVisible();
    expect(a().getByText(enQueryAggregations.notice_terminatedEarly)).toBeVisible();
    expect(a().getByText(enQueryAggregations.notice_clusterReport)).toBeVisible();
    expect(region()).not.toHaveTextContent('return 7');
  });

  it('keeps aggregation shape rejection separate from query results and raw response access', () => {
    const f = setup(fixture({ rawPages: [body('null', '', '[{"_id":"doc","_source":{"n":1}}]')] }));
    open();
    expect(a().getByRole('alert')).toHaveTextContent(enQueryAggregations.error_invalidResponse);
    expect(a().getByRole('button', { name: 'Copy received response' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    expect(screen.getByRole('button', { name: 'Document doc' })).toBeVisible();
    expect(f.onRun).not.toHaveBeenCalled();
  });

  it('does not offer loaded-document export as if it were exporting the displayed aggregation buckets', () => {
    const service = createSessionQueryLibraryService();
    const save = vi.spyOn(service, 'save');
    const exportFile = vi.spyOn(service, 'saveExportFile');
    const f = setup(fixture({ rawPages: [body(VALUES, '', '[{"_id":"doc","_source":{"n":1}}]')] }));
    f.rerender(f.wrap({ exportService: service }));
    expect(screen.getByRole('button', { name: 'Export loaded results' })).toBeVisible();
    open();
    expect(screen.queryByRole('button', { name: 'Export loaded results' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    expect(screen.getByRole('button', { name: 'Export loaded results' })).toBeVisible();
    expect(exportFile).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects an over-budget interpretation as a whole while preserving explicit original-page copy', async () => {
    const raw = body(VALUES, `,"padding":"${'x'.repeat(AGGREGATION_LIMITS.responseBytes)}"`);
    const f = setup(fixture({ rawPages: [raw] }));
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    open();
    expect(a().getByRole('alert')).toHaveTextContent(enQueryAggregations.error_tooLarge);
    expect(a().queryByLabelText('amount')).toBeNull();
    await f.user.click(a().getByRole('button', { name: 'Copy received response' }));
    expect(clipboard).toHaveBeenLastCalledWith(raw);
    await f.user.click(a().getByText('Original received response', { selector: 'summary' }));
    expect(await a().findByText(enQueryAggregations.rawTooLarge)).toBeVisible();
    expect(a().queryByLabelText('Original received response')).toBeNull();
  });

  it('shows raw execution/page text on demand with wrapping, and keeps native controls keyboard-accessible', async () => {
    const f = setup();
    open();
    expect(region().querySelector('pre')).toBeNull();
    await f.user.click(a().getByText('Executed DSL', { selector: 'summary' }));
    expect(await a().findByLabelText('Executed DSL')).toHaveTextContent(DSL);
    expect(a().getByLabelText('Executed DSL')).toHaveAttribute('data-wrap', 'false');
    f.rerender(f.wrap({ wrapJson: true }));
    expect(a().getByLabelText('Executed DSL')).toHaveAttribute('data-wrap', 'true');
    const selectBox = a().getByRole('combobox', { name: 'Aggregation' });
    selectBox.focus();
    expect(selectBox).toHaveFocus();
    await f.user.tab();
    expect(a().getByRole('button', { name: 'Copy received response' })).toHaveFocus();
    expect(f.onRun).not.toHaveBeenCalled();
  });

  it('switches language without reinterpreting against a new draft or issuing commands', async () => {
    const f = setup();
    open();
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.getByRole('region', { name: '聚合' })).toBeVisible();
    expect(screen.getByLabelText('amount')).toHaveTextContent('9007199254740993');
    expect(screen.getByRole('combobox', { name: '接收页' })).toBeVisible();
    expect(f.onRun).not.toHaveBeenCalled();
    expect(f.onViewChange).not.toHaveBeenCalled();
    expect(Object.keys(zhQueryAggregations).sort()).toEqual(Object.keys(enQueryAggregations).sort());
  });
});
