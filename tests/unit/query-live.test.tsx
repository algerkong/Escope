import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryWorkspace, type QueryCommand } from '../../src/features/query/QueryWorkspace';
import {
  addWorkspaceTab, closeWorkspaceTab, createIndexTab, createQuery, selectWorkspaceTab, updateWorkspaceDocument,
  type WorkspaceState,
} from '../../src/domain/query';
import { defaultPreferences } from '../../src/domain/preferences';
import type { ConnectionProfile } from '../../src/domain/connection';
import { i18n } from '../../src/locales';
import { enLive, zhLive } from '../../src/locales/query-live';
import type { PitOpenRequest, QueryBackend, QueryRequest, QueryResponse, ResourceRequest, ResourceResponse } from '../../src/services/ipc';
import type { SnapshotExportService } from '../../src/services/query-export';
import type { SnapshotExportOutcome, SnapshotExportRequest } from '../../src/domain/query-export';
import type { CancellationToken, IRange, languages } from 'monaco-editor/editor/editor.api';
import { createEditorView, editorRuntime } from './monaco-view-mock';

const baseProfile: ConnectionProfile = {
  id: 'c1', displayName: 'Fixture ES', endpoint: 'https://es.test', environment: 'development', sortOrder: 0, auth: 'none',
};
const indicesResponse = '{"indices":[{"name":"orders-1","attributes":["open"],"aliases":[]},'
  + '{"name":"other-1","attributes":["open"],"aliases":[]}],"aliases":[],"data_streams":[]}';
const capsOrders = '{"indices":["orders-1"],"fields":{"legacy":{"keyword":{"type":"keyword","searchable":true,"aggregatable":true}}}}';
const capsOther = '{"indices":["other-1"],"fields":{"amount":{"long":{"type":"long","searchable":true,"aggregatable":true}}}}';
const searchResponse = '{"took":3,"timed_out":false,"_shards":{"total":1,"successful":1,"skipped":0,"failed":0},'
  + '"hits":{"total":{"value":1,"relation":"eq"},"max_score":1,"hits":[{"_index":"orders-1","_id":"1","_score":1,"_source":{"id":9007199254740993,"name":"a"}}]}}';
const partialResponse = '{"took":5,"timed_out":true,"_shards":{"total":2,"successful":1,"skipped":0,"failed":1,'
  + '"failures":[{"shard":1,"_index":"orders-1","reason":{"reason":"boom"}}]},'
  + '"hits":{"total":{"value":1,"relation":"eq"},"hits":[{"_index":"orders-1","_id":"1","_source":{"id":1}}]}}';

function makeBackend(options: { available?: boolean } = {}) {
  return {
    available: options.available ?? true,
    readResource: vi.fn((request: ResourceRequest) => Promise.resolve({
      requestId: request.requestId, connectionId: request.connectionId, endpoint: 'https://es.test',
      rawResponse: request.resource === 'indices' ? indicesResponse
        : request.resource === 'fieldCaps' ? (request.index === 'other-1' ? capsOther : capsOrders) : '{}',
    })),
    execute: vi.fn<(request: QueryRequest) => Promise<QueryResponse>>((request) => Promise.resolve({
      requestId: request.requestId, connectionId: request.connectionId, endpoint: 'https://es.test',
      rawResponse: searchResponse, partial: false, pitId: null,
    })),
    cancel: vi.fn(() => Promise.resolve(true)),
    openPit: vi.fn((request: PitOpenRequest) => Promise.resolve({
      requestId: request.requestId, connectionId: request.connectionId, endpoint: 'https://es.test',
      pitId: 'pit-fixture',
    })),
    closePit: vi.fn(() => Promise.resolve()),
  } satisfies QueryBackend;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

interface SetupOptions {
  seeds?: { index: string; dsl?: string }[];
  surface?: 'preview' | 'query';
  endpoint?: string;
  canQuery?: boolean;
  active?: boolean;
  grouping?: boolean;
  onCommandReady?: (command: QueryCommand | null) => void;
  snapshotExportService?: SnapshotExportService;
}

function setup(backend: QueryBackend, options: SetupOptions = {}) {
  const seeds = options.seeds ?? [{ index: 'orders-1' }];
  const control: { setEndpoint: (value: string) => void; removeConnection: () => void } = {
    setEndpoint: () => {},
    removeConnection: () => {},
  };
  function Harness() {
    const [endpoint, setEndpoint] = useState(options.endpoint ?? baseProfile.endpoint);
    const [connected, setConnected] = useState(true);
    control.setEndpoint = (value: string) => { act(() => setEndpoint(value)); };
    control.removeConnection = () => { act(() => setConnected(false)); };
    const [state, renderState] = useState<WorkspaceState>(() => {
      const queries = seeds.map((seed) => ({ ...createQuery('c1'), ...seed }));
      return {
        activeConnectionId: 'c1', activeTabId: options.surface === 'preview' ? null : queries[0]!.id,
        tabs: queries.map((document) => ({ kind: 'query', document })), lastTabByConnection: {},
      };
    });
    const stateRef = useRef(state);
    const setState = (change: (value: WorkspaceState) => WorkspaceState) => {
      stateRef.current = change(stateRef.current);
      renderState(stateRef.current);
    };
    return <I18nextProvider i18n={i18n}><QueryWorkspace state={state}
      profiles={connected ? [{ ...baseProfile, endpoint }] : []} preferences={{ ...defaultPreferences, grouping: options.grouping ?? true }}
      aiOpen={false} testResults={{}} toggleAI={() => {}} onSettings={() => {}}
      updateQuery={(id, patch) => setState((current) => updateWorkspaceDocument(current, id, patch))}
      selectTab={(id) => setState((current) => selectWorkspaceTab(current, id))}
      openIndex={(connectionId, index) => {
        const existing = stateRef.current.tabs.find((tab) => tab.kind === 'index'
          && tab.document.connectionId === connectionId && tab.document.index === index);
        const tab = existing ?? createIndexTab(connectionId, index, 'table');
        setState((current) => addWorkspaceTab(current, tab));
        return { document: tab.document, created: !existing };
      }}
      addQuery={() => {}}
      closeTab={(id) => setState((current) => closeWorkspaceTab(current, id))}
      backend={backend} canQuery={options.canQuery} active={options.active ?? true}
      snapshotExportService={options.snapshotExportService}
      onCommandReady={options.onCommandReady} /></I18nextProvider>;
  }
  render(<Harness />);
  return { user: userEvent.setup(), control };
}

const runButton = () => screen.getByRole('button', { name: '执行查询' });
const fields = () => screen.getByLabelText('查询 DSL');

beforeEach(async () => { await i18n.changeLanguage('zh-CN'); });

describe('workspace local completion evidence', () => {
  function completions() {
    const registered = vi.spyOn(editorRuntime.languages, 'registerCompletionItemProvider');
    const token: CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    const latest = () => registered.mock.calls.at(-1)![1];
    const request = (provider = latest()) => {
      const model = createEditorView.mock.results.at(-1)!.value.getModel()!;
      return provider.provideCompletionItems(model, model.getPositionAt(model.getValue().indexOf('""') + 1),
        { triggerKind: 0 }, token) as languages.CompletionList;
    };
    return { registered, latest, request };
  }

  it('uses an explicit same-target field read, without suggesting or fetching for another tab', async () => {
    const backend = makeBackend();
    const f = completions();
    const { user } = setup(backend, { seeds: [
      { index: 'orders-1', dsl: '{"fields":[""]}' }, { index: 'other-1', dsl: '{"fields":[""]}' },
    ] });
    await waitFor(() => expect(backend.readResource).toHaveBeenCalledOnce());
    await user.click(screen.getByRole('button', { name: '本地补全' }));
    expect(f.request().suggestions).toEqual([]);
    expect(backend.readResource).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: '刷新字段' }));
    await waitFor(() => expect(f.request().suggestions).toEqual([expect.objectContaining({ label: {
      label: 'legacy', description: '字段证据：keyword',
    } })]));
    const previous = f.latest();
    await user.click(screen.getAllByRole('tab')[2]!);
    expect(f.request(previous).suggestions).toEqual([]);
    expect(f.request().suggestions).toEqual([]);
    await user.click(screen.getByRole('button', { name: '本地补全' }));
    expect(backend.readResource).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: '刷新字段' }));
    await waitFor(() => expect(f.request().suggestions).toEqual([expect.objectContaining({ label: {
      label: 'amount', description: '字段证据：long',
    } })]));
    const completion = f.request().suggestions[0]!;
    const model = createEditorView.mock.results.at(-1)!.value.getModel()!;
    act(() => {
      model.pushStackElement();
      model.pushEditOperations(null, [{ range: completion.range as IRange, text: completion.insertText }], () => null);
      model.pushStackElement();
    });
    expect(fields()).toHaveValue('{"fields":["amount"]}');
    await user.click(screen.getByRole('button', { name: '撤销编辑' }));
    expect(fields()).toHaveValue('{"fields":[""]}');
    expect(backend.execute).not.toHaveBeenCalled();
    expect(backend.openPit).not.toHaveBeenCalled();
    f.registered.mockRestore();
  });

  it('withdraws ready evidence during refresh and after a failed refresh, without falling back to old fields', async () => {
    const backend = makeBackend();
    const f = completions();
    const { user } = setup(backend, { seeds: [{ index: 'orders-1', dsl: '{"fields":[""]}' }] });
    await user.click(screen.getByRole('button', { name: '刷新字段' }));
    await waitFor(() => expect(f.request().suggestions).toHaveLength(1));
    const previous = f.latest();
    const refresh = deferred<ResourceResponse>();
    backend.readResource.mockImplementationOnce(() => refresh.promise);
    await user.click(screen.getByRole('button', { name: '刷新字段' }));
    expect(f.request(previous).suggestions).toEqual([]);
    expect(f.request().suggestions).toEqual([]);
    const sent = backend.readResource.mock.calls.at(-1)![0];
    await act(async () => {
      refresh.resolve({ requestId: sent.requestId, connectionId: sent.connectionId, endpoint: baseProfile.endpoint, rawResponse: 'invalid' });
    });
    expect(f.request().suggestions).toEqual([]);
    expect(backend.execute).not.toHaveBeenCalled();
    expect(backend.openPit).not.toHaveBeenCalled();
    f.registered.mockRestore();
  });

  it('drops a replaced endpoint or removed connection and ignores a late old response', async () => {
    const backend = makeBackend();
    const f = completions();
    const { user, control } = setup(backend, { seeds: [{ index: 'orders-1', dsl: '{"fields":[""]}' }] });
    await user.click(screen.getByRole('button', { name: '刷新字段' }));
    await waitFor(() => expect(f.request().suggestions).toHaveLength(1));
    const previous = f.latest();
    const refresh = deferred<ResourceResponse>();
    backend.readResource.mockImplementationOnce(() => refresh.promise);
    await user.click(screen.getByRole('button', { name: '刷新字段' }));
    const sent = backend.readResource.mock.calls.at(-1)![0];
    control.setEndpoint('https://replacement.test');
    expect(f.request(previous).suggestions).toEqual([]);
    expect(f.request().suggestions).toEqual([]);
    await act(async () => {
      refresh.resolve({ requestId: sent.requestId, connectionId: sent.connectionId,
        endpoint: baseProfile.endpoint, rawResponse: capsOrders });
    });
    expect(f.request().suggestions).toEqual([]);
    control.removeConnection();
    expect(f.request().suggestions).toEqual([]);
    expect(fields()).toHaveValue('{"fields":[""]}');
    expect(backend.execute).not.toHaveBeenCalled();
    expect(backend.openPit).not.toHaveBeenCalled();
    f.registered.mockRestore();
  });
});

