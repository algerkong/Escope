import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { selectDataView, type DataViewDefinition } from '../../src/domain/data-views';
import { createWorkspace } from '../../src/domain/query';
import { recoveryWorkspace } from '../../src/domain/workspace-recovery';
import { i18n } from '../../src/locales';
import { createSessionDataViewService } from '../../src/services/data-views';
import type { PitOpenRequest, QueryBackend, QueryRequest, ResourceRequest } from '../../src/services/ipc';
import { createSessionQueryLibraryService } from '../../src/services/query-library';
import { createSessionStorage } from '../../src/services/storage';
import { createSessionWorkspaceRecoveryService } from '../../src/services/workspace-recovery';

async function fixture(selected = false, removed = false, withRuntime = false) {
  const storage = createSessionStorage();
  const a = await storage.saveConnection({ displayName: 'Alpha', endpoint: 'https://a.test', environment: 'development' });
  const b = await storage.saveConnection({ displayName: 'Beta', endpoint: 'https://b.test', environment: 'development' });
  await storage.selectConnection(a.id);
  const definition: DataViewDefinition = { id: 'view-a', connectionId: a.id, name: 'Events', index: 'events-*', defaultTimeField: '@timestamp',
    fieldFormats: { version: 1, entries: [{ field: 'n', format: { kind: 'number', grouping: true } }] },
    ...(withRuntime ? { runtimeFields: { version: 1, entries: [
      { field: 'n', type: 'long' as const, script: { lang: 'painless' as const, source: 'emit(9007199254740995L);' } },
    ] } } : {}) };
  const other: DataViewDefinition = { id: 'view-b', connectionId: b.id, name: 'Audit', index: 'audit', defaultTimeField: null };
  const dataViews = createSessionDataViewService();
  await dataViews.save(0, { version: 1, entries: [definition, other] });
  const workspace = createWorkspace(a.id);
  const query = workspace.tabs[0]!.document;
  query.name = 'Working draft';
  query.index = selected ? definition.index : 'previous';
  query.dsl = '{"query":{"term":{"n":9007199254740993}},"size":25}';
  if (selected) query.dataView = selectDataView(definition);
  workspace.activeTabId = query.id;
  const recovery = { ...createSessionWorkspaceRecoveryService(), kind: 'desktop' as const };
  await recovery.save(0, { version: 1, workspace: recoveryWorkspace(workspace), history: [] });
  const library = createSessionQueryLibraryService();
  if (removed) await storage.deleteConnection(a.id);
  const initial = await storage.load();
  initial.preferences.locale = 'en-US';
  const endpoint = (id: string) => id === a.id ? a.endpoint : b.endpoint;
  const backend = {
    available: true,
    readResource: vi.fn(async (request: ResourceRequest) => ({
      ...request, endpoint: endpoint(request.connectionId), rawResponse: request.resource === 'indices'
        ? '{"indices":[{"name":"orders","attributes":["open"],"aliases":[]}],"aliases":[],"data_streams":[]}'
        : '{"indices":["events-1"],"fields":{"@timestamp":{"date":{"searchable":true}}}}',
    })),
    execute: vi.fn(async (request: QueryRequest) => ({
      ...request, endpoint: endpoint(request.connectionId), pitId: request.pitId ?? null, partial: false,
      rawResponse: '{"took":1,"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},"hits":{"total":{"value":1,"relation":"eq"},'
        + '"hits":[{"_index":"events-1","_id":"result-id","_source":{"marker":"original-result","n":9007199254740993},'
        + (withRuntime ? '"fields":{"n":[9007199254740995]},' : '') + '"sort":[1]}]}}',
    })),
    cancel: vi.fn(async () => true),
    openPit: vi.fn(async (request: PitOpenRequest) => ({ ...request, endpoint: endpoint(request.connectionId), pitId: 'fixture-pit' })),
    closePit: vi.fn(async () => {}),
  } satisfies QueryBackend;
  const mount = () => render(<I18nextProvider i18n={i18n}><App service={{ ...storage, kind: 'desktop' }} initial={initial}
    queryBackend={backend} dataViewService={dataViews} queryLibraryService={library} workspaceRecoveryService={recovery} /></I18nextProvider>);
  const saved = () => waitFor(() => expect(screen.getByText('Workspace saved')).toBeVisible());
  return { a, b, query, definition, other, dataViews, recovery, library, backend, mount, saved, user: userEvent.setup() };
}

