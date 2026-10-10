import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  emptyChartDefinitions, parseChartDefinitionLibrary, parseChartDefinitionRecord,
  type ChartDefinitionLibrary, type ChartDefinitionRecord,
} from '../domain/chart-definitions';
import type { ErrorCode, IpcError } from './ipc';

export interface ChartDefinitionService {
  readonly kind: 'desktop' | 'session';
  load(): Promise<ChartDefinitionRecord>;
  save(expectedRevision: number, library: ChartDefinitionLibrary): Promise<number>;
}

function fail(code: ErrorCode): never {
  throw { code, requestId: null, retryable: false } satisfies IpcError;
}

function validateWrite(revision: number, library: ChartDefinitionLibrary): ChartDefinitionLibrary {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) fail('invalidInput');
  const checked = parseChartDefinitionLibrary(library);
  if (!checked) fail('invalidInput');
  return checked;
}

export const desktopChartDefinitionService: ChartDefinitionService = {
  kind: 'desktop',
  load: async () => {
    if (!isTauri()) fail('unsupported');
    const record = parseChartDefinitionRecord(await invoke<unknown>('chart_definitions_load'));
    if (!record) fail('invalidResponse');
    return record;
  },
  save: async (expectedRevision, library) => {
    if (!isTauri()) fail('unsupported');
    const checked = validateWrite(expectedRevision, library);
    const response = await invoke<unknown>('chart_definitions_save', { expectedRevision, library: checked });
    if (typeof response !== 'object' || response === null || Object.keys(response).length !== 1
      || !('revision' in response) || response.revision !== expectedRevision + 1) fail('invalidResponse');
    return response.revision;
  },
};

/** Explicit browser preview only. Desktop errors never switch adapters. */
export function createSessionChartDefinitionService(): ChartDefinitionService {
  let record: ChartDefinitionRecord = { revision: 0, library: emptyChartDefinitions() };
  return {
    kind: 'session',
    load: async () => structuredClone(record),
    save: async (expectedRevision, library) => {
      const checked = validateWrite(expectedRevision, library);
      if (expectedRevision !== record.revision) fail('chartDefinitionConflict');
      for (const entry of checked.entries) {
        const previous = record.library.entries.find((item) => item.id === entry.id);
        if (previous && previous.connectionId !== entry.connectionId) fail('invalidInput');
      }
      record = { revision: record.revision + 1, library: checked };
      return record.revision;
    },
  };
}

export function createChartDefinitionService(): ChartDefinitionService {
  return isTauri() ? desktopChartDefinitionService : createSessionChartDefinitionService();
}