function exportOutcome(request: SnapshotExportRequest): SnapshotExportOutcome {
  return {
    requestId: request.requestId, connectionId: request.connectionId, status: 'saved',
    rows: 1, bytes: 80, fileState: 'complete', fileName: request.fileName, reason: null, pitCleanup: 'closed',
  };
}

describe('full snapshot export integration', () => {
  it('exports the displayed execution after draft edits without touching its live result or PIT', async () => {
    const backend = makeBackend();
    const exporter: SnapshotExportService = {
      available: true, run: vi.fn(async (request) => exportOutcome(request)), cancel: vi.fn(async () => true),
    };
    const { user } = setup(backend, { snapshotExportService: exporter });
    await user.click(runButton());
    const openExport = await screen.findByRole('button', { name: '导出全部匹配文档' });
    const executed = vi.mocked(backend.execute).mock.calls[0]![0];
    fireEvent.change(fields(), { target: { value: '{"query": ' } });
    fireEvent.change(screen.getByLabelText('索引或匹配模式'), { target: { value: 'draft-only' } });
    await user.click(openExport);
    expect(exporter.run).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: '全量快照导出' });
    expect(within(dialog).getByText('orders-1')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: '选择文件并导出' }));
    await within(dialog).findByText('全部匹配文档已保存。');
    const sent = vi.mocked(exporter.run).mock.calls[0]![0];
    expect(sent.index).toBe(executed.index);
    expect(sent.expectedEndpoint).toBe(baseProfile.endpoint);
    expect(sent.rawDsl).not.toContain('draft-only');
    expect(sent).not.toHaveProperty('pitId');
    expect(backend.execute).toHaveBeenCalledTimes(1);
    expect(backend.closePit).not.toHaveBeenCalled();
    expect(fields()).toHaveValue('{"query": ');
  });

  it('keeps a preview export bound to its original target when the endpoint changes', async () => {
    const backend = makeBackend();
    const result = deferred<SnapshotExportOutcome>();
    const exporter: SnapshotExportService = {
      available: true, run: vi.fn(() => result.promise), cancel: vi.fn(async () => true),
    };
    const { user, control } = setup(backend, { surface: 'preview', snapshotExportService: exporter });
    await user.click(await screen.findByRole('button', { name: 'orders-1' }));
    await user.click(await screen.findByRole('button', { name: '导出全部匹配文档' }));
    await user.click(screen.getByRole('button', { name: '选择文件并导出' }));
    const sent = vi.mocked(exporter.run).mock.calls[0]![0];
    control.setEndpoint('https://replacement.test');
    await waitFor(() => expect(exporter.cancel).toHaveBeenCalledTimes(1));
    expect(screen.getByText('原标签或连接目标已不可用，不能启动或继续此导出。')).toBeVisible();
    await act(async () => {
      result.resolve({
        ...exportOutcome(sent), status: 'cancelled', reason: 'cancelled', fileState: 'partial', fileName: 'chosen.csv.partial-fixture',
      });
    });
    expect(screen.getByText('chosen.csv.partial-fixture')).toBeVisible();
    expect(exporter.run).toHaveBeenCalledTimes(1);
    expect(sent.expectedEndpoint).toBe(baseProfile.endpoint);
    expect(backend.execute).toHaveBeenCalledTimes(1);
  });

  it('retains loaded export but offers no full scan when the service is unavailable', async () => {
    const backend = makeBackend();
    const exporter: SnapshotExportService = { available: false, run: vi.fn(), cancel: vi.fn() };
    const { user } = setup(backend, { snapshotExportService: exporter });
    await user.click(runButton());
    expect(await screen.findByRole('button', { name: '导出已加载结果' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '导出全部匹配文档' })).not.toBeInTheDocument();
    expect(exporter.run).not.toHaveBeenCalled();
  });

  it('keeps a hidden export running across tab switches and restores its original progress', async () => {
    const backend = makeBackend();
    const result = deferred<SnapshotExportOutcome>();
    const exporter: SnapshotExportService = {
      available: true, run: vi.fn(() => result.promise), cancel: vi.fn(async () => true),
    };
    const { user } = setup(backend, {
      seeds: [{ index: 'orders-1' }, { index: 'other-1' }], snapshotExportService: exporter,
    });
    await user.click(runButton());
    await user.click(await screen.findByRole('button', { name: '导出全部匹配文档' }));
    await user.click(screen.getByRole('button', { name: '选择文件并导出' }));
    const sent = vi.mocked(exporter.run).mock.calls[0]![0];
    await user.click(screen.getByRole('button', { name: '收起导出进度' }));
    expect(screen.queryByRole('dialog', { name: '全量快照导出' })).not.toBeInTheDocument();
    await user.click(screen.getAllByRole('tab')[2]!);
    expect(screen.getByLabelText('索引或匹配模式')).toHaveValue('other-1');
    expect(exporter.cancel).not.toHaveBeenCalled();
    expect(backend.execute).toHaveBeenCalledTimes(1);
    await act(async () => { result.resolve(exportOutcome(sent)); });
    expect(screen.queryByRole('dialog', { name: '全量快照导出' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '导出进度' }));
    const dialog = screen.getByRole('dialog', { name: '全量快照导出' });
    expect(within(dialog).getByText('orders-1')).toBeVisible();
    expect(within(dialog).getByText('全部匹配文档已保存。')).toBeVisible();
    expect(exporter.run).toHaveBeenCalledTimes(1);
  });
});

