import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_DOCUMENT_DETAIL_NODES, inspectLoadedDocument } from '../../src/domain/document-detail';
import { MAX_LOADED_DOCUMENT_BYTES } from '../../src/domain/loaded-document';
import { createQuery, createSnapshot, type QueryDocument } from '../../src/domain/query';
import { parseQueryResult } from '../../src/domain/query-result';
import { runtimeFieldNamesFromDsl } from '../../src/domain/runtime-fields-dsl';
import { DocumentDetailDialog } from '../../src/features/query/DocumentDetailDialog';
import { QueryResults } from '../../src/features/query/QueryResults';
import type { ExecutionEntry, ExecutionPage } from '../../src/features/query/useQueryExecutions';
import { i18n } from '../../src/locales';
import { enLive } from '../../src/locales/query-live';

const RAW = '{"_index":"orders-1","_id":"same","_score":null,"_source":{"n":9007199254740993,"null":null,"empty":[],"obj":{},"a.b":1,'
  + '"a":{"b":2},"list":[{"item":3}],"text":"\\u0061","html":"<img src=x>","rank":10,"absent":"old"},"fields":{"rank":[9007199254740993]}}';
const OTHER = '{"_index":"orders-2","_id":"same","_source":{"n":9007199254740992}}';
const DSL = '{"runtime_mappings":{"rank":{"type":"long","script":{"source":"emit(1L)"}},"absent":{"type":"keyword"}}}';
const fetchSpy = vi.fn();

function fixture(groups: readonly (readonly string[])[] = [[RAW]], options: { query?: QueryDocument; requestId?: string; partial?: boolean } = {}) {
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
  const onLayoutChange = vi.fn();
  const onViewChange = vi.fn();
  const props = {
    query: f.query, entry: f.entry, available: true, stale: false, endpointChanged: false,
    onRun, onCancel, onLoadMore, onViewChange, onLayoutChange,
  };
  const wrap = (next: Partial<Parameters<typeof QueryResults>[0]> = {}) => <I18nextProvider i18n={i18n}>
    <QueryResults {...props} {...next} />
  </I18nextProvider>;
  const view = render(wrap());
  const user = userEvent.setup();
  return { ...view, user, wrap, onRun, onLoadMore, onCancel, onLayoutChange, onViewChange, f };
}

const dialog = () => screen.getByRole('dialog');
const d = () => within(dialog());
const fieldRow = (path: string) => [...dialog().querySelectorAll<HTMLTableRowElement>('tbody tr')].find((row) => row.dataset.path === path)!;
const value = (path: string) => d().getByLabelText(`Original value: ${path}`);
const open = () => fireEvent.click(screen.getAllByRole('button', { name: 'Document same' })[0]!);

