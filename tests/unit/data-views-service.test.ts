import { invoke, isTauri } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDataViews, type DataViewLibrary } from '../../src/domain/data-views';
import { createDataViewService, createSessionDataViewService, desktopDataViewService as desktop } from '../../src/services/data-views';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); vi.mocked(isTauri).mockReturnValue(true); });
const library: DataViewLibrary = { version: 1, entries: [
  { id: 'view', connectionId: 'connection', name: 'Events', index: 'events-*', defaultTimeField: '@timestamp',
    fieldFormats: { version: 1, entries: [{ field: 'n', format: { kind: 'number', grouping: true } }] } },
] };

describe('Data View IPC', () => {
  it('refuses unsupported nested format options on reads and before writes without stripping them silently', async () => {
    const invalid = structuredClone(library);
    Object.assign(invalid.entries[0]!.fieldFormats!.entries[0]!.format, { html: '<b>fixture</b>' });
    await expect(desktop.save(0, invalid)).rejects.toMatchObject({ code: 'invalidInput' });
    expect(invoke).not.toHaveBeenCalled();
    vi.mocked(invoke).mockResolvedValue({ revision: 1, library: invalid });
    await expect(desktop.load()).rejects.toMatchObject({ code: 'invalidResponse' });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('data_views_load');
  });

  it('loads strict typed records and saves only a bounded library plus CAS revision', async () => {
    vi.mocked(invoke).mockResolvedValue({ revision: 0, library: emptyDataViews() });
    await expect(desktop.load()).resolves.toEqual({ revision: 0, library: emptyDataViews() });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('data_views_load');
    vi.mocked(invoke).mockResolvedValue({ revision: 1 });
    await expect(desktop.save(0, library)).resolves.toBe(1);
    expect(invoke).toHaveBeenLastCalledWith('data_views_save', { expectedRevision: 0, library });
  });
  it('rejects malformed stored records, unknown versions, extra fields and incorrect save receipts', async () => {
    for (const record of [{ revision: -1, library }, { revision: 0, library }, { revision: 1, library: { ...library, version: 2 } },
      { revision: 1, library, headers: {} }]) {
      vi.mocked(invoke).mockResolvedValue(record);
      await expect(desktop.load()).rejects.toMatchObject({ code: 'invalidResponse' });
    }
    for (const response of [{ revision: 0 }, { revision: 1, saved: true }, true]) {
      vi.mocked(invoke).mockResolvedValue(response);
      await expect(desktop.save(0, library)).rejects.toMatchObject({ code: 'invalidResponse' });
    }
  });
  it('refuses excess input before IPC and never falls back from desktop failure', async () => {
    await expect(desktop.save(Number.MAX_SAFE_INTEGER, library)).rejects.toMatchObject({ code: 'invalidInput' });
    await expect(desktop.save(0, { ...library, version: 2 })).rejects.toMatchObject({ code: 'invalidInput' });
    expect(invoke).not.toHaveBeenCalled();
    vi.mocked(invoke).mockRejectedValue({ code: 'storageUnavailable' });
    await expect(desktop.load()).rejects.toMatchObject({ code: 'storageUnavailable' });
    expect(createDataViewService().kind).toBe('desktop');
    vi.mocked(isTauri).mockReturnValue(false);
    await expect(desktop.load()).rejects.toMatchObject({ code: 'unsupported' });
    await expect(desktop.save(0, library)).rejects.toMatchObject({ code: 'unsupported' });
    expect(createDataViewService().kind).toBe('session');
  });
});

describe('session Data Views', () => {
  it('enforces CAS and immutable ownership, returns independent values and has no persistence side effects', async () => {
    const service = createSessionDataViewService();
    expect(await service.load()).toEqual({ revision: 0, library: emptyDataViews() });
    await expect(service.save(0, library)).resolves.toBe(1);
    await expect(service.save(0, emptyDataViews())).rejects.toMatchObject({ code: 'dataViewConflict' });
    await expect(service.save(1, { ...library, entries: [{ ...library.entries[0]!, connectionId: 'other' }] }))
      .rejects.toMatchObject({ code: 'invalidInput' });
    const copy = await service.load();
    Object.assign(copy.library.entries[0]!, { name: 'mutated' });
    Object.assign(copy.library.entries[0]!.fieldFormats!.entries[0]!.format, { grouping: false });
    expect((await service.load()).library).toEqual(library);
    expect((await createSessionDataViewService().load()).library.entries).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });
});
