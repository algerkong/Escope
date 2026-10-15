import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  emptySavedCharts, parseChartLibrary, parseChartRecord, sameChartDefinition,
  type SavedChartLibrary, type SavedChartRecord,
} from '../domain/saved-charts';
import type { ErrorCode, IpcError } from './ipc';

export interface SavedChartService {
  readonly kind: 'desktop' | 'session';
  load(): Promise<SavedChartRecord>;
  save(expectedRevision: number, library: SavedChartLibrary): Promise<number>;
}

function fail(code: ErrorCode): never {
  throw { code, requestId: null, retryable: false } satisfies IpcError;
}

function validateWrite(revision: number, library: SavedChartLibrary): SavedChartLibrary {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) fail('invalidInput');
  const checked = parseChartLibrary(library);
  if (!checked) fail('invalidInput');
  return checked;
}

export const desktopSavedChartService: SavedChartService = {
  kind: 'desktop',
  load: async () => {
    if (!isTauri()) fail('unsupported');
    const record = parseChartRecord(await invoke<unknown>('saved_charts_load'));
    if (!record) fail('invalidResponse');
    return record;
  },
  save: async (expectedRevision, library) => {
    if (!isTauri()) fail('unsupported');
    const checked = validateWrite(expectedRevision, library);
    const response = await invoke<unknown>('saved_charts_save', { expectedRevision, library: checked });
    if (typeof response !== 'object' || response === null || Object.keys(response).length !== 1
      || !('revision' in response) || (response as { revision: unknown }).revision !== expectedRevision + 1) fail('invalidResponse');
    return (response as { revision: number }).revision;
  },
};

export function createSessionSavedChartService(initialLibrary?: SavedChartLibrary): SavedChartService {
  let record: SavedChartRecord = initialLibrary
    ? { revision: 1, library: parseChartLibrary(initialLibrary) ?? emptySavedCharts() }
    : { revision: 0, library: emptySavedCharts() };
  return {
    kind: 'session',
    load: async () => structuredClone(record),
    save: async (expectedRevision, library) => {
      const checked = validateWrite(expectedRevision, library);
      if (expectedRevision !== record.revision) fail('savedChartConflict');
      if (record.revision > 0 && checked.version < record.library.version) fail('invalidInput');
      for (const entry of checked.entries) {
        const previous = record.library.entries.find((item) => item.id === entry.id);
        if (previous && !sameChartDefinition(previous, entry)) fail('invalidInput');
      }
      record = { revision: record.revision + 1, library: checked };
      return record.revision;
    },
  };
}

export function createSavedChartService(): SavedChartService {
  return isTauri() ? desktopSavedChartService : createSessionSavedChartService();
}
