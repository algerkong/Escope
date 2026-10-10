import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  emptyPinnedFilters, parsePinnedFilterLibrary, parsePinnedFilterRecord, samePinnedFilter,
  type PinnedFilterLibrary, type PinnedFilterRecord,
} from '../domain/pinned-filters';
import type { ErrorCode, IpcError } from './ipc';

export interface PinnedFilterService {
  readonly kind: 'desktop' | 'session';
  load(): Promise<PinnedFilterRecord>;
  save(expectedRevision: number, library: PinnedFilterLibrary): Promise<number>;
}

function fail(code: ErrorCode): never {
  throw { code, requestId: null, retryable: false } satisfies IpcError;
}

function validateWrite(revision: number, library: PinnedFilterLibrary): PinnedFilterLibrary {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) fail('invalidInput');
  const checked = parsePinnedFilterLibrary(library);
  if (!checked) fail('invalidInput');
  return checked;
}

export const desktopPinnedFilterService: PinnedFilterService = {
  kind: 'desktop',
  load: async () => {
    if (!isTauri()) fail('unsupported');
    const record = parsePinnedFilterRecord(await invoke<unknown>('pinned_filters_load'));
    if (!record) fail('invalidResponse');
    return record;
  },
  save: async (expectedRevision, library) => {
    if (!isTauri()) fail('unsupported');
    const checked = validateWrite(expectedRevision, library);
    const response = await invoke<unknown>('pinned_filters_save', { expectedRevision, library: checked });
    if (typeof response !== 'object' || response === null || Object.keys(response).length !== 1
      || !('revision' in response) || response.revision !== expectedRevision + 1) fail('invalidResponse');
    return response.revision;
  },
};

/** Explicit preview adapter. Existing definitions are immutable; saving mints a new definition ID. */
export function createSessionPinnedFilterService(): PinnedFilterService {
  let record: PinnedFilterRecord = { revision: 0, library: emptyPinnedFilters() };
  return {
    kind: 'session',
    load: async () => structuredClone(record),
    save: async (expectedRevision, library) => {
      const checked = validateWrite(expectedRevision, library);
      if (expectedRevision !== record.revision) fail('pinnedFilterConflict');
      if (record.revision > 0 && checked.version < record.library.version) fail('invalidInput');
      for (const entry of checked.entries) {
        const previous = record.library.entries.find((item) => item.id === entry.id);
        if (previous && !samePinnedFilter(previous, entry)) fail('invalidInput');
      }
      record = { revision: record.revision + 1, library: checked };
      return record.revision;
    },
  };
}

export function createPinnedFilterService(): PinnedFilterService {
  return isTauri() ? desktopPinnedFilterService : createSessionPinnedFilterService();
}