describe('Data Views in the query workspace', () => {
  it('reviews and applies runtime DSL without executing, preserves prior results, and restores both definition and exact applied text', async () => {
    const f = await fixture(true, false, true);
    const first = f.mount();
    await f.saved();
    expect(f.backend.execute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    await screen.findByText('9,007,199,254,740,993');
    expect(f.backend.execute.mock.calls[0]![0].rawDsl).not.toContain('runtime_mappings');
    fireEvent.click(screen.getByRole('button', { name: 'Review query-time fields' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview final DSL' }));
    expect(screen.getByRole('button', { name: 'Apply to draft' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /Allow field shadowing/ }));
    const final = (screen.getByLabelText('Final query DSL') as HTMLTextAreaElement).value;
    fireEvent.click(screen.getByRole('button', { name: 'Apply to draft' }));
    expect(screen.getByLabelText('Query DSL')).toHaveValue(final);
    expect(screen.getByText('9,007,199,254,740,993')).toBeVisible();
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    const returned = await screen.findByText('["9,007,199,254,740,995"]');
    expect(returned).toHaveAttribute('data-runtime-field', 'true');
    expect(returned).toHaveAttribute('title', 'Query-time value from fields; Formatted value; original: [9007199254740995]');
    expect(f.backend.execute.mock.calls[1]![0].rawDsl).toBe(final);
    expect(f.backend.execute.mock.calls[1]![0]).not.toHaveProperty('runtimeFields');
    await f.saved();
    const stored = (await f.recovery.load()).document;
    expect(stored.history[0]!.snapshot.dataView!.definition.runtimeFields).toEqual(f.definition.runtimeFields);
    expect(stored.history[0]!.snapshot.rawDsl).toBe(final);
    first.unmount();
    f.mount();
    await f.saved();
    expect(screen.getByLabelText('Query DSL')).toHaveValue(final);
    expect(screen.getByRole('button', { name: 'Review query-time fields' })).toBeEnabled();
    expect(f.backend.execute).toHaveBeenCalledTimes(2);
    expect(f.backend.openPit).not.toHaveBeenCalled();
  });

  it('freezes field formats for results/history until a new explicit execution, including raw view and clipboard', async () => {
    const f = await fixture(true);
    f.mount();
    await f.saved();
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    const formatted = await screen.findByText('9,007,199,254,740,993');
    expect(formatted).toHaveAttribute('title', 'Formatted value; original: 9007199254740993');
    const range = document.createRange();
    range.selectNodeContents(formatted);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    const clipboardData = { setData: vi.fn() };
    fireEvent.copy(formatted, { clipboardData });
    expect(clipboardData.setData).toHaveBeenCalledWith('text/plain', '9007199254740993');
    document.getSelection()!.removeAllRanges();
    fireEvent.click(screen.getByRole('button', { name: 'Manage data views' }));
    const row = screen.getByText('Events', { selector: 'strong' }).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Edit data view' }));
    await f.user.selectOptions(screen.getByLabelText('Format'), 'percent');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('dialog', { name: 'Data Views' });
    await f.user.keyboard('{Escape}');
    await f.user.selectOptions(screen.getByLabelText('Data view'), f.definition.id);
    expect(screen.getByText('9,007,199,254,740,993')).toBeVisible();
    expect(screen.getByLabelText('Query DSL')).toHaveValue(f.query.dsl);
    await f.saved();
    const stored = (await f.recovery.load()).document;
    expect(stored.history[0]!.snapshot.dataView?.definition.fieldFormats?.entries[0]?.format.kind).toBe('number');
    expect(stored.workspace!.tabs[0]!.document.dataView?.definition.fieldFormats?.entries[0]?.format.kind).toBe('percent');
    const toggle = screen.getByRole('button', { name: 'Execution field formats' });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('9007199254740993')).toBeVisible();
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    expect(f.backend.execute.mock.calls[0]![0]).not.toHaveProperty('dataView');
    expect(f.backend.execute.mock.calls[0]![0]).not.toHaveProperty('fieldFormats');
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    expect(await screen.findByText('900,719,925,474,099,300%')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Execution field formats' })).toHaveAttribute('aria-pressed', 'true');
    expect(f.backend.execute).toHaveBeenCalledTimes(2);
    expect(f.backend.execute.mock.calls[1]![0].rawDsl).toBe(f.query.dsl);
    await f.saved();
  });

  it('applies explicitly without execution, keeps old results during definition edits, and preserves settings/locale behavior', async () => {
    const f = await fixture();
    f.mount();
    await f.saved();
    const select = screen.getByLabelText('Data view');
    expect(within(select).getByRole('option', { name: 'Events' })).toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: 'Audit' })).not.toBeInTheDocument();
    await f.user.selectOptions(select, f.definition.id);
    expect(screen.getByLabelText('Index or pattern')).toHaveValue('events-*');
    expect(screen.getByLabelText('Query DSL')).toHaveValue(f.query.dsl);
    expect(f.backend.execute).not.toHaveBeenCalled();
    expect(f.backend.openPit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    await screen.findByText('original-result');
    fireEvent.click(screen.getByRole('button', { name: 'Manage data views' }));
    const row = screen.getByText('Events', { selector: 'strong' }).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Edit data view' }));
    fireEvent.change(screen.getByLabelText('Index, alias, data stream or pattern'), { target: { value: 'updated-*' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('dialog', { name: 'Data Views' });
    await f.user.keyboard('{Escape}');
    expect(screen.getByText('Library definition changed; draft keeps its saved copy.')).toBeVisible();
    expect(screen.getByLabelText('Index or pattern')).toHaveValue('events-*');
    expect(screen.getByText('original-result')).toBeVisible();
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    await f.user.selectOptions(screen.getByLabelText('Data view'), f.definition.id);
    expect(screen.getByLabelText('Index or pattern')).toHaveValue('updated-*');
    expect(screen.getByLabelText('Query DSL')).toHaveValue(f.query.dsl);
    expect(screen.getByText('original-result')).toBeVisible();
    await f.saved();
    const record = await f.recovery.load();
    expect(record.document.history[0]!.snapshot.index).toBe('events-*');
    expect(record.document.workspace!.tabs[0]!.document.dataView!.definition.index).toBe('updated-*');
    await f.user.click(screen.getAllByRole('button', { name: 'Settings' })[0]!);
    await f.user.click(screen.getByRole('button', { name: 'Appearance' }));
    await f.user.click(screen.getByRole('button', { name: 'Dark' }));
    await f.user.click(screen.getByRole('button', { name: 'Back to query' }));
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.getByLabelText('数据视图')).toHaveValue(f.definition.id);
    await act(async () => { await i18n.changeLanguage('en-US'); });
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    expect(f.backend.openPit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Index or pattern'), { target: { value: 'manual' } });
    expect(screen.getByLabelText('Data view')).toHaveValue('');
    expect(screen.getByText('original-result')).toBeVisible();
    await f.saved();
  });

  it('creates a new query for another connection and never changes an existing locked index tab', async () => {
    const f = await fixture(true);
    f.mount();
    await f.saved();
    fireEvent.click(await screen.findByRole('button', { name: 'orders' }));
    await screen.findByText('original-result');
    expect(screen.queryByLabelText('Data view')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Manage data views' }));
    const audit = screen.getByText('Audit', { selector: 'strong' }).closest('li')!;
    fireEvent.click(within(audit).getByRole('button', { name: 'Open as new query' }));
    expect(screen.getByLabelText('Active connection')).toHaveValue(f.b.id);
    expect(screen.getByLabelText('Index or pattern')).toHaveValue('audit');
    expect(screen.getByLabelText('Data view')).toHaveValue('view-b');
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    await f.user.click(screen.getByRole('tab', { name: 'orders (Alpha)' }));
    expect(screen.getByLabelText('Active connection')).toHaveValue(f.a.id);
    expect(screen.getByText('original-result')).toBeVisible();
    expect(screen.queryByLabelText('Data view')).not.toBeInTheDocument();
    await f.user.click(screen.getByRole('tab', { name: 'Working draft' }));
    expect(screen.getByLabelText('Data view')).toHaveValue(f.definition.id);
    expect(screen.getByLabelText('Index or pattern')).toHaveValue('events-*');
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    await f.saved();
  });

  it('retains a removed definition in saved drafts and restart recovery without executing', async () => {
    const f = await fixture(true);
    const first = f.mount();
    await f.saved();
    fireEvent.click(screen.getByRole('button', { name: 'Manage data views' }));
    const events = screen.getByText('Events', { selector: 'strong' }).closest('li')!;
    fireEvent.click(within(events).getByRole('button', { name: 'Delete data view' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete data view' }));
    await screen.findByRole('dialog', { name: 'Data Views' });
    await f.user.keyboard('{Escape}');
    expect(screen.getByText('Library definition removed; draft keeps its saved copy.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await f.library.load()).entries[0]!.dataView).toEqual(selectDataView(f.definition)));
    await f.saved();
    first.unmount();
    f.mount();
    await f.saved();
    expect(screen.getByText('Library definition removed; draft keeps its saved copy.')).toBeVisible();
    expect(screen.getByLabelText('Index or pattern')).toHaveValue('events-*');
    expect(screen.getByLabelText('Query DSL')).toHaveValue(f.query.dsl);
    expect(f.backend.execute).not.toHaveBeenCalled();
    expect(f.backend.openPit).not.toHaveBeenCalled();
  });

  it('keeps a deleted connection ID bound to the recovered copy and cannot open it on the remaining connection', async () => {
    const f = await fixture(true, true);
    f.mount();
    await f.saved();
    expect(screen.getByRole('button', { name: 'Run query' })).toBeDisabled();
    expect(screen.getByLabelText('Index or pattern')).toHaveValue('events-*');
    fireEvent.click(screen.getByRole('button', { name: 'Manage data views' }));
    const events = screen.getByText('Events', { selector: 'strong' }).closest('li')!;
    expect(within(events).getByText(/Removed connection/)).toBeVisible();
    expect(within(events).getByRole('button', { name: 'Open as new query' })).toBeDisabled();
    expect((await f.recovery.load()).document.workspace!.tabs[0]!.document.connectionId).toBe(f.a.id);
    expect(f.backend.execute).not.toHaveBeenCalled();
    expect(f.backend.openPit).not.toHaveBeenCalled();
  });
});
