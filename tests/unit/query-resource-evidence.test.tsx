import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { resourceKey, useQueryResources } from '../../src/features/query/useQueryResources';
import type { QueryBackend, ResourceRequest, ResourceResponse } from '../../src/services/ipc';

const endpoint = 'https://es.test/base';
const raw = '{"indices":["events-a"],"fields":{"amount":{"long":{"searchable":true,"aggregatable":true}}}}';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function backend() {
  return {
    available: true,
    readResource: vi.fn(async (request: ResourceRequest): Promise<ResourceResponse> =>
      ({ ...request, endpoint, rawResponse: raw })),
    execute: vi.fn(), openPit: vi.fn(), closePit: vi.fn(),
    cancel: vi.fn(async () => true),
  } satisfies QueryBackend;
}

describe('resource evidence identity', () => {
  it('records the exact requested target and validated response identity, separately from response indices', async () => {
    const api = backend();
    const { result } = renderHook(() => useQueryResources(api));
    expect(api.readResource).not.toHaveBeenCalled();
    await act(async () => result.current.refreshFields('c1', endpoint, 'events-b,events-a'));
    const request = api.readResource.mock.calls[0]![0];
    expect(result.current.fieldsFor('c1', endpoint, 'events-b,events-a')).toMatchObject({
      status: 'ready', source: { requestId: request.requestId, connectionId: 'c1', endpoint,
        resource: 'fieldCaps', index: 'events-b,events-a' }, data: { indices: ['events-a'] },
    });
    for (const target of ['events-a,events-b', 'events-*', ' events-b,events-a ']) {
      expect(result.current.fieldsFor('c1', endpoint, target)).toEqual({ status: 'idle' });
    }
    expect(result.current.fieldsFor('c2', endpoint, 'events-b,events-a')).toEqual({ status: 'idle' });
    expect(result.current.fieldsFor('c1', 'https://es.test/other', 'events-b,events-a')).toEqual({ status: 'idle' });
    expect(api.execute).not.toHaveBeenCalled();
    expect(api.openPit).not.toHaveBeenCalled();
  });

  it.each(['requestId', 'connectionId', 'endpoint'] as const)('does not publish a mismatched response %s as evidence', async (key) => {
    const api = backend();
    api.readResource.mockImplementation(async (request) => ({ ...request, endpoint, rawResponse: raw, [key]: 'different' }));
    const { result } = renderHook(() => useQueryResources(api));
    await act(async () => result.current.refreshFields('c1', endpoint, 'events-*'));
    expect(result.current.fieldsFor('c1', endpoint, 'events-*')).toEqual({ status: 'error', code: 'invalidResponse' });
  });

  it('marks old provenance non-current during refresh/failure and replaces it only after a verified success', async () => {
    const api = backend();
    const { result } = renderHook(() => useQueryResources(api));
    await act(async () => result.current.refreshFields('c1', endpoint, 'events-*'));
    const before = result.current.fieldsFor('c1', endpoint, 'events-*');
    const pending = deferred<ResourceResponse>();
    api.readResource.mockReturnValueOnce(pending.promise);
    act(() => result.current.refreshFields('c1', endpoint, 'events-*'));
    expect(result.current.fieldsFor('c1', endpoint, 'events-*')).toMatchObject({ ...before, refreshing: true });
    const request = api.readResource.mock.calls[1]![0];
    await act(async () => pending.resolve({ ...request, endpoint, rawResponse: 'invalid' }));
    expect(result.current.fieldsFor('c1', endpoint, 'events-*')).toMatchObject({ ...before,
      refreshing: false, refreshError: 'invalidResponse' });
    await act(async () => result.current.refreshFields('c1', endpoint, 'events-*'));
    const current = result.current.fieldsFor('c1', endpoint, 'events-*');
    expect(current).toMatchObject({ status: 'ready', source: { requestId: api.readResource.mock.calls[2]![0].requestId } });
    expect(current).not.toHaveProperty('refreshError');
    expect(api.execute).not.toHaveBeenCalled();
  });

  it('does not let a replaced request or endpoint restore stale evidence', async () => {
    const api = backend();
    const pending = deferred<ResourceResponse>();
    api.readResource.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useQueryResources(api));
    act(() => result.current.refreshFields('c1', endpoint, 'events-*'));
    const old = api.readResource.mock.calls[0]![0];
    await act(async () => result.current.refreshFields('c1', endpoint, 'events-*'));
    const newer = result.current.fieldsFor('c1', endpoint, 'events-*');
    await act(async () => pending.resolve({ ...old, endpoint, rawResponse: raw }));
    expect(result.current.fieldsFor('c1', endpoint, 'events-*')).toBe(newer);
    expect(api.cancel).toHaveBeenCalledWith({ requestId: old.requestId, connectionId: 'c1' });
    const second = deferred<ResourceResponse>();
    api.readResource.mockReturnValueOnce(second.promise);
    act(() => result.current.refreshFields('c1', endpoint, 'events-*'));
    const replaced = api.readResource.mock.calls[2]![0];
    act(() => result.current.invalidateConnections(new Map([['c1', 'https://new.test']])));
    await act(async () => second.resolve({ ...replaced, endpoint, rawResponse: raw }));
    expect(result.current.fieldsFor('c1', endpoint, 'events-*')).toEqual({ status: 'idle' });
    expect(result.current.fieldsFor('c1', 'https://new.test', 'events-*')).toEqual({ status: 'idle' });
  });

  it('cancels pending evidence reads on unmount and keeps request scope keys distinct', async () => {
    const api = backend();
    const pending = deferred<ResourceResponse>();
    api.readResource.mockReturnValueOnce(pending.promise);
    const { result, unmount } = renderHook(() => useQueryResources(api));
    act(() => result.current.refreshFields('c1', endpoint, 'events-*'));
    const request = api.readResource.mock.calls[0]![0];
    unmount();
    expect(api.cancel).toHaveBeenCalledWith({ requestId: request.requestId, connectionId: 'c1' });
    await act(async () => pending.resolve({ ...request, endpoint, rawResponse: raw }));
    expect(new Set([
      resourceKey('c1', endpoint, 'fieldCaps', 'a,b'), resourceKey('c1', endpoint, 'fieldCaps', 'b,a'),
      resourceKey('c2', endpoint, 'fieldCaps', 'a,b'), resourceKey('c1', endpoint, 'mapping', 'a,b'),
      resourceKey('c1', 'https://other.test', 'fieldCaps', 'a,b'),
    ]).size).toBe(5);
  });
});
