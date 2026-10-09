import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  emptyDataViews, parseDataViewLibrary, parseDataViewRecord,
  type DataViewLibrary, type DataViewRecord,
} from '../domain/data-views';
import type { ErrorCode, IpcError } from './ipc';

export interface DataViewService {
  readonly kind: 'desktop' | 'session';
  load(): Promise<DataViewRecord>;
  save(expectedRevision: number, library: DataViewLibrary): Promise<number>;
}

function fail(code: ErrorCode): never {
  throw { code, requestId: null, retryable: false } satisfies IpcError;
}

function validateWrite(revision: number, library: DataViewLibrary): DataViewLibrary {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) fail('invalidInput');
  const checked = parseDataViewLibrary(library);
  if (!checked) fail('invalidInput');
  return checked;
}

export const desktopDataViewService: DataViewService = {
  kind: 'desktop',
  load: async () => {
    if (!isTauri()) fail('unsupported');
    const record = parseDataViewRecord(await invoke<unknown>('data_views_load'));
    if (!record) fail('invalidResponse');
    return record;
  },
  save: async (expectedRevision, library) => {
    if (!isTauri()) fail('unsupported');
    const checked = validateWrite(expectedRevision, library);
    const response = await invoke<unknown>('data_views_save', { expectedRevision, library: checked });
    if (typeof response !== 'object' || response === null || Object.keys(response).length !== 1
      || !('revision' in response) || response.revision !== expectedRevision + 1) fail('invalidResponse');
    return response.revision;
  },
};

/** Explicit browser preview only. Desktop errors never switch adapters. */
export function createSessionDataViewService(): DataViewService {
  let record: DataViewRecord = { revision: 0, library: emptyDataViews() };
  return {
    kind: 'session',
    load: async () => structuredClone(record),
    save: async (expectedRevision, library) => {
      const checked = validateWrite(expectedRevision, library);
      if (expectedRevision !== record.revision) fail('dataViewConflict');
      for (const entry of checked.entries) {
        const previous = record.library.entries.find((item) => item.id === entry.id);
        if (previous && previous.connectionId !== entry.connectionId) fail('invalidInput');
      }
      record = { revision: record.revision + 1, library: checked };
      return record.revision;
    },
  };
}

export function createDataViewService(): DataViewService {
  return isTauri() ? desktopDataViewService : createSessionDataViewService();
}
