import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { emptyDataViews, type DataViewDefinition, type DataViewRecord } from '../../src/domain/data-views';
import { useDataViews } from '../../src/features/query/useDataViews';
import { createSessionDataViewService, type DataViewService } from '../../src/services/data-views';

const definition: DataViewDefinition = { id: 'first', name: 'First', connectionId: 'a', index: 'orders-*', defaultTimeField: null };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function serviceFixture() {
  const memory = createSessionDataViewService();
  const service = { ...memory, load: vi.fn(memory.load), save: vi.fn(memory.save) };
  return { service, memory };
}

describe('Data View save ownership', () => {
  it('does not write before a successful load or repair a failed load', async () => {
    const { service } = serviceFixture();
    service.load.mockRejectedValue({ code: 'invalidResponse' });
    const { result } = renderHook(() => useDataViews(service));
    await waitFor(() => expect(result.current.status).toBe('error'));
    await act(async () => { expect(await result.current.save(definition)).toBe(false); });
    expect(service.save).not.toHaveBeenCalled();
    expect(result.current.error).toBe('invalidResponse');
  });

  it('serializes CAS saves with independent payloads and no write on initial StrictMode mount', async () => {
    const { service, memory } = serviceFixture();
    const pending = deferred<void>();
    service.save.mockImplementationOnce(async (revision, library) => {
      await pending.promise;
      return memory.save(revision, library);
    });
    const { result } = renderHook(() => useDataViews(service), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(service.save).not.toHaveBeenCalled();
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    const changed = { ...definition };
    act(() => {
      first = result.current.save(changed);
      second = result.current.save({ ...definition, id: 'second', name: 'Second' });
    });
    changed.name = 'Mutation after dispatch';
    await waitFor(() => expect(service.save).toHaveBeenCalledTimes(1));
    expect(result.current.entries).toHaveLength(0);
    await act(async () => { pending.resolve(); expect(await first).toBe(true); expect(await second).toBe(true); });
    expect(service.save.mock.calls.map(([revision]) => revision)).toEqual([0, 1]);
    expect(result.current.entries.map((entry) => entry.name)).toEqual(['First', 'Second']);
  });

  it('stops queued writes on an ambiguous failure and reloads the actual persisted outcome', async () => {
    const { service, memory } = serviceFixture();
    service.save.mockImplementationOnce(async (revision, library) => {
      await memory.save(revision, library);
      throw { code: 'invalidResponse' };
    });
    const { result } = renderHook(() => useDataViews(service));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      const first = result.current.save(definition);
      const second = result.current.save({ ...definition, id: 'second' });
      expect(await first).toBe(false);
      expect(await second).toBe(false);
    });
    expect(result.current.error).toBe('invalidResponse');
    expect(service.save).toHaveBeenCalledTimes(1);
    expect(result.current.entries).toEqual([]);
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.error).toBeNull();
    expect(result.current.entries).toEqual([definition]);
  });

  it('waits for dispatched writes on reload and drops queued old-generation intents', async () => {
    const { service, memory } = serviceFixture();
    const pending = deferred<void>();
    service.save.mockImplementationOnce(async (revision, library) => {
      await pending.promise;
      return memory.save(revision, library);
    });
    const { result } = renderHook(() => useDataViews(service));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => { void result.current.save(definition); void result.current.save({ ...definition, id: 'stale' }); });
    await waitFor(() => expect(service.save).toHaveBeenCalledTimes(1));
    act(() => result.current.reload());
    expect(service.load).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(); });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(service.load).toHaveBeenCalledTimes(2);
    expect(service.save).toHaveBeenCalledTimes(1);
    expect(result.current.entries).toEqual([definition]);
  });

  it('does not let a previous service load overwrite the new service', async () => {
    const { service } = serviceFixture();
    const pending = deferred<DataViewRecord>();
    service.load.mockReturnValueOnce(pending.promise);
    const replacement: DataViewService = { kind: 'session', load: vi.fn(async () => ({ revision: 0, library: emptyDataViews() })), save: vi.fn() };
    const { result, rerender } = renderHook(({ store }) => useDataViews(store), { initialProps: { store: service as DataViewService } });
    await waitFor(() => expect(service.load).toHaveBeenCalledOnce());
    rerender({ store: replacement });
    await act(async () => { pending.resolve({ revision: 1, library: { version: 1, entries: [definition] } }); });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.entries).toEqual([]);
    expect(replacement.load).toHaveBeenCalledOnce();
    expect(replacement.save).not.toHaveBeenCalled();
  });

  it('keeps concurrent controllers and stale editor copies from overwriting saved definitions', async () => {
    const { service, memory } = serviceFixture();
    await memory.save(0, { version: 1, entries: [definition] });
    const first = renderHook(() => useDataViews(service));
    const second = renderHook(() => useDataViews(service));
    await waitFor(() => expect(first.result.current.status).toBe('ready'));
    await waitFor(() => expect(second.result.current.status).toBe('ready'));
    const changed = { ...definition, name: 'Latest definition' };
    await act(async () => { expect(await first.result.current.save(changed, definition)).toBe(true); });
    await act(async () => { expect(await second.result.current.remove(definition)).toBe(false); });
    expect(second.result.current.error).toBe('dataViewConflict');
    expect((await memory.load()).library.entries).toEqual([changed]);
    const calls = service.save.mock.calls.length;
    await act(async () => { expect(await first.result.current.save({ ...definition, name: 'Stale' }, definition)).toBe(false); });
    expect(first.result.current.error).toBe('dataViewConflict');
    expect(service.save).toHaveBeenCalledTimes(calls);
  });

  it('captures edit and delete review copies before queued work starts', async () => {
    const { service, memory } = serviceFixture();
    await memory.save(0, { version: 1, entries: [definition] });
    const { result } = renderHook(() => useDataViews(service));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const reviewed = { ...definition };
    const changed = { ...definition, name: 'Updated' };
    await act(async () => {
      const saved = result.current.save(changed, reviewed);
      reviewed.name = 'Changed after review';
      expect(await saved).toBe(true);
    });
    await act(async () => {
      const deleted = result.current.remove(changed);
      changed.id = 'another-id';
      expect(await deleted).toBe(true);
    });
    expect((await memory.load()).library.entries).toEqual([]);
  });
});