beforeEach(async () => { await i18n.changeLanguage('en-US'); vi.stubGlobal('fetch', fetchSpy); });
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('structured loaded document detail UI', () => {
  it('opens the structured view, keeps literal sources separate and expands real JSON containers', async () => {
    const f = setup();
    open();
    expect(d().getByRole('button', { name: 'Structured' })).toHaveAttribute('aria-pressed', 'true');
    expect(value('/_id')).toHaveTextContent('"same"');
    expect(value('/_source/n')).toHaveTextContent('9007199254740993');
    expect(fieldRow('/_source/null')).toHaveAttribute('data-kind', 'null');
    expect(value('/_source/null')).toHaveTextContent('null');
    expect(value('/_source/empty')).toHaveTextContent('[]');
    expect(value('/_source/obj')).toHaveTextContent('{}');
    expect(value('/_source/a.b')).toHaveTextContent('1');
    expect(d().queryByLabelText('Original value: /_source/a/b')).toBeNull();
    await f.user.click(d().getByRole('button', { name: 'Expand /_source/a' }));
    expect(value('/_source/a/b')).toHaveTextContent('2');
    expect(d().getByRole('button', { name: 'Collapse /_source/a' })).toHaveAttribute('aria-expanded', 'true');
    await f.user.click(d().getByRole('button', { name: 'Expand /fields/rank' }));
    expect(value('/fields/rank/0')).toHaveTextContent('9007199254740993');
    expect(fieldRow('/fields/rank/0')).toHaveAttribute('data-runtime', 'true');
    expect(fieldRow('/_source/rank')).toHaveAttribute('data-runtime', 'false');
    expect(within(fieldRow('/fields/absent')).getByText('Not returned')).toBeVisible();
    expect(d().getByRole('button', { name: 'Copy original value: /fields/absent' })).toBeDisabled();
    expect(dialog()).not.toHaveTextContent('emit(');
    expect(dialog().querySelector('img, script, a')).toBeNull();
    expect(f.onRun).not.toHaveBeenCalled();
    expect(f.onLoadMore).not.toHaveBeenCalled();
    expect(f.onCancel).not.toHaveBeenCalled();
    expect(f.onLayoutChange).not.toHaveBeenCalled();
  });

  it('copies precise scalars, escaped strings, whole containers and unambiguous JSON Pointers', async () => {
    const f = setup(fixture([['{"_id":"same","_source":{"a/b~":{"n":9007199254740993},"text":"\\u0061"}}']]));
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    open();
    expect(clipboard).not.toHaveBeenCalled();
    await f.user.click(d().getByRole('button', { name: 'Copy JSON Pointer: /_source/a~1b~0' }));
    expect(clipboard).toHaveBeenLastCalledWith('/_source/a~1b~0');
    await f.user.click(d().getByRole('button', { name: 'Copy original value: /_source/a~1b~0' }));
    expect(clipboard).toHaveBeenLastCalledWith('{"n":9007199254740993}');
    await f.user.click(d().getByRole('button', { name: 'Expand /_source/a~1b~0' }));
    await f.user.click(d().getByRole('button', { name: 'Copy original value: /_source/a~1b~0/n' }));
    expect(clipboard).toHaveBeenLastCalledWith('9007199254740993');
    await f.user.click(d().getByRole('button', { name: 'Copy original value: /_source/text' }));
    expect(clipboard).toHaveBeenLastCalledWith('"\\u0061"');
    expect(f.f.query.dsl).toBe(DSL);
    expect(f.onRun).not.toHaveBeenCalled();
  });

  it('keeps raw hit, document payload and original response copying distinct, including clipboard rejection', async () => {
    const f = setup();
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    open();
    await f.user.click(d().getByRole('button', { name: 'Copy raw hit' }));
    expect(clipboard).toHaveBeenLastCalledWith(RAW);
    await f.user.click(d().getByRole('button', { name: 'Copy document' }));
    expect(clipboard).toHaveBeenLastCalledWith(expect.stringContaining('"n":9007199254740993'));
    expect(clipboard).not.toHaveBeenLastCalledWith(expect.stringContaining('"_index"'));
    await f.user.click(d().getByRole('button', { name: 'Copy raw response' }));
    expect(clipboard).toHaveBeenLastCalledWith(f.f.entry.pages[0]!.rawResponse);
    await f.user.click(d().getByRole('button', { name: 'JSON' }));
    expect(d().getByLabelText('Raw hit JSON')).toHaveTextContent('"n": 9007199254740993');
    expect(d().getByLabelText('Raw hit JSON')).toHaveTextContent('"text": "\\u0061"');
    expect(d().getByLabelText('Raw hit JSON')).toHaveAttribute('data-wrap', 'false');
    f.rerender(f.wrap({ wrapJson: true }));
    expect(d().getByLabelText('Raw hit JSON')).toHaveAttribute('data-wrap', 'true');
    clipboard.mockRejectedValueOnce(new Error('unavailable clipboard'));
    await f.user.click(d().getByRole('button', { name: 'Copy raw hit' }));
    expect(await d().findByText(enLive.copyFailed)).toBeVisible();
    expect(f.onRun).not.toHaveBeenCalled();
    expect(f.onViewChange).not.toHaveBeenCalled();
  });

  it('copies fields when source is absent, null when it is returned, and disables a missing payload', async () => {
    const f = setup(fixture([['{"_id":"same","fields":{"n":[9007199254740993]}}', '{"_id":"same","_source":null}', '{"_id":"same"}']]));
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    open();
    expect(within(fieldRow('/_source')).getByText('Not returned')).toBeVisible();
    await f.user.click(d().getByRole('button', { name: 'Copy document' }));
    expect(clipboard).toHaveBeenLastCalledWith('{"n":[9007199254740993]}');
    await f.user.keyboard('{Escape}');
    await f.user.click(screen.getAllByRole('button', { name: 'Document same' })[1]!);
    expect(value('/_source')).toHaveTextContent('null');
    await f.user.click(d().getByRole('button', { name: 'Copy document' }));
    expect(clipboard).toHaveBeenLastCalledWith('null');
    await f.user.keyboard('{Escape}');
    await f.user.click(screen.getAllByRole('button', { name: 'Document same' })[2]!);
    expect(d().getByRole('button', { name: 'Copy document' })).toBeDisabled();
    expect(d().getByRole('button', { name: 'Copy raw hit' })).toBeEnabled();
  });

  it('shows missing real metadata without putting a positional fallback ID in the title or metadata', () => {
    setup(fixture([['{"_source":{"_id":"shadow"}}']]));
    fireEvent.click(screen.getByRole('button', { name: 'Document 0' }));
    expect(screen.getByRole('dialog', { name: 'Document detail' })).toBeVisible();
    expect(fieldRow('/_id')).toHaveAttribute('data-kind', 'missing');
    expect(within(fieldRow('/_id')).getByText('Not returned')).toBeVisible();
    expect(value('/_source/_id')).toHaveTextContent('"shadow"');
    expect(d().getByText('Received page 1, row 1')).toBeVisible();
  });

  it('filters all loaded paths inside collapsed containers, never values, and restores fold state after search', async () => {
    const f = setup();
    open();
    await f.user.click(d().getByRole('button', { name: 'Collapse all containers' }));
    expect(d().queryByLabelText('Original value: /_source/n')).toBeNull();
    const search = d().getByRole('searchbox', { name: 'Find JSON path' });
    expect(search).toHaveAttribute('maxlength', '1024');
    await f.user.type(search, 'list/0/item');
    expect(value('/_source/list/0/item')).toHaveTextContent('3');
    expect(d().getByRole('button', { name: 'Expand all containers' })).toBeDisabled();
    expect(dialog().querySelectorAll('tbody tr')).toHaveLength(1);
    await f.user.clear(search);
    expect(d().queryByLabelText('Original value: /_source/list/0/item')).toBeNull();
    await f.user.type(search, '9007199254740993');
    expect(d().getByText('No matching paths')).toBeVisible();
    await f.user.clear(search);
    await f.user.click(d().getByRole('button', { name: 'Expand all containers' }));
    expect(value('/_source/list/0/item')).toHaveTextContent('3');
    await f.user.click(d().getByRole('button', { name: 'fields' }));
    expect(d().queryByLabelText('Original value: /_source/n')).toBeNull();
    expect(value('/fields/rank/0')).toHaveTextContent('9007199254740993');
    await f.user.click(d().getByRole('button', { name: 'Metadata' }));
    expect(value('/_id')).toHaveTextContent('"same"');
    expect(d().queryByLabelText('Original value: /fields/rank/0')).toBeNull();
    expect(f.onRun).not.toHaveBeenCalled();
    expect(f.onLoadMore).not.toHaveBeenCalled();
  });

  it('paginates directory rows at 50 without hiding fields from search or raw JSON', async () => {
    const raw = `{"_id":"same","_source":{${Array.from({ length: 120 }, (_, n) => `"field-${n}":${n}`).join(',')}}}`;
    const f = setup(fixture([[raw]]));
    open();
    expect(dialog().querySelectorAll('tbody tr')).toHaveLength(50);
    await f.user.click(d().getByRole('button', { name: 'Next detail page' }));
    expect(d().getByText('Page 2 of 3')).toBeVisible();
    await f.user.type(d().getByRole('searchbox', { name: 'Find JSON path' }), 'field-119');
    expect(dialog().querySelectorAll('tbody tr')).toHaveLength(1);
    expect(value('/_source/field-119')).toHaveTextContent('119');
    expect(d().queryByRole('button', { name: 'Next detail page' })).toBeNull();
    await f.user.click(d().getByRole('button', { name: 'JSON' }));
    expect(d().getByLabelText('Raw hit JSON')).toHaveTextContent('"field-119": 119');
    await f.user.click(d().getByRole('button', { name: 'Structured' }));
    expect(value('/_source/field-119')).toBeVisible();
    await f.user.clear(d().getByRole('searchbox', { name: 'Find JSON path' }));
    expect(d().getByText('Page 1 of 3')).toBeVisible();
    expect(f.onLoadMore).not.toHaveBeenCalled();
  });

  it('opens the correct occurrence across received pages and local sorting, retaining row selection and focus on close', async () => {
    const f = setup(fixture([[RAW, ...Array.from({ length: 49 }, (_, n) => `{"_id":"filler-${n}","_source":{"n":${n}}}`)], [OTHER]]));
    await f.user.click(screen.getByRole('button', { name: 'Next page' }));
    const gridRow = document.querySelector<HTMLTableRowElement>('.rg-table tbody tr')!;
    fireEvent.click(gridRow);
    await f.user.click(screen.getByRole('button', { name: 'Sort by n' }));
    await f.user.click(screen.getByRole('button', { name: 'Previous page' }));
    const opener = screen.getAllByRole('button', { name: 'Document same' })[0]!;
    await f.user.click(opener);
    expect(value('/_source/n')).toHaveTextContent('9007199254740992');
    expect(value('/_index')).toHaveTextContent('"orders-2"');
    expect(d().getByText('Received page 2, row 1')).toBeVisible();
    await f.user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(opener).toHaveFocus());
    expect(document.querySelectorAll('.rg-table tr[aria-selected="true"]')).toHaveLength(1);
    expect(f.onLoadMore).not.toHaveBeenCalled();
    expect(f.onRun).not.toHaveBeenCalled();
  });

  it('freezes the selected raw hit, page and origin while pages change and drafts or endpoints diverge', async () => {
    const f = setup();
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    open();
    const replacement = fixture([[OTHER]]).entry.pages[0]!;
    f.rerender(f.wrap({
      entry: { ...f.f.entry, pages: [replacement, replacement], endpoint: 'https://new.test', continuing: true },
      query: { ...f.f.query, index: 'other-*', dsl: '{}', revision: 1 }, stale: true, endpointChanged: true,
    }));
    expect(value('/_source/n')).toHaveTextContent('9007199254740993');
    expect(fieldRow('/fields/rank')).toHaveAttribute('data-runtime', 'true');
    expect(d().getByText(enLive.staleResult)).toBeVisible();
    expect(d().getByText(enLive.endpointChanged)).toBeVisible();
    await f.user.click(dialog().querySelector('summary')!);
    expect(d().getByText('https://old.test')).toBeVisible();
    expect(d().getByText('request-1')).toBeVisible();
    expect(d().getByText('c1')).toBeVisible();
    expect(d().queryByText('other-*')).toBeNull();
    await f.user.click(d().getByRole('button', { name: 'Copy raw hit' }));
    expect(clipboard).toHaveBeenLastCalledWith(RAW);
    await f.user.click(d().getByRole('button', { name: 'Copy raw response' }));
    expect(clipboard).toHaveBeenLastCalledWith(f.f.entry.pages[0]!.rawResponse);
    expect(f.onRun).not.toHaveBeenCalled();
    expect(f.onLoadMore).not.toHaveBeenCalled();
  });

  it('retains a partial-result notice even if later pages complete', () => {
    const f = setup(fixture([[RAW]], { partial: true }));
    open();
    expect(d().getByText('This record belongs to a partial result.')).toBeVisible();
    if (f.f.entry.state.status !== 'success' && f.f.entry.state.status !== 'partial') throw new Error('result required');
    f.rerender(f.wrap({ entry: { ...f.f.entry, state: { ...f.f.entry.state, status: 'success' } } }));
    expect(d().getByText('This record belongs to a partial result.')).toBeVisible();
  });

  it('closes synchronously for running or replaced execution snapshots, including a reused request ID', () => {
    const f = setup();
    open();
    const next = fixture([[OTHER]], { query: f.f.query });
    if (!('snapshot' in next.entry.state)) throw new Error('snapshot required');
    f.rerender(f.wrap({ entry: next.entry }));
    expect(screen.queryByRole('dialog')).toBeNull();
    f.rerender(f.wrap());
    expect(screen.queryByRole('dialog')).toBeNull();
    open();
    f.rerender(f.wrap({ entry: { ...next.entry, state: { status: 'running', snapshot: next.entry.state.snapshot }, pages: [], parsed: null } }));
    expect(screen.queryByRole('dialog')).toBeNull();
    f.rerender(f.wrap({ entry: next.entry }));
    expect(screen.queryByRole('dialog')).toBeNull();
    open();
    expect(value('/_source/n')).toHaveTextContent('9007199254740992');
    f.rerender(f.wrap({ entry: fixture([[RAW]], { query: f.f.query }).entry }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('requires explicit reopening after settings or tab changes, resets detail controls and leaves the grid intact', async () => {
    const f = setup();
    open();
    await f.user.type(d().getByRole('searchbox', { name: 'Find JSON path' }), 'rank');
    f.rerender(f.wrap({ active: false }));
    expect(screen.queryByRole('dialog')).toBeNull();
    f.rerender(f.wrap());
    expect(screen.queryByRole('dialog')).toBeNull();
    open();
    expect(d().getByRole('searchbox', { name: 'Find JSON path' })).toHaveValue('');
    const other = fixture([[OTHER]]);
    f.rerender(f.wrap({ query: other.query, entry: other.entry }));
    expect(screen.queryByRole('dialog')).toBeNull();
    f.rerender(f.wrap());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(f.onRun).not.toHaveBeenCalled();
  });

  it('uses the same local detail in index previews and changes language without changing values or fetching', async () => {
    const f = setup();
    f.rerender(f.wrap({ kind: 'preview' }));
    open();
    await f.user.click(d().getByRole('button', { name: 'Expand /fields/rank' }));
    await act(() => i18n.changeLanguage('zh-CN'));
    expect(screen.getByRole('dialog', { name: '文档 same' })).toBeVisible();
    expect(d().getByLabelText('原始值：/fields/rank/0')).toHaveTextContent('9007199254740993');
    expect(d().getByRole('searchbox', { name: '查找 JSON 路径' })).toBeVisible();
    expect(d().getAllByText('fields（查询期字段）').length).toBeGreaterThan(0);
    expect(f.onRun).not.toHaveBeenCalled();
    expect(f.onLoadMore).not.toHaveBeenCalled();
  });

  it('bounds the title and displays long values safely without shortening explicit copies', async () => {
    const id = 'x'.repeat(300);
    const path = '/_source/' + 'long-name'.repeat(100);
    const raw = `{"_id":"${id}","_source":{"${path.slice('/_source/'.length)}":"${'v'.repeat(1000)}"}}`;
    const f = setup(fixture([[raw]]));
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    await f.user.click(screen.getByRole('button', { name: `Document ${id}` }));
    expect(screen.getByRole('dialog', { name: `Document ${id.slice(0, 160)}...` })).toBeVisible();
    expect(value('/_id').textContent).toBe(JSON.stringify(id));
    await f.user.click(d().getByRole('button', { name: `Copy JSON Pointer: ${path}` }));
    expect(clipboard).toHaveBeenLastCalledWith(path);
    await f.user.click(d().getByRole('button', { name: `Copy original value: ${path}` }));
    expect(clipboard).toHaveBeenLastCalledWith(`"${'v'.repeat(1000)}"`);
  });

  it.each([
    [`{"_id":"same","_source":{"text":"${'x'.repeat(MAX_LOADED_DOCUMENT_BYTES)}"}}`, '1 MiB per raw hit'],
    [`{"_id":"same","_source":{"array":[${Array.from({ length: MAX_DOCUMENT_DETAIL_NODES }, () => '0').join(',')}]}}`, '4,096 nodes'],
  ])('refuses oversized details without partial rows or a copy fallback', (raw, message) => {
    setup(fixture([[raw]]));
    open();
    expect(d().getByRole('alert')).toHaveTextContent(message);
    expect(dialog().querySelector('table')).toBeNull();
    expect(d().queryByRole('button', { name: 'Copy raw hit' })).toBeNull();
  });

  it('reports an unavailable received identity instead of showing stale or guessed content', () => {
    const f = fixture();
    if (!('snapshot' in f.entry.state)) throw new Error('snapshot required');
    const hit = f.entry.pages[0]!.summary.hits[0]!;
    const result = inspectLoadedDocument(f.entry.state.snapshot, f.entry.endpoint, f.entry.pages,
      { hit: { ...hit }, pageIndex: 0, position: 0 });
    render(<I18nextProvider i18n={i18n}><DocumentDetailDialog result={result} stale={false} endpointChanged={false}
      partial={false} wrapJson={false} onClose={() => {}} /></I18nextProvider>);
    expect(d().getByRole('alert')).toHaveTextContent('no longer available');
    expect(dialog().querySelector('table')).toBeNull();
  });
});
