import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryWorkspace, type QueryCommand } from '../../src/features/query/QueryWorkspace';
import { createQuery, type WorkspaceState } from '../../src/domain/query';
import { defaultPreferences } from '../../src/domain/preferences';
import type { ConnectionProfile } from '../../src/domain/connection';
import { i18n } from '../../src/locales';
import { enLive, zhLive } from '../../src/locales/query-live';
import type { QueryBackend, QueryRequest, QueryResponse, ResourceRequest, ResourceResponse } from '../../src/services/ipc';

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
    execute: vi.fn((request: QueryRequest) => Promise.resolve({
      requestId: request.requestId, connectionId: request.connectionId, endpoint: 'https://es.test',
      rawResponse: searchResponse, partial: false,
    })),
    cancel: vi.fn(() => Promise.resolve(true)),
  } satisfies QueryBackend;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

interface SetupOptions {
  seeds?: { index: string }[];
  endpoint?: string;
  canQuery?: boolean;
  active?: boolean;
  onCommandReady?: (command: QueryCommand | null) => void;
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
    const [state, setState] = useState<WorkspaceState>(() => {
      const queries = seeds.map((seed) => ({ ...createQuery('c1'), index: seed.index }));
      return { activeConnectionId: 'c1', activeQueryId: queries[0]!.id, queries };
    });
    return <I18nextProvider i18n={i18n}><QueryWorkspace state={state}
      profiles={connected ? [{ ...baseProfile, endpoint }] : []} preferences={defaultPreferences}
      aiOpen={false} testResults={{}} toggleAI={() => {}} onSettings={() => {}}
      updateQuery={(id, patch) => setState((current) => ({ ...current, queries: current.queries.map((query) => query.id === id
        ? { ...query, ...patch, revision: patch.resultView ? query.revision : query.revision + 1 } : query) }))}
      selectQuery={(id) => setState((current) => ({ ...current, activeQueryId: id }))}
      addQuery={() => {}}
      closeQuery={(id) => setState((current) => {
        const queries = current.queries.filter((query) => query.id !== id);
        if (queries.length === 0) queries.push(createQuery('c1'));
        return { ...current, queries, activeQueryId: current.activeQueryId === id ? queries[0]!.id : current.activeQueryId };
      })}
      backend={backend} canQuery={options.canQuery} active={options.active ?? true}
      onCommandReady={options.onCommandReady} /></I18nextProvider>;
  }
  render(<Harness />);
  return { user: userEvent.setup(), control };
}

const runButton = () => screen.getByRole('button', { name: '执行查询' });
const fields = () => screen.getByLabelText('查询 DSL');

beforeEach(async () => { await i18n.changeLanguage('zh-CN'); });

describe('live query execution and results', () => {
  it('runs the frozen draft and shows a lossless hit count, timing and document', async () => {
    const backend = makeBackend();
    const { user } = setup(backend);
    expect(runButton()).toBeEnabled();
    await user.click(runButton());
    expect(await screen.findByText('已完成')).toBeInTheDocument();
    expect(screen.getByText('1 条命中')).toBeInTheDocument();
    expect(screen.getByText('3 毫秒')).toBeInTheDocument();
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
      rawResponse: partialResponse, partial: true,
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
      rawResponse: '{"took":1}', partial: false,
    }));
    const { user } = setup(backend);
    await user.click(runButton());
    expect(await screen.findByText('该响应无法作为 Elasticsearch 查询结果读取。')).toBeInTheDocument();
    expect(screen.queryByText('已完成')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'JSON' }));
    expect(screen.queryByText(searchResponse)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'JSON' }));
    expect(screen.getByText('{"took":1}')).toBeInTheDocument();
  });

  it('rejects a response that does not echo the frozen request identity', async () => {
    const backend = makeBackend();
    backend.execute = vi.fn(() => Promise.resolve({
      requestId: 'rewritten', connectionId: 'c1', endpoint: 'https://es.test', rawResponse: searchResponse, partial: false,
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
      rawResponse: searchResponse, partial: false,
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
    pending.resolve({ requestId: 'late', connectionId: 'c1', endpoint: 'https://es.test', rawResponse: searchResponse, partial: false });
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
    expect(screen.getByText(/"id":9007199254740993/)).toBeInTheDocument();
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
    await user.click(screen.getAllByRole('tab')[1]!);
    expect(screen.getByText('此查询尚未执行。')).toBeInTheDocument();
    expect(screen.queryByText('9007199254740993')).not.toBeInTheDocument();
    await user.click(screen.getAllByRole('tab')[0]!);
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
  it('selecting an index only retargets the draft and reads fields', async () => {
    const backend = makeBackend();
    const { user } = setup(backend);
    await user.click(await screen.findByRole('button', { name: 'orders-1' }));
    await waitFor(() => expect(backend.readResource).toHaveBeenCalledWith(expect.objectContaining({ resource: 'fieldCaps', index: 'orders-1' })));
    expect(backend.execute).not.toHaveBeenCalled();
    expect(await screen.findByText('legacy')).toBeInTheDocument();
    expect(screen.getByText('可搜索')).toBeInTheDocument();
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
