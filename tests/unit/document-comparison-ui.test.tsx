import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_COMPARISON_HIT_BYTES, compareLoadedDocuments } from '../../src/domain/document-comparison';
import { createQuery, createSnapshot, type QueryDocument } from '../../src/domain/query';
import { parseQueryResult } from '../../src/domain/query-result';
import { runtimeFieldNamesFromDsl } from '../../src/domain/runtime-fields-dsl';
import { DocumentComparisonDialog } from '../../src/features/query/DocumentComparisonDialog';
import { QueryResults } from '../../src/features/query/QueryResults';
import type { ExecutionEntry, ExecutionPage } from '../../src/features/query/useQueryExecutions';
import { i18n } from '../../src/locales';
import { enLive } from '../../src/locales/query-live';

const LEFT = '{"_index":"orders-1","_id":"same","_source":{"n":9007199254740993,"null":null,"same":"\\u0061","html":"<img src=x>","rank":10},"fields":{"rank":[9007199254740993]}}';
const RIGHT = '{"_index":"orders-2","_id":"same","_source":{"n":9007199254740992,"array":[],"same":"a","html":"<script>x</script>","rank":10}}';
const DSL = '{"runtime_mappings":{"rank":{"type":"long"}}}';
const fetchSpy = vi.fn();

function fixture(groups: readonly (readonly string[])[] = [[LEFT, RIGHT]], options: { query?: QueryDocument; requestId?: string; partial?: boolean } = {}) {
  const query = options.query ?? { ...createQuery('c1'), index: 'orders-*', dsl: DSL };
  const snapshot = createSnapshot(query, options.requestId ?? 'request-1', new Date('2026-10-10T00:00:00Z'));
  const pages: ExecutionPage[] = groups.map((documents) => {
    const rawResponse = `{"hits":{"total":${groups.flat().length},"hits":[${documents.join(',')}]}}`;
    const parsed = parseQueryResult(rawResponse, runtimeFieldNamesFromDsl(snapshot.rawDsl));
    if (!parsed.ok) throw new Error('valid fixture required');
    return { rawResponse, summary: parsed.summary, partial: options.partial ?? false, cursor: '[2]' };
  });
  const last = pages.at(-1)!;
  const entry: ExecutionEntry = {
    state: { status: options.partial ? 'partial' : 'success', snapshot, rawResponse: last.rawResponse },
    parsed: { ok: true, summary: last.summary }, endpoint: 'https://old.test', rawResponse: last.rawResponse,
    pages, pitId: 'fixture-pit', continuing: false, continuationError: null,
  };
  return { query, entry };
}

function setup(f = fixture()) {
  const onRun = vi.fn();
  const onCancel = vi.fn();
  const onLoadMore = vi.fn();
  const onViewChange = vi.fn();
  const onLayoutChange = vi.fn();
  const props = {
    query: f.query, entry: f.entry, available: true, stale: false, endpointChanged: false,
    onRun, onCancel, onLoadMore, onViewChange, onLayoutChange,
  };
  const wrap = (next: Partial<Parameters<typeof QueryResults>[0]> = {}) => <I18nextProvider i18n={i18n}>
    <QueryResults {...props} {...next} />
  </I18nextProvider>;
  const view = render(wrap());
  const user = userEvent.setup();
  return { ...view, user, props, wrap, onRun, onLoadMore, onCancel, onLayoutChange, f };
}

