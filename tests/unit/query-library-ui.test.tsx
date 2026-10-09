import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useQueryLibrary } from '../../src/features/query/QueryLibrary';
import { QueryWorkspace } from '../../src/features/query/QueryWorkspace';
import {
  addWorkspaceTab, closeWorkspaceTab, createQuery, selectWorkspaceTab, updateWorkspaceDocument,
  type QueryDocument, type WorkspaceState,
} from '../../src/domain/query';
import { defaultPreferences } from '../../src/domain/preferences';
import { createEmptyLibrary, type SavedQueryEntry, type SavedQueryLibrary } from '../../src/domain/query-library';
import type { ConnectionProfile } from '../../src/domain/connection';
import { i18n } from '../../src/locales';
import { enQueryLibrary, zhQueryLibrary } from '../../src/locales/query-library';
import { enLive, zhLive } from '../../src/locales/query-live';
import { enResultGrid, zhResultGrid } from '../../src/locales/result-grid';
import type { PitOpenRequest, QueryBackend, QueryRequest, ResourceRequest } from '../../src/services/ipc';
import type { QueryLibraryService } from '../../src/services/query-library';

i18n.addResourceBundle('zh-CN', 'queryLibrary', zhQueryLibrary);
i18n.addResourceBundle('en-US', 'queryLibrary', enQueryLibrary);
i18n.addResourceBundle('zh-CN', 'queryLive', zhLive);
i18n.addResourceBundle('en-US', 'queryLive', enLive);
i18n.addResourceBundle('zh-CN', 'resultGrid', zhResultGrid);
i18n.addResourceBundle('en-US', 'resultGrid', enResultGrid);

const DOC_DSL = '{"query":{"range":{"total":{"gte":9007199254740993}}},"size":25}';
const baseProfile: ConnectionProfile = {
  id: 'c1', displayName: 'Fixture ES', endpoint: 'https://es.test', environment: 'development', sortOrder: 0, auth: 'none',
};

const PROBE_DOC: QueryDocument = {
  id: 'q1', connectionId: 'c1', name: '', index: 'orders-1', dsl: DOC_DSL, revision: 0, resultView: 'table',
};

