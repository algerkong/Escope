import { invoke, isTauri } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../fixtures/pinned-filters-v1.json';
import nestedFixture from '../fixtures/pinned-filters-v2.json';
import { emptyPinnedFilters, parsePinnedFilterLibrary } from '../../src/domain/pinned-filters';
import { createPinnedFilterService, createSessionPinnedFilterService, desktopPinnedFilterService as desktop } from '../../src/services/pinned-filters';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); vi.mocked(isTauri).mockReturnValue(true); });
const library = parsePinnedFilterLibrary(fixture)!;

describe('pinned filter IPC', () => {
  it('sends only the bounded definition library and expected revision', async () => {
    vi.mocked(invoke).mockResolvedValue({ revision: 0, library: emptyPinnedFilters() });
    await expect(desktop.load()).resolves.toEqual({ revision: 0, library: emptyPinnedFilters() });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('pinned_filters_load');
    vi.mocked(invoke).mockResolvedValue({ revision: 1 });
    await expect(desktop.save(0, library)).resolves.toBe(1);
    expect(invoke).toHaveBeenLastCalledWith('pinned_filters_save', { expectedRevision: 0, library });
    expect(JSON.stringify(vi.mocked(invoke).mock.calls.at(-1))).not.toContain('snapshot');
  });

  it('rejects unknown, damaged and future definitions before invocation or recovery', async () => {
    const invalid = structuredClone(library);
    Object.assign(invalid.entries[0]!.filters[2]!, { nestedPath: 'comments' });
    await expect(desktop.save(0, invalid)).rejects.toMatchObject({ code: 'invalidInput' });
    await expect(desktop.save(Number.MAX_SAFE_INTEGER, library)).rejects.toMatchObject({ code: 'invalidInput' });
    expect(invoke).not.toHaveBeenCalled();
    for (const record of [
      { revision: 0, library }, { revision: -1, library }, { revision: 1, library: invalid },
      { revision: 1, library: { ...library, version: 3 } }, { revision: 1, library, headers: {} },
    ]) {
      vi.mocked(invoke).mockResolvedValue(record);
      await expect(desktop.load()).rejects.toMatchObject({ code: 'invalidResponse' });
    }
  });

  it('checks save receipts and never switches a failed desktop store to session memory', async () => {
    for (const receipt of [{ revision: 0 }, { revision: 2 }, { revision: 1, saved: true }, null, true]) {
      vi.mocked(invoke).mockResolvedValue(receipt);
      await expect(desktop.save(0, library)).rejects.toMatchObject({ code: 'invalidResponse' });
    }
    vi.mocked(invoke).mockRejectedValue({ code: 'storageUnavailable' });
    await expect(desktop.load()).rejects.toMatchObject({ code: 'storageUnavailable' });
    expect(createPinnedFilterService().kind).toBe('desktop');
    vi.mocked(isTauri).mockReturnValue(false);
    await expect(desktop.save(0, library)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(desktop.load()).rejects.toMatchObject({ code: 'unsupported' });
    expect(createPinnedFilterService().kind).toBe('session');
  });

  it('isolates session copies, enforces CAS and forbids replacing any part of an existing definition', async () => {
    const service = createSessionPinnedFilterService();
    await expect(service.save(0, library)).resolves.toBe(1);
    await expect(service.save(0, emptyPinnedFilters())).rejects.toMatchObject({ code: 'pinnedFilterConflict' });
    for (const patch of [{ name: 'other' }, { connectionId: 'other' }, { index: 'other' }]) {
      await expect(service.save(1, { ...library, entries: [{ ...library.entries[0]!, ...patch }] }))
        .rejects.toMatchObject({ code: 'invalidInput' });
    }
    const copy = await service.load();
    Object.assign(copy.library.entries[0]!.filters[0]!, { enabled: false });
    await expect(service.save(1, copy.library)).rejects.toMatchObject({ code: 'invalidInput' });
    expect((await service.load()).library).toEqual(library);
    expect((await createSessionPinnedFilterService().load()).library).toEqual(emptyPinnedFilters());
    await expect(service.save(1, emptyPinnedFilters())).resolves.toBe(2);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('preserves v1 reads and sends v2 scopes without execution metadata or a compatibility downgrade', async () => {
    vi.mocked(invoke).mockResolvedValue({ revision: 1, library });
    await expect(desktop.load()).resolves.toEqual({ revision: 1, library });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('pinned_filters_load');
    const nested = parsePinnedFilterLibrary(nestedFixture)!;
    const next = { version: 2, entries: [...library.entries, ...nested.entries] };
    vi.mocked(invoke).mockResolvedValue({ revision: 2 });
    await expect(desktop.save(1, next)).resolves.toBe(2);
    expect(invoke).toHaveBeenLastCalledWith('pinned_filters_save', { expectedRevision: 1, library: next });
    const session = createSessionPinnedFilterService();
    await session.save(0, library);
    await session.save(1, next);
    await expect(session.save(2, { version: 1, entries: [] })).rejects.toMatchObject({ code: 'invalidInput' });
    const changed = structuredClone(next);
    Object.assign(changed.entries[1]!.composition.groups[1]!.nested!, { match: 'exclude' });
    await expect(session.save(2, changed)).rejects.toMatchObject({ code: 'invalidInput' });
    expect((await session.load()).library).toEqual(next);
  });
});