const gridRow = (position: number) => document.querySelectorAll<HTMLTableRowElement>('.rg-table tbody tr')[position]!;
const compareButton = () => screen.getByRole('button', { name: 'Compare two selected documents' });
const dialog = () => screen.getByRole('dialog', { name: 'Document comparison' });
function selectTwo() {
  fireEvent.click(gridRow(0));
  fireEvent.click(gridRow(1), { ctrlKey: true });
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('loaded document comparison UI', () => {
  it('enables only exactly two selected records and preserves selection when the dialog closes', async () => {
    const f = setup(fixture([[LEFT, RIGHT, '{"_source":{"n":3}}']]));
    expect(compareButton()).toBeDisabled();
    fireEvent.click(gridRow(0));
    expect(compareButton()).toBeDisabled();
    fireEvent.click(gridRow(1), { ctrlKey: true });
    expect(compareButton()).toBeEnabled();
    fireEvent.click(gridRow(2), { ctrlKey: true });
    expect(compareButton()).toBeDisabled();
    fireEvent.click(gridRow(2), { ctrlKey: true });
    const opener = compareButton();
    await f.user.click(opener);
    expect(dialog()).toBeVisible();
    await f.user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(opener).toHaveFocus());
    expect(gridRow(0)).toHaveAttribute('aria-selected', 'true');
    expect(gridRow(1)).toHaveAttribute('aria-selected', 'true');
    expect(f.onRun).not.toHaveBeenCalled();
    expect(f.onLoadMore).not.toHaveBeenCalled();
    expect(f.onCancel).not.toHaveBeenCalled();
  });

  it('compares the two received occurrences across loaded pages after local sorting', async () => {
    const f = setup(fixture([[LEFT, ...Array.from({ length: 49 }, (_, n) => `{"_id":"filler-${n}","_source":{"n":${n}}}`)], [RIGHT]]));
    fireEvent.click(gridRow(0));
    await f.user.click(screen.getByRole('button', { name: 'Next page' }));
    fireEvent.click(gridRow(0), { ctrlKey: true });
    await f.user.click(screen.getByRole('button', { name: 'Sort by n' }));
    const layoutCalls = f.onLayoutChange.mock.calls.length;
    await f.user.click(compareButton());
    const d = within(dialog());
    expect(d.getByText('Received page 1, row 1')).toBeVisible();
    expect(d.getByText('Received page 2, row 1')).toBeVisible();
    expect(d.getByLabelText('Left value: _source / n')).toHaveTextContent('9007199254740993');
    expect(d.getByLabelText('Right value: _source / n')).toHaveTextContent('9007199254740992');
    expect(d.getAllByText('"same"')).toHaveLength(2);
    expect(f.onLayoutChange).toHaveBeenCalledTimes(layoutCalls);
    expect(f.onLoadMore).not.toHaveBeenCalled();
    expect(f.onRun).not.toHaveBeenCalled();
    expect(f.f.query.dsl).toBe(DSL);
  });

  it('separates source, runtime fields, missing, null and original number tokens without HTML interpretation', async () => {
    const f = setup();
    selectTwo();
    await f.user.click(compareButton());
    const d = within(dialog());
    expect(d.getByLabelText('Left value: _source / n')).toHaveTextContent('9007199254740993');
    expect(d.getByLabelText('Left value: _source / null')).toHaveTextContent('null');
    expect(d.getByRole('button', { name: 'Copy Right value: _source / null' })).toBeDisabled();
    expect(d.getByLabelText('Right value: _source / array')).toHaveTextContent('[]');
    expect(d.getByLabelText('Left value: fields / rank')).toHaveTextContent('[9007199254740993]');
    expect(d.getByText('fields (runtime)')).toBeVisible();
    expect(d.getByRole('button', { name: 'Copy Right value: fields / rank' })).toBeDisabled();
    expect(dialog().querySelector('img, script')).toBeNull();
    await f.user.click(d.getByRole('button', { name: '_source' }));
    expect(d.queryByLabelText('Left value: fields / rank')).toBeNull();
    await f.user.click(d.getByRole('checkbox', { name: 'Differences only' }));
    expect(d.getByLabelText('Left value: _source / same')).toHaveTextContent('"\\u0061"');
    expect(d.getByLabelText('Right value: _source / same')).toHaveTextContent('"a"');
    expect(d.getByLabelText('Left value: _source / rank')).toHaveTextContent('10');
  });

  it('swaps both values and one-sided status, and copies the original hit and value only on explicit clicks', async () => {
    const f = setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    selectTwo();
    await f.user.click(compareButton());
    const d = within(dialog());
    expect(write).not.toHaveBeenCalled();
    await f.user.click(d.getByRole('button', { name: 'Copy Left value: _source / n' }));
    expect(write).toHaveBeenLastCalledWith('9007199254740993');
    await f.user.click(d.getByRole('button', { name: 'Swap left and right' }));
    expect(d.getByLabelText('Left value: _source / n')).toHaveTextContent('9007199254740992');
    const nullRow = d.getByLabelText('Right value: _source / null').closest('tr')!;
    expect(nullRow).toHaveAttribute('data-status', 'rightOnly');
    expect(within(nullRow).getByText('Right only')).toBeVisible();
    await f.user.click(d.getByRole('button', { name: 'Copy left raw hit' }));
    expect(write).toHaveBeenLastCalledWith(RIGHT);
    await f.user.click(d.getByRole('button', { name: 'Copy right raw hit' }));
    expect(write).toHaveBeenLastCalledWith(LEFT);
    write.mockRejectedValueOnce(new Error('clipboard unavailable'));
    await f.user.click(d.getByRole('button', { name: 'Copy right raw hit' }));
    expect(await d.findByText(enLive.copyFailed)).toBeVisible();
    expect(f.onRun).not.toHaveBeenCalled();
  });

  it('retains the frozen pair when pages append or the draft changes, including partial and endpoint warnings', async () => {
    const f = setup();
    selectTwo();
    await f.user.click(compareButton());
    const extra = fixture([['{"_source":{"new":4}}']]).entry.pages[0]!;
    f.rerender(f.wrap({
      query: { ...f.f.query, dsl: '{}', index: 'different-*', revision: 1 },
      entry: { ...f.f.entry, pages: [...f.f.entry.pages, extra], continuing: true },
      stale: true, endpointChanged: true,
    }));
    const d = within(dialog());
    expect(d.getByText(enLive.staleResult)).toBeVisible();
    expect(d.getByText(enLive.endpointChanged)).toBeVisible();
    expect(d.queryByText('"new"')).toBeNull();
    const origin = dialog().querySelector('summary')!;
    expect(origin).toHaveTextContent('Execution: orders-*');
    await f.user.click(origin);
    expect(d.getByText('https://old.test')).toBeVisible();
    expect(d.getByText('request-1')).toBeVisible();
    expect(d.getByText('c1')).toBeVisible();
    expect(d.queryByText('different-*')).toBeNull();
    f.rerender(f.wrap({ entry: { ...f.f.entry, state: { ...f.f.entry.state, status: 'partial' } as ExecutionEntry['state'] } }));
    expect(within(dialog()).getByText('These records belong to a partial result.')).toBeVisible();
    expect(f.onRun).not.toHaveBeenCalled();
    expect(f.onLoadMore).not.toHaveBeenCalled();
  });

  it('closes before a new execution can replace either selected target, without carrying row selection forward', async () => {
    const f = setup();
    selectTwo();
    await f.user.click(compareButton());
    const next = fixture([['{"_id":"same","_source":{"n":5}}', '{"_id":"same","_source":{"n":6}}']],
      { query: f.f.query, requestId: 'request-2' });
    if (!('snapshot' in next.entry.state)) throw new Error('snapshot required');
    f.rerender(f.wrap({ entry: { ...next.entry, state: { status: 'running', snapshot: next.entry.state.snapshot }, pages: [], parsed: null } }));
    expect(screen.queryByRole('dialog')).toBeNull();
    f.rerender(f.wrap({ entry: next.entry }));
    expect(compareButton()).toBeDisabled();
    expect(document.querySelectorAll('.rg-table tr[aria-selected="true"]')).toHaveLength(0);
    selectTwo();
    await f.user.click(compareButton());
    expect(within(dialog()).getByLabelText('Left value: _source / n')).toHaveTextContent('5');
    expect(within(dialog()).queryByText('9007199254740993')).toBeNull();
  });

  it('requires reopening after settings or a tab switch and keeps each tab selection independent', async () => {
    const f = setup();
    selectTwo();
    await f.user.click(compareButton());
    f.rerender(f.wrap({ active: false }));
    expect(screen.queryByRole('dialog')).toBeNull();
    f.rerender(f.wrap());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(compareButton()).toBeEnabled();
    await f.user.click(compareButton());
    const other = fixture();
    f.rerender(f.wrap({ query: other.query, entry: other.entry }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(compareButton()).toBeDisabled();
    f.rerender(f.wrap());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(compareButton()).toBeEnabled();
  });

  it('keeps keyboard selection and JSON view round trips local, and offers the existing detail view unchanged', async () => {
    const f = setup();
    fireEvent.keyDown(gridRow(0), { key: ' ' });
    fireEvent.keyDown(gridRow(1), { key: ' ' });
    f.rerender(f.wrap({ query: { ...f.f.query, resultView: 'json' } }));
    f.rerender(f.wrap());
    expect(compareButton()).toBeEnabled();
    await f.user.click(compareButton());
    await f.user.keyboard('{Escape}');
    await f.user.click(screen.getAllByRole('button', { name: 'Document same' })[0]!);
    const detail = screen.getByRole('dialog', { name: 'Document same' });
    const rawBlocks = within(detail).getAllByText(/9007199254740993/, { selector: 'pre' });
    expect(rawBlocks).toHaveLength(2);
    for (const block of rawBlocks) expect(block).toBeVisible();
    expect(f.onRun).not.toHaveBeenCalled();
    expect(f.onLoadMore).not.toHaveBeenCalled();
  });

  it('uses the same local comparison in index previews without starting another preview', async () => {
    const f = setup();
    f.rerender(f.wrap({ kind: 'preview' }));
    selectTwo();
    await f.user.click(compareButton());
    expect(dialog()).toBeVisible();
    expect(f.onRun).not.toHaveBeenCalled();
    expect(f.onLoadMore).not.toHaveBeenCalled();
  });

  it('shows an explicit limit error with no partial table or network action', async () => {
    const f = setup(fixture([[`{"_source":{"n":"${'x'.repeat(MAX_COMPARISON_HIT_BYTES)}"}}`, RIGHT]]));
    selectTwo();
    await f.user.click(compareButton());
    expect(within(dialog()).getByRole('alert')).toHaveTextContent('1 MiB per raw hit');
    expect(dialog().querySelector('.qdc-table')).toBeNull();
    expect(within(dialog()).queryByRole('button', { name: 'Copy left raw hit' })).toBeNull();
    expect(f.onRun).not.toHaveBeenCalled();
    expect(f.onLoadMore).not.toHaveBeenCalled();
  });

  it('switches dialog labels and value states to Chinese without rebuilding or executing the comparison', async () => {
    const f = setup();
    selectTwo();
    await f.user.click(compareButton());
    await act(() => i18n.changeLanguage('zh-CN'));
    const d = within(screen.getByRole('dialog', { name: '文档对比' }));
    expect(d.getByRole('checkbox', { name: '仅差异' })).toBeChecked();
    expect(d.getByRole('button', { name: '交换左右' })).toBeVisible();
    expect(d.getByLabelText('左侧值：_source / n')).toHaveTextContent('9007199254740993');
    expect(d.getByText('fields（查询期字段）')).toBeVisible();
    expect(f.onRun).not.toHaveBeenCalled();
  });

  it('paginates and filters bounded fields, resetting the page without changing comparison values', async () => {
    const a = Array.from({ length: 120 }, (_, n) => `"field-${n}":1`).join(',');
    const b = Array.from({ length: 120 }, (_, n) => `"field-${n}":2`).join(',');
    const f = fixture([[`{"_source":{${a}}}`, `{"_source":{${b}}}`]]);
    if (!('snapshot' in f.entry.state)) throw new Error('snapshot required');
    const rows = f.entry.pages[0]!.summary.hits.map((hit, position) => ({ hit, pageIndex: 0, position }));
    const result = compareLoadedDocuments(f.entry.state.snapshot, f.entry.endpoint, f.entry.pages, rows);
    render(<I18nextProvider i18n={i18n}><DocumentComparisonDialog result={result}
      stale={false} endpointChanged={false} partial={false} onClose={() => {}} /></I18nextProvider>);
    const user = userEvent.setup();
    const d = within(dialog());
    expect(dialog().querySelectorAll('tbody tr')).toHaveLength(50);
    await user.click(d.getByRole('button', { name: 'Next comparison page' }));
    expect(d.getByText('Page 2 of 3')).toBeVisible();
    expect(d.getByLabelText('Left value: _source / field-50')).toHaveTextContent('1');
    await user.type(d.getByRole('searchbox', { name: 'Find field' }), 'field-119');
    expect(dialog().querySelectorAll('tbody tr')).toHaveLength(1);
    expect(d.getByText('Fields: 1')).toBeVisible();
    expect(d.getByLabelText('Left value: _source / field-119')).toHaveTextContent('1');
    expect(d.queryByRole('button', { name: 'Next comparison page' })).toBeNull();
    await user.clear(d.getByRole('searchbox', { name: 'Find field' }));
    expect(d.getByText('Page 1 of 3')).toBeVisible();
    await user.type(d.getByRole('searchbox', { name: 'Find field' }), 'unknown');
    expect(d.getByText('No matching fields')).toBeVisible();
  });
});