function storedEntry(overrides: Partial<SavedQueryEntry> = {}): SavedQueryEntry {
  return {
    id: 'e1', name: 'Saved orders', connectionId: 'c1', index: 'other-9',
    dsl: '{"query":{"term":{"a":1}}}', resultView: 'table', favorite: false,
    updatedAt: '2026-10-09T12:00:00.000Z', ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fakeLibrary(initial: SavedQueryLibrary = createEmptyLibrary(), loadError: unknown = null) {
  const state = { stored: initial, loadError };
  const save = vi.fn(async (library: SavedQueryLibrary) => { state.stored = library; });
  const service: QueryLibraryService = {
    kind: 'session',
    load: vi.fn(async () => {
      if (state.loadError) throw state.loadError;
      return state.stored;
    }),
    save,
    saveExportFile: vi.fn(async () => ({ status: 'saved' as const })),
  };
  return { service, save, state };
}

function makeBackend(): QueryBackend {
  return {
    available: true,
    readResource: vi.fn(async (request: ResourceRequest) => ({
      requestId: request.requestId, connectionId: request.connectionId, endpoint: baseProfile.endpoint,
      rawResponse: request.resource === 'fieldCaps'
        ? '{"indices":["orders-1"],"fields":{"amount":{"long":{"type":"long","searchable":true,"aggregatable":true}}}}'
        : request.resource === 'mapping' ? '{}' : '{"indices":[],"aliases":[],"data_streams":[]}',
    })),
    execute: vi.fn(async (request: QueryRequest) => ({
      requestId: request.requestId, connectionId: request.connectionId, endpoint: baseProfile.endpoint,
      rawResponse: '{"took":1,"timed_out":false,"_shards":{"total":1,"successful":1,"skipped":0,"failed":0},'
        + '"hits":{"total":{"value":0,"relation":"eq"},"hits":[]}}',
      partial: false, pitId: null,
    })),
    cancel: vi.fn(async () => true),
    openPit: vi.fn(async (request: PitOpenRequest) => ({
      requestId: request.requestId, connectionId: request.connectionId, endpoint: baseProfile.endpoint, pitId: 'pit-fixture',
    })),
    closePit: vi.fn(async () => {}),
  };
}

function Probe({ service }: { service: QueryLibraryService }) {
  const library = useQueryLibrary(service);
  const first = library.entries[0];
  return <div>
    <span data-testid="status">{library.status}</span>
    <span data-testid="count">{library.entries.length}</span>
    <span data-testid="name">{first?.name ?? '-'}</span>
    <span data-testid="favorite">{first ? String(first.favorite) : '-'}</span>
    <span data-testid="save-status">{library.saveStatus.status}</span>
    <button onClick={() => { library.saveDraft(PROBE_DOC, { name: 'Draft A', favorite: false, entryId: 'e1' }); }}>save-a</button>
    <button onClick={() => { if (first) library.setFavorite(first.id, true); }}>favorite</button>
    <button onClick={library.retrySave}>retry</button>
    <button onClick={library.reload}>reload</button>
  </div>;
}

function setupWorkspace(backend: QueryBackend, options: { library: QueryLibraryService; restoreQuery?: (document: QueryDocument) => void }) {
  const openIndex = vi.fn(() => ({ document: createQuery('c1'), created: false }));
  function Harness() {
    const [state, renderState] = useState<WorkspaceState>(() => {
      const document = { ...createQuery('c1'), index: 'orders-1', dsl: DOC_DSL };
      return { activeConnectionId: 'c1', activeTabId: document.id, tabs: [{ kind: 'query', document }], lastTabByConnection: {} };
    });
    // Mirrors the App: the restored tab keeps the freshly minted document.id the library minted,
    // which is how the library links the tab back to its entry.
    const restore = options.restoreQuery === undefined ? undefined : (document: QueryDocument) => {
      options.restoreQuery!(document);
      renderState((current) => addWorkspaceTab(current, { kind: 'query', document }));
    };
    return <I18nextProvider i18n={i18n}>
      <QueryWorkspace state={state} profiles={[baseProfile]} preferences={defaultPreferences}
        aiOpen={false} testResults={{}} toggleAI={() => {}} onSettings={() => {}}
        updateQuery={(id, patch) => renderState((current) => updateWorkspaceDocument(current, id, patch))}
        selectTab={(id) => renderState((current) => selectWorkspaceTab(current, id))}
        openIndex={openIndex} addQuery={() => {}}
        closeTab={(id) => renderState((current) => closeWorkspaceTab(current, id))}
        backend={backend} canQuery active
        libraryService={options.library} restoreQuery={restore} />
    </I18nextProvider>;
  }
  render(<Harness />);
  return { user: userEvent.setup(), openIndex };
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('query library persistence ordering', () => {
  it('serializes saves and leaves the latest intent as the last write', async () => {
    const { service, save } = fakeLibrary();
    const pending = deferred<void>();
    save.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    render(<Probe service={service} />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));

    await user.click(screen.getByText('save-a'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await user.click(screen.getByText('favorite'));
    expect(screen.getByTestId('favorite')).toHaveTextContent('true');
    expect(save).toHaveBeenCalledTimes(1);

    await act(async () => { pending.resolve(); await pending.promise; });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[0]![0].entries[0]!.favorite).toBe(false);
    expect(save.mock.calls[1]![0].entries[0]!.favorite).toBe(true);
    await waitFor(() => expect(screen.getByTestId('save-status')).toHaveTextContent('saved'));
  });

  it('applies only the newest load generation', async () => {
    const { service } = fakeLibrary();
    const older = deferred<SavedQueryLibrary>();
    const newer = deferred<SavedQueryLibrary>();
    vi.mocked(service.load).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const user = userEvent.setup();
    render(<Probe service={service} />);
    await waitFor(() => expect(service.load).toHaveBeenCalledTimes(1));

    await user.click(screen.getByText('reload'));
    await waitFor(() => expect(service.load).toHaveBeenCalledTimes(2));
    await act(async () => { newer.resolve({ version: 1, entries: [storedEntry({ id: 'new', name: 'Newer' })] }); });
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('name')).toHaveTextContent('Newer');
    expect(screen.getByTestId('count')).toHaveTextContent('1');

    await act(async () => { older.resolve({ version: 1, entries: [storedEntry({ id: 'old', name: 'Older' })] }); });
    expect(screen.getByTestId('name')).toHaveTextContent('Newer');
    expect(screen.getByTestId('count')).toHaveTextContent('1');
  });

  it('never writes a newer document to the previous backend after a service switch', async () => {
    const first = fakeLibrary();
    const pending = deferred<void>();
    first.save.mockReturnValueOnce(pending.promise);
    const second = fakeLibrary({ version: 1, entries: [storedEntry({ id: 'b1', name: 'From B' })] });
    const view = render(<Probe service={first.service} />);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));

    await user.click(screen.getByText('save-a'));
    await waitFor(() => expect(first.save).toHaveBeenCalledTimes(1));
    await user.click(screen.getByText('favorite'));
    expect(screen.getByTestId('favorite')).toHaveTextContent('true');

    // The host swaps the adapter: the queued favorite edit must neither run on the old backend
    // nor be replayed against the new one, and the late completion must not touch newer state.
    view.rerender(<Probe service={second.service} />);
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('From B'));

    await act(async () => { pending.resolve(); });
    expect(first.save).toHaveBeenCalledTimes(1);
    expect(second.save).not.toHaveBeenCalled();
    expect(screen.getByTestId('name')).toHaveTextContent('From B');
    expect(screen.getByTestId('count')).toHaveTextContent('1');
    expect(screen.getByTestId('save-status')).toHaveTextContent('idle');
  });

  it('never saves while the stored library failed to load', async () => {
    const { service, save } = fakeLibrary(createEmptyLibrary(), { code: 'invalidResponse', requestId: null, retryable: false });
    const user = userEvent.setup();
    render(<Probe service={service} />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    await user.click(screen.getByText('save-a'));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByTestId('count')).toHaveTextContent('0');
  });

  it('reports a failed save and retries the latest intent', async () => {
    const { service, save } = fakeLibrary();
    const pending = deferred<void>();
    save.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    render(<Probe service={service} />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    await user.click(screen.getByText('save-a'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await act(async () => { pending.reject({ code: 'storageUnavailable', requestId: null, retryable: false }); });
    await waitFor(() => expect(screen.getByTestId('save-status')).toHaveTextContent('error'));
    expect(screen.getByTestId('count')).toHaveTextContent('1');

    await user.click(screen.getByText('retry'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('save-status')).toHaveTextContent('saved'));
  });
});

describe('query library in the workspace', () => {
  it('saves a named favorite without executing or mutating the editor', async () => {
    const { service, save } = fakeLibrary();
    const backend = makeBackend();
    const { user, openIndex } = setupWorkspace(backend, { library: service });
    const editor = await screen.findByLabelText('查询 DSL');
    const original = (editor as HTMLTextAreaElement).value;

    await user.click(screen.getByRole('button', { name: '保存草稿' }));
    const dialog = await screen.findByRole('dialog', { name: '保存查询草稿' });
    await user.type(within(dialog).getByLabelText('草稿名称'), 'Orders favourite');
    await user.click(within(dialog).getByRole('checkbox', { name: '标记为收藏' }));
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const saved = save.mock.calls[0]![0];
    expect(saved.entries).toHaveLength(1);
    expect(saved.entries[0]).toMatchObject({
      name: 'Orders favourite', favorite: true, connectionId: 'c1', index: 'orders-1', dsl: original,
    });
    expect((editor as HTMLTextAreaElement).value).toBe(original);
    expect(screen.getByLabelText('查询名称')).toHaveValue('');
    expect(backend.execute).not.toHaveBeenCalled();
    expect(openIndex).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: '取消收藏' })).toBeVisible();
  });

  it('shows save progress in the workspace and retries a failed save there', async () => {
    const pending = deferred<void>();
    const { service, save } = fakeLibrary();
    save.mockReturnValueOnce(pending.promise);
    const { user } = setupWorkspace(makeBackend(), { library: service });

    await user.click(screen.getByRole('button', { name: '保存草稿' }));
    const dialog = await screen.findByRole('dialog', { name: '保存查询草稿' });
    await user.type(within(dialog).getByLabelText('草稿名称'), 'Draft A');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    // The closed dialog no longer carries the outcome: the workspace itself reports it, and a
    // failed write leaves the optimistic draft visible with a retry next to it.
    expect(await screen.findByText('正在保存…')).toBeVisible();
    await act(async () => { pending.reject({ code: 'storageUnavailable', requestId: null, retryable: false }); });
    expect(await screen.findByText('保存失败。草稿仍保留在当前窗口，可稍后重试。')).toBeVisible();

    await user.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('已保存到本地库')).toBeVisible();
  });

  it('disables saving while a visual draft makes the displayed JSON stale', async () => {
    const { service } = fakeLibrary();
    const { user } = setupWorkspace(makeBackend(), { library: service });
    await user.click(screen.getByRole('button', { name: '可视化' }));
    await user.click(screen.getByRole('button', { name: '添加条件' }));

    const saveButton = screen.getByRole('button', { name: '保存草稿' });
    expect(saveButton).toBeDisabled();
    expect(saveButton.getAttribute('title')).toContain('JSON 已过期');

    // Back in the JSON editor the textarea is the source of truth again and saving is allowed.
    await user.click(screen.getByRole('button', { name: 'DSL' }));
    expect(screen.getByRole('button', { name: '保存草稿' })).toBeEnabled();
  });

  it('restores a saved draft through the App callback without executing', async () => {
    const entry = storedEntry();
    const { service, save } = fakeLibrary({ version: 1, entries: [entry] });
    const backend = makeBackend();
    const restoreQuery = vi.fn();
    const { user, openIndex } = setupWorkspace(backend, { library: service, restoreQuery });

    await user.click(screen.getByRole('button', { name: '已保存的查询' }));
    const dialog = await screen.findByRole('dialog', { name: '已保存的查询' });
    expect(await within(dialog).findByText('Saved orders')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: '恢复' }));

    expect(restoreQuery).toHaveBeenCalledTimes(1);
    const document = restoreQuery.mock.calls[0]![0] as QueryDocument;
    expect(document).toMatchObject({
      connectionId: 'c1', index: 'other-9', dsl: entry.dsl, name: 'Saved orders', revision: 0, resultView: 'table',
    });
    expect(document.id).not.toBe('e1');
    expect(backend.execute).not.toHaveBeenCalled();
    expect(openIndex).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '已保存的查询' })).not.toBeInTheDocument());

    // The App keeps the minted document.id; re-saving the restored tab updates the original entry.
    expect(screen.getByLabelText('查询名称')).toHaveValue('Saved orders');
    await user.click(screen.getByRole('button', { name: '保存草稿' }));
    const saveDialog = await screen.findByRole('dialog', { name: '更新已保存的草稿' });
    await user.click(within(saveDialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0].entries).toHaveLength(1);
    expect(save.mock.calls[0]![0].entries[0]).toMatchObject({ id: 'e1', name: 'Saved orders', dsl: entry.dsl });
  });

  it('disables restore without the host callback and never loads the draft into this tab', async () => {
    const entry = storedEntry();
    const { service } = fakeLibrary({ version: 1, entries: [entry] });
    const backend = makeBackend();
    const { user } = setupWorkspace(backend, { library: service });
    const editor = await screen.findByLabelText('查询 DSL');
    const before = (editor as HTMLTextAreaElement).value;

    await user.click(screen.getByRole('button', { name: '已保存的查询' }));
    const dialog = await screen.findByRole('dialog', { name: '已保存的查询' });
    const restoreButton = within(dialog).getByRole('button', { name: '恢复' });
    expect(restoreButton).toBeDisabled();
    expect(restoreButton.getAttribute('title')).toContain('无法恢复');

    // The draft was saved against another target; nothing may be loaded into this tab.
    expect((screen.getByLabelText('查询 DSL') as HTMLTextAreaElement).value).toBe(before);
    expect(screen.getByLabelText('查询名称')).toHaveValue('');
    expect(backend.execute).not.toHaveBeenCalled();
  });

  it('fails closed on a damaged stored library and disables saving', async () => {
    const { service, save } = fakeLibrary(createEmptyLibrary(), { code: 'invalidResponse', requestId: null, retryable: false });
    const { user } = setupWorkspace(makeBackend(), { library: service });

    await user.click(screen.getByRole('button', { name: '已保存的查询' }));
    const dialog = await screen.findByRole('dialog', { name: '已保存的查询' });
    expect(await within(dialog).findByText(/存储的查询库已损坏/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: '关闭' }));

    await user.click(screen.getByRole('button', { name: '保存草稿' }));
    const saveDialog = await screen.findByRole('dialog', { name: '保存查询草稿' });
    expect(within(saveDialog).getByRole('button', { name: '保存' })).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
  });

  it('deletes a saved draft after an explicit confirmation', async () => {
    const { service, save } = fakeLibrary({ version: 1, entries: [storedEntry()] });
    const { user } = setupWorkspace(makeBackend(), { library: service });

    await user.click(screen.getByRole('button', { name: '已保存的查询' }));
    const dialog = await screen.findByRole('dialog', { name: '已保存的查询' });
    await user.click(await within(dialog).findByRole('button', { name: '删除' }));
    const confirm = await screen.findByRole('dialog', { name: '删除草稿' });
    await user.click(within(confirm).getByRole('button', { name: '删除' }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0].entries).toHaveLength(0);
    expect(await within(dialog).findByText('暂无已保存的草稿')).toBeVisible();
  });
});