describe('compact data preview', () => {
  it.each([
    { locale: 'zh-CN', grouping: true, relation: 'eq', expected: '9,007,199,254,740,993 条命中' },
    { locale: 'en-US', grouping: true, relation: 'eq', expected: '9,007,199,254,740,993 hits' },
    { locale: 'zh-CN', grouping: false, relation: 'eq', expected: '9007199254740993 条命中' },
    { locale: 'en-US', grouping: true, relation: 'gte', expected: '≥ 9,007,199,254,740,993 hits (lower bound)' },
  ])('preserves exact totals in $locale with grouping=$grouping and relation=$relation', async ({ locale, grouping, relation, expected }) => {
    await i18n.changeLanguage(locale);
    const backend = makeBackend();
    backend.execute.mockImplementation(async (request) => ({
      ...request, endpoint: baseProfile.endpoint, partial: false, pitId: null,
      rawResponse: searchResponse.replace('"value":1', '"value":9007199254740993').replace('"relation":"eq"', `"relation":"${relation}"`),
    }));
    const { user } = setup(backend, { surface: 'preview', grouping });
    await user.click(await screen.findByRole('button', { name: 'orders-1' }));
    const toolbar = screen.getByRole('form', { name: i18n.t('queryLive:previewToolbar') });
    expect(await within(toolbar).findByText(expected)).toHaveAttribute('title', expected);
    expect(within(toolbar).getByText('3 ms')).toBeVisible();
    expect(screen.getByText('9007199254740993', { selector: '.rg-cell' })).toBeVisible();
    expect(screen.queryByText(baseProfile.endpoint)).not.toBeInTheDocument();
    expect(backend.execute).toHaveBeenCalledTimes(1);
  });

  it('does not turn an omitted hit total into zero', async () => {
    const backend = makeBackend();
    backend.execute.mockImplementation(async (request) => ({
      ...request, endpoint: baseProfile.endpoint, partial: false, pitId: null,
      rawResponse: searchResponse.replace('"total":{"value":1,"relation":"eq"},', ''),
    }));
    const { user } = setup(backend, { surface: 'preview' });
    await user.click(await screen.findByRole('button', { name: 'orders-1' }));
    expect(await screen.findByText('命中总数未知')).toBeVisible();
    expect(screen.queryByText('0 条命中')).not.toBeInTheDocument();
  });

  it('retains partial-result and changed-endpoint warnings outside the compact toolbar', async () => {
    const backend = makeBackend();
    backend.execute.mockImplementation(async (request) => ({
      ...request, endpoint: baseProfile.endpoint, rawResponse: partialResponse, partial: true, pitId: null,
    }));
    const { user, control } = setup(backend, { surface: 'preview' });
    await user.click(await screen.findByRole('button', { name: 'orders-1' }));
    const toolbar = screen.getByRole('form', { name: '预览工具栏' });
    expect(await within(toolbar).findByText('部分结果')).toBeVisible();
    expect(screen.getByText('查询已超时。')).toBeVisible();
    expect(screen.getByText('1 个分片失败。')).toBeVisible();
    expect(screen.queryByRole('img', { name: '已完成' })).not.toBeInTheDocument();
    control.setEndpoint('https://replacement.test');
    expect(await screen.findByText('执行后连接地址已更改。')).toBeVisible();
    expect(screen.getByText('查询已超时。')).toBeVisible();
    expect(backend.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps cancellation in the preview toolbar and discards the late response', async () => {
    const backend = makeBackend();
    const pending = deferred<QueryResponse>();
    backend.execute.mockReturnValueOnce(pending.promise);
    const { user } = setup(backend, { surface: 'preview' });
    await user.click(await screen.findByRole('button', { name: 'orders-1' }));
    await waitFor(() => expect(backend.execute).toHaveBeenCalledTimes(1));
    const toolbar = screen.getByRole('form', { name: '预览工具栏' });
    expect(within(toolbar).getByRole('button', { name: '刷新索引' })).toBeDisabled();
    await user.click(within(toolbar).getByRole('button', { name: '取消请求' }));
    expect(within(toolbar).getByText('请求已取消')).toBeVisible();
    expect(within(toolbar).getByRole('button', { name: '刷新索引' })).toBeEnabled();
    await act(async () => {
      pending.resolve({ ...backend.execute.mock.calls[0]![0], endpoint: baseProfile.endpoint, rawResponse: searchResponse, partial: false, pitId: null });
      await pending.promise;
    });
    expect(screen.queryByRole('img', { name: '已完成' })).not.toBeInTheDocument();
    expect(screen.queryByText('9007199254740993')).not.toBeInTheDocument();
    expect(backend.cancel).toHaveBeenCalledTimes(1);
  });
});

describe('live query execution and results', () => {
  it('blocks incomplete visual conditions without executing or replacing the previous DSL', async () => {
    const backend = makeBackend();
    const { user } = setup(backend);
    const original = (fields() as HTMLTextAreaElement).value;
    await user.click(screen.getByRole('button', { name: '可视化' }));
    await user.click(screen.getByRole('button', { name: '添加条件' }));
    expect(runButton()).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText('字段 1'), { key: 'Enter', ctrlKey: true });
    expect(backend.execute).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'DSL' }));
    expect(fields()).toHaveValue(original);
    expect(runButton()).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '可视化' }));
    expect(runButton()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('字段 1'), { target: { value: 'legacy' } });
    fireEvent.change(screen.getByLabelText('值 1'), { target: { value: 'active' } });
    expect(runButton()).toBeEnabled();
    await user.click(runButton());
    expect(backend.execute).toHaveBeenCalledTimes(1);
    expect(backend.execute.mock.calls[0]![0].rawDsl).toContain('"legacy":"active"');
  });

  it('keeps grid preferences per query through JSON, tabs and reruns without reusing the old page', async () => {
    const backend = makeBackend();
    const documents = Array.from({ length: 65 }, (_, index) => `{"_index":"orders-1","_id":"id-${index}",`
      + `"_source":{"n":${9007199254740992n + BigInt(index)},"label":"row-${index}"}}`).join(',');
    backend.execute.mockImplementation(async (request) => ({
      ...request, endpoint: 'https://es.test', partial: false, pitId: null,
      rawResponse: `{"took":1,"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},"hits":{"total":{"value":65,"relation":"eq"},"hits":[${documents}]}}`,
    }));
    const { user } = setup(backend, { seeds: [{ index: 'orders-1', dsl: '{"size":65}' }, { index: 'other-1', dsl: '{"size":65}' }] });
    await user.click(runButton());
    const width = screen.getByRole('separator', { name: '调整 n 列宽' });
    const originalWidth = Number(width.getAttribute('aria-valuenow'));
    fireEvent.keyDown(width, { key: 'ArrowRight' });
    await user.click(screen.getByRole('button', { name: '按 n 排序' }));
    await user.click(screen.getByRole('button', { name: '列' }));
    await user.click(screen.getByRole('button', { name: '向左移动 n' }));
    await user.click(screen.getByRole('checkbox', { name: '显示列 索引 (_index)' }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getByText('第 2 页，共 2 页')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'JSON' }));
    await user.click(screen.getByRole('button', { name: '表格' }));
    expect(screen.getByText('第 2 页，共 2 页')).toBeVisible();
    expect(screen.getByRole('separator', { name: '调整 n 列宽' })).toHaveAttribute('aria-valuenow', String(originalWidth + 12));
    expect(screen.queryByRole('separator', { name: '调整 索引 (_index) 列宽' })).not.toBeInTheDocument();
    const headers = () => [...screen.getByRole('region', { name: '文档表格' }).querySelectorAll('th')];
    expect(headers().map((header) => header.dataset.columnId)).toEqual(['meta:row', 'field:n', 'meta:id', 'field:label']);
    await user.click(screen.getAllByRole('tab')[2]!);
    await user.click(runButton());
    expect(screen.getByRole('separator', { name: '调整 n 列宽' })).toHaveAttribute('aria-valuenow', String(originalWidth));
    expect(headers().find((header) => header.dataset.columnId === 'field:n')).not.toHaveAttribute('aria-sort');
    await user.click(screen.getAllByRole('tab')[1]!);
    expect(screen.getByText('第 2 页，共 2 页')).toBeVisible();
    await user.click(runButton());
    expect(screen.getByText('第 1 页，共 2 页')).toBeVisible();
    expect(headers().find((header) => header.dataset.columnId === 'field:n')).toHaveAttribute('aria-sort', 'ascending');
    expect(screen.getByRole('separator', { name: '调整 n 列宽' })).toHaveAttribute('aria-valuenow', String(originalWidth + 12));
    expect(backend.execute).toHaveBeenCalledTimes(3);
    expect(fields()).toHaveValue('{"size":65}');
  }, 15_000);

  it('runs the frozen draft and shows a lossless hit count, timing and document', async () => {
    const backend = makeBackend();
    const { user } = setup(backend);
    expect(runButton()).toBeEnabled();
    await user.click(runButton());
    expect(await screen.findByText('已完成')).toBeInTheDocument();
    expect(screen.getByText('1 条命中')).toBeInTheDocument();
    expect(screen.getByText('3 毫秒')).toBeInTheDocument();
    expect(screen.getByLabelText('执行目标')).toHaveTextContent(baseProfile.endpoint);
    expect(screen.getByText('9007199254740993')).toBeInTheDocument();
    expect(backend.execute).toHaveBeenCalledTimes(1);
    const request = backend.execute.mock.calls[0]![0];
    expect(request).toMatchObject({ connectionId: 'c1', index: 'orders-1' });
    expect(request.requestId).not.toBe('');
  });

  it('keeps the verbatim response in the JSON view and copies it', async () => {
    const { user } = setup(makeBackend());
    await user.click(runButton());
    await screen.findByText('已完成');
    await user.click(screen.getByRole('button', { name: 'JSON' }));
    expect(screen.getByText(/9007199254740993/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '复制原始响应' }));
    expect(await screen.findByText('已复制')).toBeInTheDocument();
  });

  it('marks the result stale once the draft changes and never re-runs on its own', async () => {
    const backend = makeBackend();
    const { user } = setup(backend);
    await user.click(runButton());
    await screen.findByText('已完成');
    fireEvent.change(fields(), { target: { value: '{"size":2}' } });
    expect(await screen.findByText('执行后查询已修改，当前显示上次执行的结果。')).toBeInTheDocument();
    expect(backend.execute).toHaveBeenCalledTimes(1);
  });

  it('reports partial results with timeout and shard failures instead of success', async () => {
    const backend = makeBackend();
    backend.execute = vi.fn((request: QueryRequest) => Promise.resolve({
      requestId: request.requestId, connectionId: request.connectionId, endpoint: 'https://es.test',
      rawResponse: partialResponse, partial: true, pitId: null,
    }));
    const { user } = setup(backend);
    await user.click(runButton());
    expect(await screen.findByText('部分结果')).toBeInTheDocument();
    expect(screen.getByText('查询已超时。')).toBeInTheDocument();
    expect(screen.getByText('1 个分片失败。')).toBeInTheDocument();
    expect(screen.getByText('orders-1 · #1 · boom')).toBeInTheDocument();
    expect(screen.queryByText('已完成')).not.toBeInTheDocument();
  });

  it('fails instead of reporting success when the body is not a search result', async () => {
    const backend = makeBackend();
    backend.execute = vi.fn((request: QueryRequest) => Promise.resolve({
      requestId: request.requestId, connectionId: request.connectionId, endpoint: 'https://es.test',
      rawResponse: '{"took":1}', partial: false, pitId: null,
    }));
    const { user } = setup(backend);
    await user.click(runButton());
    expect(await screen.findByText('该响应无法作为 Elasticsearch 查询结果读取。')).toBeInTheDocument();
    expect(screen.queryByText('已完成')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'JSON' }));
    expect(screen.queryByText(searchResponse)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'JSON' }));
    expect(screen.getByText((_, element) => element?.tagName === 'PRE' && element.textContent === '{\n  "took": 1\n}')).toBeInTheDocument();
  });

  it('rejects a response that does not echo the frozen request identity', async () => {
    const backend = makeBackend();
    backend.execute = vi.fn(() => Promise.resolve({
      requestId: 'rewritten', connectionId: 'c1', endpoint: 'https://es.test', rawResponse: searchResponse, partial: false, pitId: null,
    }));
    const { user } = setup(backend);
    await user.click(runButton());
    expect(await screen.findByText('该响应无法作为 Elasticsearch 查询结果读取。')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'JSON' }));
    expect(screen.queryByText(searchResponse)).not.toBeInTheDocument();
    expect(screen.queryByText('已完成')).not.toBeInTheDocument();
  });

  it('rejects a response sent to a different endpoint than the frozen one', async () => {
    const backend = makeBackend();
    backend.execute = vi.fn((request: QueryRequest) => Promise.resolve({
      requestId: request.requestId, connectionId: request.connectionId, endpoint: 'https://other.test',
      rawResponse: searchResponse, partial: false, pitId: null,
    }));
    const { user } = setup(backend);
    await user.click(runButton());
    expect(await screen.findByText('该响应无法作为 Elasticsearch 查询结果读取。')).toBeInTheDocument();
  });

  it('cancels a running request and isolates the late response', async () => {
    const backend = makeBackend();
    const pending = deferred<QueryResponse>();
    backend.execute = vi.fn(() => pending.promise);
    const { user } = setup(backend);
    await user.click(runButton());
    expect(runButton()).toBeDisabled();
    await user.click(await screen.findByRole('button', { name: '取消请求' }));
    expect(backend.cancel).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('请求已取消').length).toBeGreaterThan(0);
    pending.resolve({ requestId: 'late', connectionId: 'c1', endpoint: 'https://es.test', rawResponse: searchResponse, partial: false, pitId: null });
    await act(async () => { await pending.promise; });
    expect(screen.queryByText('已完成')).not.toBeInTheDocument();
    expect(screen.getAllByText('请求已取消').length).toBeGreaterThan(0);
  });

  it('leaves a query cancelled when its connection is removed mid-flight', async () => {
    const backend = makeBackend();
    const pending = deferred<QueryResponse>();
    backend.execute = vi.fn(() => pending.promise);
    const { user, control } = setup(backend);
    await user.click(runButton());
    await screen.findByRole('button', { name: '取消请求' });
    control.removeConnection();
    await waitFor(() => expect(backend.cancel).toHaveBeenCalledTimes(1));
    expect(screen.getAllByText('请求已取消').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '取消请求' })).not.toBeInTheDocument();
  });

  it('leaves a query cancelled when its endpoint changes mid-flight', async () => {
    const backend = makeBackend();
    const pending = deferred<QueryResponse>();
    backend.execute = vi.fn(() => pending.promise);
    const { user, control } = setup(backend);
    await user.click(runButton());
    await screen.findByRole('button', { name: '取消请求' });
    control.setEndpoint('https://other.test');
    await waitFor(() => expect(backend.cancel).toHaveBeenCalledTimes(1));
    expect(screen.getAllByText('请求已取消').length).toBeGreaterThan(0);
  });

  it('opens one document detail and reveals a clipboard failure', async () => {
    const { user } = setup(makeBackend());
    await user.click(runButton());
    await screen.findByText('已完成');
    await user.click(screen.getByText('9007199254740993'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '文档 1' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/"id": 9007199254740993/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '复制文档' }));
    expect(await screen.findByText('已复制')).toBeInTheDocument();
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    await user.click(screen.getByRole('button', { name: '复制文档' }));
    expect(await screen.findByText('复制失败，请手动选择文本复制。')).toBeInTheDocument();
  });

  it('stops the request when its tab closes or the workspace unmounts', async () => {
    const backend = makeBackend();
    const first = deferred<QueryResponse>();
    backend.execute = vi.fn(() => first.promise);
    const { user } = setup(backend, { seeds: [{ index: 'orders-1' }, { index: 'other-*' }] });
    await user.click(runButton());
    await screen.findByRole('button', { name: '取消请求' });
    await user.click(screen.getByRole('button', { name: '关闭查询 1' }));
    await waitFor(() => expect(backend.cancel).toHaveBeenCalledTimes(1));
    const second = deferred<QueryResponse>();
    backend.execute = vi.fn(() => second.promise);
    await user.click(runButton());
    await screen.findByRole('button', { name: '取消请求' });
    cleanup();
    expect(backend.cancel).toHaveBeenCalledTimes(2);
  });

  it('runs with Ctrl+Enter from the editor but not while composing, hidden or in a dialog', async () => {
    const backend = makeBackend();
    const { user } = setup(backend);
    fireEvent.keyDown(fields(), { key: 'Enter', ctrlKey: true, isComposing: true });
    expect(backend.execute).not.toHaveBeenCalled();
    fireEvent.change(fields(), { target: { value: '{"size":2}' } });
    await user.click(screen.getByRole('button', { name: '关闭查询 1' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(fields(), { key: 'Enter', ctrlKey: true });
    expect(backend.execute).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.keyDown(fields(), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(backend.execute).toHaveBeenCalledTimes(1));
  });

  it('ignores the shortcut while the workspace is hidden behind settings', async () => {
    const backend = makeBackend();
    setup(backend, { active: false });
    fireEvent.keyDown(fields(), { key: 'Enter', ctrlKey: true });
    expect(backend.execute).not.toHaveBeenCalled();
  });

  it('keeps one result per tab while switching', async () => {
    const backend = makeBackend();
    const { user } = setup(backend, { seeds: [{ index: 'orders-1' }, { index: 'other-1' }] });
    await user.click(runButton());
    await screen.findByText('9007199254740993');
    await user.click(screen.getAllByRole('tab')[2]!);
    expect(screen.getByText('此查询尚未执行。')).toBeInTheDocument();
    expect(screen.queryByText('9007199254740993')).not.toBeInTheDocument();
    await user.click(screen.getAllByRole('tab')[1]!);
    expect(screen.getByText('9007199254740993')).toBeInTheDocument();
  });

  it('registers a run command whose enabled state matches the workspace', async () => {
    const backend = makeBackend();
    const commands: (QueryCommand | null)[] = [];
    const { control } = setup(backend, { onCommandReady: (command) => commands.push(command) });
    await waitFor(() => expect(commands.at(-1)?.enabled).toBe(true));
    commands.at(-1)!.run();
    await waitFor(() => expect(backend.execute).toHaveBeenCalledTimes(1));
    control.removeConnection();
    await waitFor(() => expect(commands.at(-1)?.enabled).toBe(false));
    expect(commands.at(-1)?.reason).not.toBe('');
  });
});

describe('live resource sidebar', () => {
  it('uses one trimmed target for field loading, refresh and index selection state', async () => {
    const backend = makeBackend();
    const { user } = setup(backend, { seeds: [{ index: ' orders-1 ' }] });
    fireEvent.blur(screen.getByRole('textbox', { name: '索引或匹配模式' }));
    await screen.findByText('legacy');
    expect(screen.getByRole('button', { name: 'orders-1' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: '刷新字段' }));
    const requests = backend.readResource.mock.calls.map(([request]) => request).filter((request) => request.resource === 'fieldCaps');
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.index === 'orders-1')).toBe(true);
    expect(backend.execute).not.toHaveBeenCalled();
  });

  it('keeps the index catalog visible while refreshing and after a transient failure', async () => {
    const backend = makeBackend();
    const { user } = setup(backend, { surface: 'preview' });
    await screen.findByRole('button', { name: 'orders-1' });
    const refresh = deferred<ResourceResponse>();
    backend.readResource.mockReturnValueOnce(refresh.promise);
    await user.click(screen.getByRole('button', { name: '刷新索引' }));
    expect(screen.getByRole('button', { name: 'orders-1' })).toBeVisible();
    expect(screen.getByRole('button', { name: '刷新索引' })).toBeDisabled();
    const request = backend.readResource.mock.calls.at(-1)![0];
    await act(async () => {
      refresh.resolve({ ...request, endpoint: 'https://es.test', rawResponse: 'invalid' });
      await refresh.promise;
    });
    expect(await screen.findByText(/刷新失败，仍显示上次加载的元数据/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'orders-1' })).toBeVisible();
    expect(screen.getByRole('button', { name: '刷新索引' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '刷新索引' }));
    await waitFor(() => expect(screen.queryByText(/刷新失败/)).not.toBeInTheDocument());
    expect(backend.execute).not.toHaveBeenCalled();
  });

  it('keeps field metadata after a failed refresh and clears it when the endpoint changes', async () => {
    const backend = makeBackend();
    const { user, control } = setup(backend, { surface: 'preview' });
    await user.click(await screen.findByRole('button', { name: 'orders-1' }));
    await screen.findByText('legacy');
    backend.readResource.mockRejectedValueOnce({ code: 'networkError' });
    await user.click(screen.getByRole('button', { name: '刷新字段' }));
    expect(await screen.findByText(/刷新失败，仍显示上次加载的元数据/)).toBeVisible();
    expect(screen.getByText('legacy')).toBeVisible();
    control.setEndpoint('https://replacement.test');
    expect(screen.queryByText('legacy')).not.toBeInTheDocument();
    expect(backend.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps metadata fields collapsed and exposes capabilities only on demand', async () => {
    const backend = makeBackend();
    backend.readResource.mockImplementation(async (request) => ({
      ...request, endpoint: 'https://es.test', rawResponse: request.resource === 'indices' ? indicesResponse
        : '{"indices":["orders-1"],"fields":{"amount":{"long":{"type":"long","searchable":true,"aggregatable":true}},'
          + '"_id":{"_id":{"type":"_id","searchable":true,"aggregatable":false,"metadata_field":true}}}}',
    }));
    const { user } = setup(backend, { surface: 'preview' });
    await user.click(await screen.findByRole('button', { name: 'orders-1' }));
    expect(await screen.findByText('amount', { selector: '.ql-field-name' })).toBeVisible();
    const metadataName = screen.getByText('_id', { selector: '.ql-field-name' });
    expect(metadataName).not.toBeVisible();
    await user.click(screen.getByText('元数据字段（1）'));
    expect(metadataName).toBeVisible();
    expect(screen.getByText('不可聚合')).not.toBeVisible();
    await user.click(screen.getByLabelText('_id 详情'));
    expect(screen.getByText('不可聚合')).toBeVisible();
  });

  it('starts on an idle data preview and preserves query results and drafts independently', async () => {
    const backend = makeBackend();
    const { user } = setup(backend, { surface: 'preview' });
    expect(screen.getByRole('tab', { name: '数据预览' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('尚未选择索引')).toBeVisible();
    expect(backend.execute).not.toHaveBeenCalled();
    await user.click(screen.getAllByRole('tab')[1]!);
    fireEvent.change(fields(), { target: { value: '{"query":{"term":{"id":9007199254740993}}}' } });
    await user.click(runButton());
    await screen.findByText('已完成');
    const executedDsl = backend.execute.mock.calls[0]![0].rawDsl;
    await user.click(await screen.findByRole('button', { name: 'other-1' }));
    await waitFor(() => expect(backend.execute).toHaveBeenCalledTimes(2));
    expect(backend.execute.mock.calls[1]![0].rawDsl).not.toBe(executedDsl);
    expect(backend.execute.mock.calls[1]![0].rawDsl).toContain('match_all');
    expect(screen.getByRole('tab', { name: 'other-1 (Fixture ES)' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getAllByRole('tab')[1]!);
    expect(fields()).toHaveValue(executedDsl);
    expect(screen.getByLabelText('索引或匹配模式')).toHaveValue('orders-1');
    expect(within(screen.getByRole('region', { name: '查询结果' })).getByText('9007199254740993')).toBeVisible();
    expect(backend.execute).toHaveBeenCalledTimes(2);
  });

  it('does not let a slower old index preview replace the latest selected index', async () => {
    const backend = makeBackend();
    const first = deferred<QueryResponse>();
    const second = deferred<QueryResponse>();
    backend.execute.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { user } = setup(backend, { surface: 'preview' });
    await user.click(await screen.findByRole('button', { name: 'orders-1' }));
    await waitFor(() => expect(backend.execute).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'other-1' }));
    await waitFor(() => expect(backend.execute).toHaveBeenCalledTimes(2));
    const reply = (request: QueryRequest, marker: string) => ({
      ...request, endpoint: 'https://es.test', rawResponse: searchResponse.replace('"name":"a"', `"name":"${marker}"`),
      partial: false, pitId: null,
    });
    await act(async () => { second.resolve(reply(backend.execute.mock.calls[1]![0], 'new-preview')); await second.promise; });
    expect(screen.getByText('new-preview')).toBeVisible();
    await act(async () => { first.resolve(reply(backend.execute.mock.calls[0]![0], 'old-preview')); await first.promise; });
    expect(screen.queryByText('old-preview')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'other-1 (Fixture ES)' })).toHaveAttribute('aria-selected', 'true');
    expect(backend.cancel).not.toHaveBeenCalled();
    await user.click(screen.getByRole('tab', { name: 'orders-1 (Fixture ES)' }));
    expect(screen.getByText('old-preview')).toBeVisible();
    expect(screen.queryByText('new-preview')).not.toBeInTheDocument();
    expect(backend.execute).toHaveBeenCalledTimes(2);
  });

  it('selecting an index starts independent read-only preview without retargeting the draft', async () => {
    const backend = makeBackend();
    const { user } = setup(backend);
    await user.click(await screen.findByRole('button', { name: 'other-1' }));
    await waitFor(() => expect(backend.readResource).toHaveBeenCalledWith(expect.objectContaining({ resource: 'fieldCaps', index: 'other-1' })));
    await waitFor(() => expect(backend.execute).toHaveBeenCalledTimes(1));
    expect(backend.execute.mock.calls[0]![0]).toMatchObject({ index: 'other-1', pitId: 'pit-fixture' });
    expect(screen.getByRole('tab', { name: 'other-1 (Fixture ES)' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('amount')).toBeInTheDocument();
    expect(screen.getByText('可搜索')).not.toBeVisible();
    fireEvent.click(screen.getByLabelText('amount 详情'));
    expect(screen.getByText('可搜索')).toBeVisible();
    await user.click(screen.getAllByRole('tab')[1]!);
    expect(screen.getByLabelText('索引或匹配模式')).toHaveValue('orders-1');
    expect(screen.getByText('此查询尚未执行。')).toBeVisible();
  });

  it('never shows one index field list as another when a slower response arrives last', async () => {
    const backend = makeBackend();
    const slow = deferred<ResourceResponse>();
    let slowRequestId = '';
    backend.readResource = vi.fn((request: ResourceRequest) => {
      if (request.resource === 'fieldCaps' && request.index === 'orders-1') {
        slowRequestId = request.requestId;
        return slow.promise;
      }
      return Promise.resolve({
        requestId: request.requestId, connectionId: request.connectionId, endpoint: 'https://es.test',
        rawResponse: request.resource === 'indices' ? indicesResponse : capsOther,
      });
    });
    const { user } = setup(backend);
    await user.click(await screen.findByRole('button', { name: 'orders-1' }));
    await user.click(screen.getByRole('button', { name: 'other-1' }));
    expect(await screen.findByText('amount')).toBeInTheDocument();
    slow.resolve({ requestId: slowRequestId, connectionId: 'c1', endpoint: 'https://es.test', rawResponse: capsOrders });
    await act(async () => { await slow.promise; });
    expect(screen.getByText('amount')).toBeInTheDocument();
    expect(screen.queryByText('legacy')).not.toBeInTheDocument();
    const calls = backend.readResource.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'orders-1' }));
    expect(await screen.findByText('legacy')).toBeInTheDocument();
    expect(backend.readResource.mock.calls.length).toBe(calls);
  });

  it('drops reads and stops requests when the endpoint is replaced', async () => {
    const backend = makeBackend();
    const first = deferred<ResourceResponse>();
    let firstRequestId = '';
    backend.readResource = vi.fn((request: ResourceRequest) => {
      if (firstRequestId === '') {
        firstRequestId = request.requestId;
        return first.promise;
      }
      return Promise.resolve({
        requestId: request.requestId, connectionId: request.connectionId, endpoint: 'https://other.test',
        rawResponse: '{"indices":[{"name":"b-1","attributes":["open"],"aliases":[]}],"aliases":[],"data_streams":[]}',
      });
    });
    const { control } = setup(backend);
    await waitFor(() => expect(backend.readResource).toHaveBeenCalledTimes(1));
    control.setEndpoint('https://other.test');
    expect(await screen.findByRole('button', { name: 'b-1' })).toBeInTheDocument();
    await waitFor(() => expect(backend.cancel).toHaveBeenCalledWith({ requestId: firstRequestId, connectionId: 'c1' }));
    first.resolve({ requestId: firstRequestId, connectionId: 'c1', endpoint: 'https://es.test', rawResponse: indicesResponse });
    await act(async () => { await first.promise; });
    expect(screen.getByRole('button', { name: 'b-1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'orders-1' })).not.toBeInTheDocument();
  });

  it('keeps the manual index input usable when listing is denied', async () => {
    const backend = makeBackend();
    backend.readResource = vi.fn((request: ResourceRequest) => Promise.reject({ code: 'serverForbidden', requestId: request.requestId, retryable: false }));
    const { user } = setup(backend);
    expect(await screen.findByText('索引列表被拒绝。仍可手动填写索引或模式进行搜索。')).toBeInTheDocument();
    expect(screen.getByLabelText('索引或匹配模式')).toHaveValue('orders-1');
    expect(runButton()).toBeEnabled();
    await user.click(runButton());
    expect(await screen.findByText('已完成')).toBeInTheDocument();
  });

  it('rejects a resource response bound to another endpoint', async () => {
    const backend = makeBackend();
    backend.readResource = vi.fn((request: ResourceRequest) => Promise.resolve({
      requestId: request.requestId, connectionId: request.connectionId, endpoint: 'https://other.test', rawResponse: indicesResponse,
    }));
    setup(backend);
    expect(await screen.findByText('该响应无法作为 Elasticsearch 查询结果读取。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'orders-1' })).not.toBeInTheDocument();
  });

  it('never calls the backend and offers no retry when live reads are unavailable', async () => {
    const backend = makeBackend({ available: false });
    setup(backend);
    expect((await screen.findAllByText(/实时资源需要桌面应用/)).length).toBeGreaterThan(1);
    expect(screen.queryByRole('button', { name: '重新加载' })).not.toBeInTheDocument();
    expect(backend.readResource).not.toHaveBeenCalled();
    expect(runButton()).toBeDisabled();
    fireEvent.click(runButton());
    expect(backend.execute).not.toHaveBeenCalled();
  });
});

describe('queryLive translations', () => {
  it('keeps both languages in parity and registered as a namespace', () => {
    expect(Object.keys(zhLive)).toEqual(Object.keys(enLive));
    for (const [key, text] of Object.entries(enLive)) {
      expect((zhLive as Record<string, string>)[key]!.match(/\{\{.*?\}\}/g)).toEqual(text.match(/\{\{.*?\}\}/g));
    }
    expect(i18n.exists('queryLive:runNeedsIndex')).toBe(true);
    expect(i18n.t('queryLive:runNeedsIndex')).not.toBe('queryLive:runNeedsIndex');
  });
});

/** Every managed page, including the first one, belongs to the PIT opened for this run. */
const pagedResponse = (id: string, pitId: string | null, sortValue: number) => '{"took":2,"timed_out":false,'
  + (pitId === null ? '' : '"pit_id":"' + pitId + '",')
  + '"_shards":{"total":1,"successful":1,"failed":0},'
  + '"hits":{"total":{"value":9,"relation":"eq"},"hits":[{"_index":"orders-1","_id":"' + id + '",'
  + '"_source":{"id":' + sortValue + '},"sort":[' + sortValue + ']}]}}';

describe('snapshot pagination', () => {
  it('places preview continuation beside the row count and keeps snapshot details in its tooltip', async () => {
    const backend = makeBackend();
    backend.execute.mockImplementation(async (request) => ({
      ...request, endpoint: baseProfile.endpoint, rawResponse: pagedResponse(request.searchAfter ? 'next' : 'first', 'pit-1', request.searchAfter ? 2 : 1),
      partial: false, pitId: 'pit-1',
    }));
    const { user } = setup(backend, { surface: 'preview' });
    await user.click(await screen.findByRole('button', { name: 'orders-1' }));
    const more = await screen.findByRole('button', { name: '加载更多' });
    const footer = more.closest<HTMLElement>('.rg-footer')!;
    expect(within(footer).getByText('已加载 1 行')).toBeVisible();
    expect(more).toHaveAttribute('title', zhLive.loadMoreHint);
    expect(screen.queryByText(zhLive.loadMoreHint)).not.toBeInTheDocument();
    await user.click(screen.getByText('first'));
    expect(screen.getByText('first').closest('tr')).toHaveAttribute('aria-selected', 'true');
    await user.click(more);
    await within(footer).findByText('已加载 2 行');
    expect(screen.getByText('first').closest('tr')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('next').closest('tr')).toHaveAttribute('aria-selected', 'false');
    expect(more).toHaveAttribute('title', expect.stringContaining('已加载 2 页'));
    expect(screen.queryByText('已加载 2 页')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'JSON' }));
    const jsonFooter = document.querySelector<HTMLElement>('.ql-result-footer')!;
    expect(within(jsonFooter).getByText('已加载 2 行')).toBeVisible();
    expect(within(jsonFooter).getByText('最新响应页')).toBeVisible();
    expect(within(jsonFooter).getByRole('button', { name: '加载更多' })).toBeEnabled();
    expect(within(jsonFooter).getByRole('button', { name: '复制原始响应' })).toBeEnabled();
    expect(backend.execute).toHaveBeenCalledTimes(2);
  });

  it('keeps loaded rows after cancelling a page without reporting a load failure', async () => {
    const backend = makeBackend();
    const slow = deferred<QueryResponse>();
    backend.execute.mockImplementationOnce(async (request) => ({
      ...request, endpoint: 'https://es.test', rawResponse: pagedResponse('kept', 'pit-1', 1), partial: false, pitId: 'pit-1',
    })).mockReturnValueOnce(slow.promise);
    const { user } = setup(backend, { seeds: [{ index: 'orders-1', dsl: '{"sort":["_doc"],"size":1}' }] });
    await user.click(runButton());
    await user.click(await screen.findByRole('button', { name: '加载更多' }));
    await user.click(screen.getByRole('button', { name: '取消请求' }));
    expect(screen.getByText('kept')).toBeVisible();
    expect(screen.getByText('已停止加载，保留已加载文档，分页快照已释放。')).toBeVisible();
    expect(screen.queryByText(/下一页加载失败/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新执行' })).toBeEnabled();
    const request = backend.execute.mock.calls[1]![0];
    await act(async () => {
      slow.resolve({ ...request, endpoint: 'https://es.test', rawResponse: pagedResponse('discarded', 'pit-2', 2), partial: false, pitId: 'pit-2' });
      await slow.promise;
    });
    expect(screen.queryByText('discarded')).not.toBeInTheDocument();
  });

  it('loads the next page inside one snapshot and keeps every received row', async () => {
    const backend = makeBackend();
    backend.execute = vi.fn((request: QueryRequest) => Promise.resolve({
      requestId: request.requestId, connectionId: request.connectionId, endpoint: 'https://es.test',
      rawResponse: request.searchAfter === undefined ? pagedResponse('a', 'pit-1', 1)
        : request.searchAfter === '[1]' ? pagedResponse('b', 'pit-2', 2) : pagedResponse('c', 'pit-3', 3),
      partial: false, pitId: request.searchAfter === undefined ? 'pit-1' : request.searchAfter === '[1]' ? 'pit-2' : 'pit-3',
    }));
    const { user } = setup(backend, { seeds: [{ index: 'orders-1', dsl: '{"sort":[{"id":"asc"}],"size":1}' }] });
    await user.click(runButton());
    await screen.findByText('已完成');
    expect(screen.queryByText('已加载 2 页')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: '加载更多' }));
    await screen.findByText('已加载 2 行');
    expect(screen.getByRole('button', { name: '加载更多' })).toHaveAttribute('title', expect.stringContaining('已加载 2 页'));
    expect(backend.openPit).toHaveBeenCalledTimes(1);
    expect(backend.execute.mock.calls[0]![0]).toMatchObject({ pitId: 'pit-fixture' });
    expect(backend.execute.mock.calls[0]![0].searchAfter).toBeUndefined();
    expect(backend.execute.mock.calls[1]![0]).toMatchObject({ pitId: 'pit-1', searchAfter: '[1]' });
    expect(screen.getByText('a')).toBeInTheDocument();
    expect(screen.getByText('b')).toBeInTheDocument();
    // The newest snapshot id wins for the next page, and the snapshot is reused, not reopened.
    await user.click(await screen.findByRole('button', { name: '加载更多' }));
    await screen.findByText('已加载 3 行');
    expect(backend.openPit).toHaveBeenCalledTimes(1);
    expect(backend.execute.mock.calls[2]![0]).toMatchObject({ pitId: 'pit-2', searchAfter: '[2]' });
  });

  it('offers continuation only when the response carries a cursor', async () => {
    const backend = makeBackend();
    backend.execute.mockImplementation(async (request) => ({
      ...request, endpoint: 'https://es.test', rawResponse: searchResponse.replace('"value":1', '"value":9'), partial: false, pitId: null,
    }));
    const { user } = setup(backend);
    await user.click(runButton());
    await screen.findByText('已完成');
    expect(screen.getByRole('img', { name: /继续加载需要在查询体中定义 sort/ })).toHaveAttribute('title', zhLive.loadMoreNeedsSort);
    expect(screen.queryByText(zhLive.loadMoreNeedsSort)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument();
  });

  it('keeps the rows on PIT expiry and only restarts from page one after an explicit rerun', async () => {
    const backend = makeBackend();
    let calls = 0;
    backend.execute = vi.fn((request: QueryRequest) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          requestId: request.requestId, connectionId: request.connectionId, endpoint: 'https://es.test',
          rawResponse: pagedResponse('a', 'pit-fixture', 1), partial: false, pitId: 'pit-fixture',
        });
      }
      if (calls === 2) return Promise.reject({ code: 'notFound', requestId: request.requestId, retryable: false });
      return Promise.resolve({
        requestId: request.requestId, connectionId: request.connectionId, endpoint: 'https://es.test',
        rawResponse: pagedResponse('restarted', 'pit-9', 1), partial: false, pitId: 'pit-9',
      });
    });
    const { user } = setup(backend, { seeds: [{ index: 'orders-1', dsl: '{"sort":["_doc"],"size":1}' }] });
    await user.click(runButton());
    await screen.findByText('已完成');
    await user.click(await screen.findByRole('button', { name: '加载更多' }));
    expect(await screen.findByText(/搜索快照已过期或不可用/)).toBeInTheDocument();
    // The row from the first page stays visible through the failed continuation.
    expect(screen.getByText('a')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重新执行' }));
    await screen.findByText('restarted');
    expect(screen.queryByText('a')).not.toBeInTheDocument();
    expect(screen.queryByText('已加载 2 页')).not.toBeInTheDocument();
    expect(backend.execute.mock.calls[2]![0].searchAfter).toBeUndefined();
    expect(backend.openPit).toHaveBeenCalledTimes(2);
  });

  it('closes the snapshot when the query is executed again', async () => {
    const backend = makeBackend();
    backend.execute = vi.fn((request: QueryRequest) => Promise.resolve({
      requestId: request.requestId, connectionId: request.connectionId, endpoint: 'https://es.test',
      rawResponse: request.searchAfter === undefined ? pagedResponse('a', 'pit-1', 1) : pagedResponse('b', 'pit-2', 2),
      partial: false, pitId: request.searchAfter === undefined ? 'pit-1' : 'pit-2',
    }));
    const { user } = setup(backend, { seeds: [{ index: 'orders-1', dsl: '{"sort":["_doc"],"size":1}' }] });
    await user.click(runButton());
    await screen.findByText('已完成');
    await user.click(await screen.findByRole('button', { name: '加载更多' }));
    await screen.findByText('已加载 2 行');
    await user.click(runButton());
    await waitFor(() => expect(backend.closePit).toHaveBeenCalledWith(expect.objectContaining({ pitId: 'pit-2' })));
  });

  it('shows and copies the latest JSON page while document details still use their original page', async () => {
    const backend = makeBackend();
    backend.execute.mockImplementation(async (request) => ({
      ...request, endpoint: 'https://es.test',
      rawResponse: request.searchAfter === undefined ? pagedResponse('first-document', 'pit-1', 1) : pagedResponse('second-document', 'pit-2', 2),
      partial: false, pitId: request.searchAfter === undefined ? 'pit-1' : 'pit-2',
    }));
    const { user } = setup(backend, { seeds: [{ index: 'orders-1', dsl: '{"sort":["_doc"],"size":1}' }] });
    await user.click(runButton());
    await user.click(await screen.findByRole('button', { name: '加载更多' }));
    await screen.findByText('已加载 2 行');
    await user.click(screen.getByRole('button', { name: '文档 first-document' }));
    expect(within(screen.getByRole('dialog')).getByText(/"id": 1/)).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '关闭' }));
    await user.click(screen.getByRole('button', { name: 'JSON' }));
    expect(screen.getByText(/"second-document"/)).toBeVisible();
    expect(screen.queryByText(/"first-document"/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '复制原始响应' }));
    expect(await navigator.clipboard.readText()).toBe(pagedResponse('second-document', 'pit-2', 2));
  });
});
