import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import fixture from '../fixtures/pinned-filters-v1.json';
import nestedFixture from '../fixtures/pinned-filters-v2.json';
import { emptyPinnedFilters, parsePinnedFilterLibrary, type PinnedFilterRecord } from '../../src/domain/pinned-filters';
import { usePinnedFilters } from '../../src/features/query/usePinnedFilters';
import { createSessionPinnedFilterService, type PinnedFilterService } from '../../src/services/pinned-filters';

const library = parsePinnedFilterLibrary(fixture)!;
const definition = library.entries[0]!;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function store() {
  const memory = createSessionPinnedFilterService();
  return { memory, service: { ...memory, load: vi.fn(memory.load), save: vi.fn(memory.save) } };
}

describe('pinned filter persistence controller', () => {
  it('loads without writing in StrictMode and cannot overwrite a failed load', async () => {
    const { service } = store();
    service.load.mockRejectedValue({ code: 'invalidResponse' });
    const { result } = renderHook(() => usePinnedFilters(service), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.status).toBe('error'));
    await act(async () => { expect(await result.current.save(definition)).toBe(false); });
    expect(service.save).not.toHaveBeenCalled();
  });

  it('serializes saves and deeply captures nested definitions at dispatch', async () => {
    const { service, memory } = store();
    const pending = deferred<void>();
    service.save.mockImplementationOnce(async (revision, library) => { await pending.promise; return memory.save(revision, library); });
    const { result } = renderHook(() => usePinnedFilters(service));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const first = structuredClone(definition);
    let saved!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      saved = result.current.save(first);
      second = result.current.save({ ...definition, id: 'second' });
    });
    Object.assign(first.filters[0]!, { enabled: false, value: '"mutated"' });
    await waitFor(() => expect(service.save).toHaveBeenCalledOnce());
    await act(async () => { pending.resolve(); expect(await saved).toBe(true); expect(await second).toBe(true); });
    expect(service.save.mock.calls.map(([revision]) => revision)).toEqual([0, 1]);
    expect(result.current.entries[0]).toEqual(definition);
  });

  it('does not retry ambiguous writes or dispatch subsequent intents until explicit reload', async () => {
    const { service, memory } = store();
    service.save.mockImplementationOnce(async (revision, library) => { await memory.save(revision, library); throw { code: 'invalidResponse' }; });
    const { result } = renderHook(() => usePinnedFilters(service));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      const first = result.current.save(definition);
      const second = result.current.save({ ...definition, id: 'second' });
      expect(await first).toBe(false);
      expect(await second).toBe(false);
    });
    expect(service.save).toHaveBeenCalledOnce();
    expect(result.current.error).toBe('invalidResponse');
    expect(result.current.entries).toEqual([]);
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.entries).toEqual([definition]));
  });

  it('waits for dispatched writes before reloading and drops older queued intents', async () => {
    const { service, memory } = store();
    const pending = deferred<void>();
    service.save.mockImplementationOnce(async (revision, library) => { await pending.promise; return memory.save(revision, library); });
    const { result } = renderHook(() => usePinnedFilters(service));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => { void result.current.save(definition); void result.current.save({ ...definition, id: 'stale' }); });
    await waitFor(() => expect(service.save).toHaveBeenCalledOnce());
    act(() => result.current.reload());
    expect(service.load).toHaveBeenCalledOnce();
    await act(async () => pending.resolve());
    await waitFor(() => expect(result.current.entries).toEqual([definition]));
    expect(service.save).toHaveBeenCalledOnce();
    expect(service.load).toHaveBeenCalledTimes(2);
  });

  it('rejects concurrent-controller CAS and stale or changed deletion reviews', async () => {
    const { service, memory } = store();
    await memory.save(0, library);
    const first = renderHook(() => usePinnedFilters(service));
    const second = renderHook(() => usePinnedFilters(service));
    await waitFor(() => expect(first.result.current.status).toBe('ready'));
    await waitFor(() => expect(second.result.current.status).toBe('ready'));
    await act(async () => { expect(await first.result.current.save({ ...definition, id: 'new' })).toBe(true); });
    await act(async () => { expect(await second.result.current.remove(definition)).toBe(false); });
    expect(second.result.current.error).toBe('pinnedFilterConflict');
    expect((await memory.load()).library.entries).toHaveLength(2);
    const changed = structuredClone(definition);
    Object.assign(changed.filters[0]!, { enabled: false });
    const calls = service.save.mock.calls.length;
    await act(async () => { expect(await first.result.current.remove(changed)).toBe(false); });
    expect(service.save).toHaveBeenCalledTimes(calls);
  });

  it('deeply captures deletion reviews and ignores old service completions', async () => {
    const { service, memory } = store();
    await memory.save(0, library);
    const { result } = renderHook(() => usePinnedFilters(service));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const copy = structuredClone(definition);
    await act(async () => {
      const removed = result.current.remove(copy);
      Object.assign(copy.filters[0]!, { value: '"mutated"' });
      expect(await removed).toBe(true);
    });
    expect((await memory.load()).library.entries).toEqual([]);
    const pending = deferred<PinnedFilterRecord>();
    service.load.mockReturnValueOnce(pending.promise);
    const replacement: PinnedFilterService = { kind: 'session',
      load: vi.fn(async () => ({ revision: 0, library: emptyPinnedFilters() })), save: vi.fn() };
    const next = renderHook(({ store }) => usePinnedFilters(store), { initialProps: { store: service as PinnedFilterService } });
    await waitFor(() => expect(service.load).toHaveBeenCalledTimes(2));
    next.rerender({ store: replacement });
    await act(async () => pending.resolve({ revision: 1, library }));
    await waitFor(() => expect(next.result.current.status).toBe('ready'));
    expect(next.result.current.entries).toEqual([]);
    expect(replacement.save).not.toHaveBeenCalled();
  });

  it('upgrades v1 only on explicit save and deeply captures nested scopes without altering retained definitions', async () => {
    const { service, memory } = store();
    await memory.save(0, library);
    const { result } = renderHook(() => usePinnedFilters(service));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(service.save).not.toHaveBeenCalled();
    expect((await memory.load()).library.version).toBe(1);
    const nested = parsePinnedFilterLibrary(nestedFixture)!.entries[0]!;
    const captured = structuredClone(nested);
    await act(async () => {
      const saving = result.current.save(captured);
      Object.assign(captured.composition.groups[1]!.nested!, { match: 'exclude' });
      expect(await saving).toBe(true);
    });
    expect((await memory.load()).library).toEqual({ version: 2, entries: [definition, nested] });
    expect(service.save).toHaveBeenCalledExactlyOnceWith(1, { version: 2, entries: [definition, nested] });
  });

  it('deletes legacy entries without an automatic envelope upgrade', async () => {
    const { service, memory } = store();
    await memory.save(0, library);
    const { result } = renderHook(() => usePinnedFilters(service));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { expect(await result.current.remove(definition)).toBe(true); });
    expect((await memory.load()).library).toEqual({ version: 1, entries: [] });
  });
});
