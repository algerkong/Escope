import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createQuery } from '../../src/domain/query';
import { selectDataView } from '../../src/domain/data-views';
import { DATA_PREVIEW_DSL, supportsSnapshotPaging } from '../../src/domain/query-pagination';
import { useQueryExecutions } from '../../src/features/query/useQueryExecutions';
import type { ExecutionHistoryEntry } from '../../src/domain/workspace-recovery';
import type { PitOpenResponse, QueryBackend, QueryRequest, QueryResponse } from '../../src/services/ipc';

const endpoint = 'https://fixture.test';
const query = { ...createQuery('c1'), index: 'orders', dsl: '{"query":{"term":{"n":9007199254740993}},"sort":["_doc"],"size":1}' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function response(request: QueryRequest, id = 'first', n = 1, partial = false): QueryResponse {
  const pitId = request.pitId ?? null;
  return {
    requestId: request.requestId, connectionId: request.connectionId, endpoint, pitId, partial,
    rawResponse: `{"took":1,"timed_out":${partial},"_shards":{"total":1,"successful":1,"failed":0},`
      + `"hits":{"total":{"value":20,"relation":"eq"},"hits":[{"_id":"${id}","_index":"orders","_source":{"n":${n}},"sort":[${n}]}]}}`,
  };
}

function backend() {
  let pit = 0;
  return {
    available: true,
    readResource: vi.fn<QueryBackend['readResource']>(),
    openPit: vi.fn<QueryBackend['openPit']>(async (request) => ({ ...request, endpoint, pitId: `pit-${++pit}` })),
    execute: vi.fn<QueryBackend['execute']>(async (request) => response(request)),
    cancel: vi.fn<QueryBackend['cancel']>(async () => true),
    closePit: vi.fn<QueryBackend['closePit']>(async () => {}),
  } satisfies QueryBackend;
}

describe('snapshot paging eligibility', () => {
  it('opens a snapshot only for an explicit first-page sort', () => {
    for (const raw of [DATA_PREVIEW_DSL, query.dsl, '{"sort":{"amount":"desc"}}', '{"sort":"_doc","from":0}']) {
      expect(supportsSnapshotPaging(raw)).toBe(true);
    }
    for (const raw of ['{}', '{"size":0,"sort":["_doc"]}', '{"sort":[]}', '{"sort":["_doc"],"from":5}',
      '{"sort":["_doc"],"search_after":[1]}', '{"sort":["_doc"],"pit":{"id":"old"}}',
      '{"sort":["_doc"],"collapse":{"field":"x"}}', 'invalid']) {
      expect(supportsSnapshotPaging(raw)).toBe(false);
    }
  });
});

describe('execution history events', () => {
  it('uses the original format copy for continuation and never sends presentation options to search or PIT IPC', async () => {
    const api = backend();
    const history = vi.fn<(entry: ExecutionHistoryEntry) => void>();
    const dataView = selectDataView({ id: 'view', name: 'View', connectionId: 'c1', index: 'orders', defaultTimeField: null,
      fieldFormats: { version: 1, entries: [{ field: 'n', format: { kind: 'number', grouping: true } }] } });
    const draft = { ...query, dataView };
    const { result } = renderHook(() => useQueryExecutions(api, history));
    await act(async () => { await result.current.run(draft, endpoint); });
    api.execute.mockImplementationOnce(async (request) => response(request, 'second', 2));
    const changed = selectDataView({ ...dataView.definition,
      fieldFormats: { version: 1, entries: [{ field: 'n', format: { kind: 'percent', grouping: false } }] } });
    await act(async () => { await result.current.loadMore({ ...draft, dataView: changed, dsl: '{"size":500}' }); });
    const state = result.current.entries[query.id]!.state;
    expect(state.status).toBe('success');
    expect('snapshot' in state && state.snapshot.dataView).toEqual(dataView);
    expect(result.current.entries[query.id]!.pages).toHaveLength(2);
    expect(history.mock.calls[3]![0].snapshot.dataView).toEqual(dataView);
    expect(history.mock.calls[3]![0].kind).toBe('continuation');
    expect(history.mock.calls[3]![0].snapshot.dataView).not.toBe(dataView);
    expect(JSON.stringify([...api.execute.mock.calls, ...api.openPit.mock.calls])).not.toMatch(/fieldFormats|dataView|grouping/);
    await act(async () => { expect(await result.current.run(draft, endpoint, 'index')).toEqual({ code: 'invalidDataView' }); });
    expect(api.execute).toHaveBeenCalledTimes(2);
  });

  it('records exact immutable snapshots and honest success without response bodies or PIT ids', async () => {
    const api = backend();
    const history = vi.fn<(entry: ExecutionHistoryEntry) => void>();
    const { result } = renderHook(() => useQueryExecutions(api, history));
    await act(async () => { await result.current.run(query, endpoint, 'index'); });
    const start = history.mock.calls[0]![0];
    const end = history.mock.calls[1]![0];
    expect(start).toMatchObject({ kind: 'index', status: 'running', finishedAt: null });
    expect(end).toMatchObject({ kind: 'index', status: 'success', errorCode: null, snapshot: { rawDsl: query.dsl } });
    expect(end.snapshot).toBe(start.snapshot);
    expect(Object.isFrozen(start.snapshot)).toBe(true);
    expect(end.finishedAt).not.toBeNull();
    expect(JSON.stringify(history.mock.calls)).not.toMatch(/rawResponse|pitId|_source|pit-1/);
    await act(async () => { await result.current.run({ ...query, dsl: 'invalid' }, endpoint); });
    expect(history).toHaveBeenCalledTimes(2);
  });

  it('does not replace cancellation with the late success of an abandoned PIT open', async () => {
    const api = backend();
    const pending = deferred<PitOpenResponse>();
    api.openPit.mockReturnValueOnce(pending.promise);
    const history = vi.fn<(entry: ExecutionHistoryEntry) => void>();
    const { result } = renderHook(() => useQueryExecutions(api, history));
    let run!: ReturnType<typeof result.current.run>;
    act(() => { run = result.current.run(query, endpoint); });
    act(() => result.current.cancel(query.id));
    await act(async () => {
      pending.resolve({ ...api.openPit.mock.calls[0]![0], endpoint, pitId: 'late-history-pit' });
      await run;
    });
    expect(history.mock.calls.map(([entry]) => entry.status)).toEqual(['running', 'cancelled']);
    expect(history.mock.calls[1]![0].errorCode).toBe('cancelled');
    expect(api.execute).not.toHaveBeenCalled();
  });

  it('records continuation failure separately using the frozen DSL and actual next-page request id', async () => {
    const api = backend();
    api.execute.mockImplementationOnce(async (request) => response(request, 'first', 1, true));
    const history = vi.fn<(entry: ExecutionHistoryEntry) => void>();
    const { result } = renderHook(() => useQueryExecutions(api, history));
    await act(async () => { await result.current.run(query, endpoint); });
    api.execute.mockRejectedValueOnce({ code: 'timeout' });
    await act(async () => { await result.current.loadMore({ ...query, dsl: '{"size":999}', index: 'edited' }); });
    expect(history.mock.calls.map(([entry]) => entry.status)).toEqual(['running', 'partial', 'running', 'failed']);
    expect(history.mock.calls[3]![0]).toMatchObject({
      kind: 'continuation', errorCode: 'timeout',
      snapshot: { requestId: api.execute.mock.calls[1]![0].requestId, rawDsl: query.dsl, index: query.index },
    });
    expect(history.mock.calls[3]![0].snapshot.requestId).not.toBe(history.mock.calls[1]![0].snapshot.requestId);
    expect(JSON.stringify(history.mock.calls)).not.toMatch(/searchAfter|pitId/);
  });

  it('marks an unfinished component lifetime interrupted, with no invented completion time', async () => {
    const api = backend();
    const pending = deferred<PitOpenResponse>();
    api.openPit.mockReturnValueOnce(pending.promise);
    const history = vi.fn<(entry: ExecutionHistoryEntry) => void>();
    const hook = renderHook(() => useQueryExecutions(api, history));
    let run!: ReturnType<typeof hook.result.current.run>;
    act(() => { run = hook.result.current.run(query, endpoint); });
    hook.unmount();
    await act(async () => {
      pending.resolve({ ...api.openPit.mock.calls[0]![0], endpoint, pitId: 'interrupted-pit' });
      await run;
    });
    expect(history.mock.calls.map(([entry]) => entry.status)).toEqual(['running', 'interrupted']);
    expect(history.mock.calls[1]![0]).toMatchObject({ finishedAt: null, errorCode: null });
  });
});

describe('query execution ownership', () => {
  it('claims the opening stage synchronously and starts page one inside the opened PIT', async () => {
    const api = backend();
    const opening = deferred<PitOpenResponse>();
    api.openPit.mockReturnValue(opening.promise);
    const { result } = renderHook(() => useQueryExecutions(api));
    let pending!: ReturnType<typeof result.current.run>;
    act(() => {
      pending = result.current.run(query, endpoint);
      void result.current.run(query, endpoint);
    });
    expect(api.openPit).toHaveBeenCalledTimes(1);
    expect(api.execute).not.toHaveBeenCalled();
    expect(result.current.entries[query.id]?.state.status).toBe('running');
    await act(async () => {
      opening.resolve({ ...api.openPit.mock.calls[0]![0], endpoint, pitId: 'p'.repeat(608) });
      await pending;
    });
    expect(api.execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ pitId: 'p'.repeat(608), rawDsl: query.dsl }));
    expect(api.execute.mock.calls[0]![0].searchAfter).toBeUndefined();
    expect(result.current.entries[query.id]?.state.status).toBe('success');
  });

  it('closes a late opened PIT after cancel and cannot replace a newer run', async () => {
    const api = backend();
    const opening = deferred<PitOpenResponse>();
    api.openPit.mockReturnValueOnce(opening.promise);
    const { result } = renderHook(() => useQueryExecutions(api));
    let abandoned!: ReturnType<typeof result.current.run>;
    act(() => { abandoned = result.current.run(query, endpoint); });
    const oldOpen = api.openPit.mock.calls[0]![0];
    act(() => result.current.cancel(query.id));
    expect(api.cancel).toHaveBeenCalledWith({ requestId: oldOpen.requestId, connectionId: 'c1' });
    await act(async () => { await result.current.run(query, endpoint); });
    const current = result.current.entries[query.id];
    await act(async () => {
      opening.resolve({ ...oldOpen, endpoint, pitId: 'abandoned-pit' });
      await abandoned;
    });
    expect(api.execute).toHaveBeenCalledTimes(1);
    expect(api.closePit).toHaveBeenCalledWith(expect.objectContaining({ pitId: 'abandoned-pit' }));
    expect(result.current.entries[query.id]).toBe(current);
  });

  it.each(['release', 'endpoint', 'unmount'] as const)('cleans an opening PIT after %s without searching it', async (change) => {
    const api = backend();
    const opening = deferred<PitOpenResponse>();
    api.openPit.mockReturnValueOnce(opening.promise);
    const { result, unmount } = renderHook(() => useQueryExecutions(api));
    let pending!: ReturnType<typeof result.current.run>;
    act(() => { pending = result.current.run(query, endpoint); });
    const request = api.openPit.mock.calls[0]![0];
    act(() => {
      if (change === 'release') result.current.release(new Set());
      if (change === 'endpoint') result.current.reconcile(new Map([['c1', 'https://changed.test']]));
      if (change === 'unmount') unmount();
    });
    await act(async () => { opening.resolve({ ...request, endpoint, pitId: 'orphan' }); await pending; });
    expect(api.cancel).toHaveBeenCalledWith({ requestId: request.requestId, connectionId: 'c1' });
    expect(api.execute).not.toHaveBeenCalled();
    expect(api.closePit).toHaveBeenCalledWith(expect.objectContaining({ pitId: 'orphan' }));
  });

  it('rejects an unbound PIT without sending a search or closing another target token', async () => {
    const api = backend();
    api.openPit.mockImplementationOnce(async (request) => ({ ...request, endpoint: 'https://foreign.test', pitId: 'foreign' }));
    const { result } = renderHook(() => useQueryExecutions(api));
    await act(async () => { await result.current.run(query, endpoint); });
    expect(result.current.entries[query.id]?.state).toMatchObject({ status: 'failed', code: 'invalidResponse' });
    expect(api.execute).not.toHaveBeenCalled();
    expect(api.closePit).not.toHaveBeenCalled();
  });

  it('uses frozen DSL for continuation, updates the latest response and retains partial state', async () => {
    const api = backend();
    const { result } = renderHook(() => useQueryExecutions(api));
    await act(async () => { await result.current.run(query, endpoint); });
    api.execute.mockImplementationOnce(async (request) => response(request, 'partial', 2, true));
    const changed = { ...query, dsl: '{"size":100}', index: 'different', revision: 3 };
    await act(async () => { await result.current.loadMore(changed); });
    const second = api.execute.mock.calls[1]![0];
    expect(second).toMatchObject({ index: query.index, rawDsl: query.dsl, searchAfter: '[1]', pitId: 'pit-1' });
    const entry = result.current.entries[query.id]!;
    expect(entry.pages).toHaveLength(2);
    expect(entry.state.status).toBe('partial');
    expect(entry.rawResponse).toContain('"partial"');
    expect(entry.parsed?.ok && entry.parsed.summary.timedOut).toBe(true);
    api.execute.mockImplementationOnce(async (request) => response(request, 'last', 3));
    await act(async () => { await result.current.loadMore(changed); });
    expect(result.current.entries[query.id]?.state.status).toBe('partial');
    expect(api.openPit).toHaveBeenCalledTimes(1);
  });

  it('deduplicates next-page clicks and a cancelled old rejection cannot release the new request', async () => {
    const api = backend();
    const { result } = renderHook(() => useQueryExecutions(api));
    await act(async () => { await result.current.run(query, endpoint); });
    const oldPage = deferred<QueryResponse>();
    api.execute.mockReturnValueOnce(oldPage.promise);
    let continuing!: Promise<void>;
    act(() => {
      continuing = result.current.loadMore(query);
      void result.current.loadMore(query);
    });
    expect(api.execute).toHaveBeenCalledTimes(2);
    act(() => result.current.cancel(query.id));
    const newPage = deferred<QueryResponse>();
    api.execute.mockReturnValueOnce(newPage.promise);
    let rerun!: ReturnType<typeof result.current.run>;
    await act(async () => { rerun = result.current.run(query, endpoint); });
    expect(api.execute).toHaveBeenCalledTimes(3);
    await act(async () => { oldPage.reject({ code: 'networkError' }); await continuing; });
    expect(result.current.entries[query.id]?.state.status).toBe('running');
    await act(async () => { await result.current.run(query, endpoint); });
    expect(api.execute).toHaveBeenCalledTimes(3);
    await act(async () => {
      newPage.resolve(response(api.execute.mock.calls[2]![0], 'new', 10));
      await rerun;
    });
    expect(result.current.entries[query.id]?.rawResponse).toContain('"new"');
    expect(result.current.entries[query.id]?.pages).toHaveLength(1);
  });

  it('does not open a fresh snapshot for an expired cursor', async () => {
    const api = backend();
    const { result } = renderHook(() => useQueryExecutions(api));
    await act(async () => { await result.current.run(query, endpoint); });
    api.execute.mockRejectedValueOnce({ code: 'notFound' });
    await act(async () => { await result.current.loadMore(query); });
    expect(result.current.entries[query.id]).toMatchObject({ pitId: null, continuing: false, continuationError: 'notFound' });
    await act(async () => { await result.current.loadMore(query); });
    expect(api.execute).toHaveBeenCalledTimes(2);
    expect(api.openPit).toHaveBeenCalledTimes(1);
    expect(result.current.entries[query.id]?.pages).toHaveLength(1);
    await act(async () => { await result.current.run(query, endpoint); });
    expect(api.openPit).toHaveBeenCalledTimes(2);
    expect(api.execute.mock.calls[2]![0].searchAfter).toBeUndefined();
  });
});
